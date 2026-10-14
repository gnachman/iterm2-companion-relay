// iTerm2 relay monitor -- the Node I/O shell (replaces the Cloudflare Worker).
//
// Why this exists: on Cloudflare the relay's ~1/min metrics push was one KV
// write each, and KV's free tier caps writes at ~1000/day, so the monitor ran
// out of quota every afternoon and emailed about it. Running here, on a Linux
// box you control, the snapshot lands in a local file with no write cap. No
// Cloudflare in the loop.
//
// Fleet-first (see core.js): with SHARD_MAP_URL set, the shard map is the source
// of truth for which hosts exist. Relays push per-host to /ingest/<host>; the
// monitor watches every host the map names and probes each with a room it owns.
// Adding a relay is zero monitor config. Without SHARD_MAP_URL it degrades to a
// single direct-mode relay pushing to /ingest.
//
//   POST /ingest              (Authorization: Bearer INGEST_TOKEN)  direct-mode push
//   POST /ingest/<host>       (Authorization: Bearer INGEST_TOKEN)  fleet per-host push
//   GET  /                    (x-monitor-key: MANUAL_TRIGGER_SECRET) dry-run analysis JSON
//   GET  /?test=1             (x-monitor-key: MANUAL_TRIGGER_SECRET) send a REAL test email
//
// plus an internal timer (MONITOR_INTERVAL_MS, default 5 min). Run it behind a
// TLS reverse proxy (Caddy or Apache): bind loopback here and proxy /ingest.

import http from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";

import { run, LATEST_KEY, latestKeyFor, HEALTH_KEY } from "./core.js";
import { probeHandshake, ownedRoomForHost, parseConfig, normalizeSnapshot } from "./monitor.js";
import { fileStore } from "./store.js";

// --- auth helpers ---

// Constant-time compare of two secrets supplied as strings. Length-guard first
// (timingSafeEqual throws on a length mismatch), then compare the bytes.
function secretEquals(a, expected) {
  if (!expected || typeof a !== "string") return false;
  const ab = Buffer.from(a);
  const eb = Buffer.from(expected);
  if (ab.length !== eb.length) return false;
  return timingSafeEqual(ab, eb);
}

function bearerOk(authHeader, expected) {
  const m = /^Bearer\s+(.+)$/i.exec(authHeader || "");
  return m ? secretEquals(m[1], expected) : false;
}

// HTTP Basic auth for the browser-facing dashboard: any username, password must
// equal the operator secret. Gives a native browser login and keeps the secret
// out of the URL (unlike the header-keyed operator JSON endpoints).
function basicAuthOk(authHeader, expected) {
  const m = /^Basic\s+(.+)$/i.exec(authHeader || "");
  if (!m) return false;
  let decoded;
  try { decoded = Buffer.from(m[1], "base64").toString("utf8"); } catch { return false; }
  const i = decoded.indexOf(":");
  return secretEquals(i === -1 ? decoded : decoded.slice(i + 1), expected);
}

// --- outside-in synthetic probe (real WebSocket handshake) ---

// A fresh 64-hex room per probe, so it never touches a real pairing (and the
// throwaway room is evicted once idle). Matches the relay's ROOM_NAME_RE. Used
// for the direct-mode probe; fleet mode supplies a specific owned room instead.
function randomRoom() {
  return randomBytes(32).toString("hex");
}

// Adapt the event-based `ws` socket to the { send, next, close } interface
// probeHandshake expects: buffer messages and hand them out one await at a time;
// a close/error before the next message rejects the pending read.
function wsAdapter(ws) {
  const queue = [];
  const waiters = [];
  const fail = (msg) => {
    const err = new Error(msg);
    while (waiters.length) waiters.shift().reject(err);
  };
  ws.on("message", (data) => {
    const s = typeof data === "string" ? data : data.toString("utf8");
    if (waiters.length) waiters.shift().resolve(s);
    else queue.push(s);
  });
  ws.on("close", () => fail("socket closed before reply"));
  ws.on("error", () => fail("socket error"));
  return {
    send: (s) => ws.send(s),
    next: () => new Promise((resolve, reject) => {
      if (queue.length) resolve(queue.shift());
      else waiters.push({ resolve, reject });
    }),
    close: () => { try { ws.close(); } catch { /* ignore */ } },
  };
}

