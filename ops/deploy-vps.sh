#!/usr/bin/env bash
# Provision + deploy the iTerm2 companion relay (and optional dashboard) on a
# fresh Ubuntu/Debian VPS. Idempotent and safe to re-run — also the upgrade path.
#
# Reads config from a deploy.env file (see ops/deploy.env.example) or from the
# environment. Run it as a normal user WITH sudo rights; it calls sudo for the
# privileged steps itself:
#
#   cp ops/deploy.env.example ops/deploy.env && $EDITOR ops/deploy.env
#   bash ops/deploy-vps.sh ops/deploy.env
#
# By default the relay and dashboard run as locked-down systemd DynamicUsers
# (dedicated, NOT the invoking user); set RELAY_SERVICE_USER / DASHBOARD_SERVICE_USER
# to run as fixed named accounts instead. The /opt checkout is owned by root.
set -euo pipefail

# ── Load config ───────────────────────────────────────────────────────────────
CFG="${1:-${DEPLOY_ENV:-}}"
if [ -n "$CFG" ]; then
  [ -f "$CFG" ] || { echo "config file not found: $CFG" >&2; exit 1; }
  set -a; . "$CFG"; set +a
fi

: "${RELAY_ORIGIN_HOST:?set RELAY_ORIGIN_HOST (e.g. relay1.iterm2.com) via deploy.env or the environment}"
APP_ID="${APP_ID:-H7V7XYVQ7D.com.googlecode.iterm2.companion}"
APPATTEST_ENV="${APPATTEST_ENV:-production}"
ATTEST_REQUIRED="${ATTEST_REQUIRED:-true}"
RELAY_DAILY_BYTE_QUOTA="${RELAY_DAILY_BYTE_QUOTA:-8589934592}"
ENABLE_DASHBOARD="${ENABLE_DASHBOARD:-true}"
DASHBOARD_USER="${DASHBOARD_USER:-admin}"
DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-}"
RELAY_METRICS_PUSH_URL="${RELAY_METRICS_PUSH_URL:-}"
RELAY_METRICS_PUSH_TOKEN="${RELAY_METRICS_PUSH_TOKEN:-}"
REPO_URL="${REPO_URL:-https://github.com/gnachman/iterm2-companion-relay}"
REPO_REF="${REPO_REF:-main}"
SRC_DIR="${SRC_DIR:-}"
APP_DIR="${APP_DIR:-/opt/iterm2-companion-relay}"
INSTALL_NODE="${INSTALL_NODE:-true}"
INSTALL_CADDY="${INSTALL_CADDY:-true}"
# Fixed system account for each service to run as. Blank = keep the unit's
# DynamicUser (a dedicated, systemd-managed ephemeral account). Set a name to run
# as a stable, named system user instead (created here; unit rewritten to User=).
RELAY_SERVICE_USER="${RELAY_SERVICE_USER:-}"
DASHBOARD_SERVICE_USER="${DASHBOARD_SERVICE_USER:-}"

RELAY_ORIGIN="https://${RELAY_ORIGIN_HOST}"
is_true() { case "${1,,}" in true|yes|1|on) return 0;; *) return 1;; esac; }

# Ensure a locked-down system account exists (no login, no home).
ensure_user() {
  id -u "$1" >/dev/null 2>&1 \
    || sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$1"
}

# Emit a unit to stdout, replacing DynamicUser=yes with User=/Group=<name> when a
# fixed service user is given; otherwise pass the unit through unchanged.
render_unit() {  # <unit-file> <service-user-or-empty>
  if [ -n "$2" ]; then
    ensure_user "$2"
    sed "s/^DynamicUser=yes.*/User=$2\nGroup=$2/" "$1"
  else
    cat "$1"
  fi
}

echo "==> Deploying relay for ${RELAY_ORIGIN} into ${APP_DIR}"
if [ "$(id -u)" -eq 0 ]; then
  # Already root (e.g. `ssh root@host` / ops/deploy-remote.sh): shim `sudo` to a
  # passthrough that drops its own flags, so every sudo-based step below runs
  # unchanged without needing the sudo binary installed.
  sudo() { while [ "${1:-}" = "-E" ] || [ "${1:-}" = "-H" ] || [ "${1:-}" = "-n" ]; do shift; done; "$@"; }
