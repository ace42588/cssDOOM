# Deploy brief — {{APP_NAME}}

Single source of truth for every render in Phases D–G. Fill in every
field; leave `# none` for genuinely empty lists.

## Application

- `APP_NAME`: short, hyphen/underscore-safe (e.g. `cssdoom`).
- `IMAGE_TAG`: tag applied to the locally built images (default `latest`).
- `REPO_PATH_ON_HOST`: where the repo will live on the Docker host
  (default `/opt/<APP_NAME>`).
- `ENV_FILE_LOCAL`: path to the `.env` to ship (default `./.env`; falls
  back to `./.env.example` with a warning).

## Compose services

For each service in `docker-compose.yml`:

| Service | Build target | Container port | Host port | Healthcheck |
|---------|--------------|----------------|-----------|-------------|
| `web`   | `web`        | 80             | 8080      | `GET /healthz` |
| `game`  | `server`     | 8787           | 8787      | `GET /healthz` |
| ...     | ...          | ...            | ...       | ...            |

(For this repo, see [docker-compose.yml](../../../../docker-compose.yml)
and [Dockerfile](../../../../Dockerfile).)

## Target host

- `TARGET_KIND`: `lxc` | `vm` | `existing`.

If `lxc`:
- `CT_ID`: numeric, in 200–999.
- `CT_HOSTNAME`: short DNS-safe name.
- `CT_TEMPLATE`: e.g. `local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst`.
- `CT_STORAGE`, `CT_BRIDGE`.
- `CT_CORES` (default 2), `CT_MEMORY_MB` (default 2048), `CT_DISK_GB` (default 16).
- `CT_PASSWORD` and/or `CT_SSH_PUBKEY` (file contents inlined).

If `vm`:
- `VM_ID`: numeric, in 1000–9999.
- `VM_NAME`: short DNS-safe name.
- `VM_TEMPLATE_ID`: existing cloud-init template VM ID to clone.
- `VM_STORAGE`, `VM_BRIDGE`.
- `VM_CORES` (default 2), `VM_MEMORY_MB` (default 4096), `VM_DISK_GB` (default 32).
- `VM_CLOUDINIT_USER` (default `deploy`).
- `VM_SSH_PUBKEY`: file contents inlined.

If `existing`:
- `DEPLOY_HOST`: hostname or IP reachable over SSH.
- `DEPLOY_SSH_USER`: typically `root` or `deploy`.

## PingAccess

- `PUBLIC_HOSTNAME`: external FQDN (e.g. `doom.example.com`).
- `PA_VHOST_PORT`: PA Engine listener port (default `443`).
- `BACKEND_HOST`: filled in after Phase D from `host.json` (Docker host IP).
- Sites — one per backend port. For this repo:
  - `SITE_NAME_WEB` = `<APP_NAME>-web`, `BACKEND_WEB_PORT` = host port for the static client.
  - `SITE_NAME_GAME` = `<APP_NAME>-game`, `BACKEND_GAME_PORT` = host port for the WebSocket / `/healthz` server.
- `APPLICATION_NAME`: defaults to `APP_NAME`.
- `APPLICATION_CONTEXT_ROOT`: default `/`.

## Approval

Set when the user approves via `AskQuestion`:

- `APPROVED_AT`: ISO 8601 timestamp.
- `APPROVED_BY`: shell `whoami` at approval time.
