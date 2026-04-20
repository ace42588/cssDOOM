#!/usr/bin/env bash
# deploy_compose.sh - rsync the repo to the Docker host and bring up
# the compose stack.
#
# Usage:
#   bash deploy_compose.sh deploy-work/<APP>/brief/host.json
#
# Optional env:
#   REPO_PATH_ON_HOST   override default /opt/<APP>
#   ENV_FILE_LOCAL      path to .env to ship (default: ./.env)

set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "usage: deploy_compose.sh <host.json>" >&2
    exit 2
fi

HOST_JSON="$1"
[[ -f "${HOST_JSON}" ]] || { echo "deploy_compose: ${HOST_JSON} not found" >&2; exit 2; }

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$(dirname "$(dirname "${HOST_JSON}")")"
APP_NAME="$(basename "${APP_DIR}")"
REPO_PATH_ON_HOST="${REPO_PATH_ON_HOST:-/opt/${APP_NAME}}"

KIND="$(python3 -c "import json,sys; print(json.load(open('${HOST_JSON}'))['kind'])")"
if [[ "${KIND}" == "existing" ]]; then
    : "${DEPLOY_HOST:?DEPLOY_HOST not set for existing-host target}"
    SSH_HOST="${DEPLOY_HOST}"
    SSH_USER="${DEPLOY_SSH_USER:-root}"
else
    SSH_HOST="$(python3 -c "import json,sys; print(json.load(open('${HOST_JSON}'))['ip'])")"
    SSH_USER="$([[ "${KIND}" == "lxc" ]] && echo root || echo "${PVE_VM_CLOUDINIT_USER:-deploy}")"
fi

if [[ "${SSH_USER}" == "root" ]]; then
    SUDO=""
else
    SUDO="sudo"
fi

# 1. Render the compose-deploy script with the host-side repo path.
VARS_JSON="$(mktemp)"
trap 'rm -f "${VARS_JSON}"' EXIT
cat > "${VARS_JSON}" <<EOF
{ "APP_NAME": "${APP_NAME}", "REPO_PATH_ON_HOST": "${REPO_PATH_ON_HOST}" }
EOF

RENDERED="${APP_DIR}/draft/compose-deploy.sh"
python3 "${SKILL_DIR}/scripts/render_template.py" \
    "${SKILL_DIR}/assets/templates/compose-deploy.sh.tmpl" \
    "${VARS_JSON}" --out "${RENDERED}"

# 2. Make sure the destination exists and is writable by SSH_USER.
# Prefer a normal mkdir when deploying under the remote user's home (no sudo);
# fall back to sudo for paths like /opt/... when passwordless sudo exists.
if [[ "${SSH_USER}" == "root" ]]; then
    ssh -o StrictHostKeyChecking=accept-new "${SSH_USER}@${SSH_HOST}" \
        "mkdir -p ${REPO_PATH_ON_HOST} && chown -R ${SSH_USER} ${REPO_PATH_ON_HOST}"
else
    ssh -o StrictHostKeyChecking=accept-new "${SSH_USER}@${SSH_HOST}" \
        "mkdir -p ${REPO_PATH_ON_HOST}" \
    || ssh -o StrictHostKeyChecking=accept-new "${SSH_USER}@${SSH_HOST}" \
        "${SUDO} mkdir -p ${REPO_PATH_ON_HOST} && ${SUDO} chown -R ${SSH_USER} ${REPO_PATH_ON_HOST}"
fi

# 3. Ship the repo to the host.
# Use rsync --inplace so bind-mounted single-file configs (for example,
# docker/edge.conf -> /etc/nginx/conf.d/default.conf) keep the same inode
# and can be reloaded by long-running containers.
# Do not merge `.dockerignore` here: many repos exclude `Dockerfile` /
# `docker-compose.yml` from the *build context* only, but those files must
# still exist on the host for `docker compose up --build`.
# Many minimal hosts also lack `rsync`; fall back to `tar` over SSH.
SSH_BASE=(ssh -o StrictHostKeyChecking=accept-new "${SSH_USER}@${SSH_HOST}")
# Leading `/` anchors to the transfer root so we do not exclude nested paths
# like `public/assets/sprites/` (DOOM art) when trimming top-level `sprites/`.
SHIP_EXCLUDES=(
    --exclude='.git/' --exclude='node_modules/' --exclude='dist/'
    --exclude='deploy-work/' --exclude='.cursor/' --exclude='.codex/'
    --exclude='/docs/' --exclude='/generate/' --exclude='/sprites/'
    --exclude='.DS_Store' --exclude='*.log' --exclude='*.tmp'
    --exclude='.env'
)

if "${SSH_BASE[@]}" "command -v rsync" >/dev/null 2>&1; then
    rsync -az --delete --inplace \
        "${SHIP_EXCLUDES[@]}" \
        -e "ssh -o StrictHostKeyChecking=accept-new" \
        ./ "${SSH_USER}@${SSH_HOST}:${REPO_PATH_ON_HOST}/"
else
    echo "deploy_compose: remote has no rsync; using tar over ssh" >&2
    "${SSH_BASE[@]}" "rm -rf '${REPO_PATH_ON_HOST}'/* '${REPO_PATH_ON_HOST}'/.[!.]* '${REPO_PATH_ON_HOST}'/..?* 2>/dev/null || true"
    # COPYFILE_DISABLE avoids macOS xattrs breaking Linux `tar` extract.
    COPYFILE_DISABLE=1 tar czf - "${SHIP_EXCLUDES[@]}" . \
        | "${SSH_BASE[@]}" "tar xzf - -C '${REPO_PATH_ON_HOST}'"
fi

# 4. Ship the .env separately (never from the archive above).
ENV_FILE_LOCAL="${ENV_FILE_LOCAL:-.env}"
if [[ -f "${ENV_FILE_LOCAL}" ]]; then
    scp -q -o StrictHostKeyChecking=accept-new \
        "${ENV_FILE_LOCAL}" "${SSH_USER}@${SSH_HOST}:${REPO_PATH_ON_HOST}/.env"
    echo "deploy_compose: shipped ${ENV_FILE_LOCAL} -> ${REPO_PATH_ON_HOST}/.env"
fi

# 5. Run the compose-up script remotely.
REMOTE_RUN="/tmp/compose-deploy-${APP_NAME}.$$.sh"
scp -q -o StrictHostKeyChecking=accept-new \
    "${RENDERED}" "${SSH_USER}@${SSH_HOST}:${REMOTE_RUN}"
ssh -o StrictHostKeyChecking=accept-new "${SSH_USER}@${SSH_HOST}" \
    "bash ${REMOTE_RUN}; rm -f ${REMOTE_RUN}"

echo "deploy_compose: ${APP_NAME} is up on ${SSH_HOST}:${REPO_PATH_ON_HOST}"
