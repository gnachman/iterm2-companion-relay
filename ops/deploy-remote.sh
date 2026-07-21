#!/usr/bin/env bash
# One-command remote deploy/update, run from your Mac (or any workstation).
#
#   ops/deploy-remote.sh <host> [path/to/deploy.env]   # full deploy / provision
#   ops/deploy-remote.sh <host> --update               # fast in-place code update
#
#   ops/deploy-remote.sh relay1.iterm2.com
#   ops/deploy-remote.sh relay1.iterm2.com --update
#
# Connects to root@<host> over SSH.
#  - full deploy: copies ops/deploy-vps.sh + your local (secret-bearing)
#    deploy.env, runs the deploy as root, then shreds the copied env.
#  - --update: copies ops/update-vps.sh and runs it (git pull + npm ci if the
#    lockfile changed + restart). No secrets needed, so no deploy.env is sent.
#
# In both cases the app code is pulled ON the host from GitHub (REPO_REF, default
# main) — so push your changes first. Env overrides: SSH_USER (root), SSH_PORT (22).
set -euo pipefail

MODE=deploy
POS=()
for a in "$@"; do
  case "$a" in
    --update) MODE=update ;;
    --deploy) MODE=deploy ;;
    -*) echo "unknown option: $a" >&2; exit 1 ;;
    *) POS+=("$a") ;;
  esac
done

HOST="${POS[0]:?usage: deploy-remote.sh <host> [path/to/deploy.env] [--update]}"
ENV_FILE="${POS[1]:-ops/deploy.env}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
TARGET="${SSH_USER}@${HOST}"
REMOTE_DIR="/root/.iterm2-relay-deploy"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Multiplex all SSH/scp over one authenticated connection (one prompt at most).
CTL="$(mktemp -u "${TMPDIR:-/tmp}/iterm2-relay-ssh.XXXXXX")"
# Use -o Port= (not -p): ssh's port flag is -p but scp's is -P, whereas -o Port=
# is accepted by both.
SSH_BASE=(-o Port="$SSH_PORT" -o ControlMaster=auto -o ControlPath="$CTL" -o ControlPersist=120)
cleanup() { ssh "${SSH_BASE[@]}" -O exit "$TARGET" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> ${MODE} on ${TARGET}:${SSH_PORT}"
ssh "${SSH_BASE[@]}" "$TARGET" "mkdir -p '${REMOTE_DIR}' && chmod 700 '${REMOTE_DIR}'"

if [ "$MODE" = update ]; then
  UPDATE_SH="${SCRIPT_DIR}/update-vps.sh"
  [ -f "$UPDATE_SH" ] || { echo "missing update script: $UPDATE_SH" >&2; exit 1; }
  echo "==> Copying update script"
  scp "${SSH_BASE[@]}" -q "$UPDATE_SH" "${TARGET}:${REMOTE_DIR}/update-vps.sh"
  echo "==> Running update on ${HOST}"
  ssh -t "${SSH_BASE[@]}" "$TARGET" "bash '${REMOTE_DIR}/update-vps.sh'"
  echo "==> Remote update finished OK."
else
  DEPLOY_SH="${SCRIPT_DIR}/deploy-vps.sh"
  [ -f "$DEPLOY_SH" ] || { echo "missing deploy script: $DEPLOY_SH" >&2; exit 1; }
  [ -f "$ENV_FILE" ]  || { echo "env file not found: $ENV_FILE"$'\n'"  cp ops/deploy.env.example ops/deploy.env  and fill in the secrets" >&2; exit 1; }
  echo "==> Copying deploy script + env (${ENV_FILE})"
  scp "${SSH_BASE[@]}" -q "$DEPLOY_SH" "${TARGET}:${REMOTE_DIR}/deploy-vps.sh"
  scp "${SSH_BASE[@]}" -q "$ENV_FILE"  "${TARGET}:${REMOTE_DIR}/deploy.env"
  echo "==> Running deploy on ${HOST}"
  # -t: stream output live. The copied env is shredded even if the deploy fails,
  # and the deploy's exit code is propagated back so this script's status is honest.
  ssh -t "${SSH_BASE[@]}" "$TARGET" \
    "cd '${REMOTE_DIR}' && bash deploy-vps.sh deploy.env; rc=\$?; { command -v shred >/dev/null && shred -u deploy.env; } 2>/dev/null || rm -f deploy.env; exit \$rc"
  echo "==> Remote deploy finished OK."
fi
