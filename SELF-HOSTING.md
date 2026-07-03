# Self-hosting the iTerm2 companion relay

The companion relay is the middle box that lets your Mac and your phone find
each other. It splices the two together through a pair of outbound WebSockets
and **sees only ciphertext** — it never holds your keys, terminal contents, or
anything readable. Admission is gated by Ed25519 join signatures and Apple App
Attest, so only your own paired devices can use a room.

You might self-host it because you want the traffic to flow through
infrastructure you control, or because you don't want to depend on someone
else's instance. This guide covers standing up your own.

There are two shapes of deployment, and they are **not** mutually exclusive —
the second is the first with Cloudflare added in front:

| | **Path A — VPS only** | **Path B — VPS behind Cloudflare** |
|---|---|---|
| What runs the relay | A Node process on your VPS | Same Node process on your VPS |
| TLS to clients | Let's Encrypt (via Caddy) | Cloudflare terminates; origin uses a CF Origin CA cert |
| Origin IP | Public | Hidden behind Cloudflare |
| DDoS protection | None (your VPS absorbs it) | Cloudflare's free unmetered L3/4 |
| Cost | Just the VPS | Just the VPS (Cloudflare's proxy is $0) |
| Extra setup | None | Proxied DNS record + origin firewall |

Pick **Path A** if you just want it working and aren't worried about attack
traffic. Pick **Path B** if you want your origin IP hidden and free DDoS
absorption. You can start with A and add Cloudflare later without touching the
relay itself.

> **What about deploying to Cloudflare Workers?** This relay originally ran as a
> Cloudflare Worker + Durable Object, and that code still lives in the git
> history. It was retired because Durable Objects bill **per connection**, and a
> phone or Mac that flaps its network generates hundreds of reconnects an hour —
> which turns into a surprising bill. On a VPS a reconnect is a TLS handshake
> plus one signature check, effectively free, so flapping is just a diagnostic
> signal instead of a cost. If you have a stable client and want zero-ops
> hosting, the Workers path may still suit you, but it is not what this repo
> ships today. Everything below is the VPS relay.

---

## What you need

- A small VPS (any provider; the relay is tiny — a shared/1-core box is plenty).
- **Node 20 LTS** on it (`node -v` → `v20.x`).
- A DNS name you control that will point at the relay, e.g.
  `relay.example.com`. This name is load-bearing: it gets bound into every join
  handshake, so it must exactly match what your devices connect to (more below).
- Root/sudo on the VPS.

You do **not** need to build or publish an iOS app. The relay verifies Apple App
Attest for the existing iTerm2 companion app; `APP_ID` is preconfigured for it.

---

## 1. Install

```sh
sudo mkdir -p /opt/iterm2-companion-relay
sudo chown "$USER" /opt/iterm2-companion-relay
git clone https://github.com/gnachman/iterm2-companion-relay /opt/iterm2-companion-relay
cd /opt/iterm2-companion-relay

npm ci --omit=dev     # installs ws + better-sqlite3 (prebuilt binary, no compiler needed)
npm test              # optional but recommended: the full suite runs in plain Node
```

State (your established pairings) lives in a single SQLite file and survives
restarts, so there's no database to provision.

---

## 2. Configure

```sh
sudo cp ops/relay.env.example /etc/iterm2-companion-relay.env
sudo chmod 600 /etc/iterm2-companion-relay.env
sudoedit /etc/iterm2-companion-relay.env
```

The two settings you must get right:

- **`RELAY_ORIGIN`** — the public HTTPS origin your devices will connect to,
  e.g. `https://relay.example.com`. This is bound into join transcripts and the
  App Attest `clientDataHash`, so if it doesn't match the URL the devices
  actually use, **every pairing is rejected**. No trailing slash, include
  `https://`.

- **Proxy trust** — pick exactly one, matching your path, so per-IP rate limits
  key on the *real* client and can't be spoofed:
  - **Path A (Caddy, no Cloudflare):** `RELAY_TRUST_PROXY=true`. The relay trusts
    `X-Forwarded-For` (Caddy overwrites it with the real peer) and ignores any
    client-supplied `CF-Connecting-IP`.
  - **Path B (behind Cloudflare):** `RELAY_TRUST_CLOUDFLARE=true` *instead*. The
    relay trusts `CF-Connecting-IP`, which only Cloudflare can set — provided you
    apply the origin firewall (step 4B) so nobody can reach the origin directly
    and forge it.

  Set **exactly one**. Never enable a trust flag for a header your proxy doesn't
  authoritatively set — that reopens per-IP-cap evasion. With neither set, every
  client shares one rate-limit bucket (one abuser then throttles everyone), and
  the process warns loudly at startup.

Sensible defaults cover everything else. Notable optional knobs (see the env
file for the full list):

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_HOST` / `RELAY_PORT` | `127.0.0.1` / `8787` | Localhost bind; the proxy reaches it here. |
| `ATTEST_REQUIRED` | `true` | Require App Attest for *fresh* pairings. Leave on. |
| `RELAY_ESTABLISHED_IDLE_TTL_MS` | 30 days | Unused pairings are reaped after this. |
| `RELAY_LOG` | `false` | Zero-retention by default. `true` only to debug. |
| `RELAY_KEEPALIVE_MS` | `30000` | Server-side WebSocket ping interval. |

---

## 3. Run it under systemd

```sh
sudo cp ops/iterm2-companion-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now iterm2-companion-relay
systemctl status iterm2-companion-relay
```

The unit runs the relay as a locked-down `DynamicUser`, keeps its SQLite file in
`/var/lib/iterm2-companion-relay/`, restarts on crash, raises the file-descriptor
limit for many idle sockets, and forwards `SIGTERM` to the process's graceful
shutdown.

Confirm it's listening on localhost:

```sh
curl -s localhost:8787/metrics | head
```

---

## 4. TLS and the reverse proxy

The Node process listens on localhost only; a reverse proxy terminates TLS. The
examples use **Caddy** (automatic HTTPS). Do one of the following.

### 4A. Path A — origin-only (simplest)

Caddy fetches a Let's Encrypt certificate automatically. Ports **80 and 443**
must be reachable from the internet for the ACME challenge, and your DNS
`A`/`AAAA` record for `relay.example.com` must point at the VPS.

```sh
sudo cp ops/Caddyfile /etc/caddy/Caddyfile    # merge into any existing config
# edit it: change relay.iterm2.com → your relay.example.com
sudo systemctl reload caddy
```

The shipped Caddyfile disables access logging (no client IP ever hits disk,
matching the relay's zero-retention posture) and rewrites `X-Forwarded-For` to
the real peer. That's all Path A needs.

### 4B. Path B — behind Cloudflare's free proxy

Cloudflare's free plan gives unmetered L3/4 DDoS protection and hides your origin
IP at no cost. (This is **not** the product that bills per connection — that's
Workers/Durable Objects. The free CDN proxy does not meter or cap WebSocket
connections.)

1. In Cloudflare, add the DNS record for `relay.example.com` as **proxied**
   (orange cloud), and set **SSL/TLS mode → Full (strict)**.
2. Create a free **Cloudflare Origin CA** certificate, install the cert + key on
   the VPS, and point Caddy at them by uncommenting the `tls` line in the
   Caddyfile:
   ```
   tls /etc/caddy/cf-origin.pem /etc/caddy/cf-origin-key.pem
   ```
   Also remove the `header_up -CF-Connecting-IP` line — behind Cloudflare that
   header is legitimate and you want it.
3. Set `RELAY_TRUST_CLOUDFLARE=true` (instead of `RELAY_TRUST_PROXY`) in the env
   file and restart the service.
4. Lock the origin so nobody can bypass Cloudflare by hitting your IP directly:
   ```sh
   sudo bash ops/cloudflare-origin-firewall.sh
   ```
   This restricts inbound 80/443 to Cloudflare's published ranges (preserving SSH
   first). Re-run it if Cloudflare updates its ranges (rare).

> **Verify idle sockets survive.** Cloudflare can drop *idle* proxied
> WebSockets, and a parked Mac is deliberately idle. The relay pings every 30s
> (`RELAY_KEEPALIVE_MS`) and the apps reconnect, but before you rely on Path B,
> pair a device, leave it idle for several minutes, and confirm the connection
> isn't reaped mid-session.

---

## 5. Point your devices at the relay

Your Mac and phone must connect using the **exact** origin in `RELAY_ORIGIN`.
Configure the iTerm2 companion setup to use `relay.example.com` as its relay
host, then pair as usual (scan the QR from the phone).

If pairing is rejected immediately, the cause is almost always a `RELAY_ORIGIN`
mismatch — a trailing slash, `http` vs `https`, or a hostname that differs from
what the device dialed. Make the three agree: the DNS name, `RELAY_ORIGIN`, and
whatever the app connects to.

> Self-hosting requires that the companion app supports pointing at a custom
> relay host. If your build only talks to the default relay, you'll need a
> version that exposes that setting.

---

## 6. Health and metrics

Aggregate, non-identifying metrics (Prometheus format) are served on **localhost
only** — never expose them through the proxy:

```sh
curl -s localhost:8787/metrics
```

You get live room/socket counts, WebSocket accept/reject tallies (by reason), and
a socket-lifetime histogram. **No** room names, device tags, or IPs are ever
emitted, and there is no access logging anywhere. If a client is flapping, you'll
see it as a spike of short-lived sockets in the histogram — a signal, not a bill.

### Alerting (optional): the monitor Worker

`/metrics` is localhost-only by design, so nothing is watching it while you're
asleep. The [`monitor/`](monitor/) directory is a small **Cloudflare Worker** that
does: the relay **pushes** its aggregate snapshot outbound to the Worker every
~60s, the Worker stores the latest in KV, and a cron run every 5 minutes emails
you (via Resend) on:

- **Liveness** — no snapshot within the staleness window (a dead-man's-switch: a
  down or wedged relay stops pushing, so silence itself pages you).
- **Handshake** — an outside-in **synthetic probe**: the Worker opens a real
  WebSocket to your public origin each run and drives a mac-park pairing
  handshake. The push only proves the *process* is alive; this proves a phone
  could actually *pair* — it exercises DNS, Cloudflare, the origin firewall, the
  proxy, the WS upgrade, and admission, catching outages the push can't see.
- **Capacity** — live sockets/rooms approaching your configured caps.
- **Error rate** — HTTP 500s as a fraction of requests.
- **Exceptions** — swallowed process exceptions between checks.
- **Traffic anomaly** — hourly volume far above/below the weekly baseline.

Because the metrics transport is **outbound push**, the relay exposes no metrics endpoint
to the internet and never reveals its origin hostname — the VPS only ever makes
outbound calls. To enable it, deploy the Worker (see [`monitor/README.md`](monitor/README.md))
and set `RELAY_METRICS_PUSH_URL` + `RELAY_METRICS_PUSH_TOKEN` in the relay's env
file. Leave them unset and the relay simply doesn't push; `/metrics` stays
loopback-only either way.

---

## 7. Upgrades and backups

```sh
cd /opt/iterm2-companion-relay && git pull && npm ci --omit=dev
sudo systemctl restart iterm2-companion-relay
```

Established pairings persist across the restart (they're in SQLite); in-flight
connections just reconnect. If you want pairings to survive a full host rebuild,
back up `/var/lib/iterm2-companion-relay/relay.db`. Losing it is not a security
event — it just forces your devices to re-pair.

---

## Security notes

- The relay never sees plaintext; end-to-end confidentiality does not depend on
  trusting the host.
- Keep `/etc/iterm2-companion-relay.env` at mode `600` — it holds your config,
  not secrets that unlock traffic, but there's no reason to leave it readable.
- Keep `ATTEST_REQUIRED=true`. It gates *fresh* pairings on Apple App Attest;
  already-established rooms admit by signature regardless.
- Leave `RELAY_LOG=false` in normal operation. It's the zero-retention default;
  set it `true` only while actively debugging, and turn it back off.
```