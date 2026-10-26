#!/usr/bin/env bash
# The always-on heartbeat. No LLM. It samples tick.mjs on a timer and, only on
# SUSTAINED relay-shaped trouble (with this box's own internet healthy), POKES the
# live `claude` window in this same tmux session via `tmux send-keys`, so the
# interactive, phone-controllable Claude runs the triage and owns all user-facing
# output (the OSC 9 page, the incident report). The heartbeat only decides WHEN to
# wake Claude, and dedupes so you are poked once per incident (with an occasional
# nudge if it drags on). It never pages by itself, because an OSC 9 from this
# background window would not reach iTerm2 until you switched to it; Claude, in the
# window you actually attach to, is the right emitter.
set -uo pipefail
cd "$(dirname "$0")"
[ -f watch.env ] && { set -a; . ./watch.env; set +a; }

SOCKET="${WATCH_TMUX_SOCKET:-relaywatch}"
SESSION="${WATCH_SESSION:-relay-watch}"
CLAUDE_WIN="${WATCH_CLAUDE_WINDOW:-claude}"
QUIET_INTERVAL="${WATCH_QUIET_INTERVAL:-120}" # seconds between checks while healthy
RETRY_INTERVAL="${WATCH_RETRY_INTERVAL:-20}"  # seconds between confirm re-checks
CONFIRM_FAILS="${WATCH_CONFIRM_FAILS:-2}"     # consecutive relay fails before waking Claude
REPOKE_SECONDS="${WATCH_REPOKE_SECONDS:-900}" # re-nudge an unresolved incident at most this often
NOTIFY_CHECK_INTERVAL="${WATCH_NOTIFY_CHECK_INTERVAL:-600}" # seconds between paging-path checks
NOTIFY_REMIND_SECONDS="${WATCH_NOTIFY_REMIND_SECONDS:-21600}" # re-email a still-broken paging path
mkdir -p state incidents

