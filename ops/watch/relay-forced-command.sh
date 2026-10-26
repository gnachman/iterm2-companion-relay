#!/usr/bin/env bash
# Installed ON EACH RELAY BOX (not run by the watcher): the forced command for
# the watcher's dedicated ssh key, so that key can run only the fixed read-only
# commands probe-relay.sh sends, whatever the client asks for. This moves the
# restriction from the client (probe-relay.sh + the watcher's deny list) to the
# server, where a stolen key or a modified client can't get around it.
#
# Install (as the relay's login user, e.g. gnachman):
#   install -m 755 relay-forced-command.sh ~/bin/relay-watch-forced-command
#   and add ONE line to ~/.ssh/authorized_keys:
#   command="/home/gnachman/bin/relay-watch-forced-command",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc ssh-ed25519 AAAA... relay-watch@minipc
#
# Every allowed request matches one of the patterns below in FULL. The quoted
# values' charset has no quote, backslash, or shell metacharacter, so a matching
# string can only pass data to journalctl/curl/systemctl. Keep these in step
# with the templates in probe-relay.sh.
set -uo pipefail
cmd="${SSH_ORIGINAL_COMMAND:-}"

unit="'(iterm2-companion-relay|iterm2-relay-dashboard)\.service'"
ts="'[A-Za-z0-9:._+ -]+'"
journal="^sudo journalctl -u $unit --utc --no-pager( --since $ts)?( --until $ts)?( -n '[0-9]+')?\$"
metrics="^curl -sS --max-time 10 'http://localhost:[0-9]+/metrics'\$"
status="^systemctl show $unit -p ActiveState -p SubState -p ActiveEnterTimestamp -p NRestarts -p MainPID -p ExecMainStartTimestamp -p NRestarts; echo '---'; systemctl status $unit --no-pager -n 0 \|\| true\$"

if [[ "$cmd" =~ $journal || "$cmd" =~ $metrics || "$cmd" =~ $status ]]; then
  exec bash -c "$cmd"
fi
logger -t relay-watch-forced-command "rejected: ${cmd:0:200}" 2>/dev/null || true
echo "relay-watch key: command not allowed" >&2
exit 1