else
  command -v sudo >/dev/null || { echo "run as root, or install sudo" >&2; exit 1; }
  sudo -v   # cache credentials up front
fi

# ── Packages ──────────────────────────────────────────────────────────────────
if is_true "$INSTALL_NODE" || is_true "$INSTALL_CADDY"; then
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl gnupg openssl git build-essential python3
fi

if is_true "$INSTALL_NODE"; then
  echo "==> Installing Node.js 20 LTS (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
command -v node >/dev/null && echo "    node $(node -v), npm $(npm -v)"

if is_true "$INSTALL_CADDY"; then
  echo "==> Installing Caddy"
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

# ── Deploy source to APP_DIR (root-owned) ─────────────────────────────────────
echo "==> Deploying source to ${APP_DIR}"
if [ -d "${APP_DIR}/.git" ]; then
  sudo git -C "${APP_DIR}" fetch --all -q
  sudo git -C "${APP_DIR}" checkout -q "$REPO_REF"
  sudo git -C "${APP_DIR}" pull --ff-only -q || true
elif [ -n "$SRC_DIR" ]; then
  sudo git clone -q "$SRC_DIR" "${APP_DIR}"
  sudo git -C "${APP_DIR}" remote set-url origin "$REPO_URL" || true
else
  sudo git clone -q --branch "$REPO_REF" "$REPO_URL" "${APP_DIR}"
fi
sudo chown -R root:root "${APP_DIR}"

echo "==> Installing production deps (npm ci --omit=dev)"
( cd "${APP_DIR}" && sudo npm ci --omit=dev )

# ── Relay env + service ───────────────────────────────────────────────────────
echo "==> Writing /etc/iterm2-companion-relay.env"
relay_env="RELAY_HOST=127.0.0.1
RELAY_PORT=8787
RELAY_DB=/var/lib/iterm2-companion-relay/relay.db
ATTEST_REQUIRED=${ATTEST_REQUIRED}
APP_ID=${APP_ID}
APPATTEST_ENV=${APPATTEST_ENV}
RELAY_ORIGIN=${RELAY_ORIGIN}
RELAY_ESTABLISHED_IDLE_TTL_MS=2592000000
RELAY_DAILY_BYTE_QUOTA=${RELAY_DAILY_BYTE_QUOTA}
RELAY_LOG=false
RELAY_TRUST_PROXY=true
RELAY_METRICS_PUSH_MS=240000"
if [ -n "$RELAY_METRICS_PUSH_URL" ] && [ -n "$RELAY_METRICS_PUSH_TOKEN" ]; then
  relay_env+="
RELAY_METRICS_PUSH_URL=${RELAY_METRICS_PUSH_URL}
RELAY_METRICS_PUSH_TOKEN=${RELAY_METRICS_PUSH_TOKEN}"
fi
printf '%s\n' "$relay_env" | sudo tee /etc/iterm2-companion-relay.env >/dev/null
sudo chmod 600 /etc/iterm2-companion-relay.env

echo "==> Installing relay systemd unit${RELAY_SERVICE_USER:+ (User=${RELAY_SERVICE_USER})}"
render_unit "${APP_DIR}/ops/iterm2-companion-relay.service" "$RELAY_SERVICE_USER" \
  | sudo tee /etc/systemd/system/iterm2-companion-relay.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now iterm2-companion-relay

# ── Dashboard env + service (optional) ────────────────────────────────────────
if is_true "$ENABLE_DASHBOARD"; then
  if [ -z "$DASHBOARD_PASSWORD" ]; then
    # Reuse an existing password across re-runs; only generate on first deploy.
    if sudo test -f /etc/iterm2-relay-dashboard.env; then
      DASHBOARD_PASSWORD="$(sudo sed -n 's/^DASHBOARD_PASSWORD=//p' /etc/iterm2-relay-dashboard.env)"
    fi
    [ -n "$DASHBOARD_PASSWORD" ] || DASHBOARD_PASSWORD="$(openssl rand -base64 24)"
  fi
  echo "==> Writing /etc/iterm2-relay-dashboard.env"
  printf '%s\n' "DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=8789
