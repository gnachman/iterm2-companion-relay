# Plan: alert on a resolver outage

Status: proposed 2026-10-09. Owner: whoever executes this plan (an agent with
repo write, ssh to mcnachman.cloud, and access to George's Mac).

## Why

`resolver.iterm2.com/shardmap.json` returned HTTP 429 (Cloudflare `error code:
1027`, Workers free-plan daily request limit) twice, and nothing reached
George's phone either time:

| When (UTC) | Duration | Ended by |
|---|---|---|
| 2026-10-08 22:20 to 2026-10-09 00:00 | ~100 min | Cloudflare's daily counter reset |
| 2026-10-09 21:39 to 21:55 | ~15 min | static-asset deploy (commit 59454cd) |

The relays kept serving on their last-known-good map v3 the whole time, so
already-connected pairs were fine. But the resolver is the only way a client
learns which relay owns its room, so any client needing a fresh map (new
pairing, reconnect after an evict) and not falling back to the GitHub Pages
mirror could not connect. That is a user-facing outage and should page.

The root cause (Worker script counting every request) is fixed: the resolver is
now an assets-only Worker with no script, which is free and unlimited. This plan
is only about detection, so the next resolver failure of any kind pages within
minutes.

## What went wrong in detection

### Gap 1: the Mac watcher treats every map failure as "my own problem"

`ops/watch/tick.mjs` fetches the map and, if that fails and it has no hosts to
probe, returns verdict `map-unreachable`. `ops/watch/heartbeat.sh` (line ~95)
holds quietly on `map-unreachable` and never wakes Claude. That rule was added
2026-09-03 to stop pointless pokes during a home network outage.

It does not distinguish two cases:

- **Network-level failure** (timeout, DNS, connection refused, TLS): plausibly
  this Mac's path. Holding is reasonable.
- **The resolver answered with an HTTP error** (429, 5xx, 403) **while the
  internet controls pass**: Cloudflare is saying, definitively, that the
  resolver is broken. Holding is wrong.

Evidence: `state/heartbeat.log` shows `map-unreachable ... holding` from
2026-10-08 15:21 to 17:00 PDT and 2026-10-09 14:41 to 14:55 PDT, and
`state/notify.log` has no page since the 2026-09-08 test.

Minor related issue: the resolver URL is also in the default `WATCH_CONTROLS`
list. `controlsOk` uses `some()`, so it did not cause a false `mac-offline`, but
the controls should measure only this Mac's internet, not the thing under test.

### Gap 2: without the map, the watcher stops probing relays at all

When the map fetch fails, `hostList` falls back to `RELAY_HOSTS` (unset), so
zero relays are probed. A resolver outage blinds relay monitoring even though
the GitHub Pages mirror
(`https://gnachman.github.io/iterm2-companion-relay/shardmap.json`) serves the
same map. The off-box monitor has the same blind spot: `monitor/src/core.js`
only probes when `map` is non-null.

### Gap 3: the off-box monitor's map alert is email-only and mislabeled

`monitor/src/core.js` (~line 99) does raise a fleet-wide alert after
`ALERT_FAIL_STREAK` (default 2, ~10 min) failed map fetches, built with
`probeAlert(...)`. So it is `severity: "critical"`, but:

- Its title is "Relay handshake failing" and its key is the bare `probe`,
  which reads like a relay problem, not a resolver problem.
- Delivery is email via Resend with a 360-minute cooldown (`COOLDOWN_MINUTES`).
  George's real-time channel is the phone push, and the monitor has none.
- The fleet dashboard shows the hosts as `warn` (no probe ran), not `crit`.

Unverified: whether that email was actually sent on 10-08 and 10-09. The
watcher session could not read Gmail. Step 0 settles it.

## Changes

Do them in this order. Each section says how to verify.

### Step 0: investigate the monitor's alert history (read-only)

On mcnachman.cloud:

```
journalctl -u iterm2-relay-monitor --since '2026-10-08 22:00' --until '2026-10-09 22:10' --no-pager \
  | grep -iE 'shard map|alert|email|resend|429'
```

Also look at `sentAt` in the monitor's persisted state under
`/var/lib/private/iterm2-relay-monitor/` (DynamicUser; read with sudo) for the
`probe` key. Record in the PR description whether the critical email went out
and when. If it did, the detection worked and the failure was the delivery
channel, which makes Step 4 the important one.

### Step 1: `ops/watch/tick.mjs`

1. **Separate the resolver from the controls.** Change the default
   `WATCH_CONTROLS` to only `https://www.cloudflare.com/cdn-cgi/trace` and
   `https://www.google.com/generate_204`. (If `watch.env` overrides
   `WATCH_CONTROLS`, update it to match; it is gitignored and local.)
2. **Classify the map fetch.** Record the primary fetch as
   `resolver: { url, ok, status, errorKind, ms, bodySnippet }`, where
   `errorKind` is `http` (got a response with status >= 400), `parse` (2xx but
   not valid JSON or missing `version`/`ranges`), or `network` (threw before a
   response: timeout, DNS, connect, TLS). Keep the first ~80 bytes of an error
   body so a Cloudflare code like `error code: 1027` shows up in the verdict.
3. **Fallback map.** If the primary fails for any reason, fetch
   `WATCH_MAP_FALLBACK_URL` (default the Pages URL above) and use it to build
   `hostList` and owned rooms. Record `mapSource: "primary" | "fallback" | null`.
   Relay probing must continue during a resolver outage.
4. **New verdict.** Precedence, highest first:
   1. `mac-offline`: no control succeeded.
   2. `all-relays-unreachable` / `some-relays-unreachable`: as today.
      (A relay failure outranks a resolver failure; the `resolver` field still
      shows the resolver state.)
   3. `resolver-error`: controls ok, and the primary resolver failed with
      `errorKind` `http` or `parse`.
   4. `map-unreachable`: controls ok, primary failed with `errorKind` `network`,
      and the fallback also failed (no hosts to probe).
   5. `ok`. Note: a primary `network` failure with a working fallback and
      healthy relays is `ok` plus a populated `resolver` field, not an alarm;
      the heartbeat's long-hold ceiling (Step 2) catches it if it persists.
5. **Drill hook.** Add `WATCH_FORCE_RESOLVER_STATUS=<code>`: when set, treat the
   primary fetch as an HTTP error with that status (body `forced by drill`)
   without making the request, then proceed to the fallback. Mirrors the
   existing `WATCH_FORCE_FAIL_HOSTS`.

Verify by hand:
```
cd ops/watch
node tick.mjs                                          # verdict ok, mapSource primary
WATCH_FORCE_RESOLVER_STATUS=429 node tick.mjs          # verdict resolver-error, mapSource fallback, hosts probed ok
WATCH_MAP_FALLBACK_URL=https://192.0.2.1/x WATCH_FORCE_RESOLVER_STATUS=429 node tick.mjs   # still resolver-error, hosts empty
```

### Step 2: `ops/watch/heartbeat.sh`

1. Treat `resolver-error` as failure-shaped: it counts toward `CONFIRM_FAILS`
   exactly like a relay failure, and the poke reads
   `TRIAGE: resolver-error (<status> <bodySnippet>) sustained for N checks`.
   Do NOT add it to the quiet-hold list on line ~95.
2. **Long-hold ceiling.** Track when a continuous run of `map-unreachable` began.
   If it has lasted longer than `WATCH_MAP_HOLD_MAX_SECONDS` (default 1800), poke
   Claude once with `TRIAGE: map-unreachable for 30+ min with controls ok`,
   then apply the normal `REPOKE_SECONDS` dedupe. Do not apply the ceiling to
   `mac-offline` (no internet really is local).
3. `RESOLVED:` fires when the verdict returns to `ok` after a `resolver-error`
   incident, same as for relays.

### Step 3: `ops/watch/PLAYBOOK.md` and `ops/watch/CLAUDE.md`

Add a section **"On a resolver-error poke"** to PLAYBOOK.md:

1. Re-run `node tick.mjs` two or three times over ~30s. If `resolver.ok` comes
   back true, it is transient: log to `state/transients.log`, no page.
2. Corroborate from the relays' own view, which is independent of this Mac:
   `./probe-relay.sh journal --host interserver1 --since '<10 min ago>' --until '<now>' | grep -a 'shardmap fetch'`
   (and `--host interserver2`). Both relays logging `shardmap fetch FAILING`
   with the same cause makes it certain.
3. `curl -si https://resolver.iterm2.com/shardmap.json | head` for the status
   and body. Known Cloudflare codes: `1027` = Workers daily request limit
   (should no longer happen with the assets-only resolver; if it does, someone
   re-added a script), `1015` = rate limited by a WAF rule.
4. If the resolver still fails from here AND at least one relay corroborates,
   page: `./notify.sh "RESOLVER DOWN" "shardmap.json HTTP <status> <snippet>; relays on last-known-good map v<N>; new pairings/reconnects may fail"`.
   Same dedupe and `state/incident-active.json` handling as a relay incident,
   with `host: "resolver"`.
5. If only this Mac sees it and both relays fetch fine, it is a Mac-path or
   edge-POP issue: log a transient, no page.

Also update the verdict list in `ops/watch/CLAUDE.md` ("How it decides") and
`ops/watch/README.md` to include `resolver-error`, the fallback map, and the
long-hold ceiling.

### Step 4: off-box monitor (`monitor/`, deployed to mcnachman.cloud)

1. **Dedicated alert.** Add `resolverAlert(detail)` in `monitor/src/monitor.js`:
   `key: "resolver"`, `severity: "critical"`, title `Shard map resolver failing`,
   body naming the URL, the error, and the impact (new pairings and reconnects
   may fail; relays run on last-known-good). Use it in `core.js` in place of
   `probeAlert(\`shard map fetch failed: ...\`)`.
2. **Fallback map in the monitor.** Add `SHARD_MAP_FALLBACK_URL` (default empty
   in code; set it to the Pages URL in `/etc/iterm2-relay-monitor.env`). When
   the primary fails, fetch the fallback and use it to drive per-host probes,
   so a resolver outage no longer blinds relay probing. The `resolver` alert
   still fires based on the PRIMARY fetch.
3. **Dashboard.** When the primary map fetch is failing, the header is `crit`
   with the resolver error shown in the banner (it already prints
   `shard map fetch failed: ...`; make the color match).
4. **Phone delivery (confirm with George before building).** The watcher's
   `notify.sh` shows the phone-push mechanism (`~/bin/it2-notify` with
   `ITERM_PUSH_TOKEN` / `ITERM_PUSH_SECRET`). Adding the same push to the
   monitor for `critical` alerts, alongside the email, would make the off-box
   vantage page the phone too. This needs the push credentials on
   mcnachman.cloud and a decision from George on whether he wants two pagers;
   ask first, do not assume.
5. **Tests.** `monitor/test/` is vitest. Add cases: primary map fails, fallback
   succeeds -> hosts are still probed and a `resolver` alert is raised after
   `ALERT_FAIL_STREAK`; both fail -> `resolver` alert, no probes, previous hosts
   kept for liveness; primary recovers -> streak resets and the alert clears.
   Update any existing test that asserts the old `probe`-keyed map alert.
6. **Deploy.** The box is NOT a git checkout. From the repo root:
   ```
   (cd monitor && npm test)
   rsync -av --delete --exclude node_modules monitor/ mcnachman.cloud:/opt/iterm2-companion-relay/monitor/
   ```
   then on the box (sudo needs a password): add `SHARD_MAP_FALLBACK_URL=...` to
   `/etc/iterm2-relay-monitor.env`, `npm ci --omit=dev` in
   `/opt/iterm2-companion-relay/monitor` if `package-lock.json` changed, and
   `sudo systemctl restart iterm2-relay-monitor`. Verify per `monitor/README.md`
   (`curl -s -H "x-monitor-key: $K" http://127.0.0.1:8791/ | jq ...`: both
   hosts `ok`, `probeOk: true`) and that https://mcnachman.cloud/fleet is green.

### Step 5: deploy and drill the Mac watcher

The watcher runs on George's Mac in `tmux -L relaywatch`, session `relay-watch`.
Editing files does not affect the running heartbeat.

1. Reload only the beat window (leaves the Claude window and its conversation
   alone):
   ```
   cd ops/watch
   tmux -L relaywatch respawn-window -k -t relay-watch:beat "$(pwd)/launch-beat.sh"
   ```
2. Drill the resolver path end to end:
   ```
   tmux -L relaywatch respawn-window -k -t relay-watch:beat \
     "bash -lc 'WATCH_FORCE_RESOLVER_STATUS=429 exec $(pwd)/launch-beat.sh'"
   ```
   Expect, within ~3 min: two `resolver-error` lines in `state/heartbeat.log`,
   then a `TRIAGE: resolver-error ...` poke in the claude window
   (`tmux -L relaywatch capture-pane -p -t relay-watch:claude`). Claude should
   find the real resolver healthy and both relays fetching fine, log a
   transient, and NOT page (the fault is forced, Mac-side only). That proves
   detection and escalation without paging.
3. Disarm:
   ```
   tmux -L relaywatch respawn-window -k -t relay-watch:beat "$(pwd)/launch-beat.sh"
   ```
   and confirm `tick ok` resumes in `state/heartbeat.log`.
4. The real page path (`notify.sh "RESOLVER DOWN" ...`) was verified for relay
   incidents on 2026-09-08; no need to send a real page unless George asks.

## Out of scope

- The resolver's request volume. It no longer costs anything (static assets are
  unlimited), but Cloudflare analytics for `resolver.iterm2.com` would show
  whether clients poll far more than the design's expected rate. Worth a look,
  separately.
- relay2 is still on code older than 14e410c (shard-map retry); deploy with
  `SSH_USER=gnachman ops/deploy-remote.sh interserver2 --update` when convenient.

## Done when

- [ ] Step 0 findings recorded (did the monitor email go out?).
- [ ] `tick.mjs` returns `resolver-error` for a forced 429 and still probes
      relays via the Pages fallback.
- [ ] Heartbeat escalates `resolver-error` after 2 checks and caps a
      `map-unreachable` hold at 30 min.
- [ ] PLAYBOOK.md, CLAUDE.md, README.md in `ops/watch/` updated.
- [ ] Monitor raises a `resolver`-keyed critical alert, probes via the fallback,
      tests pass, deployed, fleet dashboard green.
- [ ] Watcher drill run: TRIAGE poke arrives, no page, disarmed, `tick ok`.
- [ ] Phone delivery for the monitor: decided with George (built or declined).
