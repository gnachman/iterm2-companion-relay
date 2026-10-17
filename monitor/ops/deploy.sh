#!/usr/bin/env bash
# Install or update the relay monitor on a box, from a workstation:
#
#   monitor/ops/deploy.sh <ssh-host> [git-ref]      (ref defaults to HEAD)
#
# Copies the COMMITTED monitor/ (git archive, so uncommitted edits are not
# shipped) to /opt/iterm2-relay-monitor, reusing node_modules when the lockfile
# is unchanged, installs the systemd unit, and restarts the service. It never
# touches /etc/iterm2-relay-monitor.env, which holds the secrets: create that
# once from monitor.env.example (root, mode 640) before the first deploy.
# Needs passwordless sudo on the box, and Node at /usr/bin/node.
set -euo pipefail

host="${1:?usage: $0 <ssh-host> [git-ref]}"
ref="${2:-HEAD}"
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
tarball="/tmp/iterm2-relay-monitor-$$.tar"

echo "==> Sending monitor/ at $(git -C "$root" rev-parse --short "$ref") to ${host}"
git -C "$root" archive --format=tar "$ref" monitor | ssh "$host" "cat > ${tarball}"

ssh "$host" "TARBALL=${tarball} bash -s" <<'REMOTE'
set -euo pipefail
dir=/opt/iterm2-relay-monitor
work="$(mktemp -d)"
trap 'rm -rf "$work" "$TARBALL"' EXIT
tar -xf "$TARBALL" -C "$work"
new="$work/monitor"

if sudo test -d "$dir/node_modules" && sudo cmp -s "$dir/package-lock.json" "$new/package-lock.json"; then
  echo "==> Lockfile unchanged, keeping node_modules"
  sudo cp -a "$dir/node_modules" "$new/"
else
  echo "==> Installing dependencies"
  (cd "$new" && npm ci --omit=dev --no-audit --no-fund)
fi

# Keep the existing owner (mcnachman.cloud's copy is owned by its login user);
# a fresh install is root's.
owner="root:root"
if sudo test -d "$dir"; then owner="$(sudo stat -c %U:%G "$dir")"; fi
sudo chown -R "$owner" "$new"
sudo rm -rf "$dir.old"
if sudo test -d "$dir"; then sudo mv "$dir" "$dir.old"; fi
sudo mv "$new" "$dir"
sudo chmod 755 "$dir"

sudo install -m 0644 "$dir/ops/iterm2-relay-monitor.service" /etc/systemd/system/iterm2-relay-monitor.service
sudo systemctl daemon-reload
if ! sudo test -f /etc/iterm2-relay-monitor.env; then
  echo "!! /etc/iterm2-relay-monitor.env is missing; create it, then:"
  echo "   sudo systemctl enable --now iterm2-relay-monitor"
  exit 1
fi
sudo systemctl enable iterm2-relay-monitor
sudo systemctl restart iterm2-relay-monitor
sleep 2
sudo systemctl is-active iterm2-relay-monitor
sudo journalctl -u iterm2-relay-monitor -n 8 --no-pager -o cat
REMOTE
