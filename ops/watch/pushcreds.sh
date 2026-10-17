# Sourced by notify.sh and check-notify.sh: load the phone's push credentials
# from where the iTerm2 app keeps them (its prefs and keychain), via
# `it2-notify --print-secrets`. There is deliberately no copy in watch.env: a copy
# went stale when the phone was re-paired, and every page then failed with 403
# "bad secret" (2026-10-16). Any ITERM_PUSH_* inherited from the environment (the
# watcher session exported the old copy at startup) is ignored for the same reason.
#
# load_push_creds: sets and exports ITERM_PUSH_TOKEN / ITERM_PUSH_SECRET, or
# returns non-zero with the reason in PUSH_CREDS_ERROR.
load_push_creds() {
  unset ITERM_PUSH_TOKEN ITERM_PUSH_SECRET
  PUSH_CREDS_ERROR=""
  local bin="$HOME/bin/it2-notify" out line k v
  if [ ! -x "$bin" ]; then PUSH_CREDS_ERROR="$bin is missing"; return 1; fi
  if ! out="$("$bin" --print-secrets 2>&1)"; then
    PUSH_CREDS_ERROR="it2-notify --print-secrets failed: $(printf '%s' "$out" | head -1)"
    return 1
  fi
  while IFS= read -r line; do
    k="${line%%=*}"; v="${line#*=}"; v="${v//\"/}"; v="${v//\'/}"
    case "$k" in
      ITERM_PUSH_TOKEN) ITERM_PUSH_TOKEN="$v" ;;
      ITERM_PUSH_SECRET) ITERM_PUSH_SECRET="$v" ;;
    esac
  done <<<"$out"
  if [ -z "${ITERM_PUSH_TOKEN:-}" ] || [ -z "${ITERM_PUSH_SECRET:-}" ]; then
    PUSH_CREDS_ERROR="it2-notify --print-secrets returned no token or secret (is the phone paired?)"
    unset ITERM_PUSH_TOKEN ITERM_PUSH_SECRET
    return 1
  fi
  export ITERM_PUSH_TOKEN ITERM_PUSH_SECRET
}
