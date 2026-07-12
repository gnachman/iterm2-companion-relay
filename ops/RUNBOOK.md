# Monitor alerts — incident runbook

What to do when the relay monitor emails you, and the facts you need to triage
fast. Covers the alert classes the monitor (`monitor/`) can send and the
diagnostics that actually distinguish them.

> ⚠️ **Redacted for a public repo.** Identifying values — the relay's public
> origin, the monitor's `workers.dev` URL, the KV namespace id, the alert email —
> are placeholders (`<relay-origin>`, `<monitor-url>`, `<kv-id>`, `<alert-email>`).
> Substitute your own. Your live copy of `monitor/wrangler.jsonc` holds the real
> ones and is `skip-worktree` so they never get committed (see
> [Config lives locally](#config-lives-locally)).

---

## Architecture in one picture

```
  relay (Node, VPS) ──outbound push every 4 min──▶ monitor Worker /ingest ──▶ KV "latest"
   │  bin/relay.js                                  (Cloudflare, free plan)      │
   │  host/metricspush.js                                                        │
   │                                    cron */5 ──▶ reads "latest", analyzes ───┘
   │                                                 emails on liveness/cap/errors/
   │                                                 exceptions/anomaly
   │
   └──loopback /metrics (127.0.0.1:8788)──▶ on-box dashboard (independent path)
```

Two things to internalize:

- **The relay is self-hosted** (a Node process behind Cloudflare), **not** the
  old Cloudflare Worker. The monitor watches the VPS relay via *pushed* metrics.
  An older Analytics-based monitor used to live in the `iterm2` repo under
  `Companion/RelayMonitor/`; it has been deleted — see [History: the old
  monitor](#history-the-old-monitor).
- **The push path and the dashboard path are independent.** The dashboard scrapes
  the relay's loopback `/metrics` locally, so it keeps working even when the
  outbound push to the monitor is failing. That split is a diagnostic lever
  (below).

---

## Alert: "Relay not reporting" (liveness / dead-man's-switch)

> `[CRITICAL] Relay not reporting` — *No fresh metrics from the relay: no snapshot
> for N min. The relay process or its host may be down.*

This means the monitor's stored snapshot went stale (`> STALE_MINUTES` old). It
fires on a **real relay/host outage** *or* on **the outbound push failing while
the relay is fine**. Distinguish them before assuming an outage — the second is
more common and looks identical from Cloudflare's side.

### Triage, in order

**1. Is the relay process actually up?**

```bash
systemctl status iterm2-companion-relay-cf     # active (running)?
ps -o pid,etime,cmd -C node | grep relay.js     # note the PID + uptime
```

A stable PID with long uptime = **the process never restarted**, so this is not a
crash. `Restart=always` means a crash would show a *recent* start time.

**2. Is it serving users right now?** Hit the loopback metrics (always available
if the process is healthy; never exposed to the internet):

```bash
curl -s http://127.0.0.1:8788/metrics | grep -E \
  'relay_sockets_live|relay_rooms_live|relay_ws_upgrades_total|relay_process_exceptions_total|relay_metrics_push_errors_total'
```

- `relay_sockets_live` / `relay_rooms_live` nonzero and `relay_ws_upgrades_total`
  climbing over a few seconds ⇒ **the relay is up and serving**. The alert is a
  *reporting* problem, not an outage. Go to step 3.
- Connection refused / no response ⇒ the relay really is down. Check
  `journalctl -u iterm2-companion-relay-cf` (needs root) for the crash, and
  `relay_process_exceptions_total` history in the dashboard.

**3. Are the outbound pushes failing?** Watch the push-error counter for ~2 min
(pushes happen every 4 min; the counter should be flat):

```bash
for i in 1 2 3; do curl -s http://127.0.0.1:8788/metrics \
  | awk '/^relay_metrics_push_errors_total /{print systime(), $2}'; sleep 60; done
```

Counter **climbing ~once per push interval ⇒ ~100% of pushes are failing.** The
relay only *counts* failures (`host/server.js`: `onError: () =>
metrics.inc("metrics_push_errors_total")`) — it never logs the reason (logless
posture), so the reason must come from the monitor side (step 4).

**4. Why are pushes failing? Ask the monitor.** Observability is ON for the
monitor Worker, so tail it and reproduce:

```bash
cd monitor && wrangler tail iterm2-relay-monitor      # then trigger one push (below)
```

Then reproduce a single push from the VPS with the real URL + token (needs root
to read the env):

```bash
sudo bash -c 'set -a; . /etc/iterm2-companion-relay-cf.env;
  curl -sS -X POST "$RELAY_METRICS_PUSH_URL" \
    -H "authorization: Bearer $RELAY_METRICS_PUSH_TOKEN" \
    -H "content-type: application/json" -d "{\"ts\":0}" \
    -o /dev/null -w "HTTP %{http_code}\n"'
```

Read the status code:

| Code | Meaning | Fix |
|------|---------|-----|
| **500** + tail shows `KV put() limit exceeded for the day` | **KV free-tier write cap hit** (the incident below) | slow the push cadence — see fix |
| **500** + tail shows `Cannot read properties of undefined` | `MONITOR_KV` binding missing/broken | fix the KV binding id in `wrangler.jsonc`, redeploy |
| **401** | token mismatch: relay's `RELAY_METRICS_PUSH_TOKEN` ≠ monitor's `INGEST_TOKEN` secret | re-`wrangler secret put INGEST_TOKEN` or fix the relay env |
| **404** | wrong URL/path (must end `/ingest`) or wrong worker | fix `RELAY_METRICS_PUSH_URL` |
| **000 / could not resolve** | DNS/egress to the monitor host | check the `<subdomain>` in the URL; confirm VPS egress to `workers.dev` |
| **204** | the push actually works | failure is intermittent/network-timing; widen `STALE_MINUTES` |

### Known root cause #1 — KV free-tier write cap (the July 2026 incident)

**Symptom:** one `Relay not reporting` email, arriving the same time each day;
relay healthy and serving throughout; `wrangler tail` shows
`Error: KV put() limit exceeded for the day` on `POST /ingest`.

**Cause:** the Workers **free plan caps KV at 1000 writes/day, account-wide**
(shared with every other Worker/KV on the account). The monitor writes one KV
entry per push. At the old 60 s cadence that's **1440 writes/day** from pushes
alone, plus ~288/day from the `*/5` cron's state write ≈ **1728/day** — well over
the cap. Each day's quota is spent mid-day; from then on every `/ingest` PUT
throws 500, the stored snapshot stops advancing, it goes stale, and the
dead-man's-switch pages. Quota resets at **00:00 UTC**, so it "recovers" every
night and re-breaks every day.

**Why only one email despite an all-day outage:** `COOLDOWN_MINUTES=360` (6 h)
suppresses repeats of the same alert key. A persistent condition pages once, then
goes quiet — silence after a liveness alert does **not** mean resolved.

**Fix — slow the push to stay under the cap:**

| Setting | Where | Value | Writes/day |
|---------|-------|-------|-----------|
| `RELAY_METRICS_PUSH_MS` | relay env (`/etc/iterm2-companion-relay-cf.env`) | `240000` (4 min) | 360 (push) |
| `STALE_MINUTES` | `monitor/wrangler.jsonc` | `9` | — |

New total ≈ **648 writes/day** (push + cron), leaving headroom under 1000 for
other projects. Trade-off: a genuinely dead relay is now detected in up to
~14 min (`STALE_MINUTES` 9 + up to 5 min for the next cron) instead of ~6.

Rules of thumb:
- `STALE_MINUTES` **must exceed** the push interval by a comfortable margin, or
  normal jitter false-alarms. 4-min push ↔ 9-min stale is the tuned pair.
- If other Workers projects on the account are write-heavy, or you want to keep
  the tight 60 s cadence / ~6-min detection, **upgrade to Workers Paid ($5/mo)** —
  KV goes to 1M writes/day and this class of problem disappears with no code
  change.

**Apply the fix:**

```bash
# Relay (VPS, root):
sudo sed -i 's/^RELAY_METRICS_PUSH_MS=.*/RELAY_METRICS_PUSH_MS=240000/' \
  /etc/iterm2-companion-relay-cf.env \
  || echo 'RELAY_METRICS_PUSH_MS=240000' | sudo tee -a /etc/iterm2-companion-relay-cf.env
sudo systemctl restart iterm2-companion-relay-cf

# Monitor (from the machine you deploy from): set STALE_MINUTES to "9" in
# monitor/wrangler.jsonc (it's skip-worktree — edit by hand, see below), then:
cd monitor && wrangler deploy
```

The current day stays blind until the next 00:00 UTC reset regardless — the new
cadence just keeps you under the cap from then on.

---

## Alert: "Relay handshake failing" (synthetic probe)

The monitor also opens a **real WebSocket to the relay's public origin**
(`RELAY_PROBE_URL`) each cron run and drives a mac-park handshake. This alert
means that outside-in path is broken **even if the relay is up and pushing** —
i.e. the inbound serving chain (DNS → Cloudflare → origin firewall → reverse
proxy → WS upgrade → admission) is failing where the metrics push can't see it.

- **Liveness fired but probe did NOT** ⇒ the process/push side is the problem;
  inbound serving is fine (this was true in the July 2026 incident).
- **Probe fired but liveness did NOT** ⇒ process is up and pushing, but users
  can't connect. Check the origin firewall (`ops/cloudflare-origin-firewall.sh`,
  which pins inbound to current Cloudflare IPs and goes stale as those rotate),
  the reverse proxy, and DNS/proxy status for `<relay-origin>`.

---

## Other alerts (brief)

- **Capacity** (`Live sockets/rooms near cap`): approaching
  `SOCKETS_CAP`/`ROOMS_CAP`. Confirm on the dashboard; raise
  `RELAY_MAX_TOTAL_SOCKETS`/`RELAY_MAX_ROOMS` (and the monitor caps to match) or
  investigate a leak/abuse.
- **Error rate** (`Error rate N%`): HTTP 500s over the interval past
  `ERROR_RATIO` with an `ERROR_MIN_REQUESTS` floor. Check the dashboard for the
  spike; correlate with a deploy.
- **Process exceptions** (`Process exceptions: N`): the relay swallowed
  process-level exceptions to keep serving. Nonzero between checks is worth a
  look even though it self-recovered.
- **Traffic anomaly** (`Traffic spike/drop`): hourly requests vs the per-hour-of-
  week baseline. A **drop** can be an early outage signal; a **spike** can be
  abuse. Silent until the baseline has `MIN_SAMPLES` weeks — expect no anomaly
  alerts for the first couple of weeks after deploy.

---

## Not an alert: a user can't connect / client logs "1008 daily quota exceeded"

This one does **not** page. The relay process is healthy and keeps pushing, so
both liveness and the synthetic probe stay green — it surfaces instead as a
**user report** ("my Mac won't connect") whose client logs show the relay
closing the WebSocket with close code **1008**, reason **`daily quota
exceeded`**.

**Root cause.** Each room has a per-room **daily byte quota**: relayed bytes per
rolling 24h, code default **512 MiB** (`RELAY_DAILY_BYTE_QUOTA`, enforced in
`src/room.js` `overQuota`). A live terminal-sharing session (video stream +
history tiles) can blow 512 MiB in one long sitting. Once a room crosses the cap
it is torn down — **every** socket in that room is closed with `1008 daily quota
exceeded` — and the byte count is **persisted**, so the room keeps refusing until
its 24h window rolls. The relay sees only ciphertext; the cap is purely
abuse/cost protection, not correctness.

**Why it doesn't self-heal.** Neither app treats 1008 as terminal today: both
reconnect on a backoff, immediately relay a frame, re-trip the still-exhausted
quota, and get closed again — a silent all-day retry loop until the window resets
or the cap is raised. (App-side handling is tracked separately.)

**Triage.**

1. **Dashboard:** the **Quota closes** tile and **Quota closes /min** chart are
   nonzero and climbing. The counter increments once per
   severed socket, so a client stuck in the retry loop makes it ramp steadily —
   that ramp is the tell that someone is pinned against the cap right now.
2. **On the box**, find the offending room and when its window resets. `bytes`
   near the limit is the culprit; the window resets at `dayStart + 24h`:

   ```sh
   DB=$(sudo grep -E '^RELAY_DB=' /etc/iterm2-companion-relay-cf.env | cut -d= -f2-)
   sudo sqlite3 -readonly "$DB" \
     "SELECT room, json_extract(value,'\$.bytes') AS bytes,
             datetime(json_extract(value,'\$.dayStart')/1000,'unixepoch') AS window_start
      FROM kv WHERE key='quota' ORDER BY bytes DESC LIMIT 15;"
   ```

   `room` is an opaque hash, not the room name (zero PII).

**Fix.** Raise the cap and restart. The persisted byte count is then below the
new limit, so the room recovers on its **next frame** — no need to wait out the
window:

```sh
sudo sed -i -E '/^#?[[:space:]]*RELAY_DAILY_BYTE_QUOTA=/d' /etc/iterm2-companion-relay-cf.env
echo 'RELAY_DAILY_BYTE_QUOTA=8589934592' | sudo tee -a /etc/iterm2-companion-relay-cf.env   # 8 GiB
sudo systemctl restart iterm2-companion-relay-cf
```

Production runs **8 GiB** (carried in `ops/relay.env.example`); raise further if
legitimate sessions still hit it.

---

## Reference facts (the gotchas that cost time)

### Config lives locally

`monitor/wrangler.jsonc` is committed as a **sanitized template** (placeholder KV
id, `example.com` emails, empty `RELAY_PROBE_URL`) and flagged **`skip-worktree`**
so your real values never show as a diff or get committed. Consequences:

- **Never `git add` it / never clear the flag** — that would bake the KV id, your
  alert email, and the relay's public origin into public history.
- Edits to it (like `STALE_MINUTES`) don't travel via `git commit`/`git pull`.
  Change per-deploy values **by hand on the machine you deploy from**.
- Check the flag with `git ls-files -v monitor/wrangler.jsonc` (`S` = skip-
  worktree). See what it's hiding with
  `diff <(git show HEAD:monitor/wrangler.jsonc) monitor/wrangler.jsonc`.
- The *rationale and defaults* that are safe to publish go in
  `ops/relay.env.example`, which is a normal tracked file.

### History: the old monitor

There used to be a second monitor — `iterm2/Companion/RelayMonitor/`,
Analytics-based (Cloudflare GraphQL), watching the retired Cloudflare **Worker**
relay. It deployed to the **same Worker name** (`iterm2-relay-monitor`) and the
**same KV namespace id** as this one, so a `wrangler deploy` from that directory
would silently replace this push-based monitor with the wrong one. It has been
**deleted** (recoverable from the `iterm2` repo history). If you ever see a
monitor that does *not* emit **"no snapshot for N min"** on a relay outage, you're
looking at that old Analytics-based worker resurrected — this push-based one is
the only one that should be deployed under that name.

### Where things are

| Thing | Location |
|-------|----------|
| Relay process | `iterm2-companion-relay-cf.service` → `bin/relay.js` |
| Relay env (real secrets) | `/etc/iterm2-companion-relay-cf.env` (root) |
| Relay loopback metrics | `http://127.0.0.1:8788/metrics` |
| Relay SQLite state (per-room quota/tickets) | `$RELAY_DB` (opaque room hashes; zero PII) |
| Outbound push code | `host/metricspush.js`, wired in `host/server.js` |
| On-box dashboard | `iterm2-relay-dashboard.service` → `bin/dashboard.js` (SQLite, loopback) |
| Monitor Worker | `monitor/` → `wrangler tail iterm2-relay-monitor` |
| Monitor analysis (unit-tested, pure) | `monitor/src/monitor.js` |

### Key constants (defaults)

- Push cadence: `RELAY_METRICS_PUSH_MS` = 240000 (4 min). One KV write each.
- Staleness window: `STALE_MINUTES` = 9. Cron cadence: `*/5` (5 min).
- Alert cooldown: `COOLDOWN_MINUTES` = 360 (6 h); escalation warn→critical bypasses
  it.
- KV free-plan write cap: **1000/day, account-wide.** Budget: push (360) + cron
  (288) ≈ 648/day.
- Per-room daily byte quota: `RELAY_DAILY_BYTE_QUOTA` = **8 GiB** in prod (code
  default 512 MiB). Trips → `1008 daily quota exceeded`, persisted for the rolling
  24h window; surfaced by the dashboard's **Quota closes** tile/chart
  (`relay_quota_exceeded_total`). See the quota section above.
