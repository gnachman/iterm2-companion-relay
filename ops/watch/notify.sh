#!/usr/bin/env bash
# Page George's phone via ~/bin/it2-notify (a real network push), replacing the
# old OSC 9 -> /dev/tty scheme that could never work from Claude's Bash tool
# (subprocesses have no controlling terminal, so the escape reached nothing).
#
# it2-notify needs ITERM_PUSH_SECRET and ITERM_PUSH_TOKEN in the environment.
# The watcher session exports them by sourcing watch.env in launch-claude.sh /
# launch-beat.sh / run.sh, so every subprocess (this script, the heartbeat, and
# Claude's Bash tool) inherits them with no tty required. If you run this by hand
# outside the session, source watch.env first: `set -a; . ./watch.env; set +a`.
#
# Usage:
#   notify.sh "RELAY DOWN: relay1 unreachable ..."        # 1 arg  -> default title
#   notify.sh "RELAY DOWN" "relay1 unreachable from ..."  # 2 args -> title, body
set -euo pipefail

if [ "$#" -ge 2 ]; then
  title="$1"; shift; body="$*"
else
  title="relay-watch"; body="${1:-relay-watch alert}"
fi

# Always re-read watch.env when it exists, even inside the watcher session (which
# exported it at startup): after the phone is re-paired and watch.env updated,
# the session's copy is stale, and every relay answers 403 "bad secret".
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$here/watch.env" ] && { set -a; . "$here/watch.env"; set +a; }

logdir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/state"
mkdir -p "$logdir"
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ -z "${ITERM_PUSH_TOKEN:-}" ] || [ -z "${ITERM_PUSH_SECRET:-}" ]; then
  # No credentials: never lose the message. Record it and surface on stderr so
  # the email backstop / logs still carry the page.
  printf '%s NOTIFY (no push creds): %s - %s\n' "$stamp" "$title" "$body" | tee -a "$logdir/notify.log" >&2
  exit 1
fi

# Try each push relay in turn, so a page still goes out while push.iterm2.com
# (mcnachman.cloud) is down, the outage this watcher most needs to report. The
# relays share registrations, so the phone is reachable through either.
# NOTIFY_PUSH_URLS (space-separated) overrides the list.
urls="${NOTIFY_PUSH_URLS:-https://push.iterm2.com https://push2.iterm2.com}"
failures=""
rc=1
for url in $urls; do
  if "$HOME/bin/it2-notify" --url "$url" "$title" "$body"; then
    printf '%s pushed via %s%s: %s - %s\n' "$stamp" "$url" "${failures:+ (after: $failures)}" "$title" "$body" >> "$logdir/notify.log"
    exit 0
  else
    rc=$?
    failures="${failures:+$failures, }$url rc=$rc"
  fi
done
printf '%s PUSH FAILED (%s): %s - %s\n' "$stamp" "$failures" "$title" "$body" | tee -a "$logdir/notify.log" >&2
exit "$rc"
