#!/usr/bin/env node
// Production entrypoint for the self-hosted relay. Reads configuration from the
// environment (the same binding names room.js expects, so systemd/EnvironmentFile
// drives it), starts the http+ws host bound to localhost, and shuts down
// gracefully on SIGTERM/SIGINT.
//
// Put a TLS-terminating reverse proxy (Caddy) in front; this process listens on
// localhost only. Client IP is read from CF-Connecting-IP / X-Forwarded-For, so
// it works origin-only or behind Cloudflare's free proxy unchanged.

import { createRelay } from "../host/server.js";

const HOST = process.env.RELAY_HOST || "127.0.0.1";
const PORT = Number(process.env.RELAY_PORT || process.env.PORT || 8787);
const DB_PATH = process.env.RELAY_DB || "relay.db";

// Optional cap overrides; unset ones fall back to the host defaults.
function numEnv(name) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}
const overrides = {
  maxRooms: numEnv("RELAY_MAX_ROOMS"),
  maxSocketsPerIp: numEnv("RELAY_MAX_SOCKETS_PER_IP"),
  maxTotalSockets: numEnv("RELAY_MAX_TOTAL_SOCKETS"),
  keepaliveMs: numEnv("RELAY_KEEPALIVE_MS"),
  // Number of appending proxies in front, if any (default 1). Only relevant
  // when a trust flag is set; X-Forwarded-For is then read this-many-from-right.
  trustedHops: numEnv("RELAY_TRUSTED_HOPS"),
  metricsPushMs: numEnv("RELAY_METRICS_PUSH_MS"),
};
for (const k of Object.keys(overrides)) if (overrides[k] === undefined) delete overrides[k];

// Off-box monitoring by outbound push (host/metricspush.js). Both a collector
// URL and a shared token are required to enable it; missing either leaves the
// relay with no metrics egress and /metrics loopback-only.
if (process.env.RELAY_METRICS_PUSH_URL) overrides.metricsPushUrl = process.env.RELAY_METRICS_PUSH_URL;
if (process.env.RELAY_METRICS_PUSH_TOKEN) overrides.metricsPushToken = process.env.RELAY_METRICS_PUSH_TOKEN;
if ((overrides.metricsPushUrl ? 1 : 0) ^ (overrides.metricsPushToken ? 1 : 0)) {
  console.warn(
    "relay: WARNING RELAY_METRICS_PUSH_URL and RELAY_METRICS_PUSH_TOKEN must both " +
    "be set to enable metrics push; with only one set, push stays disabled.");
}

// Declare which fronting proxy is authoritative for the client IP. Behind a
// generic proxy (Caddy) that sets X-Forwarded-For, set RELAY_TRUST_PROXY; behind
// Cloudflare (which sets CF-Connecting-IP), set RELAY_TRUST_CLOUDFLARE. Enabling
// neither keys per-IP caps on the socket peer.
if (process.env.RELAY_TRUST_PROXY === "true") overrides.trustProxy = true;
if (process.env.RELAY_TRUST_CLOUDFLARE === "true") overrides.trustCloudflare = true;

// A loopback bind implies a reverse proxy in front; without a trust flag the
// per-IP caps key on the proxy's address, collapsing every client into one
// shared bucket (one abuser then rate-limits everyone). Warn loudly — a
// hand-rolled config that omits the flag is the residual risk.
if (!overrides.trustProxy && !overrides.trustCloudflare &&
    (HOST === "127.0.0.1" || HOST === "::1" || HOST === "localhost")) {
  console.warn(
    `relay: WARNING bound to loopback (${HOST}) without RELAY_TRUST_PROXY or ` +
    "RELAY_TRUST_CLOUDFLARE — per-IP rate limits will key on the proxy address (one " +
    "shared bucket for all clients). Set RELAY_TRUST_PROXY=true behind a generic " +
    "proxy, or RELAY_TRUST_CLOUDFLARE=true behind Cloudflare.");
}

const relay = createRelay({ env: process.env, dbPath: DB_PATH, ...overrides });

// Last-resort net: the runtime guards each per-socket handler (the known
// failure source), but anything stray must still not drop every room. Log and
// keep serving — fail open per process, not fail stop — since a crash here is
// precisely the mass-reconnect storm the relay exists to avoid. (Swallowing
// uncaughtException is a deliberate trade: continuing on a possibly-degraded
// process beats dropping all live pairings.) Count them so a swallowed error is
// visible in /metrics, not just in logs (which are off in prod). Pre-register at
// 0 so the counter always appears.
relay.metrics.inc("process_exceptions_total", 0);
// Continue-serving beats dropping every live pairing on a stray throw — but a
// persistently wedged process could serve wrong results indefinitely. So bound
// it: if swallowed exceptions come faster than a threshold, exit for a clean
// systemd restart (Restart=always) rather than limping on a likely-corrupt state.
const EXC_WINDOW_MS = 60_000;
const EXC_LIMIT = 25;
const excTimes = [];
function onProcessException(kind, err) {
  relay.metrics.inc("process_exceptions_total");
  console.error(`relay: ${kind} (continuing):`, err?.message ?? err);
  const now = Date.now();
  excTimes.push(now);
  while (excTimes.length && now - excTimes[0] > EXC_WINDOW_MS) excTimes.shift();
  if (excTimes.length > EXC_LIMIT) {
    console.error(`relay: ${excTimes.length} exceptions within ${EXC_WINDOW_MS}ms — exiting for a clean restart`);
    process.exit(1);
  }
}
process.on("unhandledRejection", (reason) => onProcessException("unhandledRejection", reason));
process.on("uncaughtException", (err) => onProcessException("uncaughtException", err));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`relay: ${signal} received, shutting down`);
  try {
    await relay.close();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

relay.listen(PORT, HOST).then(() => {
  const { port } = relay.address();
  // Non-identifying startup line only (no rooms, no IPs): honors the zero-PII
  // posture while still confirming the process is up.
  console.log(`relay: listening on ${HOST}:${port} (db=${DB_PATH}, attest=${process.env.ATTEST_REQUIRED ?? "required"})`);
}).catch((err) => {
  console.error("relay: failed to start:", err.message);
  process.exit(1);
});
