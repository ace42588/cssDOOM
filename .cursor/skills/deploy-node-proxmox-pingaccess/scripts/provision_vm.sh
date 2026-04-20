#!/usr/bin/env bash
# provision_vm.sh - clone a cloud-init template VM on Proxmox, attach
# rendered user-data, start it, and capture {ip,id,kind:"vm"}.
#
# Usage:
#   bash provision_vm.sh deploy-work/<APP>/draft/host-vars.json \
#                        deploy-work/<APP>/draft/cloudinit.yaml
#
# Requires env: PVE_HOST, PVE_NODE, PVE_SSH_USER, PVE_VM_SNIPPET_STORAGE.

set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "usage: provision_vm.sh <host-vars.json> <cloudinit.yaml>" >&2
    exit 2
fi

VARS_JSON="$1"
CLOUDINIT_YAML="$2"

[[ -f "${VARS_JSON}" ]] || { echo "provision_vm: ${VARS_JSON} not found" >&2; exit 2; }
[[ -f "${CLOUDINIT_YAML}" ]] || { echo "provision_vm: ${CLOUDINIT_YAML} not found" >&2; exit 2; }

: "${PVE_HOST:?PVE_HOST not set}"
: "${PVE_VM_SNIPPET_STORAGE:?PVE_VM_SNIPPET_STORAGE not set}"
PVE_SSH_USER="${PVE_SSH_USER:-root}"

read_var() { python3 -c "import json,sys; print(json.load(open('${VARS_JSON}'))['$1'])"; }
APP_NAME="$(read_var APP_NAME)"
VM_ID="$(read_var VM_ID)"
VM_NAME="$(read_var VM_NAME)"
VM_TEMPLATE_ID="$(read_var VM_TEMPLATE_ID)"
VM_STORAGE="$(read_var VM_STORAGE)"
VM_BRIDGE="$(read_var VM_BRIDGE)"
VM_CORES="$(read_var VM_CORES)"
VM_MEMORY_MB="$(read_var VM_MEMORY_MB)"
VM_DISK_GB="$(read_var VM_DISK_GB)"
VM_CLOUDINIT_USER="$(read_var VM_CLOUDINIT_USER)"

APP_DIR="$(dirname "$(dirname "${VARS_JSON}")")"
HOST_JSON="${APP_DIR}/brief/host.json"

SNIPPET_REMOTE="/var/lib/vz/snippets/${APP_NAME}-user.yaml"
case "${PVE_VM_SNIPPET_STORAGE}" in
    local)            SNIPPET_REMOTE="/var/lib/vz/snippets/${APP_NAME}-user.yaml" ;;
    *)                SNIPPET_REMOTE="/mnt/pve/${PVE_VM_SNIPPET_STORAGE}/snippets/${APP_NAME}-user.yaml" ;;
esac

scp -q -o StrictHostKeyChecking=accept-new \
    "${CLOUDINIT_YAML}" "${PVE_SSH_USER}@${PVE_HOST}:${SNIPPET_REMOTE}"

OUTPUT="$(ssh -o StrictHostKeyChecking=accept-new "${PVE_SSH_USER}@${PVE_HOST}" bash -s <<EOF
set -euo pipefail
if qm status ${VM_ID} >/dev/null 2>&1; then
    echo "provision_vm: VM ${VM_ID} already exists; aborting" >&2
    exit 3
fi
qm clone ${VM_TEMPLATE_ID} ${VM_ID} --name ${VM_NAME} --full --storage ${VM_STORAGE}
qm set ${VM_ID} \\
    --cores ${VM_CORES} \\
    --memory ${VM_MEMORY_MB} \\
    --net0 virtio,bridge=${VM_BRIDGE} \\
    --ipconfig0 ip=dhcp \\
    --ciuser ${VM_CLOUDINIT_USER} \\
    --cicustom "user=${PVE_VM_SNIPPET_STORAGE}:snippets/${APP_NAME}-user.yaml" \\
    --agent enabled=1
qm resize ${VM_ID} scsi0 ${VM_DISK_GB}G || true
qm start ${VM_ID}

# Wait for guest agent to report an IPv4 lease (cloud-init needs ~30-90s).
for _ in \$(seq 1 60); do
    IP=\$(qm guest cmd ${VM_ID} network-get-interfaces 2>/dev/null \\
        | python3 -c 'import json,sys
data=json.load(sys.stdin)
for nic in data:
    if nic.get("name")=="lo": continue
    for a in nic.get("ip-addresses", []):
        if a.get("ip-address-type")=="ipv4" and not a["ip-address"].startswith("169.254"):
            print(a["ip-address"]); raise SystemExit
' 2>/dev/null || true)
    if [[ -n "\${IP:-}" ]]; then
        printf '{"ip":"%s","id":%d,"kind":"vm"}\n' "\${IP}" ${VM_ID}
        exit 0
    fi
    sleep 3
done
echo "provision_vm: VM ${VM_ID} did not report an IPv4 in 180s" >&2
exit 4
EOF
)"

LAST_LINE="$(printf '%s\n' "${OUTPUT}" | tail -n1)"
if ! printf '%s' "${LAST_LINE}" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' >/dev/null 2>&1; then
    echo "provision_vm: did not get JSON from remote; full output:" >&2
    printf '%s\n' "${OUTPUT}" >&2
    exit 5
fi

mkdir -p "$(dirname "${HOST_JSON}")"
printf '%s\n' "${LAST_LINE}" > "${HOST_JSON}"
echo "provision_vm: wrote ${HOST_JSON}"
cat "${HOST_JSON}"
