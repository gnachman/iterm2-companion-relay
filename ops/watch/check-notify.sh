#!/usr/bin/env bash
# Check the paging path without sending anything, so a broken one is noticed
# before the page that matters (the heartbeat runs this every
# WATCH_NOTIFY_CHECK_INTERVAL). Checks what can be checked locally: it2-notify is
# installed, the app's stored push credentials can be read from this context, and
# the email fallback is configured. (The relays have no credentials-only call:
# /push checks them and then delivers, so verifying them with a relay means a
# visible notification.) Prints "ok" or one line per problem; exits 0 / 1.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$here/watch.env" ] && { set -a; . "$here/watch.env"; set +a; }
. "$here/pushcreds.sh"

problems=()
load_push_creds || problems+=("phone push: $PUSH_CREDS_ERROR")
for k in RESEND_API_KEY ALERT_FROM ALERT_TO; do
  [ -n "${!k:-}" ] || problems+=("email fallback: $k is not set in watch.env")
done

if [ "${#problems[@]}" -eq 0 ]; then echo ok; exit 0; fi
printf '%s\n' "${problems[@]}"
exit 1
