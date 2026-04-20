---
name: deploy-node-proxmox-pingaccess
description: Deploy a Dockerized Node.js application onto a Proxmox VE host (LXC container or QEMU VM) and front it with PingAccess as an identity-aware reverse proxy. Use when the user asks to deploy, ship, provision, or roll out a Node app to Proxmox, when fronting a service with PingAccess, or when scaffolding a Docker-on-Proxmox + PingAccess pipeline for any repo containing a Dockerfile and docker-compose.yml.
---

# /deploy-node-proxmox-pingaccess

End-to-end workflow for deploying a Dockerized Node application onto a
Proxmox VE host and fronting it with PingAccess. The agent runs every
script directly; the user is never asked to run a command. Use the
**repository workspace root** as the working directory — paths like
`deploy-work/{{APP_NAME}}/...` are relative to it.

Read [README.md](README.md) once at the start to confirm prerequisites
are documented for the user. If any required environment variable from
`assets/env.deploy.example` is unset, stop and tell the user which ones
to export before continuing.

## Setup

Read these files once before starting:

- `references/PROXMOX_REFERENCE.md` — `pct` / `qm` / cloud-init essentials.
- `references/PINGACCESS_REFERENCE.md` — `/pa-admin-api/v3` endpoints and auth.
- `references/DOCKER_HOST_BOOTSTRAP.md` — Docker install steps inside LXC and VM.
- `assets/DEPLOY_BRIEF_TEMPLATE.md` — brief format that drives every render.
- `assets/templates/*.tmpl` — provisioning, compose, and PingAccess JSON sources.
- `assets/env.deploy.example` — the env vars the scripts consume.

## Input

The user must provide an `{{APP_NAME}}` (short, hyphen/underscore-safe;
e.g. `cssdoom`, `internal-portal`). If absent, derive one from the repo
folder name and confirm via `AskQuestion`.

Optional inputs:
- An external hostname the app should serve at (`PUBLIC_HOSTNAME`).
- A target Proxmox node, storage pool, and bridge (otherwise read from
  `PVE_*` env vars).
- A pre-existing Docker host (skips Phase D entirely).

---

## Phase A — Discovery

### Step 1 — Scaffold the working directory

Run `bash .cursor/skills/deploy-node-proxmox-pingaccess/scripts/scaffold.sh {{APP_NAME}}`.
This creates `deploy-work/{{APP_NAME}}/{brief,draft,out,logs}/` plus an
empty `deploy.log`, and adds `deploy-work/` to `.gitignore` if a
`.gitignore` exists and the entry is missing.

### Step 2 — Detect the app shape

Run `python3 .cursor/skills/deploy-node-proxmox-pingaccess/scripts/detect_app.py`
and parse the JSON it prints. Save it to
`deploy-work/{{APP_NAME}}/brief/detect.json`. The report contains:

- `dockerfile` — path to `Dockerfile` (must exist, else stop).
- `composeFile` — path to `docker-compose.yml` / `compose.yaml` (must exist, else stop).
- `services` — service names parsed from compose, with `target`, exposed
  `ports`, and inferred `image` tags.
- `envExample` — path to `.env.example` if present.
- `nodeVersion` — from `package.json#engines.node` if pinned.
- `healthchecks` — each service's `HEALTHCHECK` URL/port pair (parsed
  from the Dockerfile when not declared in compose).

If `dockerfile` or `composeFile` is missing, stop and tell the user the
skill requires both before it can deploy.

### Step 3 — Confirm secrets

Verify the required env vars are set in the agent's shell. Required for
every deploy:
- `PVE_HOST`, `PVE_NODE`, `PVE_SSH_USER` (default `root`).
- `PVE_STORAGE`, `PVE_BRIDGE`.
- `PA_ADMIN_HOST`, `PA_ADMIN_USER`, `PA_ADMIN_PASS`.

