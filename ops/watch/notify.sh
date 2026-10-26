#!/usr/bin/env bash
# Page George's phone through ntfy.sh: one POST to https://ntfy.sh/<topic>, which
# the ntfy app on his phone subscribes to. It doesn't depend on the iTerm2 push
# relays, so a page still goes out while push.iterm2.com is the thing that's down.
# If ntfy doesn't take it, the page is emailed instead (email.sh), so a page is
# never only a line in a log.
#
# The topic is a secret (ntfy-topic.sh): never put it on a command line you echo,
# in a log, or in git.
#
# Priority (ntfy etiquette: interrupt George only when it matters): a page is
# `high` (breaks through on the phone); pass --low for FYI messages such as
# RECOVERED. One push per event; don't call this per retry.
#
# WATCH_SHADOW=1 (watch.env) logs the page with a SHADOW tag and sends nothing,
# so a second watcher can run alongside the live one without double-paging.
#
# Usage:
#   notify.sh "RELAY DOWN: relay1 unreachable ..."        # 1 arg  -> default title
#   notify.sh "RELAY DOWN" "relay1 unreachable from ..."  # 2 args -> title, body
#   notify.sh --low "RECOVERED" "relay1 reachable again"  # quiet FYI
# Exits 0 when George was reached (by push, or by email after push failed; the
# latter also prints a warning), non-zero when neither worked.
set -uo pipefail

priority=high tags=rotating_light,relay-watch
if [ "${1:-}" = --low ]; then priority=low tags=white_check_mark,relay-watch; shift; fi
if [ "$#" -ge 2 ]; then
  title="$1"; shift; body="$*"
else
  title="relay-watch"; body="${1:-relay-watch alert}"
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$here/watch.env" ] && { set -a; . "$here/watch.env"; set +a; }
. "$here/ntfy-topic.sh"
logdir="$here/state"
mkdir -p "$logdir"
stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log() { printf '%s %s\n' "$stamp" "$*" >> "$logdir/notify.log"; }

if [ "${WATCH_SHADOW:-0}" = 1 ]; then
  log "SHADOW (not sent, $priority): $title - $body"
  echo "notify.sh: shadow mode (WATCH_SHADOW=1); logged, not sent" >&2
  exit 0
fi

# One POST; a second try after 5s only if the first didn't get a 200 (a network
# blip), so George still gets at most one push. curl's error text never
# includes the URL, so the topic stays out of the log.
send() {
  printf '%s' "$body" | curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
    -H "Title: $title" -H "Priority: $priority" -H "Tags: $tags" \
    -H "Click: https://mcnachman.cloud/fleet" \
    --data-binary @- "${NTFY_BASE_URL:-https://ntfy.sh}/$NTFY_TOPIC" 2>&1
}
failure=""
if load_ntfy_topic; then
  for try in 1 2; do
    out="$(send)"
    if [ "$out" = 200 ]; then
      log "pushed via ntfy ($priority)${failure:+ (after: $failure)}: $title - $body"
      exit 0
    fi
    failure="ntfy: $(printf '%s' "$out" | tail -1 | sed 's/^000$/no response/; s/^[0-9][0-9][0-9]$/HTTP &/')"
    [ "$try" = 1 ] && sleep 5
  done
else
  failure="ntfy: $NTFY_TOPIC_ERROR"
fi

# ntfy didn't take it: email instead, saying why the push failed so it gets fixed.
if "$here/email.sh" "$title" "$body

(Sent by email because the phone push failed: $failure)" 2>>"$logdir/notify.log"; then
  log "PUSH FAILED ($failure); emailed instead: $title - $body"
  echo "notify.sh: push failed ($failure); delivered by email instead" >&2
  exit 0
fi
log "PUSH FAILED ($failure) AND EMAIL FAILED: $title - $body"
echo "notify.sh: push failed ($failure) and the email fallback failed too" >&2
exit 1
