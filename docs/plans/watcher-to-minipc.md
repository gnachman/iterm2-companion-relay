# Plan: move the relay watcher from the Mac to the mini PC

Status: approved 2026-10-25. Owner: a normal (non-watcher) Claude Code session
in the repo root on George's Mac, which can `ssh minipc`. The watcher session
itself cannot do this: its `.claude/settings.json` denies ssh/scp by design.

## Why

The watcher (`ops/watch/`, see `ops/watch/CLAUDE.md`) runs in tmux on George's
Mac. The Mac sleeps and travels, so the watcher is down exactly when nobody is
around. That was tolerable for a read-only second vantage, but the watcher is
about to supervise automatic failover (`docs/plans/auto-failover-reshard.md`)
and gain a few fixed write powers (pause/resume/restore failover). That needs a
host that is always on.

The mini PC is always on, runs Linux, and is reachable from the Mac as
`ssh minipc` (key auth, no password). Claude Code is installed and logged in
there.

## Scope

In scope: run the existing watcher (heartbeat + Claude triage window) on the
mini PC with the same behavior and safety rules, then retire the Mac copy.

Out of scope: the failover supervisor powers (`failover-ctl.sh`). Build those
after the move, on the mini PC, as part of the auto-failover plan.

## Step 0: inventory the mini PC

```
ssh minipc 'uname -a; . /etc/os-release; echo $PRETTY_NAME; node -v; npm -v; tmux -V; bash --version | head -1; claude --version; loginctl show-user $USER -p Linger; command -v nc dig curl git'
```

Requirements and fixes:

- Node 20+ (the watcher only needs `ws`), tmux 3.x, bash 4+ (`probe-relay.sh`
  uses `declare -A`), curl, dig (dnsutils/bind-utils), nc, git.
- **Linger must be on** (`loginctl enable-linger $USER`, needs sudo once, ask
  George), or the user systemd service stops when nobody is logged in.
- Note the distro's `nc` flavor. The watcher scripts do not use `nc`, but the
  playbook's ad hoc checks used macOS `nc -G`; Linux uses `nc -w`. Fix any
  such references in `PLAYBOOK.md`.

## Step 1: get the code there

Clone the repo on the mini PC (`git clone https://github.com/gnachman/iterm2-companion-relay`)
to a stable path, e.g. `~/iterm2-companion-relay`. The watcher runs from
`ops/watch/`. `npm install` in `ops/watch` (run.sh also does this).

Copy the gitignored runtime files from the Mac's `ops/watch/` with scp from
the Mac (never paste secrets into chat):

- `watch.env` (MONITOR_PASSWORD, PUSH_DASHBOARD_*, RESEND_API_KEY, ALERT_FROM,
  ALERT_TO, cadence settings).
- `incidents/` and `state/transients.log`, so the history comes along. Do not
  copy the rest of `state/`; it is regenerated.

## Step 2: phone alerts (the hard part)

**Superseded 2026-10-25:** paging moved to ntfy.sh instead (one POST to the
private topic in `/etc/lalia/ntfy.env` that George's ntfy app subscribes to).
No iTerm2 push credentials on the mini PC, nothing to go stale, and paging no
longer depends on the push relays the watcher monitors. `check-notify.sh` checks
`https://ntfy.sh/v1/health` without posting. See `ops/watch/CLAUDE.md`
"Paging the phone". The original plan for this step follows, for the record.

`notify.sh` and `pushcreds.sh` call `~/bin/it2-notify`, which is a **macOS
arm64 binary** and does not run on Linux. It does two jobs:

1. `it2-notify --print-secrets` reads the push token and secret from iTerm2's
   stored pairing (so the watcher always uses the current credentials; a stale
   copy in watch.env caused the 2026-10-16 "403 bad secret" outage of paging).
2. `it2-notify --url <push relay> <title> <body>` sends the push.

On the mini PC:

- **Sending:** replace the binary with a small script (`ops/watch/push-send.mjs`
  or similar) that speaks the same HTTP API to the push relay. Find the request
  format from the push relay's source (it lives outside this repo; the monitor
  only scrapes its metrics) or from it2-notify's behavior. Keep notify.sh's
  existing order: push.iterm2.com, then push2.iterm2.com, then email via
  `email.sh`.
- **Credentials:** there is no iTerm2 on the mini PC, so it needs a copy.
  Put the token/secret in a separate gitignored file (`push.env`, mode 600),
  copied from the Mac's `it2-notify --print-secrets` output via scp, never
  pasted. Because a copy can go stale, `check-notify.sh` must do a real
  end-to-end check (see below), and email stays the fallback.
- **`check-notify.sh`:** today it checks what it can locally. On the mini PC,
  make it detect a rejected push (403 bad secret) from the last real page or a
  low-noise test, and email George to refresh `push.env` when it does. The
  6h reminder / "fixed" email logic already exists; reuse it.
