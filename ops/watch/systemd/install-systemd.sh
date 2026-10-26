#!/usr/bin/env bash
# Install and start the watcher's systemd user timer (Linux). Idempotent.
# Renders @WATCH_DIR@ to this checkout's ops/watch, so run it from the checkout
# the watcher should run from.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
watch_dir="$(cd "$here/.." && pwd)"
dest="$HOME/.config/systemd/user"
mkdir -p "$dest" "$watch_dir/state"
for f in relay-watch.service relay-watch.timer; do
  sed "s|@WATCH_DIR@|$watch_dir|g" "$here/$f" > "$dest/$f"
done
systemctl --user daemon-reload
systemctl --user enable --now relay-watch.timer
[ "$(loginctl show-user "$USER" -p Linger --value)" = yes ] \
  || echo "warning: linger is off; the watcher stops when you log out (sudo loginctl enable-linger $USER)" >&2
systemctl --user list-timers relay-watch.timer --no-pager