log()        { printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" | tee -a state/heartbeat.log; }
verdict_of() { grep -o '"verdict"[^,]*' "$1" 2>/dev/null | head -1 | sed 's/.*"\([a-z-]*\)"$/\1/'; }
# Claude's input box treats an inline newline as "insert a line", not "send", so
# deliver the message (as literal text, -l) and the submitting Enter as two
# discrete send-keys with a beat in between; the lone Enter then registers as a
# real Enter keypress and submits. Retries a few times because send-keys can fail
# transiently (e.g. a resize race while the session is being attached), and
# returns non-zero if it never lands so the caller can keep the incident live and
# retry next cycle rather than silently believing Claude was woken.
poke() {
  # Prefix every poke with the wall-clock time it was SENT. If Claude was busy,
  # pokes queue in its input; the timestamps let it see a batch arrived (and how
  # old each is) and collapse them into one triage against current state instead
  # of re-triaging per queued poke. See PLAYBOOK.md "Batched / queued pokes".
  local msg="[poke @ $(date '+%Y-%m-%dT%H:%M:%S%z')] $1"
  local n
  for n in 1 2 3; do
    if tmux -L "$SOCKET" send-keys -t "${SESSION}:${CLAUDE_WIN}" -l "$msg" 2>>state/heartbeat.log; then
      sleep 0.4
      tmux -L "$SOCKET" send-keys -t "${SESSION}:${CLAUDE_WIN}" Enter 2>>state/heartbeat.log
      return 0
    fi
    log "poke attempt ${n}/3 failed (send-keys); retrying"
    sleep 1
  done
  log "WARN: could not poke '${CLAUDE_WIN}' after 3 attempts"
  return 1
}

cat <<'BANNER'
================================================================================
 relay-watch heartbeat  -  the deterministic probe loop (no LLM).
 Quiet when healthy; a "tick ok" pulse prints each cycle, and real events
 (failures, poking Claude, recovery) print here and to state/heartbeat.log.
 The interactive watcher is the "claude" window: Ctrl-b p.
================================================================================
BANNER
log "heartbeat up (quiet=${QUIET_INTERVAL}s retry=${RETRY_INTERVAL}s confirm=${CONFIRM_FAILS})"
# The paging path is checked on its own schedule (check-notify.sh), because a
# watcher whose pages can't be delivered is useless and would otherwise only find
# out at the next real incident (it did, 2026-10-16). A problem is emailed, since
# the phone push may be the thing that's broken; email.sh failing too is logged.
# In shadow mode (WATCH_SHADOW=1) these emails are only logged, like pages.
mail() {
  if [ "${WATCH_SHADOW:-0}" = 1 ]; then log "SHADOW (email not sent): $1"; return 0; fi
  ./email.sh "$@" 2>>state/heartbeat.log
}
notify_broken=0
notify_checked=0
last_notify_check=0
last_notify_mail=0
check_paging() {
  local now out
  now="$(date +%s)"
  [ $((now - last_notify_check)) -ge "$NOTIFY_CHECK_INTERVAL" ] || return 0
  last_notify_check="$now"
  if out="$(./check-notify.sh 2>&1)"; then
    [ "$notify_checked" = 1 ] || log "paging path ok (checked every ${NOTIFY_CHECK_INTERVAL}s)"
    notify_checked=1
    if [ "$notify_broken" = 1 ]; then
      log "paging path fixed"
      mail "paging path fixed" "The relay watcher on $(hostname -s) can page your phone again." \
        || log "WARN: could not email that the paging path is fixed"
      notify_broken=0
    fi
    return 0
  fi
  log "PAGING PATH BROKEN: $(printf '%s' "$out" | tr '\n' ';')"
  if [ "$notify_broken" = 0 ] || [ $((now - last_notify_mail)) -ge "$NOTIFY_REMIND_SECONDS" ]; then
    if mail "paging path broken" "The relay watcher on $(hostname -s) cannot page your phone, so it would miss telling you about an outage:

$out

Fix it, then check with: ops/watch/check-notify.sh"; then
      last_notify_mail="$now"
    else
      log "WARN: could not email about the broken paging path either"
    fi
  fi
  notify_broken=1
}

fails=0
incident=0        # 1 while we believe an incident is active
last_poke=0
offline=0         # 1 while this box itself has no working internet
last_offline_log=0
while true; do
  check_paging
  if node tick.mjs > state/tick.out 2> state/tick.err; then
    if [ "$offline" = 1 ]; then log "fleet readable again from this box; resuming normal watch"; offline=0; fi
    if [ "$incident" = 1 ]; then
      log "recovered; poking RESOLVED"
      poke "RESOLVED: relays and push server reachable again from this box. Confirm, post recovery per PLAYBOOK.md, then stand down."
      incident=0
    fi
    fails=0
    printf '%s  tick ok - all relays + push reachable from this box\n' "$(date '+%H:%M:%S')"
    sleep "$QUIET_INTERVAL"; continue
  fi

  verdict="$(verdict_of state/tick.out)"

  # Only a secondary push relay is down: released apps don't use it and pushes
  # still flow, so this is not an incident (the off-box monitor emails about it).
  # Treat it as healthy, but say so, at most every 5 min.
  if [ "$verdict" = "push-degraded" ]; then
    if [ "$incident" = 1 ]; then
      log "recovered (a secondary push relay is still down); poking RESOLVED"
      poke "RESOLVED: relays and the primary push relay are reachable again from this box; a secondary push relay is still down (no failover, users unaffected). Confirm, post recovery per PLAYBOOK.md, then stand down."
      incident=0
    fi
    fails=0
    now="$(date +%s)"
    if [ $((now - ${last_degraded_log:-0})) -ge 300 ]; then
      log "tick ok except a secondary push relay is down (push-degraded); not waking Claude"
      last_degraded_log="$now"
    fi
    sleep "$QUIET_INTERVAL"; continue
  fi

  # Conditions where this box cannot get a usable read of the fleet, so waking
  # Claude cannot help:
  #   mac-offline     - this box has no working internet at all.
  #   tick-error      - the probe script itself errored.
  #   map-unreachable - the shard map (resolver) could not be fetched. Without it
  #                     we cannot build owned-room probes to verify sharded relays,
  #                     so a probe would false-fail; this is almost always local
  #                     flaky/partial connectivity (observed 2026-09-03), not a
  #                     relay outage.
  # All are local/transient in practice: hold quietly, do NOT wake Claude or page,
  # throttle the logging (announce once, then at most every 5 min), and recover
  # automatically. A genuine sustained resolver outage is out of this watcher's
  # scope (clients tolerate the map's max-age=5; the off-box monitor covers it).
  if [ "$verdict" = "mac-offline" ] || [ "$verdict" = "tick-error" ] || [ "$verdict" = "map-unreachable" ]; then
    now="$(date +%s)"
    if [ "$offline" = 0 ]; then
      log "cannot read the fleet from here (verdict=${verdict}); holding quietly, not waking Claude. Will resume automatically when it clears."
      offline=1; last_offline_log="$now"
    elif [ $((now - last_offline_log)) -ge 300 ]; then
      log "still can't read the fleet (verdict=${verdict}); holding"
      last_offline_log="$now"
    fi
    fails=0
    sleep "$RETRY_INTERVAL"; continue
  fi

  fails=$((fails + 1))
  log "relay check failed ${fails}/${CONFIRM_FAILS} (verdict=${verdict})"
  if [ "$fails" -lt "$CONFIRM_FAILS" ]; then
    sleep "$RETRY_INTERVAL"; continue
  fi

  now="$(date +%s)"
  if [ "$incident" = 0 ] || [ $((now - last_poke)) -ge "$REPOKE_SECONDS" ]; then
    {
      echo "# Relay watch incident $(date '+%Y-%m-%dT%H:%M:%S%z')"
      echo
      echo "Verdict: ${verdict}. ${fails} consecutive relay-reachability failures from"
      echo "this box while its own internet is healthy."
      echo
      echo '```json'
      cat state/tick.out
      echo '```'
    } > state/incident-brief.md
    log "waking Claude (verdict=${verdict})"
    if poke "TRIAGE: sustained relay/push failure (verdict=${verdict}). Read state/incident-brief.md and PLAYBOOK.md, then triage now."; then
      incident=1
      last_poke="$now"
    else
      log "poke did not land; leaving incident unmarked to retry next cycle"
    fi
  fi
  sleep "$RETRY_INTERVAL"
done
