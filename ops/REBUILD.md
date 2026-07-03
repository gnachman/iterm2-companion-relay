# Hosting rebuild runbook — iTerm2 Companion relay

Everything needed to recreate this deployment from a bare VPS. It documents the
**actual live setup**, not the generic guide (that's `DEPLOY.md`).

> ⚠️ **Host-specific runbook, redacted for a public repo.** Identifying values —
> the origin IP and the co-hosted site's domain — are placeholders (`<VPS-IPv4>`,
> `<VPS-IPv6>`, `<co-hosted-site>`, `<grey-test-host>`); substitute your own. It
> lives in git so it survives a host wipe — keep the repo backed up off this box,
> or a rebuild can't read its own instructions.

---

## 1. What this is

A self-hosted replacement for the old Cloudflare Worker + Durable Object relay
(dropped because DO billed per connection and a flapping client cost a fortune).
The relay is a plain Node process; it splices a Mac and a phone through two
outbound WebSockets and never sees plaintext. See the repo `README.md` for the
app itself.

**This box runs TWO relay instances** (one process = one `RELAY_ORIGIN`, so each
fronting topology needs its own instance):

| Instance | Port | Origin | Trust | Fronting | Purpose |
|---|---|---|---|---|---|
| `iterm2-companion-relay` | 8787 | `https://<grey-test-host>` | `RELAY_TRUST_PROXY` | Apache :443, Let's Encrypt (direct / "grey") | validation / direct-serve template |
| `iterm2-companion-relay-cf` | 8788 | `https://relay.iterm2.com` | `RELAY_TRUST_CLOUDFLARE` | Cloudflare :443 → origin :8443 (Apache, CF Origin cert) | orange-cloud (DDoS) path |

Apache also serves the unrelated `<co-hosted-site>` **directly** on :443 — which
is *why* the Cloudflare origin runs on a separate port (8443): so :8443 can be
firewalled to Cloudflare-only without black-holing `<co-hosted-site>` on :443.

```
                          :443 (LE)            localhost:8787
  Mac/phone ── direct ──► Apache vhost ──────► relay (grey)      <grey-test-host>
                          <grey-test-host>

                          :443                 Origin Rule        :8443 (CF cert)   localhost:8788
  Mac/phone ──► Cloudflare edge ──────────────► port→8443 ──────► Apache vhost ───► relay (cf)   relay.iterm2.com
               (proxied, Full strict)                             relay.iterm2.com
```

**Production is `relay.iterm2.com`** (the orange-cloud instance above) — live and
serving real pairings. The OLD hostname `companion-relay.iterm2.com` stays on the
Cloudflare Worker on purpose, as a fallback for pairings made before the move
(their transcripts are bound to that origin). New pairings use `relay.iterm2.com`.
See §9.

## 2. Facts / inventory

- **VPS:** `<VPS-IPv4>` (A) / `<VPS-IPv6>` (AAAA), Ubuntu 24.04.
- **Node:** 20.20.2 from NodeSource (`/usr/bin/node`).
- **App:** `/opt/iterm2-companion-relay` (deployed copy of this repo).
- **DNS:**
  - `iterm2.com` → **Cloudflare** (`vera/hayes.ns.cloudflare.com`).
  - `<co-hosted-site>` → a third-party DNS host, NOT proxied.
- **Ports:** 80/443 Apache (<co-hosted-site> + <grey-test-host>); 8443 Apache (CF origin);
  8080 an unrelated `AllowanceServer`; 8787/8788 the relays (localhost only).
- **Certs:**
  - Let's Encrypt `<grey-test-host>` — `certbot --apache`, auto-renews.
  - Cloudflare Origin CA `*.iterm2.com` — from the CF dashboard, 15-year, manual,
    at `/etc/ssl/cloudflare/companion-relay.{pem,key}`.

## 3. Install Node

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # v20.x
```

## 4. Deploy the app

```bash
# from a checkout of this repo (branch self-host-node until merged):
sudo mkdir -p /opt/iterm2-companion-relay
sudo rsync -a --delete --exclude='.git' --exclude='node_modules' --exclude='*.db*' \
  <repo>/ /opt/iterm2-companion-relay/