// Open a WebSocket to a host and drive the mac-park handshake the way a client
// would -- the room rides on the x-relay-room header (src/index.js ROOM_HEADER).
// A SINGLE deadline covers both connect/upgrade and handshake, because the
// headline failure this catches -- a stale firewall blackholing inbound -- stalls
// during connect, so the timeout must abort the connection, not just the
// handshake. Returns { ok, detail }; never rejects. `room` defaults to a random
// throwaway room (direct mode); fleet mode passes a room the target host owns, so
// a sharded host's correct HTTP 421 reject-on-doubt for foreign rooms is avoided.
export async function nodeProbe(originUrl, timeoutMs, room = randomRoom()) {
  const wsUrl = originUrl.replace(/^http/i, "ws"); // https->wss, http->ws
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(
      () => done({ ok: false, detail: `timeout after ${timeoutMs}ms` }),
      timeoutMs,
    );
    try {
      ws = new WebSocket(wsUrl, {
        headers: { "x-relay-room": room },
        handshakeTimeout: timeoutMs,
      });
    } catch (e) {
      return done({ ok: false, detail: String((e && e.message) || e) });
    }
    ws.on("open", async () => {
      done(await probeHandshake(wsAdapter(ws)));
    });
    // A non-101 response (e.g. 502/403/421 from a proxy or the origin) shows up
    // here rather than as a socket, and is exactly the broken-inbound signal.
    ws.on("unexpected-response", (_req, res) => {
      done({ ok: false, detail: `no websocket upgrade (HTTP ${res.statusCode})` });
    });
    ws.on("error", (e) => done({ ok: false, detail: String((e && e.message) || e) }));
  });
}

// --- shard map (fleet mode) ---

// Fetch + parse the live shard map. max-age is a client-correctness invariant on
// the resolver side; no-store here so the monitor always sees the current map.
async function fetchMap(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

// Build a 64-hex room the host owns, using this box's randomness (the pure
// ownedRoomForHost stays deterministic by taking the randomness as arguments).
function roomForHost(map, host) {
  return ownedRoomForHost(map, host, randomBytes(30).toString("hex"), Math.random());
}

// --- email (Resend) ---

async function sendResend(env, alerts) {
  const worst = alerts.some((a) => a.severity === "critical") ? "CRITICAL" : "warning";
  const subject = `[iTerm2 relay] ${alerts.length} alert(s) (${worst})`;
  const text = alerts.map((a) => `[${a.severity.toUpperCase()}] ${a.title}\n${a.body}`).join("\n\n");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.ALERT_FROM, to: [env.ALERT_TO], subject, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

// --- env file loading (optional convenience for local `npm start`) ---

// Minimal KEY=VALUE loader so `node src/server.js monitor.env` works without a
// process manager. Under systemd you'd use EnvironmentFile= instead and skip the
// arg. Existing process.env always wins, so systemd/shell overrides take effect.
function loadEnvFile(file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

// --- HTTP server ---

function json(res, obj, status = 200) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// GET a URL and return its body text; throws on a non-2xx or timeout. Used to
// read the push relay's loopback /metrics.
export async function fetchText(url, timeoutMs = 10_000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Outside-in check of the push relay's public path (DNS -> edge -> proxy ->
// process). A GET is answered 405 "POST only" by the worker without touching APNs,
// a device token, or the relay's push counters, so it can run every tick for free.
// Anything else (a CDN error page, a 502, a different app) means inbound is broken.
export async function probePushOrigin(url, timeoutMs = 10_000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.status === 405
      ? { ok: true, detail: "ok" }
      : { ok: false, detail: `unexpected HTTP ${res.status} from ${url} (expected 405)` };
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e) };
  }
}

// --- fleet dashboard (server-rendered from the persisted HEALTH doc) ---

const N_BUCKETS = 65536; // ring size; buckets -> % of fleet weight

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function ago(ms) {
  if (ms == null) return "never";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

// Absolute wall-clock time in US Pacific, e.g. "22:31:14 PDT". The page only
// re-renders every 30s, so a frozen relative "Ns ago" in the header is
// ambiguous; an absolute stamp is not.
function pacific(ms) {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    timeZoneName: "short",
  });
}

const rank = (s) => (s === "crit" ? 2 : s === "warn" ? 1 : 0);

function row(k, v) {
  return `<div class=r><span class=k>${esc(k)}</span><span class=v>${esc(v)}</span></div>`;
}

