# Relay watcher - operator notes (read me first)

This directory is a **self-hosted monitor for the iTerm2 companion relay fleet** that
runs on George's Mac. It exists because the off-box monitor (mcnachman.cloud) pages
from a single network vantage and false-alarms when *its* path to a relay blips while
the relays are actually serving users fine. This watcher is an **independent second
vantage**: it probes the relays from this Mac and only escalates when it *itself*
cannot reach them.

George's main way of interacting with this is to run `claude` in this directory and
ask. So: the operational knowledge lives here. Don't make him remember tmux flags.

## Where it runs (the part nobody remembers)

A detached **tmux session on a PRIVATE socket**: `tmux -L relaywatch`, session
`relay-watch`. The private socket keeps it separate from George's everyday tmux, so
his `tmux kill-server`/restarts never touch it.

| Do this | Command |
|---|---|
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
   fetches (resolver/Cloudflare/Google) proving this Mac has internet. Verdict: `ok`, `some-relays-unreachable`, `all-relays-unreachable`,
   `push-unreachable` (relays fine, the PRIMARY push relay not: released apps only
   know push.iterm2.com), `push-degraded` (only push2 down: no failover, users
   unaffected; heartbeat logs it every 5 min but never wakes Claude, the off-box
   monitor emails), `mac-offline`, `map-unreachable`.
2. `mac-offline` / `tick-error` / `map-unreachable` (this Mac can't get a usable read
   of the fleet - no internet, probe error, or the shard map can't be fetched) ->
   heartbeat holds quietly, never wakes Claude, throttles logging, recovers on its
   own. This is the biggest false-alarm source and is handled deterministically.
   `map-unreachable` was added here on 2026-09-03 after partial connectivity during a
   network outage produced ~5 pointless Claude pokes (without the map, Claude can't
   build owned-room probes anyway).
3. Two consecutive relay-shaped failures (Mac online) -> heartbeat pokes Claude with
   `TRIAGE:`. Claude re-probes independently, cross-checks the monitor, and pages
   ONLY if the relay is genuinely unreachable from here. A blip that clears -> logged
   to `state/transients.log`, no page. See `PLAYBOOK.md` for the exact decision tree.

## Auto-start at login

launchd agent `~/Library/LaunchAgents/com.iterm2.relay-watch.plist` runs `./run.sh`
at login and every 5 min (self-heal: `run.sh` is idempotent, so a dead session comes
back). Manage it:
- Load/enable: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.iterm2.relay-watch.plist`
- Unload/disable: `launchctl bootout gui/$(id -u)/com.iterm2.relay-watch`
- Status: `launchctl print gui/$(id -u)/com.iterm2.relay-watch | head`
- Its own log: `state/launchd.log`

## Resilience (network + crashes)

- **No network**: `tick.mjs` fails fast (10s timeouts), heartbeat detects `mac-offline`,
  holds quietly (throttled logging), and resumes on its own when the network is back.
  It does NOT flail or page. Claude sits idle (no API calls while idle).
- **Crashes**: both windows run under restart wrappers (`launch-claude.sh`,
  `launch-beat.sh`) that relaunch on exit. If the whole session dies, the launchd
  self-heal re-creates it within 5 min.

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
Expect Claude to re-probe, find the relay actually healthy (the fault is Mac-side
only), log a transient, and NOT page. To exercise the real page path you must make the
relay genuinely unreachable from this Mac (e.g. /etc/hosts blackhole), which needs
sudo and risks this Mac's own relay connection.

## Paging the phone (works headless)

`notify.sh` pages George's phone by shelling out to `~/bin/it2-notify <title> <body>`,
a real network push. This works from Claude's Bash tool and the heartbeat (no tty
required) - it replaced the old OSC 9 -> `/dev/tty` scheme, which could never reach a
subprocess with no controlling terminal. Verified end to end 2026-09-08 from a
confirmed no-tty context (both delivered).

- Credentials `ITERM_PUSH_TOKEN` / `ITERM_PUSH_SECRET` live in `watch.env` (gitignored);
  the session exports them, and `notify.sh` self-sources `watch.env` as a fallback, so
  it works even if invoked outside the session.
- Call it `notify.sh "TITLE" "body"` (preferred) or `notify.sh "single message"`
  (1-arg form the playbook uses; title defaults to `relay-watch`).
- It tries `push.iterm2.com`, then `push2.iterm2.com` (override with
  `NOTIFY_PUSH_URLS`), so a page still goes out while mcnachman.cloud is down. The
  relays share registrations, so either reaches the phone. The log line names the
  relay that delivered and any that failed first.
- Every page is appended to `state/notify.log`. If creds are missing it logs + prints
  to stderr and exits non-zero rather than silently dropping the page.

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

Hosts: `interserver1` = relay1, `interserver2` = relay2 (`--host`). The relay logs
shard-map fetch failures always-on now (cause=dns/timeout/conn/tls/http_5xx/...), so
a shard-map-fetch alert is diagnosable from `./probe-relay.sh journal`.

## Files

- `tick.mjs` - the independent probe (JSON verdict; run by hand any time: `node tick.mjs`)
- `heartbeat.sh` - the probe loop + poke logic
- `launch-claude.sh` / `launch-beat.sh` - restart wrappers for the two windows
- `run.sh` - idempotent bootstrap of the tmux session
- `ROLE.txt` - Claude's standing role prompt
- `PLAYBOOK.md` - the triage procedure Claude follows on a `TRIAGE:` poke
- `notify.sh` - phone page via `~/bin/it2-notify` (works headless; see above)
- `probe-relay.sh` - read-only on-box relay diagnostics (journal/metrics/status)
- `.claude/settings.json` - auto mode + hard deny list (raw ssh/sudo denied; only
  `probe-relay.sh` and read-only text filters allowed)
- `watch.env` - local config incl. `MONITOR_PASSWORD` + `ITERM_PUSH_*` (gitignored)
- `state/` - runtime: `heartbeat.log`, `tick.out`, `last.json`, `transients.log` (gitignored)
- `incidents/` - incident reports Claude writes (gitignored)

## Applying code changes

Editing `heartbeat.sh`/`tick.mjs`/`launch-*.sh` does NOT affect the running process.
Reload the affected window without disturbing the other:
`tmux -L relaywatch respawn-window -k -t relay-watch:beat "$(pwd)/launch-beat.sh"`
(respawning the `claude` window will drop any live conversation and reboot Claude).
