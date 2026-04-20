# Proxmox VE reference

Just the parts the skill uses. Full PVE docs:
<https://pve.proxmox.com/pve-docs/>.

The skill talks to Proxmox over **SSH to the node** (`PVE_SSH_USER@PVE_HOST`).
SSH is preferred over the REST API here because `pct` and `qm` provide
the simplest path for cloud-init, template lookup, and config edits.

## LXC (`pct`)

A container is created from a template tarball already present on the
node. List available templates:

```bash
pveam list local
```

### Create

```bash
pct create <CT_ID> <CT_TEMPLATE> \
  --hostname <CT_HOSTNAME> \
  --cores <CT_CORES> \
  --memory <CT_MEMORY_MB> \
  --rootfs <CT_STORAGE>:<CT_DISK_GB> \
  --net0 name=eth0,bridge=<CT_BRIDGE>,ip=dhcp \
  --features nesting=1,keyctl=1 \
  --unprivileged 1 \
  --password "<CT_PASSWORD>" \
  --ssh-public-keys <PUBKEY_PATH_ON_NODE> \
  --start 1 \
  --onboot 1
```

Critical flags for Docker-in-LXC:

- `--features nesting=1,keyctl=1` — required for the Docker daemon to
  start cleanly inside an unprivileged container.
- `--unprivileged 1` — keep the container unprivileged. Docker still
  works thanks to the features above. If you need binds with arbitrary
  UID mapping, drop to privileged (`--unprivileged 0`) and accept the
  weaker isolation.
- DHCP (`ip=dhcp`) keeps the skill simple. For static IPs, swap to
  `ip=10.0.0.42/24,gw=10.0.0.1` and skip the IP poll.

### Inspect

```bash
pct list                              # all containers on this node
pct config <CT_ID>                    # full config
pct exec <CT_ID> -- ip -4 addr show   # find IP after boot
pct status <CT_ID>                    # running / stopped
```

### Destroy

```bash
pct stop <CT_ID> && pct destroy <CT_ID>
```

## QEMU VM (`qm`)

The skill clones from an existing **cloud-init-enabled template VM**.
Building that template is a one-time prep step and out of scope; the
canonical recipe is at
<https://pve.proxmox.com/wiki/Cloud-Init_Support>.

### Clone

```bash
qm clone <VM_TEMPLATE_ID> <VM_ID> \
  --name <VM_NAME> \
  --full \
  --storage <VM_STORAGE>

qm set <VM_ID> \
  --cores <VM_CORES> \
  --memory <VM_MEMORY_MB> \
  --net0 virtio,bridge=<VM_BRIDGE> \
  --ipconfig0 ip=dhcp \
  --ciuser <VM_CLOUDINIT_USER> \
  --sshkey <PUBKEY_PATH_ON_NODE> \
  --cicustom "user=<VM_STORAGE>:snippets/<APP_NAME>-user.yaml"

qm resize <VM_ID> scsi0 <VM_DISK_GB>G
qm start <VM_ID>
```

### Cloud-init user-data

The skill writes a user-data file to the node's snippet storage (e.g.
`/var/lib/vz/snippets/<APP_NAME>-user.yaml`) and references it via
`--cicustom`. The template ships at
[../assets/templates/vm-cloudinit.yaml.tmpl](../assets/templates/vm-cloudinit.yaml.tmpl).

Snippets storage must be enabled on the chosen storage:

```bash
pvesm set <VM_STORAGE> --content snippets,images,iso,vztmpl,backup
```

### Inspect

```bash
qm list
qm config <VM_ID>
qm guest cmd <VM_ID> network-get-interfaces   # needs guest-agent
```

### Destroy

```bash
qm stop <VM_ID> && qm destroy <VM_ID> --purge
```

## ID allocation

Avoid colliding with existing IDs. The skill picks the smallest free ID
in the configured range (LXC: 200–999, VM: 1000–9999). To probe:

```bash
pvesh get /cluster/nextid                     # next ID across the cluster
cat /etc/pve/.vmlist                          # all known IDs (cluster-wide)
```

## Authentication notes

The skill relies on SSH key auth to `PVE_SSH_USER@PVE_HOST`. To wire it
up once:

```bash
ssh-copy-id <PVE_SSH_USER>@<PVE_HOST>
ssh <PVE_SSH_USER>@<PVE_HOST> 'pveversion'    # verify
```

If you must use the REST API instead (e.g. to provision through a
bastion), grant the API token `VM.Allocate`, `VM.Config.*`,
`VM.PowerMgmt`, and `Datastore.AllocateSpace` on the relevant pool. The
skill's scripts only consume the SSH path; swapping in the API is left
as an extension.
