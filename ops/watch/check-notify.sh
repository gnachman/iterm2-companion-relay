#!/usr/bin/env bash
# Check the paging path without sending anything, so a broken one is noticed
# before the page that matters (the heartbeat runs this every
# WATCH_NOTIFY_CHECK_INTERVAL). Checks what can be checked locally: a sender is
# installed (it2-notify on the Mac, node for push-send.mjs elsewhere), the push
# credentials can be read from this context, the email fallback is configured,
# and the last real page was not rejected by the relays (state/push-rejected,
# written by notify.sh on a 403). (The relays have no credentials-only call:
# /push checks them and then delivers, so verifying them with a relay means a
# visible notification; the last real page is the end-to-end check.) A recorded
# rejection counts as fixed once push.env is newer than it, i.e. refreshed.
# Prints "ok" or one line per problem; exits 0 / 1.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$here/watch.env" ] && { set -a; . "$here/watch.env"; set +a; }
. "$here/pushcreds.sh"

problems=()
if [ "$(push_sender)" = push-send ] && ! command -v node >/dev/null; then
  problems+=("phone push: node is not installed (push-send.mjs needs it)")
fi
load_push_creds || problems+=("phone push: $PUSH_CREDS_ERROR")
marker="$here/state/push-rejected"
if [ -f "$marker" ] && ! { [ "$(push_sender)" = push-send ] && [ "$here/push.env" -nt "$marker" ]; }; then
  problems+=("phone push: the last page was rejected ($(cat "$marker")); the credentials are stale. Copy fresh ones from the Mac (it2-notify --print-secrets) into $here/push.env")
fi
for k in RESEND_API_KEY ALERT_FROM ALERT_TO; do
  [ -n "${!k:-}" ] || problems+=("email fallback: $k is not set in watch.env")
done

if [ "${#problems[@]}" -eq 0 ]; then echo ok; exit 0; fi
printf '%s\n' "${problems[@]}"
exit 1
