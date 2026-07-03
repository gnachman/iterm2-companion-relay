// The self-hosted http + ws host. It replaces the Cloudflare entry Worker and
// the platform's connection routing: it applies the shared entry gate, enforces
// the per-IP rate limits and the caps a single process needs (which Cloudflare
// bounded for free), then hands each request or accepted socket to the runtime,
// which owns the room's this.ctx and the unmodified room.js logic.
//
// Client IP is read CF-Connecting-IP -> X-Forwarded-For -> socket, so the same
// binary runs origin-only or fronted by Cloudflare's free proxy with no code
// change. The IP is used only as an ephemeral rate-limit key and is never
// logged or stored (preserving the relay's zero-PII posture).

import http from "node:http";
import { WebSocketServer } from "ws";
import { StorageBackend } from "./storage.js";
import { Runtime } from "./runtime.js";
import { Metrics } from "./metrics.js";
import { Room } from "../src/room.js";
import { entryReject, ROOM_HEADER } from "../src/index.js";

// Ceiling on a single buffered frame. Above room.js's own MAX_FRAME_BYTES
// (256 KiB) so room.js still makes the semantic close(1009) decision, but low
// enough that ws bounds memory before a hostile jumbo frame is fully buffered.
const MAX_PAYLOAD = 512 * 1024;

// Hard cap on an HTTP request body. The only bodies are /attest (a CBOR
// attestation + cert chain, a few KiB) and /register (verifier + assertion,
// smaller); 64 KiB is generous. Without this, readBody would buffer an
// unbounded stream — and /register is not rate-limited — so one connection
// could OOM the process.
const MAX_BODY_BYTES = 64 * 1024;

// Defaults mirror the production wrangler.jsonc rate limits; the new cardinality
// caps are what a single process must add on top of what the platform gave.
const DEFAULTS = {
  attestLimit: { limit: 30, windowMs: 60_000 },
  wsLimit: { limit: 120, windowMs: 60_000 },
  maxRooms: 200_000,
  maxSocketsPerIp: 64,
  maxTotalSockets: 200_000,
  keepaliveMs: 30_000,
  // Trust forwarded client-IP headers only when the fronting proxy sets them
  // authoritatively (see clientIp). Default off so an unproxied/misconfigured
  // deployment cannot be spoofed into per-IP-cap evasion.
  trustProxy: false, // generic proxy (Caddy) -> trust X-Forwarded-For only
  trustCloudflare: false, // origin behind Cloudflare -> trust CF-Connecting-IP
  trustedHops: 1, // appending proxies in front; XFF is read Nth-from-right
};

// Hop-by-hop / connection headers that must not be forwarded into the synthetic
// Fetch Request (undici manages framing itself).
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade",
  "content-length", "host",
]);

// The client IP used ONLY as an ephemeral rate-limit key (never logged/stored).
// A forwarded header is honored ONLY when the proxy that sets it is authoritative
// — otherwise a direct attacker sets a fresh value per connection and defeats
// every per-IP cap:
//   - trustCloudflare: the origin is behind Cloudflare (CF sets CF-Connecting-IP
//     and strips any client copy; the origin firewall admits only CF), so prefer
//     it, then X-Forwarded-For.
//   - trustProxy: a generic reverse proxy (Caddy) that authoritatively sets
//     X-Forwarded-For. It does NOT set CF-Connecting-IP, so a client-supplied one
//     must be ignored (the H1 spoof).
// Neither set: key on the real socket peer.
//
// X-Forwarded-For is read RIGHT-to-left: each appending proxy adds the peer it
// observed to the RIGHT, so the rightmost hop is the one YOUR trusted proxy saw,
// while anything to its left is client-supplied and spoofable. `trustedHops` (the
// number of appending proxies in front, default 1) selects the Nth-from-right.
// This is correct for a replacing proxy too (single element) and, unlike taking
// the leftmost, fails closed if the front-end appends instead of replaces.
export function clientIp(headers, socket, { trustProxy = false, trustCloudflare = false, trustedHops = 1 } = {}) {
  if (trustCloudflare) {
    const cf = headers.get("cf-connecting-ip");
    if (cf) return cf.trim();
  }
  if (trustProxy || trustCloudflare) {
    const xff = headers.get("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length) {
        // Nth-from-right. If trustedHops exceeds the actual chain (misconfig),
        // fail CLOSED to the rightmost (most-trusted) hop rather than the
        // client-controlled leftmost — the latter would defeat per-IP caps.
        const idx = parts.length - trustedHops;
        return parts[idx >= 0 ? idx : parts.length - 1];
      }
    }
  }
  return socket.remoteAddress || "unknown";
}