// detailTpl: a URL template with a {host} placeholder pointing at each shard's
// own detailed dashboard (e.g. "https://{host}/dashboard/"). When set and the host
// is a real hostname, the whole card becomes a link to that shard's detail view.
function cardHtml(h, detailTpl) {
  const isPush = h.kind === "push";
  // A relay reports on a push cadence ("seen Ns ago"); the push relay is scraped
  // each analysis tick, so its freshness is when we last checked it.
  const rows = [row(isPush ? "checked" : "seen", h.ageMs == null ? "never" : `${ago(h.ageMs)} ago`)];
  if (h.sockets != null) rows.push(row("sockets", h.sockets));
  if (h.rooms != null) rows.push(row("rooms", h.rooms));
  if (h.buckets != null) rows.push(row("buckets", `${h.buckets} (${(h.buckets / N_BUCKETS * 100).toFixed(1)}%)`));
  if (isPush && h.push) {
    rows.push(row("last delivery", h.push.lastDeliveryAgeMs == null ? "none yet" : `${ago(h.push.lastDeliveryAgeMs)} ago`));
    if (h.push.delivered != null) rows.push(row("last check", `${h.push.delivered} ok / ${h.push.failed} failed`));
    if (h.push.timeouts) rows.push(row("APNs timeouts", h.push.timeouts));
    rows.push(row("APNs sessions", h.push.sessions));
    rows.push(row("devices", h.push.devices));
  }
  rows.push(row("inbound", h.probeOk == null ? "-" : (h.probeOk ? "ok" : "FAILING")));
  const why = h.status !== "ok" && h.reasons && h.reasons.length
    ? `<div class=why>${esc(h.reasons.join(", "))}</div>` : "";
  const inner = `<div class=top><span class=host>${esc(h.host)}</span>`
    + `<span class="badge ${esc(h.status)}">${esc(h.status.toUpperCase())}</span></div>`
    + `<div class=rows>${rows.join("")}</div>${why}`;
  const url = isPush ? (h.detailUrl || null)
    : (detailTpl && h.host.includes(".") ? detailTpl.replace("{host}", h.host) : null);
  return url
    ? `<a class="card link ${esc(h.status)}" href="${esc(url)}" target="_blank" rel="noopener">${inner}<div class=open>detail &#8599;</div></a>`
    : `<div class="card ${esc(h.status)}">${inner}</div>`;
}

const DASH_CSS = `
:root{--bg:#f6f7f9;--fg:#1a1d21;--card:#fff;--muted:#6b7280;--line:#e5e7eb;
--ok:#16a34a;--warn:#d97706;--crit:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#0f1216;--fg:#e6e8eb;--card:#171b21;--muted:#9aa4b2;--line:#262c34}}
*{box-sizing:border-box}body{margin:0}
.wrap{font:15px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg);min-height:100vh;padding:24px}
h1{font-size:18px;margin:0 0 12px}.muted{color:var(--muted)}
.hdr{border-radius:12px;padding:18px 20px;margin-bottom:16px;color:#fff}
.hdr.ok{background:var(--ok)}.hdr.warn{background:var(--warn)}.hdr.crit{background:var(--crit)}
.hdr .big{font-size:26px;font-weight:700}.hdr .sub{font-size:14px;opacity:.95}
.hdr .meta{font-size:12px;opacity:.85;margin-top:6px}
.banner{border-radius:10px;padding:10px 14px;margin-bottom:14px;background:var(--crit);color:#fff;font-size:14px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--muted);border-radius:10px;padding:14px}
.card.ok{border-left-color:var(--ok)}.card.warn{border-left-color:var(--warn)}.card.crit{border-left-color:var(--crit)}
a.card{display:block;text-decoration:none;color:inherit;transition:box-shadow .1s,transform .1s}
a.card:hover{box-shadow:0 2px 12px rgba(0,0,0,.18);transform:translateY(-1px)}
.open{margin-top:8px;font-size:12px;color:var(--muted)}
.top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.host{font-weight:600;word-break:break-all}
.badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;color:#fff;white-space:nowrap}
.badge.ok{background:var(--ok)}.badge.warn{background:var(--warn)}.badge.crit{background:var(--crit)}
.rows{display:grid;gap:2px}.r{display:flex;justify-content:space-between;font-size:13px}
.k{color:var(--muted)}.v{font-variant-numeric:tabular-nums}
.why{margin-top:8px;font-size:12px;color:var(--crit);word-break:break-word}
`;