cd /opt/iterm2-companion-relay && sudo npm ci --omit=dev   # prebuilt better-sqlite3, no compiler
```

## 5. systemd (both instances)

The unit is `ops/iterm2-companion-relay.service`. **Critical gotcha it already
fixes:** Node 20's libuv probes `io_uring` at startup, which `SystemCallFilter=
@system-service` blocks → the process is SIGSYS-killed and crash-loops. The unit
sets `SystemCallErrorNumber=EPERM` so the blocked probe fails gracefully and
libuv falls back to its threadpool (io_uring stays blocked, which is what we
want). If you ever see `Result: core-dump, signal=SYS`, that's this.

```bash
# --- instance 1: grey / direct (<grey-test-host>) ---
sudo install -m 600 <your relay.env> /etc/iterm2-companion-relay.env
sudo cp /opt/iterm2-companion-relay/ops/iterm2-companion-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now iterm2-companion-relay

# --- instance 2: Cloudflare origin (relay.iterm2.com) ---
# same unit but a distinct EnvironmentFile + StateDirectory + Description:
sed -e 's#/etc/iterm2-companion-relay.env#/etc/iterm2-companion-relay-cf.env#' \
    -e 's#StateDirectory=iterm2-companion-relay#StateDirectory=iterm2-companion-relay-cf#' \
    -e 's#Description=iTerm2 Companion relay#Description=iTerm2 Companion relay (Cloudflare origin)#' \
    /opt/iterm2-companion-relay/ops/iterm2-companion-relay.service \
  | sudo tee /etc/systemd/system/iterm2-companion-relay-cf.service >/dev/null
sudo install -m 600 <your relay-cf.env> /etc/iterm2-companion-relay-cf.env
sudo systemctl daemon-reload
sudo systemctl enable --now iterm2-companion-relay-cf
```

> The current live `iterm2-companion-relay` also has a redundant drop-in
> `…/iterm2-companion-relay.service.d/10-seccomp-errno.conf` from the initial
> io_uring debugging (added before the fix landed in the unit). Harmless; a fresh
> deploy from this repo needs no drop-in.

### Env files

`/etc/iterm2-companion-relay.env` (grey):
```ini
RELAY_HOST=127.0.0.1
RELAY_PORT=8787
RELAY_DB=/var/lib/iterm2-companion-relay/relay.db
ATTEST_REQUIRED=true
APP_ID=H7V7XYVQ7D.com.googlecode.iterm2.companion
APPATTEST_ENV=production          # TestFlight AND App Store are "production"; only Xcode debug builds are "development"
RELAY_ORIGIN=https://<grey-test-host>
RELAY_TRUST_PROXY=true            # Apache sets X-Forwarded-For; relay reads the rightmost hop
RELAY_LOG=false                   # true only while debugging (opaque tags, no IPs)
RELAY_ESTABLISHED_IDLE_TTL_MS=2592000000
```

`/etc/iterm2-companion-relay-cf.env` (Cloudflare): same, but
```ini
RELAY_PORT=8788
RELAY_DB=/var/lib/iterm2-companion-relay-cf/relay.db
RELAY_ORIGIN=https://relay.iterm2.com
RELAY_TRUST_CLOUDFLARE=true        # instead of RELAY_TRUST_PROXY; relay keys per-IP on CF-Connecting-IP
# (no RELAY_TRUST_PROXY)
```

`RELAY_ORIGIN` must EXACTLY match the URL the client uses — it's hashed into the
join transcript and the App Attest clientDataHash. Change it and every existing
pairing breaks (that's expected on a hostname flip).

## 6. Apache

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel headers   # ssl already on
```