Conditionally required:
- LXC target → `PVE_LXC_TEMPLATE`, `PVE_LXC_PASSWORD` (or `PVE_SSH_PUBKEY_PATH`).
- VM target → `PVE_VM_TEMPLATE_ID` or `PVE_VM_CLOUD_IMAGE`.
- Existing host → `DEPLOY_HOST` and `DEPLOY_SSH_USER`.

If anything is missing, stop and reference the exact env names from
`assets/env.deploy.example`.

---

## Phase B — Choose the deployment target

Ask via `AskQuestion`:

- "Where should the app run?" with options: `LXC container (lightweight)`,
  `QEMU VM (full isolation)`, `Existing Docker host (skip provisioning)`.

Record the answer (`lxc` / `vm` / `existing`) in
`deploy-work/{{APP_NAME}}/brief/target.txt`.

If `existing`, skip Phase C and Phase D's Docker install — Phase E still
verifies Docker is present on the target.

---

## Phase C — Fill the deploy brief

Produce a completed copy of `assets/DEPLOY_BRIEF_TEMPLATE.md` at
`deploy-work/{{APP_NAME}}/brief/BRIEF.md`. It is the single source of
truth for every render in Phases D–G.

Pre-populate from:

1. `detect.json` — service names, ports, healthcheck paths.
2. The chosen target — pick container ID range (LXC: 200–999, VM:
   1000–9999) and resource defaults (LXC: 2 vCPU / 2 GiB / 16 GiB disk;
   VM: 2 vCPU / 4 GiB / 32 GiB disk).
3. Env vars from Phase A Step 3.

Always include:
- `APP_NAME`, `IMAGE_TAG` (default `latest`).
- `HOST_PORT_*` for each service (re-use compose defaults).
- `PUBLIC_HOSTNAME` (the external FQDN PingAccess will publish).
- `PA_VHOST_PORT` (the PA Engine listener, default `443`).
- `PA_SITE_NAMES[]` — one PA Site per backend port (e.g. `<app>-web`,
  `<app>-game`).

Present the brief inline and ask via `AskQuestion`
(`Looks good — provision now` / `Edit brief first`). Loop until
approved. Do not advance until confirmed.

---

## Phase D — Provision the Proxmox host

Skip this phase entirely if target is `existing`.

### Step 1 — Build the variables file

Create `deploy-work/{{APP_NAME}}/draft/host-vars.json` with the keys
required by the chosen template:

- LXC: `CT_ID`, `CT_HOSTNAME`, `CT_TEMPLATE`, `CT_STORAGE`, `CT_BRIDGE`,
  `CT_CORES`, `CT_MEMORY_MB`, `CT_DISK_GB`, `CT_PASSWORD`,
  `CT_SSH_PUBKEY` (file contents, not path).
- VM: `VM_ID`, `VM_NAME`, `VM_TEMPLATE_ID` (clone source), `VM_STORAGE`,
  `VM_BRIDGE`, `VM_CORES`, `VM_MEMORY_MB`, `VM_DISK_GB`,
  `VM_CLOUDINIT_USER`, `VM_SSH_PUBKEY`.

### Step 2 — Render

```bash
python3 .cursor/skills/deploy-node-proxmox-pingaccess/scripts/render_template.py \
  .cursor/skills/deploy-node-proxmox-pingaccess/assets/templates/lxc-create.sh.tmpl \
  deploy-work/{{APP_NAME}}/draft/host-vars.json \
  --out deploy-work/{{APP_NAME}}/draft/provision.sh
```

(For VM, render `vm-cloudinit.yaml.tmpl` to
`deploy-work/{{APP_NAME}}/draft/cloudinit.yaml` first, then render the
qm clone command into `provision.sh`.)

### Step 3 — Provision

```bash
bash .cursor/skills/deploy-node-proxmox-pingaccess/scripts/provision_lxc.sh \
  deploy-work/{{APP_NAME}}/draft/provision.sh \
  | tee deploy-work/{{APP_NAME}}/logs/provision.log
```