// The persisted HEALTH doc is only rewritten each analysis tick (minutes apart),
// so a relay that recovered between ticks would still read as down. On every
// dashboard load, recompute the cheap, latency-sensitive parts -- "is it
// reporting?" and the live gauges -- from the per-host latest snapshots (local
// reads, no probing), keeping the tick's probe result and slower interval-based
// warnings (errors/exceptions/anomaly) as-is. This keeps liveness on the page
// current without probing relays on every refresh.
async function liveHealth(env, kv, now) {
  const health = await kv.get(HEALTH_KEY, "json");
  if (!health || !Array.isArray(health.hosts)) return health;
  const cfg = parseConfig(env);
  const hosts = await Promise.all(health.hosts.map(async (h) => {
    // The push relay is scraped each tick rather than pushing to us, so there is
    // no per-host snapshot to re-read: keep the tick's verdict, age it from when
    // it was checked.
    if (h.kind === "push") return { ...h, ageMs: h.checkedAt != null ? now - h.checkedAt : null };
    const latest = await kv.get(health.fleet ? `latest:${h.host}` : LATEST_KEY, "json");
    const ageMs = latest ? now - latest.receivedAt : null;
    const reporting = !!latest && ageMs <= cfg.staleMs;
    const gauges = latest ? normalizeSnapshot(latest.snapshot).gauges : null;
    const probeFailing = h.probeOk === false;
    const otherWarn = (h.reasons || []).some((k) => k !== "liveness" && k !== "probe");
    const reasons = (h.reasons || []).filter((k) => k !== "liveness");
    if (!reporting) reasons.unshift("liveness");
    return {
      ...h,
      ageMs,
      sockets: gauges ? gauges.socketsLive : null,
      rooms: gauges ? gauges.roomsLive : null,
      status: (!reporting || probeFailing) ? "crit" : (otherWarn ? "warn" : "ok"),
      reasons,
    };
  }));
  const summary = hosts.reduce(
    (c, s) => { c[s.status] += 1; c.total += 1; return c; },
    { total: 0, ok: 0, warn: 0, crit: 0 },
  );
  return { ...health, hosts, summary, at: now, probeAt: health.at };
}

function renderDashboard(health, now, detailTpl) {
  const head = (title, refresh) =>
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">`
    + `<meta http-equiv=refresh content=${refresh}><title>${esc(title)}</title><style>${DASH_CSS}</style>`;
  if (!health) {
    return `${head("Relay fleet", 15)}<div class=wrap><h1>iTerm2 relay fleet</h1>`
      + `<p class=muted>Collecting data. The first check runs within the analysis interval; reload shortly.</p></div>`;
  }
  const s = health.summary;
  const overall = s.crit ? "crit" : (s.warn ? "warn" : "ok");
  const sub = s.crit || s.warn
    ? `${s.crit ? `${s.crit} critical` : ""}${s.crit && s.warn ? ", " : ""}${s.warn ? `${s.warn} warning` : ""}`
    : "all systems normal";
  const cards = health.hosts.slice()
    .sort((a, b) => rank(b.status) - rank(a.status) || a.host.localeCompare(b.host))
    .map((h) => cardHtml(h, detailTpl)).join("");
  const mapLine = health.fleet ? `map v${esc(health.mapVersion ?? "?")}` : "direct mode";
  const banner = health.mapError ? `<div class=banner>shard map fetch failed: ${esc(health.mapError)}</div>` : "";
  return `${head(`Relay fleet ${s.crit ? "⚠" : ""}`.trim(), 30)}<div class=wrap>`
    + `<header class="hdr ${overall}"><div class=big>${s.ok}/${s.total} healthy</div>`
    + `<div class=sub>${esc(sub)}</div><div class=meta>${mapLine} &middot; updated ${esc(pacific(now))}`
    + `${health.probeAt != null ? ` &middot; probed ${esc(pacific(health.probeAt))}` : ""}</div></header>`
    + `${banner}<div class=grid>${cards}</div></div>`;
}

