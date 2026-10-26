#!/usr/bin/env bash
# Check the paging path without sending anything, so a broken one is noticed
# before the page that matters (the heartbeat runs this every
# WATCH_NOTIFY_CHECK_INTERVAL): the ntfy topic can be loaded, ntfy.sh says it's
# healthy (GET /v1/health, which posts nothing), and the email fallback is
# configured. Prints "ok" or one line per problem; exits 0 / 1.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$here/watch.env" ] && { set -a; . "$here/watch.env"; set +a; }
. "$here/ntfy-topic.sh"

problems=()
load_ntfy_topic || problems+=("phone push: $NTFY_TOPIC_ERROR")
# Retried once, so a one-off blip doesn't send a "broken" and a "fixed" email.
ntfy_healthy() {
  health="$(curl -sS --max-time 10 "${NTFY_BASE_URL:-https://ntfy.sh}/v1/health" 2>&1)"
  case "$health" in *'"healthy":true'*) return 0 ;; esac
  return 1
}
if ! ntfy_healthy && ! { sleep 5; ntfy_healthy; }; then
  problems+=("phone push: ntfy.sh health check failed: $(printf '%s' "$health" | tail -1 | cut -c1-200)")
fi
for k in RESEND_API_KEY ALERT_FROM ALERT_TO; do
  [ -n "${!k:-}" ] || problems+=("email fallback: $k is not set in watch.env")
done

if [ "${#problems[@]}" -eq 0 ]; then echo ok; exit 0; fi
printf '%s\n' "${problems[@]}"
exit 1
