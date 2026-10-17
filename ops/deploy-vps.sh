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
# Sharding (distributed mode). Blank RELAY_SHARDMAP_URL = direct mode (default).
RELAY_SHARDMAP_URL="${RELAY_SHARDMAP_URL:-}"
RELAY_SELF_HOST="${RELAY_SELF_HOST:-}"
RELAY_SHARDMAP_POLL_MS="${RELAY_SHARDMAP_POLL_MS:-}"
RELAY_DRAIN_DELAY_MS="${RELAY_DRAIN_DELAY_MS:-}"
RELAY_EVICTION_RATE="${RELAY_EVICTION_RATE:-}"
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

# ── Sharding config validation (fail fast HERE, not as a crash-looping unit) ──
# The relay refuses to boot on any of these misconfigurations; catching them at
# deploy time turns a systemd crash loop into an immediate, explained error.
if [ -n "$RELAY_SHARDMAP_URL" ]; then
  # The box's map identity must byte-equal its origin host (TLS cert name, map
  # `host` field, and proof-origin base are all the same string; design §6.10).
  # The deploy already knows that string, so default RELAY_SELF_HOST to it and
  # reject a divergent override: with a wrong selfHost the box either refuses to
  # boot (origin mismatch) or, worse, boots owning zero buckets and 421s all
  # traffic.
  RELAY_SELF_HOST="${RELAY_SELF_HOST:-$RELAY_ORIGIN_HOST}"
  if [ "$RELAY_SELF_HOST" != "$RELAY_ORIGIN_HOST" ]; then
    echo "RELAY_SELF_HOST (${RELAY_SELF_HOST}) must equal RELAY_ORIGIN_HOST (${RELAY_ORIGIN_HOST});" >&2
    echo "leave RELAY_SELF_HOST blank to derive it." >&2
    exit 1
  fi
  # §7.4: the drain defer must cover two poll intervals.
  poll_ms="${RELAY_SHARDMAP_POLL_MS:-10000}"
  drain_ms="${RELAY_DRAIN_DELAY_MS:-20000}"
  if [ "$drain_ms" -lt $((2 * poll_ms)) ]; then
    echo "RELAY_DRAIN_DELAY_MS (${drain_ms}) must be >= 2x RELAY_SHARDMAP_POLL_MS (${poll_ms})." >&2
    exit 1
  fi
elif [ -n "$RELAY_SELF_HOST" ]; then
  echo "RELAY_SELF_HOST is set but RELAY_SHARDMAP_URL is not: set both (distributed mode)" >&2
  echo "or neither (direct mode). The relay refuses to boot with exactly one." >&2
  exit 1
fi

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

if [ -n "$RELAY_SHARDMAP_URL" ]; then
  echo "==> Deploying relay for ${RELAY_ORIGIN} into ${APP_DIR} (distributed mode, map: ${RELAY_SHARDMAP_URL})"
else
  echo "==> Deploying relay for ${RELAY_ORIGIN} into ${APP_DIR} (direct mode)"
fi
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
if [ -n "$RELAY_SHARDMAP_URL" ]; then
  relay_env+="
RELAY_SHARDMAP_URL=${RELAY_SHARDMAP_URL}
RELAY_SELF_HOST=${RELAY_SELF_HOST}"
  if [ -n "$RELAY_SHARDMAP_POLL_MS" ]; then relay_env+=$'\n'"RELAY_SHARDMAP_POLL_MS=${RELAY_SHARDMAP_POLL_MS}"; fi
  if [ -n "$RELAY_DRAIN_DELAY_MS" ]; then relay_env+=$'\n'"RELAY_DRAIN_DELAY_MS=${RELAY_DRAIN_DELAY_MS}"; fi
  if [ -n "$RELAY_EVICTION_RATE" ]; then relay_env+=$'\n'"RELAY_EVICTION_RATE=${RELAY_EVICTION_RATE}"; fi
fi
printf '%s\n' "$relay_env" | sudo tee /etc/iterm2-companion-relay.env >/dev/null
sudo chmod 600 /etc/iterm2-companion-relay.env

echo "==> Installing relay systemd unit${RELAY_SERVICE_USER:+ (User=${RELAY_SERVICE_USER})}"
render_unit "${APP_DIR}/ops/iterm2-companion-relay.service" "$RELAY_SERVICE_USER" \
  | sudo tee /etc/systemd/system/iterm2-companion-relay.service >/dev/null
sudo systemctl daemon-reload
# enable + restart, not `enable --now`: --now only starts a STOPPED unit, so a
# re-deploy onto a live box would leave the old process running with the old
# code and env. restart covers both cases (it starts a stopped unit too).
sudo systemctl enable iterm2-companion-relay
sudo systemctl restart iterm2-companion-relay

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
  sudo systemctl enable iterm2-relay-dashboard
  sudo systemctl restart iterm2-relay-dashboard
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
# Other sites on this box (e.g. a push relay instance) go in their own files in
# /etc/caddy/sites.d/, which the generated Caddyfile imports, so rewriting the
# Caddyfile here never erases them. A glob that matches nothing is fine.
# Extra routes on THIS site (e.g. an authenticated /metrics for a pulling
# monitor, or a mirror monitor's /fleet) go in /etc/caddy/relay.d/*.caddy, which
# is imported inside the site block below and likewise survives a redeploy.
sudo install -d -m 0755 /etc/caddy/sites.d /etc/caddy/relay.d
echo "==> Writing /etc/caddy/Caddyfile"
printf '%s\n' "# iTerm2 companion relay (Option A: Caddy-managed TLS). Managed by
# ops/deploy-vps.sh. Access logging is discarded to preserve the relay's
# zero-retention posture.
${RELAY_ORIGIN_HOST} {
${dash_block}
    # Extra routes for this site, one snippet each (not managed by this script).
    # A path-matched handle here wins over the catch-all below.
    import /etc/caddy/relay.d/*.caddy

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
}

# Other sites on this box, one file each (not managed by this script).
import /etc/caddy/sites.d/*.caddy" | sudo tee /etc/caddy/Caddyfile >/dev/null
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
if [ -n "$RELAY_SHARDMAP_URL" ]; then
  echo "  sharding:  distributed mode (map: ${RELAY_SHARDMAP_URL})"
  echo "             this host serves only buckets the map assigns to ${RELAY_SELF_HOST};"
  echo "             check: curl -s localhost:8787/metrics | grep shard_"
fi
if is_true "$ENABLE_DASHBOARD"; then
  echo "  dashboard: https://${RELAY_ORIGIN_HOST}/dashboard/"
  echo "             login: ${DASHBOARD_USER} / ${DASHBOARD_PASSWORD}"
fi
echo
echo "  NEXT: point DNS  ${RELAY_ORIGIN_HOST}  ->  this host's public IP."
echo "        Caddy then issues a Let's Encrypt cert automatically (ports 80+443"
echo "        must be internet-reachable). TLS will not issue until DNS resolves."
echo "────────────────────────────────────────────────────────────────────"