// A DNS hostname: labels of letters/digits/hyphens joined by dots, <=253 chars.
// Bearer-gated already; this just keeps a bogus path from creating junk keys.
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export function createServer(env, deps) {
  const { kv } = deps;
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return json(res, { error: "bad url" }, 400);
    }

    // A relay pushes its aggregate snapshot here. Bearer-authenticated. Bare
    // /ingest is the single direct-mode relay; /ingest/<host> is a fleet host,
    // stored under its own key so per-host liveness/analysis stay separate.
    if (req.method === "POST" && (url.pathname === "/ingest" || url.pathname.startsWith("/ingest/"))) {
      if (!bearerOk(req.headers.authorization, env.INGEST_TOKEN)) {
        return json(res, { error: "unauthorized" }, 401);
      }
      let key = LATEST_KEY;
      if (url.pathname !== "/ingest") {
        const host = decodeURIComponent(url.pathname.slice("/ingest/".length));
        if (!HOST_RE.test(host)) return json(res, { error: "bad host" }, 400);
        key = latestKeyFor(host);
      }
      let snapshot;
      try {
        snapshot = JSON.parse(await readBody(req));
      } catch {
        return json(res, { error: "bad json" }, 400);
      }
      await kv.put(key, JSON.stringify({ receivedAt: Date.now(), snapshot }));
      res.writeHead(204).end();
      return;
    }

    // Fleet dashboard: a browser-facing at-a-glance health page, Basic-auth
    // gated, rendered from the last tick's persisted HEALTH doc (no re-probing
    // on load). Auto-refreshes client-side.
    if (req.method === "GET" && url.pathname === "/dashboard") {
      if (!basicAuthOk(req.headers.authorization, env.MANUAL_TRIGGER_SECRET)) {
        res.writeHead(401, {
          "WWW-Authenticate": 'Basic realm="relay-fleet", charset="UTF-8"',
          "content-type": "text/plain",
        });
        res.end("authentication required");
        return;
      }
      const now = Date.now();
      const health = await liveHealth(env, kv, now); // live liveness/gauges, tick's probe
      // Per-shard detail link. Default to each host's own dashboard; a deployment
      // can override or set empty to disable the links.
      const detailTpl = "DASHBOARD_URL_TEMPLATE" in env ? env.DASHBOARD_URL_TEMPLATE : "https://{host}/dashboard/";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(renderDashboard(health, now, detailTpl));
      return;
    }

    // Everything else is an operator tool, gated by the manual-trigger secret.
    if (req.method === "GET") {
      if (!secretEquals(req.headers["x-monitor-key"], env.MANUAL_TRIGGER_SECRET)) {
        return json(res, { error: "not found" }, 404);
      }
      if (url.searchParams.get("test") === "1") {
        try {
          await deps.sendEmail(env, [{
            key: "test", severity: "warn", title: "Relay monitor test",
            body: "If you received this, the monitor's email path works.",
          }]);
          return json(res, { emailed: true });
        } catch (e) {
          return json(res, { emailed: false, error: String((e && e.message) || e) }, 500);
        }
      }
      // Dry run: fetch the map, analyze every host's latest snapshot, and probe
      // each -- without sending mail or writing state.
      return json(res, await run(env, Date.now(), { ...deps, dry: true }));
    }

    return json(res, { error: "not found" }, 404);
  });
}

// --- entrypoint ---

// Guarded so importing this module in tests doesn't start a server or timer.
function main() {
  const envArg = process.argv[2];
  if (envArg) loadEnvFile(envArg);
  const env = process.env;

  for (const k of ["INGEST_TOKEN", "ALERT_FROM", "ALERT_TO", "RESEND_API_KEY"]) {
    if (!env[k]) {
      console.error(`relay-monitor: missing required env ${k}`);
      process.exit(1);
    }
  }

  const host = env.MONITOR_HOST || "127.0.0.1";
  const port = Number(env.MONITOR_PORT || 8790);
  const stateDir = env.MONITOR_STATE_DIR || "./data";
  const intervalMs = Number(env.MONITOR_INTERVAL_MS || 5 * 60 * 1000);

  const deps = {
    kv: fileStore(stateDir),
    sendEmail: sendResend,
    fetchMap,
    probeOne: nodeProbe,
    roomForHost,
    scrapePush: fetchText,
    probePush: probePushOrigin,
  };

  const tick = () => run(env, Date.now(), { ...deps, dry: false })
    .catch((e) => console.error("relay-monitor: tick failed:", (e && e.message) || e));

  const server = createServer(env, deps);
  server.listen(port, host, () => {
    const mode = env.SHARD_MAP_URL ? `fleet (map: ${env.SHARD_MAP_URL})` : "direct";
    console.error(`relay-monitor: listening on http://${host}:${port} (${mode})`);
    console.error(`relay-monitor: analyzing every ${Math.round(intervalMs / 1000)}s; state in ${stateDir}`);
    tick(); // run once at startup so a fresh box surfaces problems immediately
    const timer = setInterval(tick, intervalMs);
    const shutdown = () => { clearInterval(timer); server.close(() => process.exit(0)); };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
}

// Start only when run directly (node src/server.js [envfile]), not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
