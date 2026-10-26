# Sourced by notify.sh and check-notify.sh: load the phone's push credentials.
#
# On the Mac they come from where the iTerm2 app keeps them (its prefs and
# keychain), via `it2-notify --print-secrets`, on every call. There is
# deliberately no copy in watch.env: a copy went stale when the phone was
# re-paired, and every page then failed with 403 "bad secret" (2026-10-16). Any
# ITERM_PUSH_* inherited from the environment (the watcher session exported the
# old copy at startup) is ignored for the same reason.
#
# Where there is no iTerm2 (the Linux mini PC, no ~/bin/it2-notify), they come
# from push.env next to this file (gitignored, mode 600), a copy of the Mac's
# `it2-notify --print-secrets` output. That copy can go stale the same way, so
# notify.sh records a 403 from the relays (state/push-rejected) and
# check-notify.sh reports it until push.env is refreshed.
#
# push_sender: prints how to send ("it2-notify" or "push-send").
# load_push_creds: sets and exports ITERM_PUSH_TOKEN / ITERM_PUSH_SECRET, or
# returns non-zero with the reason in PUSH_CREDS_ERROR.
push_sender() {
  if [ -x "$HOME/bin/it2-notify" ]; then echo it2-notify; else echo push-send; fi
}

load_push_creds() {
  unset ITERM_PUSH_TOKEN ITERM_PUSH_SECRET
  PUSH_CREDS_ERROR=""
  local bin="$HOME/bin/it2-notify" envfile out line k v src
  envfile="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/push.env"
  if [ "$(push_sender)" = it2-notify ]; then
    src="it2-notify --print-secrets"
    if ! out="$("$bin" --print-secrets 2>&1)"; then
      PUSH_CREDS_ERROR="it2-notify --print-secrets failed: $(printf '%s' "$out" | head -1)"
      return 1
    fi
  else
    src="$envfile"
    if [ ! -r "$envfile" ]; then
      PUSH_CREDS_ERROR="$bin is missing and $envfile is not readable (copy the Mac's it2-notify --print-secrets output there)"
      return 1
    fi
    out="$(cat "$envfile")"
  fi
  while IFS= read -r line; do
    line="${line#export }"
    k="${line%%=*}"; v="${line#*=}"; v="${v//\"/}"; v="${v//\'/}"
    case "$k" in
      ITERM_PUSH_TOKEN) ITERM_PUSH_TOKEN="$v" ;;
      ITERM_PUSH_SECRET) ITERM_PUSH_SECRET="$v" ;;
    esac
  done <<<"$out"
  if [ -z "${ITERM_PUSH_TOKEN:-}" ] || [ -z "${ITERM_PUSH_SECRET:-}" ]; then
    PUSH_CREDS_ERROR="$src has no token or secret (is the phone paired?)"
    unset ITERM_PUSH_TOKEN ITERM_PUSH_SECRET
    return 1
  fi
  export ITERM_PUSH_TOKEN ITERM_PUSH_SECRET
}
