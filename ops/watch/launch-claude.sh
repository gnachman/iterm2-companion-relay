#!/usr/bin/env bash
# Launch the watcher Claude in its tmux window: auto permission mode + the standing
# role prompt. A wrapper so the multi-line ROLE.txt never has to survive shell-arg
# quoting, AND so Claude self-heals: if it ever exits (crash, or a transient API/
# network error at startup while the Mac is offline), we relaunch it after a short
# pause rather than leaving a dead window. deny rules in .claude/settings.json still
# hard-block ssh/sudo/kill/rm even under auto mode.
# Optional $1: a session ID to resume (and keep resuming after a crash) instead of
# starting a fresh watcher. The resumed conversation already has the role prompt.
cd "$(dirname "$0")"
resume_id="${1:-}"
[ -f watch.env ] && { set -a; . ./watch.env; set +a; }
export TERM="${TERM:-tmux-256color}"
while true; do
  if [ -n "$resume_id" ]; then
    claude --permission-mode auto --resume "$resume_id"
  else
    claude --permission-mode auto "$(cat ROLE.txt)"
  fi
  ec=$?
  echo "[relay-watch] claude exited (status ${ec}); relaunching in 10s. (Detach with Ctrl-b d; this window auto-restarts.)"
  sleep 10
done
