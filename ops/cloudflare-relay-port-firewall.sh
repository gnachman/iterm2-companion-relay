#!/usr/bin/env bash
# Lock the relay's Cloudflare-origin port (default 8443) to Cloudflare IP ranges
# ONLY, using targeted iptables rules in a dedicated chain that touch NOTHING
# else — so a co-hosted site on :443 (and SSH, etc.) stays fully open. This is
# the shared-box companion to cloudflare-origin-firewall.sh (which locks 80/443
# for a whole box that sits entirely behind Cloudflare — do NOT use that one
# here, it would black-hole the direct :443 site).
#
# Safe to re-run when Cloudflare rotates its ranges: it flushes and repopulates
# the dedicated chain. Persists across reboots via netfilter-persistent.
#
#   sudo bash ops/cloudflare-relay-port-firewall.sh
#   sudo RELAY_ORIGIN_PORT=8443 bash ops/cloudflare-relay-port-firewall.sh
#
# Requires: iptables, ip6tables, curl. Installs iptables-persistent if absent.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
PORT="${RELAY_ORIGIN_PORT:-8443}"
CHAIN="CF_RELAY_${PORT}"

echo "Fetching Cloudflare IP ranges..."
V4="$(curl -fsSL https://www.cloudflare.com/ips-v4)"
V6="$(curl -fsSL https://www.cloudflare.com/ips-v6)"
[[ -n "$V4" && -n "$V6" ]] || { echo "failed to fetch Cloudflare ranges" >&2; exit 1; }

apply() { # $1 = iptables|ip6tables ; $2 = CIDR list
  local ipt="$1" ranges="$2" cidr
  "$ipt" -N "$CHAIN" 2>/dev/null || "$ipt" -F "$CHAIN"   # create or flush (idempotent)
  "$ipt" -A "$CHAIN" -i lo -j ACCEPT                     # never filter loopback
  for cidr in $ranges; do "$ipt" -A "$CHAIN" -s "$cidr" -j ACCEPT; done
  "$ipt" -A "$CHAIN" -j DROP                             # everyone else on this port
  # Send inbound packets destined for PORT through the chain (add the jump once).
  "$ipt" -C INPUT -p tcp --dport "$PORT" -j "$CHAIN" 2>/dev/null \
    || "$ipt" -A INPUT -p tcp --dport "$PORT" -j "$CHAIN"
}

apply iptables  "$V4"
apply ip6tables "$V6"

if ! command -v netfilter-persistent >/dev/null; then
  echo "Installing iptables-persistent for reboot persistence..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y netfilter-persistent iptables-persistent >/dev/null
fi
netfilter-persistent save

echo
echo "Done. :$PORT now accepts only Cloudflare ($(echo "$V4" | grep -c .) v4 + $(echo "$V6" | grep -c .) v6 ranges); all other ports untouched."
echo "IPv4 chain:"; iptables -S "$CHAIN"