**Grey vhost** (`ops/apache-companion-relay.conf` is the template; set
`ServerName <grey-test-host>`, proxy → `127.0.0.1:8787`). Then let certbot
create the :443 half and cert:
```bash
sudo cp <vhost> /etc/apache2/sites-available/companion-relay.conf
sudo a2ensite companion-relay
sudo apache2ctl configtest && sudo systemctl reload apache2
sudo certbot --apache -d <grey-test-host> --redirect    # needs the DNS A/AAAA live + :80 reachable
```
Key directives: `ErrorLog` but **no** `CustomLog` (zero-PII — don't log IPs);
`RequestHeader unset CF-Connecting-IP` (not behind CF, so a client mustn't forge
it); `ProxyPass "/" "http://127.0.0.1:8787/" upgrade=websocket`.

**Cloudflare-origin vhost** (`ops/apache-companion-relay-cloudflare.conf`;
`ServerName relay.iterm2.com`, `Listen 8443`, proxy → `127.0.0.1:8788`, CF
Origin cert). Here you **pass CF-Connecting-IP through** (don't strip it) because
the relay trusts it and the :8443 firewall admits only CF:
```bash
sudo mkdir -p /etc/ssl/cloudflare
sudo tee /etc/ssl/cloudflare/companion-relay.pem >/dev/null   # paste CF Origin cert
sudo tee /etc/ssl/cloudflare/companion-relay.key >/dev/null   # paste CF Origin key
sudo chmod 640 /etc/ssl/cloudflare/companion-relay.key
sudo cp <cf-vhost> /etc/apache2/sites-available/companion-relay-cf.conf
sudo a2ensite companion-relay-cf
sudo apache2ctl configtest && sudo systemctl reload apache2
```

## 7. Cloudflare (for the orange-cloud instance)

In the `iterm2.com` zone:
1. **SSL/TLS → Origin Server → Create Certificate**, hostnames `*.iterm2.com` +
   `iterm2.com`. Paste cert+key to `/etc/ssl/cloudflare/companion-relay.{pem,key}`.
2. **SSL/TLS → Overview:** mode **Full (strict)**. (Zone-wide — leave as-is if
   other hostnames depend on it; our Origin cert works with Full or Full strict.)
3. **DNS:** `A/AAAA relay-cf → <VPS-IPv4> / <VPS-IPv6>`, **Proxied**.
4. **Rules → Origin Rules → Create:** if `http.host eq "relay.iterm2.com"`
   then **Destination Port = 8443** (Host/SNI/DNS = Preserve). Deploy.

The client keeps using `:443`, so `RELAY_ORIGIN` stays portless; the `:8443` is
only the CF→origin hop.

## 8. Firewall (lock :8443 to Cloudflare)

The orange-cloud DDoS benefit — and the trustworthiness of `CF-Connecting-IP` —
only hold if the origin can't be reached around Cloudflare. Because
`<co-hosted-site>` is served **directly** on :443, we can't lock :443 to CF — but
we lock **:8443** (the CF origin) to Cloudflare IPs without touching :443, via a
dedicated iptables chain (default INPUT policy stays ACCEPT, so SSH/:443/:8080 are
untouched — no risk of a lockout):
```bash
sudo bash /opt/iterm2-companion-relay/ops/cloudflare-relay-port-firewall.sh
```
It's idempotent (re-run when CF rotates ranges) and persists via
netfilter-persistent. Verify from OFF the box: `curl --max-time 5 -k
https://<VPS-IPv4>:8443/` should time out (only CF can reach :8443).
(Do NOT use `ops/cloudflare-origin-firewall.sh` here — it locks 80/443 to CF and
would black-hole the directly-served `<co-hosted-site>`.)

**Parked-Mac idle survival through Cloudflare: verified.** A parked pair stayed
`sockets_live` past the ~100s CF idle window (our 30s ping/pong keeps it alive),
so the orange-cloud path is safe for the long-idle parked-Mac workload.

## 9. Production status & retiring the scaffolding

`relay.iterm2.com` (orange-cloud, §7) is the live production relay — real pairings
work through it. Decisions made:

- **`companion-relay.iterm2.com` stays on the old Cloudflare Worker** as a
  fallback, so pairings made before the move keep working (their transcripts are
  bound to that origin — a hostname change would force a re-pair). New pairings use
  `relay.iterm2.com`. Retire the Worker only once you're confident no client still
  points at the old host.
- **`relay-cf.iterm2.com` was the throwaway CF test host** — its DNS record can be
  deleted; nothing references it now that the `-cf` instance origin, the `:8443`
  vhost `ServerName`, and the Origin Rule all use `relay.iterm2.com`.
- **Grey/direct path (`<grey-test-host>`) was validation scaffolding.** To
  retire it: `sudo systemctl disable --now iterm2-companion-relay`,
  `sudo a2dissite companion-relay && sudo systemctl reload apache2`, then drop the
  `<grey-test-host>` DNS + its Let's Encrypt cert.
- **Zero-retention posture:** set `RELAY_LOG=false` in
  `/etc/iterm2-companion-relay-cf.env` and `sudo systemctl restart
  iterm2-companion-relay-cf` once you're done watching pairings.

> Once the grey instance is gone, the confusingly-named production unit
> `iterm2-companion-relay-cf` is the only one left; renaming it to
> `iterm2-companion-relay` (new EnvironmentFile/StateDirectory) is optional tidy-up.

## 10. Verify

```bash
# service on localhost
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/metrics   # 200 (localhost only)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/register -X POST  # 400 bad room
# through the front door (grey)
curl -s -o /dev/null -w '%{http_code}\n' https://<grey-test-host>/register -X POST  # 400
# through Cloudflare
curl -s -o /dev/null -w '%{http_code}\n' https://relay.iterm2.com/register -X POST     # 400
# metrics must NOT be reachable through a proxy (403) — X-Forwarded-For present
curl -s -o /dev/null -w '%{http_code}\n' https://relay.iterm2.com/metrics              # 403
```
A WebSocket hello should return a `{"nonce":…}` challenge (see the `_ws.mjs`
one-liner pattern used during setup). Watch pairings live:
`sudo journalctl -u iterm2-companion-relay-cf -f` (with `RELAY_LOG=true`).

## 11. Maintenance

- **LE cert** (`<grey-test-host>`): auto-renews via certbot's timer.
- **CF Origin cert** (`*.iterm2.com`): 15-year, no auto-renew; note the expiry.
- **Update the relay:** re-`rsync` the repo to `/opt`, `sudo npm ci --omit=dev`,
  `sudo systemctl restart iterm2-companion-relay iterm2-companion-relay-cf`.
  Established pairings survive (SQLite in the StateDirectory); in-flight clients
  reconnect.
- **Back up** `/var/lib/iterm2-companion-relay*/relay.db` to preserve pairings
  across a host rebuild (losing it only forces re-pair — not a security event).
- **Logs:** off in production (`RELAY_LOG=false`), so `journalctl` shows only
  start/stop. No access logs anywhere (Apache vhosts have no `CustomLog`).

## 12. Gotchas encountered (so you don't rediscover them)

- **io_uring / SIGSYS** — see §5. `SystemCallErrorNumber=EPERM`.
- **`MemoryDenyWriteExecute=yes` crashes V8** (JIT needs W→X). The unit omits it.
- **App Attest env:** TestFlight = `production`, Xcode debug = `development`. A
  mismatch → `/attest` 403.
- **`RELAY_ORIGIN` is cryptographically bound** — must equal the client URL exactly.
- **X-Forwarded-For is read rightmost** (the trusted proxy's hop); a client-
  prepended XFF is ignored. Apache/mod_proxy appends the real peer, so this is
  correct. `RELAY_TRUSTED_HOPS` (default 1) for chained proxies.
- **`/metrics` is localhost-only** — refused if any proxy header is present, so it
  can't leak through Apache/Cloudflare.
- **One process = one `RELAY_ORIGIN`** — hence the two instances.
- **Don't run `ops/cloudflare-origin-firewall.sh` here** — it locks 80/443 to CF
  and would kill the directly-served `<co-hosted-site>`.
