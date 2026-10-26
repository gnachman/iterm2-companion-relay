# Sourced by notify.sh and check-notify.sh: load the ntfy.sh topic George's
# phone subscribes to. Anyone who knows the topic can post to it or read it, so
# it is a secret: it lives outside git in NTFY_ENV_FILE (default
# /etc/lalia/ntfy.env, mode 600, one line NTFY_TOPIC=...), and nothing here
# prints or logs it.
#
# load_ntfy_topic: sets NTFY_TOPIC, or returns non-zero with the reason in
# NTFY_TOPIC_ERROR.
load_ntfy_topic() {
  NTFY_TOPIC_ERROR=""
  local f="${NTFY_ENV_FILE:-/etc/lalia/ntfy.env}"
  if [ -z "${NTFY_TOPIC:-}" ]; then
    if [ ! -r "$f" ]; then NTFY_TOPIC_ERROR="$f is not readable"; return 1; fi
    NTFY_TOPIC="$(. "$f" >/dev/null 2>&1; printf '%s' "${NTFY_TOPIC:-}")"
  fi
  if [ -z "$NTFY_TOPIC" ]; then NTFY_TOPIC_ERROR="$f sets no NTFY_TOPIC"; return 1; fi
}
