#!/usr/bin/env bash
# install_docker.sh - bootstrap Docker on the freshly provisioned host.
#
# Usage:
#   bash install_docker.sh deploy-work/<APP>/brief/host.json
#
# Reads ip + kind from host.json. For LXC, SSHes in as root (the
# container was created with root creds). For VM, SSHes in as the
# cloud-init user from PVE_VM_CLOUDINIT_USER and uses sudo.
# For TARGET_KIND=existing, uses DEPLOY_HOST + DEPLOY_SSH_USER from env.

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "usage: install_docker.sh <host.json>" >&2
    exit 2
fi

HOST_JSON="$1"
[[ -f "${HOST_JSON}" ]] || { echo "install_docker: ${HOST_JSON} not found" >&2; exit 2; }

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="${SKILL_DIR}/assets/templates/docker-bootstrap.sh.tmpl"
APP_DIR="$(dirname "$(dirname "${HOST_JSON}")")"
APP_NAME="$(basename "${APP_DIR}")"

KIND="$(python3 -c "import json,sys; print(json.load(open('${HOST_JSON}'))['kind'])")"
case "${KIND}" in
    lxc|vm|existing) ;;
    *) echo "install_docker: unknown kind '${KIND}' in ${HOST_JSON}" >&2; exit 2 ;;
esac

if [[ "${KIND}" == "existing" ]]; then
    : "${DEPLOY_HOST:?DEPLOY_HOST not set for existing-host target}"
    SSH_HOST="${DEPLOY_HOST}"
    SSH_USER="${DEPLOY_SSH_USER:-root}"
    DEPLOY_USER="${DEPLOY_SSH_USER:-root}"
else
    SSH_HOST="$(python3 -c "import json,sys; print(json.load(open('${HOST_JSON}'))['ip'])")"
    if [[ "${KIND}" == "lxc" ]]; then
        SSH_USER="root"
        DEPLOY_USER="root"
    else
        SSH_USER="${PVE_VM_CLOUDINIT_USER:-deploy}"
        DEPLOY_USER="${SSH_USER}"
    fi
fi

# Render bootstrap with DEPLOY_USER substituted in.
VARS_JSON="$(mktemp)"
trap 'rm -f "${VARS_JSON}"' EXIT
cat > "${VARS_JSON}" <<EOF
{ "APP_NAME": "${APP_NAME}", "DEPLOY_USER": "${DEPLOY_USER}" }
EOF

RENDERED="${APP_DIR}/draft/docker-bootstrap.sh"
python3 "${SKILL_DIR}/scripts/render_template.py" \
    "${TEMPLATE}" "${VARS_JSON}" --out "${RENDERED}"

REMOTE_PATH="/tmp/docker-bootstrap-${APP_NAME}.$$.sh"
scp -q -o StrictHostKeyChecking=accept-new \
    "${RENDERED}" "${SSH_USER}@${SSH_HOST}:${REMOTE_PATH}"

if [[ "${SSH_USER}" == "root" ]]; then
    SUDO=""
else
    SUDO="sudo"
fi

ssh -o StrictHostKeyChecking=accept-new "${SSH_USER}@${SSH_HOST}" \
    "${SUDO} bash ${REMOTE_PATH}; rm -f ${REMOTE_PATH}"

echo "install_docker: bootstrap complete on ${SSH_HOST}"