(Or `provision_vm.sh` for the VM path.)

The script SSHes into `${PVE_SSH_USER}@${PVE_HOST}`, copies the rendered
provision script, runs it, then polls until the new container/VM has an
IP. The IP and ID land in `deploy-work/{{APP_NAME}}/brief/host.json` as
`{"ip": "...", "id": ..., "kind": "lxc"|"vm"}`.

---

## Phase E — Bootstrap Docker on the host

Skip the install step (but not the verification) if target is `existing`.

### Step 0 — Synthesize `host.json` for the existing-host path

Phase D normally writes `deploy-work/{{APP_NAME}}/brief/host.json` for
`lxc` / `vm` targets. For `existing`, Phase D was skipped, so create it
from env once:

```bash
[[ "$(cat deploy-work/{{APP_NAME}}/brief/target.txt)" == "existing" ]] && \
python3 -c 'import json,os,sys; \
json.dump({"ip": os.environ["DEPLOY_HOST"], "id": 0, "kind": "existing"}, \
          open(sys.argv[1], "w"))' \
  deploy-work/{{APP_NAME}}/brief/host.json
```

Refuses to run if `DEPLOY_HOST` is not set — that's the same env var the
downstream scripts also require, so it fails loudly here rather than
half-way through Phase F.

### Step 1 — Run the bootstrap

```bash
bash .cursor/skills/deploy-node-proxmox-pingaccess/scripts/install_docker.sh \
  deploy-work/{{APP_NAME}}/brief/host.json \
  | tee deploy-work/{{APP_NAME}}/logs/install.log
```

The script reads the IP from `host.json`, SSHes in, and runs the
appropriate bootstrap (LXC: Docker via the get.docker.com convenience
script; VM: same plus a reboot if cloud-init flagged one). Verify with
`docker version` and `docker compose version` before continuing.

---

## Phase F — Ship and run the compose stack

```bash
bash .cursor/skills/deploy-node-proxmox-pingaccess/scripts/deploy_compose.sh \
  deploy-work/{{APP_NAME}}/brief/host.json \
  | tee deploy-work/{{APP_NAME}}/logs/deploy.log
```

The script:
1. Rsyncs the repo to `/opt/{{APP_NAME}}` on the host (honours
   `.dockerignore` via `--filter=':- .dockerignore'`).
2. Copies a local `.env` if present; otherwise warns and copies
   `.env.example` so optional channels stay disabled.
3. Runs `docker compose pull || true` then `docker compose up --build -d`.
4. Waits for each service's `HEALTHCHECK` (parsed from `detect.json`) to
   report healthy via `docker inspect --format '{{.State.Health.Status}}'`.

If any healthcheck fails, dump the last 100 lines of
`docker compose logs <service>` into `logs/deploy.log` and stop.

---

## Phase G — Configure PingAccess (minimal)

Three resources are created via `/pa-admin-api/v3` using basic auth from
`PA_ADMIN_USER` / `PA_ADMIN_PASS`. The pattern mirrors
[references/PINGACCESS_REFERENCE.md](references/PINGACCESS_REFERENCE.md).

### Step 1 — Render JSON bodies

For each backend port the app exposes (one Site per port — typically
`web` and any auxiliary services like `game`/`api`), build
`deploy-work/{{APP_NAME}}/draft/pa-vars.json` with keys like
`PUBLIC_HOSTNAME`, `PA_VHOST_PORT`, `BACKEND_HOST` (the Docker host's
IP from `host.json`), `BACKEND_WEB_PORT`, `BACKEND_GAME_PORT`,
`SITE_NAME_WEB`, `SITE_NAME_GAME`, `APPLICATION_NAME`,
`APPLICATION_CONTEXT_ROOT` (default `/`).

Render once per template:

