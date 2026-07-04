#!/usr/bin/env node
// Entrypoint for the relay metrics dashboard. Reads config from the environment
// (systemd/EnvironmentFile drives it, same pattern as bin/relay.js), scrapes the
// relay's loopback /metrics on a timer into SQLite, and serves an authenticated
// dashboard on localhost. Put Apache in front for TLS; this listens on 127.0.0.1.
//
// The password is REQUIRED: the dashboard refuses to start without one, so it can
// never come up wide open by omission.

import { createDashboard } from "../dashboard/server.js";

const HOST = process.env.DASHBOARD_HOST || "127.0.0.1";
const PORT = Number(process.env.DASHBOARD_PORT || 8789);
const USER = process.env.DASHBOARD_USER || "admin";
const PASS = process.env.DASHBOARD_PASSWORD || "";

if (!PASS) {
  console.error("DASHBOARD_PASSWORD is required (refusing to start unauthenticated).");
  process.exit(1);
}

function num(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

const dash = createDashboard({
  dbPath: process.env.DASHBOARD_DB || "dashboard.db",
  metricsUrl: process.env.DASHBOARD_METRICS_URL || "http://127.0.0.1:8788/metrics",
  scrapeIntervalMs: num("DASHBOARD_SCRAPE_MS", 30_000),
  retentionMs: num("DASHBOARD_RETENTION_DAYS", 90) * 24 * 60 * 60 * 1000,
  user: USER,
  pass: PASS,
  caps: {
    socketsCap: num("RELAY_MAX_TOTAL_SOCKETS", 200000),
    roomsCap: num("RELAY_MAX_ROOMS", 200000),
    warnFrac: 0.7,
    critFrac: 0.9,
  },
  onError: (e) => console.warn("[dashboard]", e && e.message ? e.message : e),
});

dash.listen(PORT, HOST).then(() => {
  const { port } = dash.address();
  console.log(`relay dashboard on http://${HOST}:${port} (user "${USER}")`);
});

function shutdown() {
  dash.close().then(() => process.exit(0)).catch(() => process.exit(1));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
