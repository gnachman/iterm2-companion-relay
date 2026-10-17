#!/usr/bin/env bash
# Page George's phone via ~/bin/it2-notify (a real network push), replacing the
# old OSC 9 -> /dev/tty scheme that could never work from Claude's Bash tool
# (subprocesses have no controlling terminal, so the escape reached nothing).
#
# Credentials come from the iTerm2 app's own storage on every call (pushcreds.sh),
# never from a copy. It tries each push relay in turn, and if none delivers it
# emails the page instead (email.sh), so a page is never only a line in a log.
#
# Usage:
#   notify.sh "RELAY DOWN: relay1 unreachable ..."        # 1 arg  -> default title
#   notify.sh "RELAY DOWN" "relay1 unreachable from ..."  # 2 args -> title, body
# Exits 0 when George was reached (by push, or by email after push failed; the
# latter also prints a warning), non-zero when neither worked.
set -uo pipefail

if [ "$#" -ge 2 ]; then
  title="$1"; shift; body="$*"
else
  title="relay-watch"; body="${1:-relay-watch alert}"
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$here/watch.env" ] && { set -a; . "$here/watch.env"; set +a; }
. "$here/pushcreds.sh"
logdir="$here/state"
mkdir -p "$logdir"
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log() { printf '%s %s\n' "$stamp" "$*" >> "$logdir/notify.log"; }

failures=""
if load_push_creds; then
  # Try each push relay in turn, so a page still goes out while push.iterm2.com
  # (mcnachman.cloud) is down, the outage this watcher most needs to report. The
  # relays share registrations, so the phone is reachable through either.
  # NOTIFY_PUSH_URLS (space-separated) overrides the list.
  urls="${NOTIFY_PUSH_URLS:-https://push.iterm2.com https://push2.iterm2.com}"
  for url in $urls; do
    if err="$("$HOME/bin/it2-notify" --url "$url" "$title" "$body" 2>&1)"; then
      log "pushed via $url${failures:+ (after: $failures)}: $title - $body"
      exit 0
    fi
    failures="${failures:+$failures; }$url: $(printf '%s' "$err" | tail -1)"
  done
else
  failures="$PUSH_CREDS_ERROR"
fi

# No relay delivered: email instead, saying why push failed so it gets fixed.
if "$here/email.sh" "$title" "$body

(Sent by email because the phone push failed: $failures)" 2>>"$logdir/notify.log"; then
  log "PUSH FAILED ($failures); emailed instead: $title - $body"
  echo "notify.sh: push failed ($failures); delivered by email instead" >&2
  exit 0
fi
log "PUSH FAILED ($failures) AND EMAIL FAILED: $title - $body"
echo "notify.sh: push failed ($failures) and the email fallback failed too" >&2
exit 1
