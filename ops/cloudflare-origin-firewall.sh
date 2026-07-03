#!/usr/bin/env bash
# OPTIONAL — only when fronting the origin with Cloudflare's proxy (Option B in
# ops/Caddyfile). Restricts inbound 80/443 to Cloudflare's published IP ranges
# so an attacker who discovers the origin IP cannot bypass Cloudflare's DDoS
# protection by hitting the origin directly. SSH is preserved first so you are
# not locked out.
#
# Re-run after Cloudflare updates its ranges (rare). Requires: ufw, curl.
#
#   sudo bash ops/cloudflare-origin-firewall.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "run as root" >&2; exit 1; fi

echo "Preserving SSH access..."
ufw allow OpenSSH

echo "Fetching Cloudflare IP ranges..."
mapfile -t V4 < <(curl -fsSL https://www.cloudflare.com/ips-v4)
mapfile -t V6 < <(curl -fsSL https://www.cloudflare.com/ips-v6)
if [[ ${#V4[@]} -eq 0 ]]; then echo "failed to fetch CF ranges" >&2; exit 1; fi

echo "Removing any existing broad web rules..."
ufw delete allow 80/tcp  2>/dev/null || true
ufw delete allow 443/tcp 2>/dev/null || true

echo "Allowing 80/443 only from Cloudflare..."
for cidr in "${V4[@]}" "${V6[@]}"; do
  [[ -z "$cidr" ]] && continue
  ufw allow from "$cidr" to any port 80  proto tcp
  ufw allow from "$cidr" to any port 443 proto tcp
done

ufw default deny incoming
ufw default allow outgoing
ufw --force enable
ufw status verbose
echo "Done. Origin now accepts web traffic only from Cloudflare."
