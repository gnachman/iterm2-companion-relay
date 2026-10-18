# iterm2-relay-monitor

A small **self-hosted Node service** that watches the relay and emails you when
something is wrong. Run it on a Linux box you control, ideally a **different
hosting provider from the relays**, so one provider's outage can't take down both
the relay and the thing that's supposed to notice.

It never touches user data: the relay pushes only aggregate, PII-free counts (the
same numbers `/metrics` exposes locally), so this preserves the relay's
zero-retention posture.

> **Why it moved off Cloudflare.** This used to be a scheduled Cloudflare Worker
> backed by KV. The relay's ~1/min metrics push was one KV write each, and the KV
> free tier caps writes at ~1000/day, so the monitor ran out of quota every
> afternoon and emailed *about that*. A local file has no write cap, so that whole
> class of noise is gone, and there's no Cloudflare in the loop.

## How it works (push, not scrape)

Data flows **outbound** from each relay, so relays expose **no** metrics endpoint
to the internet. One monitor watches the whole fleet: each relay pushes to its own
`/ingest/<host>` sub-path, keyed by host so per-relay analysis stays separate.

```
relay1 ──POST + Bearer──▶ /ingest/relay1.iterm2.com ──▶ latest:relay1…json
relay2 ──POST + Bearer──▶ /ingest/relay2.iterm2.com ──▶ latest:relay2…json
                                                     │
        internal timer every 5 min ─▶ fetch shard map; for each host:
                                        diff push → analyze + owned-room probe
                                                     ▼
                                          consolidated Resend email
```

The **shard map is the source of truth for which hosts exist.** Each tick the
monitor fetches it (`SHARD_MAP_URL`) and, for every host it names, checks push
freshness + gauges/counters and drives an inbound probe. **Adding a relay is zero
monitor config:** put it in the map and point its push at `/ingest/<host>`; the
monitor discovers it and starts watching. (Without `SHARD_MAP_URL` it degrades to a
single direct-mode relay that pushes to bare `/ingest`.)

## Mirrors (pull mode)

So `/fleet` survives the primary monitor's box going down, more monitors can run
on other boxes. A mirror can't rely on pushes (each relay pushes to one URL), so
it **pulls** instead: with `RELAY_PULL_URL_TEMPLATE=https://{host}/metrics` it
fetches every map host's `/metrics` once a minute (`RELAY_PULL_MS`) and stores the
result under the same `latest:<host>` key a push would, so every check works
unchanged and a scrape that fails shows up as the usual "not reporting". A relay
serves `/metrics` publicly only behind basic auth (`RELAY_PULL_BASIC_AUTH`), via a
Caddy snippet in `/etc/caddy/relay.d/` (see `ops/deploy-vps.sh`).

Set `ALERT_EMAIL=off` on a mirror so one outage isn't emailed once per monitor;
alerts still show on its dashboard. `MONITOR_LABEL` names the monitor in the
dashboard header. `ops/deploy.sh <ssh-host>` installs or updates the committed
`monitor/` on a box.

## Two layers: push (inside-out) + probe (outside-in)

The push tells you the relay **process** is alive and reporting, but not that a
phone can actually **pair** - the snapshot travels relay → monitor and never
exercises the inbound path (DNS, TLS, origin firewall, proxy, WS upgrade,
admission). A relay can be up and pushing while every pairing fails.

So each tick also does an **outside-in synthetic probe**: it opens a real
WebSocket to each host's public origin and drives a mac-park pairing handshake,
exactly as a client would. Success means the whole serving path works; failure
(`<host>|probe` alert) means that host's inbound is broken even though its process
is up. In fleet mode the probe uses a room the target host **owns** (built from the
shard map): a sharded relay correctly answers HTTP 421 for rooms outside its slice,
so a random room would false-page against a host owning a small slice. Every probe
uses a fresh throwaway room, so it never touches a real pairing.

## What it alerts on