// Fixed-window per-key limiter. On one process this is exact (not a
// per-datacenter estimate like the platform limiter it replaces). `maxKeys`
// hard-bounds the bucket map so a high-cardinality flood (many distinct client
// IPs in one window — a large botnet keyed on XFF) cannot grow it without bound.
export function makeLimiter({ limit, windowMs }, maxKeys = 50_000) {
  const buckets = new Map();
  const over = function over(key) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start > windowMs) {
      b = { start: now, count: 0 };
      buckets.set(key, b);
    }
    b.count += 1;
    if (buckets.size > maxKeys) {
      // Sweep expired buckets first...
      for (const [k, v] of buckets) if (now - v.start > windowMs) buckets.delete(k);
      // ...then, if a live flood still exceeds the cap, evict oldest-by-insertion
      // (Map preserves insertion order) until under it. Evicting a key merely
      // resets that IP's window (fail-open for one key) — acceptable for a soft
      // memory bound.
      while (buckets.size > maxKeys) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
    }
    return b.count > limit;
  };
  over.size = () => buckets.size;
  return over;
}

function toHeaders(nodeHeaders) {
  const h = new Headers();
  for (const [k, v] of Object.entries(nodeHeaders)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (Array.isArray(v)) for (const x of v) h.append(k, x);
    else if (v != null) h.append(k, v);
  }
  return h;
}

// Read the request body, rejecting with a BODY_TOO_LARGE error as soon as it
// exceeds `limit` (rather than buffering to completion).
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        const e = new Error("body too large");
        e.code = "BODY_TOO_LARGE";
        reject(e);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => { if (!done) resolve(Buffer.concat(chunks)); });
    req.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

const STATUS_TEXT = {
  400: "Bad Request", 403: "Forbidden", 429: "Too Many Requests",
  500: "Internal Server Error", 503: "Service Unavailable",
};

function sendPlain(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(message);
}

// Reject a WebSocket upgrade before the handshake completes, so a capped or
// rate-limited connector never allocates a socket. The ws client surfaces this
// as an "unexpected-response" with the status code.
function abortUpgrade(socket, status, message) {
  const text = STATUS_TEXT[status] || "Error";
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: text/plain\r\n" +
    `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n` +
    message);
  socket.destroy();
}

