# Relay watcher - operator notes (read me first)

This directory is a **self-hosted monitor for the iTerm2 companion relay fleet** that
runs on the **mini PC** (`minipc`, hostname `Lalia`, Debian, always on, on George's
home network). It ran on George's Mac until 2026-10, which slept and traveled, so it
was down exactly when nobody was around (`docs/plans/watcher-to-minipc.md`).
It exists because the off-box monitor (mcnachman.cloud) pages from a single network vantage and false-alarms when *its* path to a relay blips while
the relays are actually serving users fine. This watcher is an **independent second
vantage**: it probes the relays from this box and only escalates when it *itself*
cannot reach them.

George's main way of interacting with this is to run `claude` in this directory and
ask. So: the operational knowledge lives here. Don't make him remember tmux flags.

## Where it runs (the part nobody remembers)

A detached **tmux session on a PRIVATE socket**: `tmux -L relaywatch`, session
`relay-watch`. The private socket keeps it separate from George's everyday tmux, so
his `tmux kill-server`/restarts never touch it.

| Do this | Command |
|---|---|
| Attach from the Mac | `ssh minipc -t tmux -L relaywatch attach -t relay-watch` |
| Attach (see/drive it) | `tmux -L relaywatch attach -t relay-watch` |
| Detach | `Ctrl-b d` |
| Switch windows | `Ctrl-b n` / `Ctrl-b p` (windows: `claude`, `beat`) |
| Peek without attaching | `tmux -L relaywatch capture-pane -p -t relay-watch:claude` |
| Peek at the heartbeat | `tmux -L relaywatch capture-pane -p -t relay-watch:beat` |
| Is it running? | `tmux -L relaywatch has-session -t relay-watch && echo up` |
| Start it (idempotent) | `./run.sh` |
| Stop it | `tmux -L relaywatch kill-session -t relay-watch` |
| Live heartbeat log | `tail -f state/heartbeat.log` |

`capture-pane` works while detached, so prefer it over attaching when you just want
to look (attaching can cause a resize that briefly disrupts things).

## The two windows

- **`claude`** - an always-live, idle Claude Code session (this is the agent that
  triages). It runs in `--permission-mode auto` (no permission prompts) with a hard
  `deny` list in `.claude/settings.json` (ssh/sudo/systemctl/kill/rm/... blocked even
  under auto). It boots from `ROLE.txt`, reads `PLAYBOOK.md`, then idles until poked.
- **`beat`** - `heartbeat.sh`, a cheap deterministic probe loop (no LLM). Every ~2 min
  it runs `tick.mjs`; prints a `tick ok` pulse when healthy; on sustained trouble it
  pokes the `claude` window via `tmux send-keys`.

## How it decides (and why it rarely pages)

1. `tick.mjs` does a real owned-room mac-park handshake to every relay in the live
   shard map, a GET to each push relay (push.iterm2.com then push2.iterm2.com,
   expect 405; `PUSH_PROBE_URLS`), PLUS control
   fetches (resolver/Cloudflare/Google) proving this box has internet. Verdict: `ok`, `some-relays-unreachable`, `all-relays-unreachable`,
   `push-unreachable` (relays fine, the PRIMARY push relay not: released apps only
   know push.iterm2.com), `push-degraded` (only push2 down: no failover, users
   unaffected; heartbeat logs it every 5 min but never wakes Claude, the off-box
   monitor emails), `mac-offline`, `map-unreachable`.