| Alert | Layer | Condition |
|---|---|---|
| **Liveness** (dead-man's-switch) | push | No fresh snapshot within `STALE_MINUTES`. A down/wedged relay stops pushing, so silence is the signal. |
| **Handshake** (`<host>\|probe`) | probe | The synthetic mac-park handshake to a host failed - that host's inbound serving path is broken. A map that can't be fetched pages once as `probe`. |
| **Capacity** | push | Live sockets/rooms cross `CAP_WARN_FRAC` / `CAP_CRIT_FRAC` of the configured caps. |
| **Error rate** | push | HTTP 500s / requests over the interval exceeds `ERROR_RATIO` (with a volume floor). |
| **Exceptions** | push | Swallowed process exceptions over the interval reach `EXCEPTION_THRESHOLD`. |
| **Shard-map fetch** | push | Distributed mode: the relay can't refresh the shard map (`SHARD_FETCH_THRESHOLD`). Always 0 in direct mode. |
| **Traffic anomaly** | push | Hourly request volume ≥ `SPIKE_FACTOR`× or ≤ `DROP_FACTOR`× the per-hour-of-week baseline. |

Probe coverage caveat: a fresh mac-park skips App Attest, and the probe doesn't
drive the phone half or the splice - so it catches the big inbound outages (DNS,
TLS, firewall, proxy, upgrade, basic admission), not attestation- or
phone-specific breakage.

The three vantage-sensitive checks (**Liveness**, **Handshake**, and the
map-fetch `probe`) page from the monitor's own network position, so a transient
blip on the monitor's uplink or the monitor→relay path can false-page even while
the relay serves real users fine. They are debounced: a page requires
`ALERT_FAIL_STREAK` **consecutive** failing ticks (default 2, so ~10 min at the
5-min tick), and one success resets the streak. The push-derived checks
(capacity, error rate, exceptions, anomaly) come from the relay's own metrics and
fire on the first tick. Set `ALERT_FAIL_STREAK=1` for the old immediate behavior.

Alerts are then deduped with a per-condition cooldown (`COOLDOWN_MINUTES`); an
escalation from warning to critical bypasses the cooldown, and a condition that
clears re-pages if it recurs.

## Deploy

On the monitoring box (Debian/Ubuntu shown; Node 20+ and Caddy assumed):

```sh
sudo mkdir -p /opt/iterm2-relay-monitor
# copy this monitor/ directory there (git clone the repo, or scp/rsync), then:
cd /opt/iterm2-relay-monitor
sudo npm ci --omit=dev

# config + secrets
sudo cp monitor.env.example /etc/iterm2-relay-monitor.env
sudo $EDITOR /etc/iterm2-relay-monitor.env   # set INGEST_TOKEN, RESEND_API_KEY,
                                             # ALERT_*, MANUAL_TRIGGER_SECRET,
                                             # SHARD_MAP_URL (fleet) or RELAY_PROBE_URL
                                             # (single relay), caps

# service
sudo cp ops/iterm2-relay-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now iterm2-relay-monitor

# TLS front door: reverse-proxy /ingest here (one route covers all relays).
sudo cp ops/Caddyfile.example /etc/caddy/Caddyfile   # edit the hostname, merge into yours
sudo systemctl reload caddy
```

Generate the shared secret with `openssl rand -hex 32`. Then point each relay at
this box - in the relay's env file (host in the path, so the monitor keys it):

```sh
RELAY_METRICS_PUSH_URL=https://monitor.yourdomain.com/ingest/relay1.iterm2.com
RELAY_METRICS_PUSH_TOKEN=<the same value as INGEST_TOKEN>
# RELAY_METRICS_PUSH_MS=60000   # optional; a local file has no KV write cap, so
                                # 60s is fine again (KV had forced 240000).
```

**Adding a relay later needs no change here:** put it in the shard map and point
its push at `.../ingest/<its-host>`. The monitor picks it up from the map on the
next tick (liveness + probe), and the one `/ingest` proxy route already covers it.

### Run it without systemd / for local testing

```sh
cp monitor.env.example monitor.env   # fill in; gitignored
npm start monitor.env                # or: node src/server.js monitor.env
```

## Verify after deploy

```sh
# Dry run: fetch + analyze the latest snapshot, no email, no state write.
curl -s -H "x-monitor-key: $MANUAL_TRIGGER_SECRET" https://monitor.yourdomain.com/ | jq

# Send a real test email end to end (checks the Resend path).
curl -s -H "x-monitor-key: $MANUAL_TRIGGER_SECRET" "https://monitor.yourdomain.com/?test=1"
```

The dry run's `ageMs` shows how long ago the last snapshot arrived - a small
number means pushes are flowing. Right after first bringing up the relay side,
wait one push interval for the first snapshot; until then the monitor reports
"relay not reporting" (expected on a brand-new box).

## Fleet dashboard

A single at-a-glance health page for the whole fleet, served by the monitor at
**`GET /dashboard`** (HTTP Basic auth; any username, password = `MANUAL_TRIGGER_SECRET`).
One color-coded card per relay (green ok / amber degraded / red down or
inbound-failing) with just the essentials - last-seen, live sockets/rooms, owned
buckets, inbound probe - plus an "X of Y healthy" header. Liveness and gauges are
recomputed live on each load (no re-probing); the probe result is as of the last
tick. Auto-refreshes every 30s. To spare a screen that leaves it open, it switches
between light and dark every 30 minutes on the clock (ignoring the OS setting),
so every monitor flips at the same moment.

**Click a card** to open that shard's own detailed dashboard. The link comes from
`DASHBOARD_URL_TEMPLATE` (default `https://{host}/dashboard/`, matching the managed
fleet); set it empty to disable the links.

Reach it either by adding one reverse-proxy route (e.g. Apache
`ProxyPass /fleet http://127.0.0.1:8790/dashboard`) or, with no server change, an
SSH tunnel:

```sh
ssh -L 8790:127.0.0.1:8790 <monitor-host>    # then open http://localhost:8790/dashboard
```

## Test

```sh
npm test    # vitest: pure analysis core + the store, HTTP, ws-probe, and dashboard
```

## Layout

- `src/monitor.js` - pure analysis: liveness, capacity, error, exception, shard,
  and anomaly checks; interval diffing; cooldown. No I/O.
- `src/core.js` - one tick's orchestration (state in, checks, delivery out), with
  storage / probe / email injected so it stays unit-tested without a network.
- `src/store.js` - the on-disk key/value store (atomic JSON files) that replaced KV.
- `src/server.js` - the Node I/O shell: the HTTP server (`/ingest` + operator
  endpoints), the analysis timer, the real `ws` probe, and Resend email.
- `monitor.env.example` - all config + secrets, documented inline.
- `ops/iterm2-relay-monitor.service` - hardened systemd unit.
- `ops/Caddyfile.example` - TLS front door for `/ingest`.
