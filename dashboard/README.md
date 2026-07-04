# Relay metrics dashboard

A small self-hosted dashboard that shows the relay's health at a glance with
historical charts. It **scrapes the relay's loopback `/metrics`** on a timer into
SQLite and serves a single self-contained page. It never touches `relay.db`, adds
no load or code to the relay process, and stores only the same aggregate, PII-free
counts `/metrics` already exposes — no room name, tag, or IP.

```
relay  ──/metrics (127.0.0.1:8788)──▶  collector  ──▶  dashboard.db (SQLite)
                                                          │
browser ──TLS──▶ Apache (Basic auth) ──▶ dashboard (127.0.0.1:8789) ──reads──┘
```

## What you see

- **Health banner** — the *same* checks the off-box monitor pages on
  (`monitor/src/monitor.js`: capacity, error rate, exceptions), so the dashboard
  and the pager never disagree about "is this healthy".
- **Tiles** — live sockets/rooms, upgrades, requests, error rate, exceptions,
  push errors, flap % (connections closing < 1s — the Cloudflare-bill signal),
  average lifetime, and last-sample freshness.
- **Charts** — historical live sockets, live rooms, request/upgrade/error/rejected
  rates (per minute, **reset-aware** so a relay restart doesn't spike them), and
  the short-lived fraction. Range selector: 1h / 6h / 24h / 7d / 30d. Auto-refreshes
  every 30s.

## Configuration (environment)

| Var | Default | Meaning |
|---|---|---|
| `DASHBOARD_PORT` | `8789` | Loopback port to serve on |
| `DASHBOARD_HOST` | `127.0.0.1` | Bind address (keep it loopback) |
| `DASHBOARD_USER` | `admin` | Basic-auth username |
| `DASHBOARD_PASSWORD` | *(required)* | Basic-auth password — **refuses to start if unset** |
| `DASHBOARD_DB` | `dashboard.db` | SQLite path |
| `DASHBOARD_METRICS_URL` | `http://127.0.0.1:8788/metrics` | The relay's loopback metrics endpoint |
| `DASHBOARD_SCRAPE_MS` | `30000` | Scrape interval |
| `DASHBOARD_RETENTION_DAYS` | `90` | Age at which old samples are pruned |
| `RELAY_MAX_TOTAL_SOCKETS`, `RELAY_MAX_ROOMS` | `200000` | Caps used for the capacity health check (match the relay's) |

The password is enforced **in-app** (constant-time compare), so protection does
not depend on Apache being configured perfectly. Apache Basic auth on top is
belt-and-suspenders.

## Run locally

```sh
DASHBOARD_PASSWORD=dev npm run dashboard
# open http://127.0.0.1:8789  (user: admin, pass: dev)
```

## Deploy on the VPS (matches the relay's `-cf` layout)

The production relay runs from a **file-copy checkout** at `/opt/iterm2-companion-relay`
(not a git repo) behind Apache. Deploy the dashboard the same way.

1. **Copy the runtime files** into `/opt/iterm2-companion-relay` (the dashboard
   imports `monitor/src/monitor.js`, so that path must be present too):

   ```sh
   sudo rsync -a --relative \
     bin/dashboard.js dashboard/ monitor/src/monitor.js \
     /opt/iterm2-companion-relay/
   ```

   `better-sqlite3` and `ws` are already installed under `/opt/.../node_modules`
   for the relay; the dashboard adds no new npm dependency.

2. **Env file** `/etc/iterm2-relay-dashboard.env` (root-only, `chmod 600`):

   ```ini
   DASHBOARD_PORT=8789
   DASHBOARD_USER=admin
   DASHBOARD_PASSWORD=<a-strong-password>
   DASHBOARD_DB=/var/lib/iterm2-relay-dashboard/dashboard.db
   DASHBOARD_METRICS_URL=http://127.0.0.1:8788/metrics
   RELAY_MAX_TOTAL_SOCKETS=200000
   RELAY_MAX_ROOMS=200000
   ```

   ```sh
   sudo mkdir -p /var/lib/iterm2-relay-dashboard
   ```

3. **systemd unit** `/etc/systemd/system/iterm2-relay-dashboard.service`:

   ```ini
   [Unit]
   Description=iTerm2 relay metrics dashboard
   After=network.target iterm2-companion-relay-cf.service

   [Service]
   Type=simple
   WorkingDirectory=/opt/iterm2-companion-relay
   EnvironmentFile=/etc/iterm2-relay-dashboard.env
   ExecStart=/usr/bin/node bin/dashboard.js
   Restart=on-failure
   DynamicUser=yes
   StateDirectory=iterm2-relay-dashboard
   # If DynamicUser can't read /opt, run as the same user as the relay unit instead.

   [Install]
   WantedBy=multi-user.target
   ```

   ```sh
   sudo systemctl daemon-reload
   sudo systemctl enable --now iterm2-relay-dashboard
   ```

4. **Apache** — terminate TLS and reverse-proxy to the loopback dashboard. Add a
   vhost (or a `<Location>` on an existing one), with its own `.htpasswd` as a
   second gate:

   ```apache
   <VirtualHost *:443>
     ServerName relay-dashboard.iterm2.com
     # ... your SSLCertificate* directives ...

     <Location "/">
       AuthType Basic
       AuthName "Relay Dashboard"
       AuthUserFile /etc/apache2/dashboard.htpasswd
       Require valid-user
     </Location>

     ProxyPreserveHost On
     ProxyPass        / http://127.0.0.1:8789/
     ProxyPassReverse / http://127.0.0.1:8789/
   </VirtualHost>
   ```

   ```sh
   sudo htpasswd -c /etc/apache2/dashboard.htpasswd admin
   sudo a2enmod proxy proxy_http auth_basic
   sudo systemctl reload apache2
   ```

   Point DNS/Cloudflare at this vhost, or keep it origin-only. The dashboard
   listens on loopback, so it is only reachable through Apache.

## Notes

- A scrape failure (relay restarting, briefly down) simply skips that sample; the
  gap is the signal — the page shows staleness and the rate math tolerates it.
- Counters reset to ~0 when the relay restarts. Every rate here is computed from
  reset-aware deltas, so a restart shows as a gap, never a negative or a spike.
- Pruning runs on the collector's own tick (~hourly), so the DB self-limits with
  no second timer.