- **Email fallback:** `email.sh` uses the Resend API and is plain curl, so it
  should work unchanged. Verify by sending one test email.

Get George's OK before sending a test push to his phone.

## Step 3: on-box diagnostics (`probe-relay.sh`)

`probe-relay.sh` sshes to the relays as `interserver1` (162.35.169.241) and
`interserver2` (69.164.245.166), user `gnachman`, using George's Mac keys and
`~/.ssh/config` aliases.

On the mini PC, create a **dedicated** key for the watcher (do not copy George's
personal key). On each relay, install it in `authorized_keys` restricted to the
fixed read-only commands, e.g. with a `command=` forced-command wrapper on the
box that only allows the exact `systemctl show/status`, `journalctl`, and
loopback `curl /metrics` invocations probe-relay.sh sends, plus
`no-port-forwarding,no-agent-forwarding,no-pty`. This is stricter than today
(today the restriction lives only on the client side). Installing the key on
the relays needs George or a session with relay ssh; ask before touching the
relays.

Add matching `Host interserver1` / `interserver2` entries to the mini PC's
`~/.ssh/config` pointing at the new key, and verify:
`./probe-relay.sh status --host interserver1` and `--host interserver2`.

## Step 4: auto-start (replace launchd with systemd)

Replace `~/Library/LaunchAgents/com.iterm2.relay-watch.plist` with a systemd
user unit plus timer on the mini PC that runs `ops/watch/run.sh` at boot and
every 5 min (run.sh is idempotent: it exits if the tmux session exists). For
example `~/.config/systemd/user/relay-watch.service` (Type=oneshot,
ExecStart=.../run.sh) and `relay-watch.timer` (OnBootSec=30s,
OnUnitActiveSec=5min). `systemctl --user enable --now relay-watch.timer`.

`launch-claude.sh` and `launch-beat.sh` are plain bash and need no change.
Check that `claude --permission-mode auto` works non-interactively there
(first launch may show a trust/onboarding prompt; clear it once by attaching).

Note: the watcher's `.claude/settings.json` denies `systemctl *`, so the
watcher Claude cannot manage its own unit. That is intended.

## Step 5: shadow run, then cut over

Run both watchers in parallel for at least a day without double-paging:

1. Add a shadow switch (e.g. `WATCH_SHADOW=1` in the mini PC's watch.env) that
   makes `notify.sh` log the page to `state/notify.log` with a `SHADOW` tag
   instead of sending. Start the mini PC watcher with it on.
2. Compare the two `state/heartbeat.log` files and any triage outcomes. The
   mini PC sees the same home network as the Mac (when the Mac is home), so
   verdicts should match.
3. Cut over: remove `WATCH_SHADOW` on the mini PC and restart its beat window;
   on the Mac, `launchctl bootout gui/$(id -u)/com.iterm2.relay-watch` and
   `tmux -L relaywatch kill-session -t relay-watch`. Keep the Mac plist file
   (unloaded) for rollback.
4. Send one real page from the mini PC (with George's OK) to confirm the whole
   path.

Rollback: re-bootstrap the launchd agent on the Mac and stop the mini PC timer
and session.

## Step 6: update the docs

- `ops/watch/CLAUDE.md`: it runs on the mini PC now; how to attach
  (`ssh minipc -t tmux -L relaywatch attach -t relay-watch`), systemd instead
  of launchd, push.env, the dedicated ssh key, shadow mode.
- `ROLE.txt` and `PLAYBOOK.md`: replace "George's Mac" with the mini PC where
  it matters (the vantage description, the drill section).
- Memory note `relay-mac-watcher` (in George's Claude memory dir on the Mac)
  will be stale; mention it to George or update it.

## Safety rules that must survive the move

- Same `.claude/settings.json` deny list (ssh, scp, sudo, systemctl, kill, rm,
  git push, ...). Drop the macOS-only `launchctl` entry only if replacing it
  with nothing more permissive.
- `probe-relay.sh` stays the only path onto the relays.
- `mac-offline` / `map-unreachable` / `tick-error` still hold quietly (the
  verdict names can stay; consider renaming `mac-offline` to `vantage-offline`
  later, not as part of this move).
- Never commit `watch.env` or `push.env`. Check `.gitignore` covers `push.env`.

## Done when

- The mini PC watcher has run a day in shadow with verdicts matching the Mac.
- A real page from the mini PC reached George's phone, and the email fallback
  was verified.
- `probe-relay.sh` works from the mini PC with the restricted key on both relays.
- It survives a mini PC reboot (timer brings it back) with nobody logged in.
- The Mac watcher is stopped and its launchd agent unloaded.
- Docs updated.
