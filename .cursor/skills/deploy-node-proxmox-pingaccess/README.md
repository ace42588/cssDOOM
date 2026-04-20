# deploy-node-proxmox-pingaccess

A Cursor agent skill that deploys a Dockerized Node.js application onto
a Proxmox VE host (LXC container or QEMU VM) and fronts it with
PingAccess as an identity-aware reverse proxy.

The skill itself lives in [SKILL.md](SKILL.md) and runs scripted phases
end-to-end. This README is for the **human operator** preparing the
environment so the skill can run without surprises.

## What this skill does

1. **Provision** a Docker host on Proxmox — either a fresh LXC container
   (`pct create`) or a QEMU VM cloned from a cloud-init template
   (`qm clone`). You can also point the skill at an existing host and
   skip provisioning.
2. **Bootstrap & ship** — installs Docker Engine + the Compose plugin
   on the new host, rsyncs the repo, copies `.env`, and runs
   `docker compose up --build -d` until every service's `HEALTHCHECK`
   reports healthy.
3. **Front with PingAccess** — creates the minimum set of PingAccess
   resources via `/pa-admin-api/v3` (one Virtual Host, one Site per
   backend port, one Application). Identity mapping, web sessions,
   policies, and certificates are intentionally left as a manual
   handoff.

## What this skill does **NOT** do

The skill is deliberately scoped. It will not:

- Issue or rotate TLS certificates (PA expects the Key Pair already
  imported and bound to the Engine listener).
- Author PingAccess Web Sessions, Identity Mappings, or Access Policies.
  It creates the Application and prints a manual checklist.
- Configure Proxmox clusters, HA groups, storage backends, or backups.
- Implement blue/green, canary, or rolling deploys. It is a single-host
  `docker compose up -d` flow.
- Manage DNS records.

## Prerequisites

### Local workstation (where the agent runs)

| Tool | Why |
|------|-----|
| `ssh`, `scp`, `rsync` | Talking to Proxmox + the Docker host |
| `curl`, `jq` | API calls and JSON munging in shell scripts |
| `python3` >= 3.10 | Template rendering and PingAccess API client |
| `docker` (optional) | Local sanity build before shipping |

### Target Node.js application

The skill assumes a repo shaped like this one. It will refuse to run if
either of the first two is missing.

- A `Dockerfile` at the repo root (multi-stage builds are fine — see
  [Dockerfile](../../../Dockerfile)).
- A `docker-compose.yml` (or `compose.yaml`) at the repo root that
  declares each service, its build target, exposed ports, and a
  `HEALTHCHECK` (in compose or in the Dockerfile).
- An `.env.example` documenting every environment variable the runtime
  reads (see [.env.example](../../../.env.example)).
- A `.dockerignore` so the rsync stays small (see
  [.dockerignore](../../../.dockerignore)).

### Proxmox VE

You need a reachable PVE node and credentials with permission to create
containers/VMs on the chosen storage and bridge.

- `PVE_HOST` — hostname or IP, e.g. `pve01.lab.example.com`.
- `PVE_NODE` — the node name as it appears in the cluster
  (e.g. `pve01`).
- `PVE_SSH_USER` — typically `root`. The skill SSHes in to run `pct` /
  `qm` rather than using the REST API, because cloud-init and template
  flows are simpler that way.
- `PVE_STORAGE` — storage pool ID for container/VM root disks (e.g.
  `local-lvm`).
- `PVE_BRIDGE` — network bridge (e.g. `vmbr0`).
- **For LXC**: `PVE_LXC_TEMPLATE` (e.g.
  `local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst`) already
  downloaded on the node, plus either `PVE_LXC_PASSWORD` or
  `PVE_SSH_PUBKEY_PATH`.
