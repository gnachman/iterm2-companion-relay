#!/usr/bin/env bash
# Fast in-place update: pull the latest app code and restart, nothing else.
# No apt, no Node/Caddy install, no env/unit/Caddy rewrite — use this for a plain
# JavaScript change. For first-time provisioning or a config change, use
# ops/deploy-vps.sh instead. Runs as root (ssh root@host) or as a sudo user.
#
#   bash ops/update-vps.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/iterm2-companion-relay}"
REPO_REF="${REPO_REF:-main}"

# Shim sudo to a passthrough when already root (see ops/deploy-vps.sh).
if [ "$(id -u)" -eq 0 ]; then
  sudo() { while [ "${1:-}" = "-E" ] || [ "${1:-}" = "-H" ] || [ "${1:-}" = "-n" ]; do shift; done; "$@"; }
else
  command -v sudo >/dev/null || { echo "run as root, or install sudo" >&2; exit 1; }
fi

[ -d "${APP_DIR}/.git" ] || { echo "no git checkout at ${APP_DIR}; run ops/deploy-vps.sh first" >&2; exit 1; }

echo "==> Updating ${APP_DIR} to ${REPO_REF}"
before="$(sudo git -C "${APP_DIR}" rev-parse HEAD)"
sudo git -C "${APP_DIR}" fetch --all -q
sudo git -C "${APP_DIR}" checkout -q "${REPO_REF}"
sudo git -C "${APP_DIR}" pull --ff-only -q
after="$(sudo git -C "${APP_DIR}" rev-parse HEAD)"

if [ "$before" = "$after" ]; then
  echo "    already up to date at ${after:0:12}; nothing to do"
  exit 0
fi
echo "    ${before:0:12} -> ${after:0:12}"

# Reinstall production deps only when the lockfile/manifest actually changed.
if sudo git -C "${APP_DIR}" diff --quiet "$before" "$after" -- package-lock.json package.json; then
  echo "==> Dependencies unchanged; skipping npm ci"
else
  echo "==> Dependencies changed; npm ci --omit=dev"
  ( cd "${APP_DIR}" && sudo npm ci --omit=dev )
fi

echo "==> Restarting services"
sudo systemctl restart iterm2-companion-relay
sudo systemctl restart iterm2-relay-dashboard 2>/dev/null || true

echo "==> Verify"
sleep 1
if curl -fsS localhost:8787/metrics >/dev/null 2>&1; then echo "    relay /metrics: OK"; else echo "    relay /metrics: FAILED (journalctl -u iterm2-companion-relay)"; fi
if sudo systemctl is-active --quiet iterm2-relay-dashboard 2>/dev/null; then
  if curl -fsS localhost:8789/healthz >/dev/null 2>&1; then echo "    dashboard /healthz: OK"; else echo "    dashboard /healthz: FAILED (journalctl -u iterm2-relay-dashboard)"; fi
fi
echo "==> Update complete."
