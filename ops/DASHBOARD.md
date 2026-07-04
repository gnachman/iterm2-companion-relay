# Relay metrics dashboard — how it works & how to deploy

A self-hosted dashboard that shows the relay's health at a glance with historical
charts. It is a small Node process that **scrapes the relay's loopback `/metrics`
on a timer into SQLite** and serves a single self-contained web page. It never
touches the relay's own database, adds no code or load to the relay process, and
stores only the aggregate, PII-free counts `/metrics` already exposes — no room
name, tag, or IP.

This document is host-agnostic: substitute your own domain and paths for the
placeholders (`<DOMAIN>`, `<SUBPATH>`, etc.).

## Architecture

```
  relay ──/metrics (127.0.0.1:RELAY_PORT)──▶ collector timer ──▶ SQLite history
                                                                     │
  browser ──TLS──▶ reverse proxy ──▶ dashboard (127.0.0.1:8789) ──reads──┘
                   (Apache/nginx)     (Node; loopback only)
```

- **Collector** (`dashboard/collector.js`): every `DASHBOARD_SCRAPE_MS` it GETs
  the relay's loopback `/metrics`, parses the Prometheus text
  (`dashboard/parse.js`), and appends one row to SQLite (`dashboard/db.js`). A
  failed scrape (relay restarting/unreachable) is logged and skipped — the gap is
  itself the signal. It prunes rows older than `DASHBOARD_RETENTION_DAYS` on the
  same tick.
- **Analysis** (`dashboard/series.js`): turns stored rows into at-a-glance tiles,
  historical chart series, and a health panel. It **reuses the off-box monitor's
  pure checks** (`monitor/src/monitor.js`: capacity, error-rate, exceptions) so
  the dashboard and the pager never disagree about "is this healthy." Relay
  counters reset to ~0 on restart, so every rate is computed from **reset-aware**
  deltas: a backwards step is a restart, shown as a gap, never a negative or a
  spike.
- **Server** (`dashboard/server.js`, entrypoint `bin/dashboard.js`): binds to
  `127.0.0.1` only, serves the page at `/`, JSON at `/api/data`, and an
  unauthenticated `/healthz`. Every other route is behind in-app HTTP Basic auth
  (`dashboard/auth.js`, constant-time compare). The page (`dashboard/page.js`) is
  one self-contained HTML document — inline CSS/JS/SVG, no external requests — so
  it renders with no CDN reachability.

## Security posture

- **Loopback only.** Node never listens on a public interface. The reverse proxy
  is the only way in; put TLS there.
- **Password enforced in-app.** The process refuses to start without
  `DASHBOARD_PASSWORD`, so it can never come up wide open by omission. The proxy
  may add its own auth on top, but the app is the floor, not the ceiling.
- **Zero PII.** Only the same counts `/metrics` exposes are stored; there is no
  per-connection data, room identifier, or IP anywhere in the DB.

## Files

| Path | Role |
|---|---|
| `bin/dashboard.js` | Entrypoint; reads env, wires collector + server |
| `dashboard/parse.js` | Prometheus text → flat snapshot (pure) |
| `dashboard/db.js` | SQLite schema, insert, range query, prune |
| `dashboard/collector.js` | Timer: scrape → parse → store (injectable fetch/clock) |
| `dashboard/series.js` | Rows → tiles/series/health (pure; reuses `monitor/`) |
| `dashboard/auth.js` | Constant-time HTTP Basic auth |
| `dashboard/server.js` | HTTP server + routes |
| `dashboard/page.js` | Self-contained HTML/SVG page |
| `ops/iterm2-relay-dashboard.service` | Hardened systemd unit |
| `ops/relay-dashboard.env` | Env file template (holds the password; keep 0600) |
| `monitor/src/monitor.js` | **Required at runtime** — `series.js` imports it |

Tests live in `test/dashboard/`; run `npm test`.

## Configuration (environment)

