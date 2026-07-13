# iTerm2 Companion Relay — notes for Claude

Self-hosted Node relay that splices a Mac and a phone through two outbound
WebSockets and sees only ciphertext. Runs as a single process behind Caddy
(TLS). See `README.md` for architecture; `DEPLOY.md` / `SELF-HOSTING.md` for the
full walkthrough.

## Deploy to a VPS

One command, config-driven and idempotent (this is also the upgrade path — re-run
it to pull latest + restart):

- **Remote, from a workstation:** `ops/deploy-remote.sh <host>`
  SSHes to `root@<host>`, copies the deploy script + your local secret-bearing
  `ops/deploy.env` to the box, runs it, and shreds the copied env afterward.
  Override the SSH user/port with `SSH_USER=` / `SSH_PORT=`.
- **On the box itself:** `bash ops/deploy-vps.sh ops/deploy.env`
  Works whether invoked as root (`ssh root@host`) or as a sudo user.

**Config:** `cp ops/deploy.env.example ops/deploy.env`, then fill it in. Every
option (origin host, App Attest, quotas, dashboard, optional metrics push, fixed
service users) is documented inline in `ops/deploy.env.example` and the script
headers. `ops/deploy.env` holds secrets (dashboard password, metrics push token)
and is **gitignored — never commit it**.

**App source:** the deploy clones the relay on the host from `REPO_URL`@`REPO_REF`
in `deploy.env` (default GitHub `main`), so **push your changes before deploying**.
The deploy *script* itself is sent from your machine, so its own fixes apply
immediately.

**What it sets up:** Node 20 + Caddy; the relay on `127.0.0.1:8787` and dashboard
on `127.0.0.1:8789` (both loopback-only, hardened systemd units); Caddy on 443
terminating TLS (Let's Encrypt) → relay, with the dashboard under `/dashboard/`
(in-app basic auth). Runtime users default to systemd DynamicUsers, or set
`RELAY_SERVICE_USER` / `DASHBOARD_SERVICE_USER` for fixed named accounts.

Current production instance: `relay1.iterm2.com` (Option A — Caddy + Let's Encrypt,
gray-cloud DNS-only, IPv4-only).

## Test

`npm test` — vitest, all in plain Node.