```bash
python3 .../scripts/render_template.py .../templates/pa-virtualhost.json.tmpl \
  deploy-work/{{APP_NAME}}/draft/pa-vars.json \
  --out deploy-work/{{APP_NAME}}/draft/pa-virtualhost.json

python3 .../scripts/render_template.py .../templates/pa-site.json.tmpl \
  deploy-work/{{APP_NAME}}/draft/pa-vars.json \
  --out deploy-work/{{APP_NAME}}/draft/pa-site.json

python3 .../scripts/render_template.py .../templates/pa-application.json.tmpl \
  deploy-work/{{APP_NAME}}/draft/pa-vars.json \
  --out deploy-work/{{APP_NAME}}/draft/pa-application.json
```

### Step 2 — POST to PingAccess

```bash
python3 .cursor/skills/deploy-node-proxmox-pingaccess/scripts/pa_api.py \
  apply deploy-work/{{APP_NAME}}/draft/ \
  | tee deploy-work/{{APP_NAME}}/logs/pingaccess.log
```

The script POSTs each JSON body to its endpoint
(`/virtualhosts`, `/sites`, `/applications`) in order, captures the
returned `id` for each, and writes them to
`deploy-work/{{APP_NAME}}/out/pa-resources.json`. If a resource with the
same name already exists it asks via `AskQuestion`
(`Reuse existing` / `Update in place` / `Abort`).

### Step 3 — Manual handoff checklist

Print this exact checklist for the user — these steps are intentionally
out of scope per [README.md](README.md) "What this skill does NOT do":

```
Manual PingAccess steps to complete in the admin UI:
  [ ] Create or attach a Web Session (Settings -> Access -> Web Sessions)
  [ ] Create or attach an Identity Mapping (Settings -> Access -> Identity Mappings)
  [ ] Assign at least one Access Policy (Policies) to the new Application
  [ ] Confirm the Engine listener is bound to PA_VHOST_PORT and the
      Key Pair for PUBLIC_HOSTNAME is selected
  [ ] Reload PingAccess configuration if running clustered
```

---

## Phase H — Verify and hand off

```bash
bash .cursor/skills/deploy-node-proxmox-pingaccess/scripts/healthcheck.sh \
  deploy-work/{{APP_NAME}}/brief/BRIEF.md \
  | tee deploy-work/{{APP_NAME}}/logs/healthcheck.log
```

Verifies, in order:
1. Direct backend reachability — `curl -fsS http://${BACKEND_HOST}:${BACKEND_WEB_PORT}/healthz`.
2. PingAccess fronting — `curl -fsS https://${PUBLIC_HOSTNAME}/healthz`.
3. WebSocket upgrade through PA — `curl -i -H 'Upgrade: websocket' -H 'Connection: Upgrade' https://${PUBLIC_HOSTNAME}/ws` and check for `101`.

Reply to the user with:
1. The destination IP, container/VM ID, PA resource IDs (from
   `out/pa-resources.json`).
2. The healthcheck status for each step (PASS / FAIL).
3. The full manual handoff checklist from Phase G Step 3, with any
   items already satisfied marked done.
4. Where to find logs: `deploy-work/{{APP_NAME}}/logs/*.log`.

---

## Determinism rules

- Always render via `render_template.py` — never hand-write a provision
  script or PingAccess JSON body.
- Always `AskQuestion` at branches: target type, brief approval,
  resource collisions in PingAccess, retry on health-check failure.
- All intermediates land under `deploy-work/{{APP_NAME}}/`. Nothing in
  that tree is ever committed.
- Credentials only flow through env vars listed in
  `assets/env.deploy.example`; the skill refuses to run if any required
  one is unset.
- Never edit a rendered file by hand — fix the brief or vars JSON and
  re-render.
- Out of scope (do not attempt): TLS issuance, PA policy / identity
  mapping authoring, Proxmox cluster setup, HA, backups, blue/green or
  rolling deploys.