- **For VM**: `PVE_VM_TEMPLATE_ID` (an existing cloud-init template VM
  ID to clone) **or** `PVE_VM_CLOUD_IMAGE` (path on the node to a
  qcow2 you've imported).

### PingAccess

You need an admin-capable account on a running PingAccess deployment
where the Engine listener and Key Pair are already wired up. The skill
only creates Virtual Host / Site / Application resources.

- `PA_ADMIN_HOST` — admin URL including port, e.g.
  `https://pa-admin.example.com:9000`.
- `PA_ADMIN_USER`, `PA_ADMIN_PASS` — admin credentials with permission
  to create VHosts, Sites, and Applications.
- An existing **Engine listener** bound to the public port the Virtual
  Host will use (typically `443`).
- An existing **Key Pair** for `PUBLIC_HOSTNAME` already imported and
  selected on the Engine listener.
- (For the manual handoff) a planned **Web Session** and **Identity
  Mapping** to attach to the new Application after the skill exits.

### DNS & network

- `PUBLIC_HOSTNAME` resolves to a PingAccess Engine reachable from the
  internet (or whatever audience the app serves).
- The PingAccess Engine can reach the Docker host on the backend ports
  the compose stack exposes (typically `8080` and `8787` in this repo's
  defaults).

### Secrets handling

All credentials live in environment variables — the skill never writes
them to disk outside the gitignored `deploy-work/` tree. See
[assets/env.deploy.example](assets/env.deploy.example) for the full
list. Copy that file and `source` it before invoking the skill:

```bash
cp .cursor/skills/deploy-node-proxmox-pingaccess/assets/env.deploy.example \
   ./.deploy.env
# edit ./.deploy.env, then:
set -a; . ./.deploy.env; set +a
```

`./.deploy.env` is matched by the existing `.env*` ignore rules in
[.dockerignore](../../../.dockerignore). Add it to `.gitignore` too if
you keep it around.

## Quick start

In a Cursor chat in this repo, with env vars sourced:

> Deploy this app to Proxmox as an LXC and put it behind PingAccess at
> `doom.example.com`.

The agent picks up the skill from the description, scaffolds
`deploy-work/cssdoom/`, asks you to confirm the brief, then runs
Phases D–H without further input unless something fails or a
PingAccess resource collides.

## Troubleshooting

Every phase tees its output to `deploy-work/{{APP_NAME}}/logs/`:

- `provision.log` — `pct create` / `qm clone` output and the IP poll.
- `install.log` — Docker bootstrap on the new host.
- `deploy.log` — `docker compose up -d` and per-service healthcheck waits.
- `pingaccess.log` — every PA API request and response body.
- `healthcheck.log` — backend / through-PA / WebSocket probes.

If the skill stops mid-flow, point it at the same `{{APP_NAME}}`; the
brief and `host.json` are reused so it picks up where it left off.
Delete the `deploy-work/{{APP_NAME}}/` tree to start clean.

## Layout

```
.cursor/skills/deploy-node-proxmox-pingaccess/
  SKILL.md                       agent workflow (Phases A-H)
  README.md                      this file
  references/                    long-form docs the agent reads on demand
    PROXMOX_REFERENCE.md
    PINGACCESS_REFERENCE.md
    DOCKER_HOST_BOOTSTRAP.md
  assets/
    DEPLOY_BRIEF_TEMPLATE.md     filled out at deploy-work/<app>/brief/BRIEF.md
    env.deploy.example           copy + source before running
    templates/                   {{KEY}} templates rendered by the agent
      lxc-create.sh.tmpl
      vm-cloudinit.yaml.tmpl
      docker-bootstrap.sh.tmpl
      compose-deploy.sh.tmpl
      pa-virtualhost.json.tmpl
      pa-site.json.tmpl
      pa-application.json.tmpl
  scripts/                       executable helpers; the agent runs these
    detect_app.py
    render_template.py
    scaffold.sh
    provision_lxc.sh
    provision_vm.sh
    install_docker.sh
    deploy_compose.sh
    pa_api.py
    healthcheck.sh
```
