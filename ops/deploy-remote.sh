#!/usr/bin/env bash
# One-command remote deploy, run from your Mac (or any workstation).
#
#   ops/deploy-remote.sh <host> [path/to/deploy.env]
#   ops/deploy-remote.sh relay1.iterm2.com
#   ops/deploy-remote.sh relay1.iterm2.com ops/deploy.env
#
# Connects to root@<host> over SSH, copies ops/deploy-vps.sh and your local
# (secret-bearing) deploy.env to the box, runs the deploy as root, then shreds
# the copied env. The relay app itself is cloned ON the host from REPO_URL@REPO_REF
# in deploy.env (default: GitHub main) — so push your changes before deploying.
#
# Env overrides: SSH_USER (default root), SSH_PORT (default 22).
set -euo pipefail

HOST="${1:?usage: deploy-remote.sh <host> [path/to/deploy.env]}"
ENV_FILE="${2:-ops/deploy.env}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
TARGET="${SSH_USER}@${HOST}"
REMOTE_DIR="/root/.iterm2-relay-deploy"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SH="${SCRIPT_DIR}/deploy-vps.sh"
[ -f "$DEPLOY_SH" ] || { echo "missing deploy script: $DEPLOY_SH" >&2; exit 1; }
[ -f "$ENV_FILE" ]  || { echo "env file not found: $ENV_FILE"$'\n'"  cp ops/deploy.env.example ops/deploy.env  and fill in the secrets" >&2; exit 1; }

# Multiplex all SSH/scp over one authenticated connection (one prompt at most).
CTL="$(mktemp -u "${TMPDIR:-/tmp}/iterm2-relay-ssh.XXXXXX")"
SSH_BASE=(-p "$SSH_PORT" -o ControlMaster=auto -o ControlPath="$CTL" -o ControlPersist=120)
cleanup() { ssh "${SSH_BASE[@]}" -O exit "$TARGET" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> Target ${TARGET}:${SSH_PORT}   env ${ENV_FILE}"

echo "==> Copying deploy script + env to ${REMOTE_DIR}"
ssh "${SSH_BASE[@]}" "$TARGET" "mkdir -p '${REMOTE_DIR}' && chmod 700 '${REMOTE_DIR}'"
# scp shares the master connection; -P is scp's port flag but ControlPath makes it moot.
scp "${SSH_BASE[@]}" -q "$DEPLOY_SH" "${TARGET}:${REMOTE_DIR}/deploy-vps.sh"
scp "${SSH_BASE[@]}" -q "$ENV_FILE"  "${TARGET}:${REMOTE_DIR}/deploy.env"

echo "==> Running deploy on ${HOST} as ${SSH_USER}"
# -t: stream output live. The copied env is shredded even if the deploy fails,
# and the deploy's exit code is propagated back so this script's status is honest.
ssh -t "${SSH_BASE[@]}" "$TARGET" \
  "cd '${REMOTE_DIR}' && bash deploy-vps.sh deploy.env; rc=\$?; { command -v shred >/dev/null && shred -u deploy.env; } 2>/dev/null || rm -f deploy.env; exit \$rc"

echo "==> Remote deploy finished OK."