| Var | Default | Meaning |
|---|---|---|
| `DASHBOARD_PORT` | `8789` | Loopback port to serve on |
| `DASHBOARD_HOST` | `127.0.0.1` | Bind address (keep it loopback) |
| `DASHBOARD_USER` | `admin` | Basic-auth username |
| `DASHBOARD_PASSWORD` | *(required)* | Basic-auth password — refuses to start if unset |
| `DASHBOARD_DB` | `dashboard.db` | SQLite path (point at a writable state dir) |
| `DASHBOARD_METRICS_URL` | `http://127.0.0.1:8788/metrics` | The relay's loopback metrics endpoint |
| `DASHBOARD_SCRAPE_MS` | `30000` | Scrape interval |
| `DASHBOARD_RETENTION_DAYS` | `90` | Age at which old samples are pruned |
| `RELAY_MAX_TOTAL_SOCKETS`, `RELAY_MAX_ROOMS` | `200000` | Caps for the capacity health check (match the relay) |

## Deploy on a new host

Assumes the app is present at `/opt/iterm2-companion-relay` with production deps
installed (`npm ci --omit=dev`, which provides `better-sqlite3`) and node at
`/usr/bin/node`. Adjust paths to taste.

1. **Ensure the runtime files are present** (the dashboard imports
   `monitor/src/monitor.js`, so that path must exist too):
   `bin/dashboard.js`, `dashboard/`, `monitor/src/monitor.js`, `node_modules/`.

2. **Create the env file** (root-owned, `0600`) with a strong password:

   ```sh
   sudo install -m 600 ops/relay-dashboard.env /etc/iterm2-relay-dashboard.env
   sudo sed -i "s|^DASHBOARD_PASSWORD=.*|DASHBOARD_PASSWORD=$(openssl rand -base64 24)|" \
     /etc/iterm2-relay-dashboard.env
   sudo grep DASHBOARD_PASSWORD /etc/iterm2-relay-dashboard.env   # note it for login
   ```

   Set `DASHBOARD_METRICS_URL` to wherever the relay's loopback `/metrics` lives
   on this host.

3. **Install and start the systemd unit** (hardened: `DynamicUser`, locked-down
   filesystem, SQLite in a systemd `StateDirectory`):

   ```sh
   sudo cp ops/iterm2-relay-dashboard.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now iterm2-relay-dashboard
   curl -s localhost:8789/healthz     # -> ok
   ```

   The unit sets `DASHBOARD_DB` (via the env file) to
   `/var/lib/iterm2-relay-dashboard/dashboard.db`, which systemd creates and owns
   for the DynamicUser.

4. **Expose it through your existing TLS reverse proxy.** Two shapes:

   **A. Subpath on an existing HTTPS site** (no new DNS or cert). Add one block
   to that site's `*:443` vhost, then config-test and reload:

   ```apache
   RedirectMatch ^/<SUBPATH>$ /<SUBPATH>/
   <Location /<SUBPATH>/>
       ProxyPass         http://127.0.0.1:8789/
       ProxyPassReverse  http://127.0.0.1:8789/
   </Location>
   ```

   The page uses only relative URLs, so it works under a subpath as long as the
   trailing slash is enforced (that is what the `RedirectMatch` does). No
   `htpasswd` is required — the app enforces its own password — but you may add
   one for defense in depth (use the same credentials to avoid a double prompt).

   **B. Dedicated subdomain** (cleanest separation; touches no existing config).
   Add a DNS record for the subdomain → this host, create a new vhost that
   `ProxyPass`es `/` to `http://127.0.0.1:8789/`, and issue a cert
   (`certbot --apache`).

   Requires the proxy modules: `proxy`, `proxy_http`, `headers`, `ssl`, `rewrite`
   (`sudo a2enmod …` on Debian/Ubuntu).

5. **Verify** from outside: browse to `https://<DOMAIN>/<SUBPATH>/` and log in
   with `DASHBOARD_USER` / `DASHBOARD_PASSWORD`.

## Operations

- **Logs:** `journalctl -u iterm2-relay-dashboard -f` (scrape failures print
  `[dashboard] …`).
- **Restart / stop:** `sudo systemctl restart|stop iterm2-relay-dashboard`.
- **Change the password:** edit `/etc/iterm2-relay-dashboard.env`, then
  `sudo systemctl restart iterm2-relay-dashboard`.
- **Database:** `/var/lib/iterm2-relay-dashboard/dashboard.db` (WAL mode). Safe to
  delete — it only holds history and is rebuilt from new scrapes; you lose the
  past charts, nothing else.
- **Ports:** dashboard `127.0.0.1:8789`; it scrapes the relay at
  `DASHBOARD_METRICS_URL`. Neither needs a public port — only the reverse proxy
  does.
