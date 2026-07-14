// The dashboard HTTP server: serves the page and a JSON API, and runs the
// collector that feeds the DB. Binds to loopback only (Apache terminates TLS and
// proxies to it); every route except /healthz is behind in-app Basic auth.
//
// Shape mirrors host/server.js: createDashboard(options) returns a handle with
// listen()/close(). Injectable fetch/clock/db keep it unit-testable against an
// in-memory relay without a socket.

import http from "node:http";
import { DashboardDB } from "./db.js";
import { startCollector } from "./collector.js";
import { buildDashboard, buildPush } from "./series.js";
import { parsePushMetrics } from "./parse.js";
import { requireAuth } from "./auth.js";
import { renderPage } from "./page.js";

const RANGE_MS = {
  "1h": 3600e3, "6h": 6*3600e3, "24h": 24*3600e3, "7d": 7*24*3600e3, "30d": 30*24*3600e3,
};

export function createDashboard(options = {}) {
  const cfg = {
    dbPath: ":memory:",
    metricsUrl: "http://127.0.0.1:8788/metrics",
    // The self-hosted push relay's loopback /metrics. Empty string disables the
    // push collector and drops the push section from the payload.
    pushMetricsUrl: "http://127.0.0.1:8790/metrics",
    scrapeIntervalMs: 30_000,
    retentionMs: 90 * 24 * 60 * 60 * 1000,
    user: "",
    pass: "",
    buckets: 240,
    caps: { socketsCap: 200000, roomsCap: 200000, warnFrac: 0.7, critFrac: 0.9 },
    errorCfg: { ratioThreshold: 0.05, minRequests: 100, exceptionThreshold: 1 },
    fetchImpl: globalThis.fetch,
    now: Date.now,
    startCollectorOnListen: true,
    allowUnauthenticated: false,
    ...options,
  };

  // Fail closed: this module IS the auth boundary. requireAuth() returns true
  // (open) when either credential is missing, so without this guard a caller that
  // omits `user`/`pass` (or a copy-paste of this call, or a future entrypoint)
  // would silently serve `/` and `/api/data` unauthenticated. Refuse to stand up
  // that way unless the embedder opts in explicitly.
  if ((!cfg.user || !cfg.pass) && !cfg.allowUnauthenticated) {
    throw new Error(
      "createDashboard: refusing to start without both `user` and `pass` " +
      "(pass allowUnauthenticated: true to intentionally serve without auth).");
  }

  const db = options.db || new DashboardDB(cfg.dbPath);
  const page = renderPage(); // static; built once

  function sendJson(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  }

  function handleData(req, res, url) {
    const range = url.searchParams.get("range") || "24h";
    const span = RANGE_MS[range] || RANGE_MS["24h"];
    const nowMs = cfg.now();
    const toMs = nowMs;
    const fromMs = nowMs - span;
    // More buckets for wider ranges, but bounded so a 30d query stays cheap.
    const buckets = Math.min(cfg.buckets, Math.max(60, Math.round(span / cfg.scrapeIntervalMs)));
    const rows = db.range(fromMs, toMs);
    const latest = db.latest();
    const payload = buildDashboard(rows, {
      latest, fromMs, toMs, buckets, nowMs, caps: cfg.caps, errorCfg: cfg.errorCfg,
    });
    // Push section, only when push collection is enabled. Absent -> the page
    // simply doesn't render the push tiles/charts.
    if (cfg.pushMetricsUrl) {
      payload.push = buildPush(db.rangePush(fromMs, toMs), {
        latest: db.latestPush(), fromMs, toMs, buckets, nowMs,
      });
    }
    sendJson(res, 200, payload);
  }

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); }
    catch { res.writeHead(400).end("bad request"); return; }

    // Unauthenticated liveness for the proxy / uptime checks — reveals nothing.
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
      return;
    }

    if (!requireAuth(req, res, { user: cfg.user, pass: cfg.pass })) return;

    try {
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(page);
        return;
      }
      if (url.pathname === "/api/data") { handleData(req, res, url); return; }
      res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end("internal error\n");
      if (cfg.onError) cfg.onError(e);
    }
  });

  let stopCollector = null;
  let stopPushCollector = null;

  return {
    server,
    db,
    address() { return server.address(); },
    listen(port, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          if (cfg.startCollectorOnListen) {
            stopCollector = startCollector({
              db,
              url: cfg.metricsUrl,
              intervalMs: cfg.scrapeIntervalMs,
              retentionMs: cfg.retentionMs,
              fetchImpl: cfg.fetchImpl,
              now: cfg.now,
              onError: cfg.onError,
            });
            if (cfg.pushMetricsUrl) {
              stopPushCollector = startCollector({
                db,
                url: cfg.pushMetricsUrl,
                intervalMs: cfg.scrapeIntervalMs,
                retentionMs: cfg.retentionMs,
                fetchImpl: cfg.fetchImpl,
                now: cfg.now,
                onError: cfg.onError,
                parse: parsePushMetrics,
                insert: (ts, snap) => db.insertPush(ts, snap),
                prune: (cutoff) => db.prunePush(cutoff),
              });
            }
          }
          resolve();
        });
      });
    },
    async close() {
      if (stopCollector) stopCollector();
      if (stopPushCollector) stopPushCollector();
      await new Promise((r) => server.close(r));
      if (!options.db) db.close();
    },
  };
}
