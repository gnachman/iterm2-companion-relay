#!/usr/bin/env bash
# Page George's phone with a real network push, replacing the old OSC 9 ->
# /dev/tty scheme that could never work from Claude's Bash tool (subprocesses
# have no controlling terminal, so the escape reached nothing). On the Mac it
# sends with ~/bin/it2-notify; elsewhere (the Linux mini PC) with push-send.mjs.
#
# Credentials come from pushcreds.sh (the iTerm2 app's own storage on the Mac,
# push.env elsewhere). It tries each push relay in turn, and if none delivers it
# emails the page instead (email.sh), so a page is never only a line in a log.
# A 403 from a relay means the credentials are stale; that is recorded in
# state/push-rejected so check-notify.sh keeps reporting it until it's fixed.
#
# WATCH_SHADOW=1 (watch.env) logs the page with a SHADOW tag and sends nothing,
# so a second watcher can run alongside the live one without double-paging.
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

if [ "${WATCH_SHADOW:-0}" = 1 ]; then
  log "SHADOW (not sent): $title - $body"
  echo "notify.sh: shadow mode (WATCH_SHADOW=1); logged, not sent" >&2
  exit 0
fi

failures=""
rejected=""
send() {
  if [ "$(push_sender)" = it2-notify ]; then
    "$HOME/bin/it2-notify" --url "$1" "$title" "$body"
  else
    node "$here/push-send.mjs" "$1" "$title" "$body"
  fi
}
if load_push_creds; then
  # Try each push relay in turn, so a page still goes out while push.iterm2.com
  # (mcnachman.cloud) is down, the outage this watcher most needs to report. The
  # relays share registrations, so the phone is reachable through either.
  # NOTIFY_PUSH_URLS (space-separated) overrides the list.
  urls="${NOTIFY_PUSH_URLS:-https://push.iterm2.com https://push2.iterm2.com}"
  for url in $urls; do
    if err="$(send "$url" 2>&1)"; then
      log "pushed via $url${failures:+ (after: $failures)}: $title - $body"
      rm -f "$logdir/push-rejected"
      exit 0
    fi
    err="$(printf '%s' "$err" | tail -1)"
    failures="${failures:+$failures; }$url: $err"
    case "$err" in *403*) rejected="$url: $err" ;; esac
  done
  [ -z "$rejected" ] || printf '%s %s\n' "$stamp" "$rejected" > "$logdir/push-rejected"
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