export function createRelay(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const env = options.env || {};
  const backend = new StorageBackend(options.dbPath || ":memory:");
  const runtime = new Runtime({ RoomClass: Room, env, backend });
  const metrics = new Metrics();

  // A falsy limit config disables that limiter entirely (mirrors the old
  // deployment where the rate-limit binding was optional): the deployment still
  // serves, unthrottled, rather than failing.
  const attestOver = cfg.attestLimit ? makeLimiter(cfg.attestLimit) : () => false;
  const wsOver = cfg.wsLimit ? makeLimiter(cfg.wsLimit) : () => false;

  let totalSockets = 0;
  const ipSockets = new Map();

  // A direct local scrape only: loopback peer and no proxy headers, so /metrics
  // is never reachable through the public reverse proxy (which sets these).
  function isLocalScrape(req, headers) {
    const addr = req.socket.remoteAddress || "";
    const loopback = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
    return loopback && !headers.get("x-forwarded-for") && !headers.get("cf-connecting-ip");
  }

  const httpServer = http.createServer(handleRequest);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  httpServer.on("upgrade", handleUpgrade);

  async function handleRequest(req, res) {
    try {
      const headers = toHeaders(req.headers);
      const url = new URL(req.url, "http://relay.local");

      // Localhost-only aggregate metrics, handled before the entry gate (a
      // scrape carries no room header). Non-identifying: counts + a lifetime
      // histogram, no room names or IPs.
      if (url.pathname === "/metrics") {
        if (!isLocalScrape(req, headers)) return sendPlain(res, 403, "forbidden");
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        return res.end(metrics.render({ rooms_live: runtime.size, sockets_live: totalSockets }));
      }

      const rej = entryReject(headers);
      if (rej) return sendPlain(res, rej.status, rej.message);

      metrics.inc("http_requests_total");
      const ip = clientIp(headers, req.socket, cfg);
      if (url.pathname.startsWith("/attest") && attestOver(ip)) {
        return sendPlain(res, 429, "rate limited");
      }
      const room = headers.get(ROOM_HEADER);
      // Check-then-act: a burst of concurrent new-room requests can each pass
      // this before any creates its room, overshooting maxRooms by the
      // concurrency width. Acceptable — the cap is a soft memory bound, not a
      // security limit, and each overshoot room is still evicted when idle.
      if (!runtime.rooms.has(room) && runtime.size >= cfg.maxRooms) {
        return sendPlain(res, 503, "capacity");
      }

      // Reject an oversized body up front by Content-Length, and abort mid-
      // stream if an un-declared (chunked) body runs past the cap. Read the raw
      // Node header — `headers` (the synthetic Fetch Headers) strips
      // content-length as hop-by-hop, so it is never visible there.
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return sendPlain(res, 413, "payload too large");
      }
      let body;
      try {
        body = await readBody(req, MAX_BODY_BYTES);
      } catch (e) {
        if (e && e.code === "BODY_TOO_LARGE") {
          if (!res.headersSent) sendPlain(res, 413, "payload too large");
          try { req.destroy(); } catch { /* ignore */ }
          return;
        }
        // Any other readBody rejection is a client-side stream failure (reset /
        // aborted mid-body). Not our internal error: return quietly — don't count
        // it toward http_errors_total and don't write 500 to a dead socket.
        return;
      }
      const request = new Request(url, {
        method: req.method,
        headers,
        body: body.length ? body : undefined,
      });
      const ctx = await runtime.get(room);
      ctx.pin(); // forbid eviction while this request runs (unpin re-checks)
      let response;
      try {
        response = await ctx.instance.fetch(request);
      } finally {
        ctx.unpin();
      }
      const buf = Buffer.from(await response.arrayBuffer());
      const out = {};
      response.headers.forEach((v, k) => { out[k] = v; });
      res.writeHead(response.status, out);
      res.end(buf);
    } catch {
      // Count 500s so a recurring internal error is visible in /metrics — prod
      // logging is off, and the process-level exception counters don't see it
      // (it's caught here). Mirrors the WS reject path.
      metrics.inc("http_errors_total");
      if (!res.headersSent) sendPlain(res, 500, "internal error");
      else res.end();
    }
  }

  function reject(socket, status, message, reason) {
    metrics.incReason("ws_upgrades_rejected_total", reason);
    abortUpgrade(socket, status, message);
  }

  function handleUpgrade(req, socket, head) {
    const headers = toHeaders(req.headers);
    const rej = entryReject(headers);
    if (rej) return reject(socket, rej.status, rej.message, "gate");

    const ip = clientIp(headers, socket, cfg);
    if (wsOver(ip)) return reject(socket, 429, "rate limited", "rate_limited");
    if ((ipSockets.get(ip) || 0) >= cfg.maxSocketsPerIp) {
      return reject(socket, 429, "too many connections", "ip_cap");
    }
    // Check-then-act, like the room cap below: concurrent upgrades can overshoot
    // these totals by the in-flight count before any increments. Fine — soft
    // memory bounds; the counters are decremented on close and self-correct.
    if (totalSockets >= cfg.maxTotalSockets) return reject(socket, 503, "capacity", "total_cap");
    const room = headers.get(ROOM_HEADER);
    if (!runtime.rooms.has(room) && runtime.size >= cfg.maxRooms) {
      return reject(socket, 503, "capacity", "room_cap");
    }

    wss.handleUpgrade(req, socket, head, async (ws) => {
      // Hold incoming frames (buffered by TCP backpressure) until the message
      // handler is attached in handleUpgrade->acceptWebSocket. The 101 is already
      // sent, so the client may send its first frame immediately; without this,
      // any real-async introduced before acceptWebSocket (an async DB driver, an
      // awaited hash in runtime.get) would drop that frame — pairing would hang
      // until the 15s pre-auth sweep. Pausing here makes that safe by
      // construction rather than relying on runtime.get staying synchronous.
      ws.pause();
      totalSockets += 1;
      ipSockets.set(ip, (ipSockets.get(ip) || 0) + 1);
      metrics.inc("ws_upgrades_total");
      ws.isAlive = true;
      ws._openedAt = Date.now();
      ws.on("pong", () => { ws.isAlive = true; });
      ws.on("close", () => {
        totalSockets -= 1;
        metrics.observeSocketLifetime((Date.now() - ws._openedAt) / 1000);
        const n = (ipSockets.get(ip) || 1) - 1;
        if (n <= 0) ipSockets.delete(ip); else ipSockets.set(ip, n);
      });
      try {
        const ctx = await runtime.get(room);
        ctx.pin(); // pin across the whole upgrade so the context cannot be
        try {      // evicted mid-await; unpin re-checks (also reclaims on throw)
          await ctx.instance.handleUpgrade(ws, { headers });
        } finally {
          ctx.unpin();
        }
      } catch {
        try { ws.close(1011, "internal error"); } catch { /* ignore */ }
      } finally {
        ws.resume(); // handler attached (or socket closed) — deliver buffered frames
      }
    });
  }

  // Keepalive: a parked Mac is meant to sit idle for a long time. Ping on a
  // cadence and terminate anything that stops answering, so a half-open socket
  // (or a proxy that silently dropped an idle connection) is detected instead
  // of pinning a dead peer. Since there is no hibernation cost, sockets stay
  // open indefinitely otherwise.
  let keepaliveTimer = null;
  function startKeepalive() {
    keepaliveTimer = setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* ignore */ }
      }
    }, cfg.keepaliveMs);
    keepaliveTimer.unref?.();
  }

  return {
    httpServer,
    wss,
    runtime,
    backend,
    metrics,
    async listen(port, host) {
      await runtime.rehydrate();
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.removeListener("error", reject);
          resolve();
        });
      });
      startKeepalive();
      return this;
    },
    address() {
      return httpServer.address();
    },
    async close() {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      for (const ws of wss.clients) {
        try { ws.close(1001, "server shutting down"); } catch { /* ignore */ }
      }
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => httpServer.close(() => resolve()));
      // Cancel per-room alarm timers before the DB closes, or a late alarm hits
      // a closed connection.
      runtime.shutdown();
      backend.close();
    },
  };
}