2. `mac-offline` / `tick-error` / `map-unreachable` (this box can't get a usable read
   of the fleet - no internet, probe error, or the shard map can't be fetched) ->
   heartbeat holds quietly, never wakes Claude, throttles logging, recovers on its
   own. This is the biggest false-alarm source and is handled deterministically.
   `map-unreachable` was added here on 2026-09-03 after partial connectivity during a
   network outage produced ~5 pointless Claude pokes (without the map, Claude can't
   build owned-room probes anyway).
3. Two consecutive relay-shaped failures (this box online) -> heartbeat pokes Claude with
   `TRIAGE:`. Claude re-probes independently, cross-checks the monitor, and pages
   ONLY if the relay is genuinely unreachable from here. A blip that clears -> logged
   to `state/transients.log`, no page. See `PLAYBOOK.md` for the exact decision tree.

## Auto-start at boot (systemd user timer)

`relay-watch.timer` runs `relay-watch.service` (`./run.sh`) 30 s after boot and every
5 min (self-heal: `run.sh` is idempotent, so a dead session comes back). Linger is on
for `gnachman`, so it runs with nobody logged in. Sources are in `systemd/`;
`systemd/install-systemd.sh` renders them into `~/.config/systemd/user/` for this
checkout and enables the timer. The service uses `KillMode=process` because it is a
oneshot that leaves the tmux server behind on purpose.
- Status: `systemctl --user list-timers relay-watch.timer; systemctl --user status relay-watch.service`
- Disable: `systemctl --user disable --now relay-watch.timer` (then kill the session)
- Its own log: `state/systemd.log`

The watcher Claude can't manage its own unit (`systemctl` is denied). The running
checkout is `~/iterm2-companion-relay` (not the dev checkout in `~/git`), so
editing code in a dev session doesn't change the live watcher until it's pulled
there.

The old Mac copy: launchd agent `~/Library/LaunchAgents/com.iterm2.relay-watch.plist`
(kept, unloaded, for rollback). Rollback = on the Mac
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.iterm2.relay-watch.plist`,
and here `systemctl --user disable --now relay-watch.timer` plus kill the session.

## Shadow mode (running two watchers at once)

`WATCH_SHADOW=1` in `watch.env` makes `notify.sh` log each page to `state/notify.log`
as `SHADOW (not sent)` and the heartbeat log (not send) its paging-path emails, so
this box can run beside another watcher without double-paging. To go live: remove it
and respawn the beat window (see "Applying code changes"); the claude window reads
watch.env on each `notify.sh` call, so it needs no restart.

## Resilience (network + crashes)

- **No network**: `tick.mjs` fails fast (10s timeouts), heartbeat detects `mac-offline`,
  holds quietly (throttled logging), and resumes on its own when the network is back.
  It does NOT flail or page. Claude sits idle (no API calls while idle).
- **Crashes**: both windows run under restart wrappers (`launch-claude.sh`,
  `launch-beat.sh`) that relaunch on exit. If the whole session dies, the systemd
  timer re-creates it within 5 min.

## Running a drill (test end to end without touching a real relay)

`tick.mjs` honors `WATCH_FORCE_FAIL_HOSTS=<host,...>` to report a host as unreachable.
To make the heartbeat autonomously detect it and poke Claude, respawn the beat window
with the flag, then watch:
```
tmux -L relaywatch respawn-window -k -t relay-watch:beat \
  "bash -lc 'WATCH_FORCE_FAIL_HOSTS=relay1.iterm2.com exec $(pwd)/launch-beat.sh'"
# watch: tmux -L relaywatch capture-pane -p -t relay-watch:claude
# disarm: tmux -L relaywatch respawn-window -k -t relay-watch:beat "$(pwd)/launch-beat.sh"
```
Expect Claude to re-probe, find the relay actually healthy (the fault is local
only), log a transient, and NOT page. To exercise the real page path you must make the
relay genuinely unreachable from this box (e.g. /etc/hosts blackhole), which needs
sudo.

## Paging the phone (works headless)

`notify.sh` pages George's phone with a real network push that works from Claude's
Bash tool and the heartbeat (no tty needed). On a Mac it shells out to
`~/bin/it2-notify` (a macOS binary); here, with no it2-notify, it uses
`push-send.mjs`, which makes the same request: `POST <relay>/push
{token, secret, title, body}` (the push relay's source is
`Companion/PushRelay/src/worker.js` in the iTerm2 repo).
Call it `notify.sh "TITLE" "body"` (preferred) or `notify.sh "single message"`
(title defaults to `relay-watch`).

- **Credentials** (`pushcreds.sh`): on a Mac, from the iTerm2 app's own storage on
  every call (`it2-notify --print-secrets`). Here there is no iTerm2, so they're a
  copy in `push.env` (gitignored, mode 600, `ITERM_PUSH_TOKEN=` /
  `ITERM_PUSH_SECRET=` lines), made on the Mac with
  `~/bin/it2-notify --print-secrets > /tmp/push.env && scp /tmp/push.env minipc:iterm2-companion-relay/ops/watch/push.env && rm /tmp/push.env`
  (never paste it). A copy goes stale when the phone is re-paired: that's how every
  page silently failed with 403 "bad secret" through the 2026-10-16 outage. So
  `notify.sh` records a 403 from a relay in `state/push-rejected`, and
  `check-notify.sh` reports it (emailed, below) until `push.env` is newer than that
  record, i.e. refreshed. Never in `watch.env`; inherited `ITERM_PUSH_*` values are
  ignored.
- **Relays:** it tries `push.iterm2.com`, then `push2.iterm2.com` (override with
  `NOTIFY_PUSH_URLS`), so a page still goes out while mcnachman.cloud is down.
- **Email fallback:** if no relay delivers, it emails the page (`email.sh`, Resend;
  `RESEND_API_KEY`/`ALERT_FROM`/`ALERT_TO` in `watch.env`) with the push error. It
  exits 0 when George was reached either way, non-zero only if both failed.
- **Checked continuously:** the heartbeat runs `check-notify.sh` every 10 min
  (`WATCH_NOTIFY_CHECK_INTERVAL`): a sender present, credentials readable, the last
  real page not rejected, email configured. A failure is logged
  (`PAGING PATH BROKEN`) and emailed, again every 6 h while it lasts, and once more
  when fixed. The relays have no credentials-only call, so the last real page is the
  end-to-end check; a stale copy shows up at the first page after a re-pair (which
  then goes out by email).
- Every page is appended to `state/notify.log`.

## Investigating a relay from here (read-only, on-box)

`probe-relay.sh` is a **read-only** remote tap so triage can pull on-box data the
external probe can't see (journal, loopback `/metrics`, unit state). The session
hard-denies raw `ssh`/`sudo`; this wrapper is the only sanctioned path and runs a
FIXED set of read-only commands (the LLM never composes the remote command; host/unit
come from allowlists, timestamps are validated). Slice the RAW output LOCALLY.

```
./probe-relay.sh status                                   # systemctl show + status
./probe-relay.sh metrics | grep -iE 'shard|fetch'         # loopback /metrics counters
./probe-relay.sh journal --since '2026-09-07 03:00' --until '2026-09-07 07:00' \
  | grep -iaE 'shard|resolver|fetch|econn|timeout|getaddr'   # journal window, filtered locally
```

Hosts: `interserver1` = relay1, `interserver2` = relay2 (`--host`). From the mini PC
they're `~/.ssh/config` aliases (user `gnachman`) using a **dedicated key**,
`~/.ssh/relay-watch_ed25519` (not George's personal key). On each relay that key is
pinned in `authorized_keys` to `relay-forced-command.sh` (installed there as
`~/bin/relay-watch-forced-command`) with `no-port-forwarding,no-agent-forwarding,no-pty`,
which only runs the exact command strings `probe-relay.sh` sends. Change a
`probe-relay.sh` template and you must update the patterns there and reinstall it on
both relays. The relay logs
shard-map fetch failures always-on now (cause=dns/timeout/conn/tls/http_5xx/...), so
a shard-map-fetch alert is diagnosable from `./probe-relay.sh journal`.

## Files

- `tick.mjs` - the independent probe (JSON verdict; run by hand any time: `node tick.mjs`)
- `heartbeat.sh` - the probe loop + poke logic
- `launch-claude.sh` / `launch-beat.sh` - restart wrappers for the two windows
- `run.sh` - idempotent bootstrap of the tmux session
- `ROLE.txt` - Claude's standing role prompt
- `PLAYBOOK.md` - the triage procedure Claude follows on a `TRIAGE:` poke
- `notify.sh` - phone page via `it2-notify` or `push-send.mjs`, email if push fails (see above)
- `push-send.mjs` - sends one push through a push relay (Linux stand-in for it2-notify)
- `pushcreds.sh` - loads the push credentials: the app's on a Mac, `push.env` here (sourced)
- `push.env` - the phone's push token + secret, copied from the Mac (gitignored, mode 600)
- `relay-forced-command.sh` - installed on the relays: the watcher key's forced command
- `systemd/` - the user service + timer and their installer
- `email.sh` - email via Resend, the second channel
- `check-notify.sh` - checks the paging path without sending (run by the heartbeat)
- `probe-relay.sh` - read-only on-box relay diagnostics (journal/metrics/status)
- `.claude/settings.json` - auto mode + hard deny list (raw ssh/sudo denied; only
  `probe-relay.sh` and read-only text filters allowed)
- `watch.env` - local config incl. `MONITOR_PASSWORD` + the Resend key (gitignored)
- `state/` - runtime: `heartbeat.log`, `tick.out`, `last.json`, `transients.log` (gitignored)
- `incidents/` - incident reports Claude writes (gitignored)

## Applying code changes

Editing `heartbeat.sh`/`tick.mjs`/`launch-*.sh` does NOT affect the running process.
Reload the affected window without disturbing the other:
`tmux -L relaywatch respawn-window -k -t relay-watch:beat "$(pwd)/launch-beat.sh"`
(respawning the `claude` window will drop any live conversation and reboot Claude).
