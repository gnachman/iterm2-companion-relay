# Relay watcher (runs on the mini PC)

A watcher that runs on the always-on mini PC at home (it ran on the Mac until
2026-10; see CLAUDE.md) and reacts to relay trouble in minutes instead of
whenever you happen to read the alert email. It leans on one fact: **this box is an
independent second vantage from the mcnachman.cloud monitor.** If it can
complete a real pairing handshake to a relay, that relay is serving users, whatever
an alert said. So it can tell the 99% case (a transient network/vantage blip)
apart from the 1% case (the relays' inbound path is genuinely broken) and only wake
you for the latter.

## Architecture

```
tmux session "relay-watch" on private socket -L relaywatch  (survives iTerm2 detach)
  ├─ window "claude"  always-live, idle, interactive Claude you attach to and
  │                   drive from the phone. Sends the page + writes reports.
  │                        ▲  (poke via tmux send-keys)
  └─ window "beat"  heartbeat.sh ── every ~2 min ──▶ node tick.mjs  (cheap, no LLM)
                          │                              │
                          │                      verdict ok ─▶ keep probing, silent
                          │                              │
                          │        sustained relay failure (own internet healthy)
                          ▼
                    pokes the claude window: "TRIAGE: ..."
                          └─ Claude re-probes, cross-checks the monitor, decides
                             real vs transient, pages the phone only if real,
                             writes an incident report, then goes back to idle.
```

Two layers on purpose. A deterministic probe is the right always-on watcher (near
zero cost). Claude stays live but **idle costs nothing** until the heartbeat pokes
it, so it spends tokens only when something is actually wrong, which is also
exactly when you want to grab the wheel from your phone. Because Claude is always
running, there is no per-incident startup and nothing needs to self-exit.

- **`tick.mjs`** - the independent probe. Owned-room mac-park handshake to every
  host in the live shard map, plus control fetches (resolver, Cloudflare, Google)
  that prove this box itself has internet. Prints one JSON verdict; exits 0 iff all
  healthy. Run it by hand any time: `node tick.mjs`.
- **`heartbeat.sh`** - the cheap probe loop. Pokes the `claude` window via
  `tmux send-keys` on sustained trouble; dedupes to one poke per incident. Skips
  entirely when the verdict is `mac-offline` (your own wifi), the biggest
  false-alarm source. Never pages by itself: Claude decides whether a failure is
  real, so it owns the page.
- **`ROLE.txt`** - the standing prompt that boots Claude into its idle watcher role.
- **`PLAYBOOK.md`** - the triage Claude runs on a `TRIAGE:` poke: re-confirm,
  corroborate with the monitor's vantage, page-or-stand-down, record.
- **`notify.sh`** - the escalation: a phone push through the push relays
  (`it2-notify` on a Mac, `push-send.mjs` + `push.env` elsewhere), email if that
  fails. `WATCH_SHADOW=1` logs instead of sending.
- **`.claude/settings.json`** - a tight allowlist. Claude may probe, curl, notify,
  and write incident files; `ssh`, `sudo`, `systemctl`, `kill`, `rm` etc. are
  denied, so the watcher can never touch production. (Read-only + notify by design.)

## Start / attach / control

```
cp watch.env.example watch.env    # fill in MONITOR_PASSWORD (optional but useful)
./run.sh                          # installs ws, starts the detached tmux session
./systemd/install-systemd.sh      # Linux: start at boot + self-heal every 5 min
```

- Attach: `ssh minipc -t tmux -L relaywatch attach -t relay-watch` (or, on the box, `tmux -L relaywatch attach -t relay-watch`). Two windows:
  switch with `Ctrl-b n`/`Ctrl-b p` (`claude`, `beat`), detach with `Ctrl-b d`.
- Control from your phone: open the iTerm2 companion app, attach to the iTerm2
  session running `tmux -L relaywatch attach -t relay-watch`, switch to the `claude`
  window, and type to it. It is always live, so you can steer it any time.
- Peek without attaching: `tmux -L relaywatch capture-pane -p -t relay-watch:claude`
  (tmux renders detached panes, so you can read Claude's screen any time).
- Follow along: `tail -f state/heartbeat.log`
- Stop: `tmux -L relaywatch kill-session -t relay-watch`

The watcher runs on a PRIVATE tmux socket (`-L relaywatch`), a separate server from
your everyday tmux, so your `tmux kill-server`/restarts never take it down. (A
`pkill tmux` would; stop it deliberately with the command above.)

## Paging

`notify.sh` sends a real network push (no attached terminal needed) through
push.iterm2.com, then push2.iterm2.com, and emails the page if neither delivers.
See CLAUDE.md "Paging the phone" for credentials (`push.env` on the mini PC) and
how a stale copy is detected.

## Cost

The heartbeat is free (a node probe). Claude runs only on sustained trouble: a quick
pass for a transient (concludes, logs, exits), or a held session during a real
outage. Expect a handful of short Claude launches per week, not a 24/7 spend.

## Deliberately NOT here yet

- **RELAY_LOG capture** (toggle verbose on the relay, snapshot the journal). That
  needs production `ssh`, which is denied in the allowlist for safety. When triage
  says a real outage needs it, Claude escalates and you (now attached) run it. Ask
  if you want a narrowly-scoped `capture.sh` added to the allowlist.
- **A freshness watchdog** for the watcher itself (checks `state/last.json` is
  recent, not just that the tmux session exists). The systemd timer
  (`systemd/`) only re-creates a missing session.
- **Context hygiene**: the live Claude accumulates history across incidents. It can
  `/compact`, or add a nightly restart of the `claude` window during healthy hours.

## Verify the wiring once

After `./run.sh`, attach and confirm the two moving parts:
- `node tick.mjs` returns `verdict: ok` (probe path works).
- From another shell, poke the live Claude the way the heartbeat does (message and
  Enter as two separate `send-keys`, because Claude's input treats an inline newline
  as "insert a line", not "send"), then read the pane to confirm it reacted:
  ```
  tmux -L relaywatch send-keys -t relay-watch:claude -l "DRILL: run node tick.mjs and report the verdict."
  sleep 0.4
  tmux -L relaywatch send-keys -t relay-watch:claude Enter
  tmux -L relaywatch capture-pane -p -t relay-watch:claude | tail -20
  ```

Note: launching Claude in this folder the first time may trigger a one-time "Do you
trust the files in this folder?" prompt. `run.sh` cannot pre-accept it (that is
intentionally gated), so if you see it, attach and accept once.
