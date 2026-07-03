# iterm2-relay-monitor

A scheduled **Cloudflare Worker** that watches the self-hosted relay and emails
you when something is wrong. It never touches user data — the relay pushes only
aggregate, PII-free counts (the same numbers `/metrics` exposes locally), so this
preserves the relay's zero-retention posture.

## How it works (push, not scrape)

The relay is a Node process behind Cloudflare, not a Worker, so there's nothing
to query in Cloudflare Analytics. Instead the data flows **outbound** from the
relay, which means the relay exposes **no** metrics endpoint to the internet and
never reveals its origin hostname:

```
relay  ──POST snapshot + Bearer INGEST_TOKEN──▶  Worker /ingest  ──▶  KV (latest)
                                                      │
                       cron every 5 min ─────────────┤
                                                      ▼
                              read KV → diff → analyze → Resend email
```

The relay pushes a snapshot every ~60s (`RELAY_METRICS_PUSH_*`, see the relay's
`SELF-HOSTING.md`). A cron run every 5 minutes diffs the latest snapshot against
the previous one and raises alerts.

## Two layers: push (inside-out) + probe (outside-in)

The push tells you the relay **process** is alive and reporting. But that alone
can't tell you a phone can actually **pair** — the snapshot travels relay →
Cloudflare and never exercises the inbound path (DNS, Cloudflare edge, origin
firewall, proxy, WS upgrade, admission). A relay can be up and pushing while
every pairing fails.

So each cron run also does an **outside-in synthetic probe**: it opens a real
WebSocket to the relay's public origin and drives a mac-park pairing handshake,
exactly as a client would. Success means the whole serving path works; failure
(`probe` alert) means inbound is broken even though the process is up. A fresh
random room is used each time, so it never touches a real pairing. Set
`RELAY_PROBE_URL` to enable it (unset = push-only).

## What it alerts on

| Alert | Layer | Condition |
|---|---|---|
| **Liveness** (dead-man's-switch) | push | No fresh snapshot within `STALE_MINUTES`. A down/wedged relay stops pushing, so silence is the signal. |
| **Handshake** (`probe`) | probe | The synthetic mac-park handshake to `RELAY_PROBE_URL` failed — the inbound serving path is broken. |
| **Capacity** | push | Live sockets/rooms cross `CAP_WARN_FRAC` / `CAP_CRIT_FRAC` of the configured caps. |
| **Error rate** | push | HTTP 500s / requests over the interval exceeds `ERROR_RATIO` (with a volume floor). |
| **Exceptions** | push | Swallowed process exceptions over the interval reach `EXCEPTION_THRESHOLD`. |
| **Traffic anomaly** | push | Hourly request volume ≥ `SPIKE_FACTOR`× or ≤ `DROP_FACTOR`× the per-hour-of-week baseline. |

Probe coverage caveat: a fresh mac-park skips App Attest, and the probe doesn't
drive the phone half or the splice — so it catches the big inbound outages (DNS,
Cloudflare, firewall, proxy, upgrade, basic admission), not attestation- or
phone-specific breakage.

Alerts are deduped with a per-condition cooldown (`COOLDOWN_MINUTES`); an
escalation from warning to critical bypasses the cooldown, and a condition that
clears re-pages if it recurs.

## Deploy

```sh
cd monitor
npm install
wrangler kv namespace create MONITOR_KV     # paste the id into wrangler.jsonc
wrangler secret put INGEST_TOKEN            # shared with the relay's RELAY_METRICS_PUSH_TOKEN
wrangler secret put RESEND_API_KEY          # https://resend.com
wrangler secret put MANUAL_TRIGGER_SECRET   # any random string; gates the dry-run/test endpoints
# edit wrangler.jsonc vars: ALERT_FROM (a Resend-verified domain), ALERT_TO,
#   RELAY_PROBE_URL (your relay's public origin), caps
npm run deploy
```

Then point the relay at it — in the relay's env file:

```sh
RELAY_METRICS_PUSH_URL=https://iterm2-relay-monitor.<your-subdomain>.workers.dev/ingest
RELAY_METRICS_PUSH_TOKEN=<the same value as INGEST_TOKEN>
# RELAY_METRICS_PUSH_MS=60000   # optional; default 60s
```

## Verify after deploy

```sh
# Dry run: fetch + analyze the latest snapshot, no email, no state write.
curl -s -H "x-monitor-key: $MANUAL_TRIGGER_SECRET" https://<worker-url>/ | jq

# Send a real test email end to end (checks the Resend path).
curl -s -H "x-monitor-key: $MANUAL_TRIGGER_SECRET" "https://<worker-url>/?test=1"
```

The dry run's `ageMs` shows how long ago the last snapshot arrived — a small
number means pushes are flowing. Right after deploying the relay side, wait ~60s
for the first push before expecting a snapshot.

## Test

```sh
npm test    # pure analysis core (src/monitor.js), no network
```

## Layout

- `src/monitor.js` — pure analysis: liveness, capacity, error, exception, and
  anomaly checks; interval diffing; cooldown. Fully unit-tested.
- `src/worker.js` — I/O shell: `/ingest`, KV, the cron trigger, Resend email.
- `wrangler.jsonc` — cron schedule, KV binding, and tunable thresholds.
