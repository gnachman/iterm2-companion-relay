#!/usr/bin/env bash
# Email George via Resend: the watcher's second channel, independent of the push
# relays. notify.sh uses it when no relay delivers a page, and the heartbeat when
# the paging path itself is broken (check-notify.sh).
#
# Needs RESEND_API_KEY, ALERT_FROM and ALERT_TO in watch.env (the same Resend
# account the fleet monitor uses; ALERT_FROM must be on the verified domain).
#
# Usage: email.sh "subject" "body"
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$here/watch.env" ] && { set -a; . "$here/watch.env"; set +a; }

subject="${1:?usage: email.sh subject body}"
body="${2:-$1}"
for k in RESEND_API_KEY ALERT_FROM ALERT_TO; do
  [ -n "${!k:-}" ] || { echo "email.sh: $k is not set in watch.env" >&2; exit 2; }
done

# Build the JSON with node so any quoting in the text is escaped correctly.
payload="$(SUBJECT="[relay-watch] $subject" BODY="$body" node -e '
  const e = process.env;
  process.stdout.write(JSON.stringify({ from: e.ALERT_FROM, to: [e.ALERT_TO], subject: e.SUBJECT, text: e.BODY }));
')"
status="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://api.resend.com/emails \
  -H "Authorization: Bearer ${RESEND_API_KEY}" -H 'content-type: application/json' \
  --data-binary @- <<<"$payload")" || status="curl-error"
case "$status" in
  2??) exit 0 ;;
  *) echo "email.sh: Resend returned ${status}" >&2; exit 1 ;;
esac
