# iterm2-companion-relay

A self-hosted relay for iTerm2 Companion remote connectivity. It splices a Mac
and a phone through two outbound WebSockets and sees only ciphertext; admission
is gated by Ed25519 join signatures and Apple App Attest. State (established
pairings) is kept in SQLite and survives restarts.

Runs as a single Node process behind a TLS-terminating reverse proxy.

- **Deploy in one command:** from a workstation, `ops/deploy-remote.sh <host>`
  (SSHes to `root@<host>` and runs the deploy); or on the box itself,
  `bash ops/deploy-vps.sh ops/deploy.env`. Copy `ops/deploy.env.example` to
  `ops/deploy.env` and fill it in first. Both scripts and the config template are
  self-documenting.
- **Self-host it:** see [SELF-HOSTING.md](SELF-HOSTING.md) — a guided walk-through
  for running your own relay on a VPS, with or without Cloudflare in front.
- **Deploy (maintainer reference):** see [DEPLOY.md](DEPLOY.md).
- **Run locally:** `npm ci && npm start` (configure via env — see
  `ops/relay.env.example`).
- **Test:** `npm test` (all tests run in plain Node).

## Layout

- `src/` — the relay logic: admission/splice/quotas (`room.js`), App Attest
  verification (`appattest.js`, `cbor.js`, `appleRoot.js`), and the shared entry
  gate (`index.js`).
- `host/` — the Node host that replaces the Cloudflare platform: SQLite storage
  shim, the runtime/alarm shim, the http+ws server, and metrics.
- `bin/relay.js` — the process entrypoint.
- `ops/` — systemd unit, Caddyfile, environment example, and the optional
  Cloudflare-origin firewall script.
- `monitor/` — an optional Cloudflare Worker that watches the relay's pushed
  aggregate metrics and emails on liveness loss, capacity, errors, or anomalies
  (see [monitor/README.md](monitor/README.md)).