DASHBOARD_USER=${DASHBOARD_USER}
DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD}
DASHBOARD_DB=/var/lib/iterm2-relay-dashboard/dashboard.db
DASHBOARD_METRICS_URL=http://127.0.0.1:8787/metrics
DASHBOARD_PUSH_METRICS_URL=
DASHBOARD_SCRAPE_MS=30000
DASHBOARD_RETENTION_DAYS=90
RELAY_MAX_TOTAL_SOCKETS=200000
RELAY_MAX_ROOMS=200000" | sudo tee /etc/iterm2-relay-dashboard.env >/dev/null
  sudo chmod 600 /etc/iterm2-relay-dashboard.env

  echo "==> Installing dashboard systemd unit${DASHBOARD_SERVICE_USER:+ (User=${DASHBOARD_SERVICE_USER})}"
  # The shipped unit orders After= a legacy service name; rewrite it to ours,
  # then apply the optional fixed service user.
  dash_unit_tmp="$(mktemp)"
  sed 's/iterm2-companion-relay-cf\.service/iterm2-companion-relay.service/' \
    "${APP_DIR}/ops/iterm2-relay-dashboard.service" > "$dash_unit_tmp"
  render_unit "$dash_unit_tmp" "$DASHBOARD_SERVICE_USER" \
    | sudo tee /etc/systemd/system/iterm2-relay-dashboard.service >/dev/null
  rm -f "$dash_unit_tmp"
  sudo systemctl daemon-reload
  sudo systemctl enable --now iterm2-relay-dashboard
fi

# ── Caddy site ────────────────────────────────────────────────────────────────
if is_true "$ENABLE_DASHBOARD"; then
  dash_block="
    # Dashboard at /dashboard/. The page uses relative URLs, so redirect the bare
    # path to the canonical trailing slash. A NAMED matcher is required: 'redir
    # /dashboard/ 308' would read the leading-slash '/dashboard/' as an inline
    # path matcher (not the destination), so the redirect would never fire.
    @dashboard_bare path /dashboard
    redir @dashboard_bare /dashboard/ 308
    handle_path /dashboard/* {
        reverse_proxy 127.0.0.1:8789
    }
"
else
  dash_block=""
fi
echo "==> Writing /etc/caddy/Caddyfile"
printf '%s\n' "# iTerm2 companion relay (Option A: Caddy-managed TLS). Managed by
# ops/deploy-vps.sh. Access logging is discarded to preserve the relay's
# zero-retention posture.
${RELAY_ORIGIN_HOST} {
${dash_block}
    # WebSocket upgrades + /attest -> the relay. XFF is forced to the real peer
    # so per-IP limits cannot be spoofed; any client CF-Connecting-IP is stripped.
    handle {
        reverse_proxy 127.0.0.1:8787 {
            header_up X-Forwarded-For {remote_host}
            header_up -CF-Connecting-IP
        }
    }

    log {
        output discard
    }
}" | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy || sudo systemctl restart caddy

# ── Verify (loopback) ─────────────────────────────────────────────────────────
echo "==> Verifying"
sleep 1
if curl -fsS localhost:8787/metrics >/dev/null 2>&1; then echo "    relay /metrics: OK"; else echo "    relay /metrics: FAILED (journalctl -u iterm2-companion-relay)"; fi
if is_true "$ENABLE_DASHBOARD"; then
  if curl -fsS localhost:8789/healthz >/dev/null 2>&1; then echo "    dashboard /healthz: OK"; else echo "    dashboard /healthz: FAILED (journalctl -u iterm2-relay-dashboard)"; fi
fi

echo
echo "────────────────────────────────────────────────────────────────────"
echo "Deploy complete: ${RELAY_ORIGIN}"
echo "  relay:     sudo systemctl status iterm2-companion-relay"
if is_true "$ENABLE_DASHBOARD"; then
  echo "  dashboard: https://${RELAY_ORIGIN_HOST}/dashboard/"
  echo "             login: ${DASHBOARD_USER} / ${DASHBOARD_PASSWORD}"
fi
echo
echo "  NEXT: point DNS  ${RELAY_ORIGIN_HOST}  ->  this host's public IP."
echo "        Caddy then issues a Let's Encrypt cert automatically (ports 80+443"
echo "        must be internet-reachable). TLS will not issue until DNS resolves."
echo "────────────────────────────────────────────────────────────────────"
