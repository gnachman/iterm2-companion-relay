# Deploying the relay on a VPS

The relay is a single Node process. It splices a Mac and a phone through two
outbound WebSockets and sees only ciphertext. State (established pairings) lives
in a SQLite file and survives restarts. A reverse proxy terminates TLS; the Node
process listens on localhost only.

This is the self-hosted replacement for the former Cloudflare Worker + Durable
Object deployment. The move was driven by cost: Durable Objects bill per
request/connection, and a flapping client generates hundreds of reconnects an
hour. Here a reconnect is a TLS handshake plus one Ed25519 verify — effectively
free — so flapping is only a diagnostic signal (watch the socket-lifetime
histogram in `/metrics`), not a bill.

## Requirements

- Node 20 LTS (`node -v` → v20.x)
- A reverse proxy for TLS. These docs use Caddy (automatic HTTPS).
- The DNS name clients use, matching `RELAY_ORIGIN` (e.g. `relay.iterm2.com`).

## Install

```sh
sudo mkdir -p /opt/iterm2-companion-relay
sudo chown "$USER" /opt/iterm2-companion-relay
git clone <this repo> /opt/iterm2-companion-relay
cd /opt/iterm2-companion-relay
npm ci --omit=dev            # installs ws + better-sqlite3 (prebuilt binary)
npm test                     # optional: 140 tests, all in plain Node
```

## Configure

```sh
sudo cp ops/relay.env.example /etc/iterm2-companion-relay.env
sudo chmod 600 /etc/iterm2-companion-relay.env
sudoedit /etc/iterm2-companion-relay.env      # set RELAY_ORIGIN, APP_ID, etc.
```

`RELAY_ORIGIN` **must** equal the public origin clients connect to — it is bound
into join transcripts and the App Attest clientDataHash, so a mismatch rejects
every pairing.

Declare which fronting proxy is authoritative for the client IP, so per-IP rate
limits key on the real client and cannot be spoofed:

- **Option A (Caddy, no Cloudflare):** `RELAY_TRUST_PROXY=true`. The relay trusts
  `X-Forwarded-For` (Caddy overwrites it with the real peer) and **ignores** any
  client-supplied `CF-Connecting-IP`.
- **Option B (behind Cloudflare):** `RELAY_TRUST_CLOUDFLARE=true` *instead*. The
  relay trusts `CF-Connecting-IP` (set by Cloudflare); keep the origin firewall
  applied so only Cloudflare can reach the origin and set it.

Set **exactly one**, and only when the process is reachable *solely* through that
proxy. Never enable a trust flag for a header the proxy does not set
authoritatively — that is the H1 spoof (a client forging `CF-Connecting-IP`
through a generic proxy). With neither set, per-IP limits fall back to the socket
peer (the proxy), so everyone shares one bucket.

`X-Forwarded-For` is read from the **right** (the hop your proxy observed), so a
client that prepends a fake entry is ignored — safe whether the proxy *replaces*
(the shipped Caddyfile does) or *appends* it. If you chain **N** appending
proxies in front, set `RELAY_TRUSTED_HOPS=N` so the relay reads the Nth-from-right
hop.

## Run under systemd

```sh
sudo cp ops/iterm2-companion-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now iterm2-companion-relay
systemctl status iterm2-companion-relay
```

The unit runs as a locked-down `DynamicUser`, keeps the SQLite file in
`/var/lib/iterm2-companion-relay/`, restarts on crash, raises the fd limit for
many idle sockets, and forwards `SIGTERM` to the process's graceful shutdown.

## TLS / reverse proxy

Pick one:

### Option A — origin-only (simplest)

Caddy fetches a Let's Encrypt cert automatically. Ports 80 and 443 must be
reachable from the internet for the ACME challenge.

```sh
sudo cp ops/Caddyfile /etc/caddy/Caddyfile     # merge with any existing config
sudo systemctl reload caddy
```

### Option B — behind Cloudflare's free proxy (DDoS absorption, $0)

Cloudflare's free plan gives unmetered L3/4 DDoS protection and hides the origin
IP, at no cost. This is **not** the product that billed you — that was Workers /
Durable Objects. The free CDN proxy does not meter or cap WebSocket connections.

1. Add the DNS record as **proxied** (orange cloud); SSL/TLS mode **Full (strict)**.
2. Create a free **Cloudflare Origin CA** cert, install it, and point Caddy at it
   (uncomment the `tls` line in `ops/Caddyfile`).
3. Lock the origin to Cloudflare so nobody can bypass the proxy:
   ```sh
   sudo bash ops/cloudflare-origin-firewall.sh
   ```

The relay reads the real client IP from `CF-Connecting-IP` automatically (it
takes precedence over `X-Forwarded-For`), so per-IP rate limiting keeps working.

**Verify before relying on Option B:** Cloudflare can drop *idle* proxied
WebSockets, and a parked Mac is deliberately idle. The relay pings every 30s
(`RELAY_KEEPALIVE_MS`) and the clients are built to reconnect, but confirm the
Mac/phone app's own keepalive is frequent enough that parked sockets are not
reaped mid-session.

## Health & metrics

Aggregate, non-identifying metrics (Prometheus format) are served on
**localhost only** — never through the proxy:

```sh
curl -s localhost:8787/metrics
```

Exposes live rooms/sockets, ws-upgrade accept/reject counts (by reason), and the
socket-lifetime histogram. No room names, tags, or IPs are ever emitted, and
there is no access logging anywhere, matching the relay's zero-retention design.

## Upgrades

```sh
cd /opt/iterm2-companion-relay && git pull && npm ci --omit=dev
sudo systemctl restart iterm2-companion-relay
```

Established pairings persist across the restart (SQLite); in-flight connections
reconnect. Back up `/var/lib/iterm2-companion-relay/relay.db` if you want to
preserve pairings across a host rebuild — losing it just forces devices to
re-pair, it is not a security event.
