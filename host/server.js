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
import { startMetricsPush } from "./metricspush.js";
import { Room } from "../src/room.js";
import { entryReject, ROOM_HEADER } from "../src/index.js";
import { resolveMode, MODE_DIRECT } from "../src/sharding/mode.js";
import { ownershipDecision } from "../src/sharding/admission.js";
import { bucketForRoomName } from "../src/sharding/bucket.js";
import { ShardMapStore } from "../src/sharding/shardMapStore.js";
import { ShardMapPoller } from "../src/sharding/shardMapPoller.js";
import { DrainScheduler } from "../src/sharding/drainScheduler.js";
import { reshardReason, WS_RESHARD_CODE } from "../src/sharding/wireCodes.js";
import { assertOriginMatches } from "../src/sharding/origin.js";
import { SHARDMAP_POLL_INTERVAL_MS, RESHARD_DRAIN_DELAY_MS, RESHARD_EVICTION_RATE } from "../src/sharding/params.js";

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
  // Off-box monitoring by OUTBOUND push (see host/metricspush.js): the relay
  // POSTs an aggregate, PII-free snapshot to a collector on a timer. This keeps
  // /metrics loopback-only — no inbound metrics surface, no origin hostname
  // exposed — and lets an external watcher run a dead-man's-switch. Empty URL
  // disables it (default).
  metricsPushUrl: "",
  metricsPushToken: "",
  metricsPushMs: 60_000,
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
  400: "Bad Request", 403: "Forbidden", 421: "Misdirected Request",
  429: "Too Many Requests",
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

// The distributed-mode shard-map GET. Direct HTTPS to the CDN; the on-box proxy
// is not in this path. Injected in tests via cfg.fetchText.
//
// Each attempt is bounded by an abort timeout well under the poll interval:
// without it a blackholed path (silent packet drop) leaves the fetch hanging
// until the OS TCP timeout (~minutes) with NO error thrown and NO counter bump
// the whole time -- the single worst case for after-the-fact diagnosis. A
// non-2xx carries the status and Cloudflare's cf-ray so an edge/Worker error is
// later attributable.
//
// A failed attempt is retried on a FRESH connection because the dominant failure
// in the field is per-packet loss on one box's path to the CDN (measured
// 2026-10-07: relay1 ~0.25% of attempts stalled to the abort and ~1% ran 1.5-8s,
// while relay2 on the same provider was clean; the loss is independent of address
// family, so a v4/v6 pin does not help). Loss is probabilistic per connection, so
// a fresh attempt almost always lands clean: retrying collapses the counted-
// failure rate without masking a real outage (which fails every attempt). The
// attempts sum to < the poll interval so successive polls never overlap.
const SHARDMAP_FETCH_ATTEMPT_TIMEOUT_MS = 3_000;
const SHARDMAP_FETCH_ATTEMPTS = 3; // 3 x 3s = 9s worst case, < SHARDMAP_POLL_INTERVAL_MS (10s)

async function fetchShardMapOnce(url, { timeoutMs, fetchImpl }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ac.signal });
    if (!r.ok) {
      const err = new Error(`shardmap HTTP ${r.status}`);
      err.httpStatus = r.status;
      err.cfRay = r.headers.get("cf-ray") || "";
      throw err;
    }
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// A 4xx is a definitive client/config fault (WAF, bad URL): repeating the same
// GET only reproduces it, so give up immediately and surface it. Everything else
// -- an abort (timeout), a network error (conn/dns/tls), or a 5xx edge blip -- is
// transient and worth a fresh-connection retry. Exported for tests.
export function shouldRetryShardFetch(error) {
  const s = error && error.httpStatus;
  if (typeof s === "number" && s >= 400 && s < 500) return false;
  return true;
}

// Fetch the shard map, retrying a transient failure on a fresh connection up to
// `attempts` times. Throws the LAST error if every attempt fails, so the poller
// records exactly one failure per poll and classifyShardFetchError still
// attributes it. `onRetry(error, attempt)` fires once per absorbed failure (for
// the retries counter). Exported for tests.
export async function fetchShardMapWithRetry(url, {
  attempts = SHARDMAP_FETCH_ATTEMPTS,
  timeoutMs = SHARDMAP_FETCH_ATTEMPT_TIMEOUT_MS,
  fetchImpl = fetch,
  onRetry,
} = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetchShardMapOnce(url, { timeoutMs, fetchImpl });
    } catch (error) {
      last = error;
      if (attempt >= attempts || !shouldRetryShardFetch(error)) break;
      if (onRetry) onRetry(error, attempt);
    }
  }
  throw last;
}

async function defaultFetchText(url) {
  return fetchShardMapWithRetry(url);
}

// Walk an error's .cause chain for the first errno-style code (undici hides the
// real code -- ENOTFOUND, ETIMEDOUT, ECONNRESET, a TLS code -- under the generic
// `TypeError: fetch failed`, in error.cause[.cause]).
function errCode(error) {
  let cur = error;
  for (let depth = 0; cur && depth < 4; depth++) {
    if (cur.code) return String(cur.code);
    cur = cur.cause;
  }
  return "";
}

// classifyShardFetchError(error) -> { cause, detail }. Turns a raw fetch/parse
// failure into a short, greppable cause so a persistent outage is attributable
// from the journal or /metrics without a live repro. The mapping is the whole
// point of the exercise: dns/timeout/conn/tls point at the relay->CDN path
// (provider network, routing, resolver DNS); http_5xx WITH a cf-ray points at
// Cloudflare/the Worker; http_4xx points at config (WAF/URL); parse points at
// the CDN serving non-map content (usually an error page). Exported for tests.
export function classifyShardFetchError(error) {
  if (!error) return { cause: "other", detail: "unknown" };
  if (typeof error.httpStatus === "number") {
    const s = error.httpStatus;
    const cause = s >= 500 ? "http_5xx" : s >= 400 ? "http_4xx" : "http_other";
    return { cause, detail: error.cfRay ? `HTTP ${s} cf-ray=${error.cfRay}` : `HTTP ${s}` };
  }
  if (error.kind) return { cause: "parse", detail: String(error.kind) };   // ShardMapValidationError
  if (error.name === "SyntaxError") return { cause: "parse", detail: "json" };
  if (error.name === "AbortError") return { cause: "timeout", detail: "abort" };
  const code = errCode(error);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { cause: "dns", detail: code };
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
    return { cause: "timeout", detail: code };
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH" ||
      code === "ENETUNREACH" || code === "EPIPE" || code === "ECONNABORTED") {
    return { cause: "conn", detail: code };
  }
  if (/^(CERT_|ERR_TLS|EPROTO|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_SSL)/.test(code)) {
    return { cause: "tls", detail: code };
  }
  return { cause: "other", detail: code || (error.message ? String(error.message).slice(0, 80) : "unknown") };
}

export function createRelay(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const env = options.env || {};
  const backend = new StorageBackend(options.dbPath || ":memory:");
  const metrics = new Metrics();
  // A room that blows its daily byte quota tears down every socket with a 1008
  // "daily quota exceeded" close (src/room.js overQuota). That close never
  // touches the pre-handshake reject counters, so meter it via the runtime's
  // server-close hook — counted per severed socket, so it keeps climbing while
  // a client retries blindly against an exhausted quota (the "stuck at the cap"
  // signal the dashboard surfaces). Other server closes (displacement) don't
  // match and are ignored.
  const runtime = new Runtime({
    RoomClass: Room, env, backend,
    onServerClose: (code, reason) => {
      const r = String(reason || "");
      if (code === 1008 && /quota/.test(r)) {
        metrics.inc("quota_exceeded_total");
      }
      // A phone turned away because no mac is parked (room.js admit -> reject
      // "mac offline"). A climbing rate is the direct, aggregate signal that
      // macs are not reaching their rooms — the failure that is otherwise only
      // visible as a stream of per-room disconnect lines. PII-free (a count).
      if (code === 1008 && r === "mac offline") {
        metrics.inc("phone_no_mac_total");
      }
    },
  });
  metrics.inc("quota_exceeded_total", 0); // pre-register so it always appears
  metrics.inc("phone_no_mac_total", 0); // pre-register so it always appears
  metrics.inc("ws_keepalive_terminated_total", 0); // pre-register so it always appears
  metrics.inc("shard_map_fetch_retries_total", 0); // pre-register so it always appears

  // A falsy limit config disables that limiter entirely (mirrors the old
  // deployment where the rate-limit binding was optional): the deployment still
  // serves, unthrottled, rather than failing.
  // Sharding mode (§6.5). Direct mode (self-host) owns every bucket and never
  // fetches a map, so the gate is a no-op. Distributed mode consults a shard-map
  // store kept current by a poller; a store may be injected (tests), otherwise it
  // is built from config (shardMapUrl + selfHost) with its own poller.
  const shardMode = resolveMode(cfg);
  if (shardMode !== MODE_DIRECT) {
    // Appendix A #7: the proof origin, the map/cert host, and this box's identity
    // are one string. Fail fast if RELAY_ORIGIN and selfHost disagree, or every
    // signed join for this box's buckets would fail.
    assertOriginMatches((cfg.env && cfg.env.RELAY_ORIGIN) || "", cfg.selfHost);
  }
  // Diagnostic log for sharding events (map adopt, drain evictions, fetch
  // failures), gated on RELAY_LOG like the room logs.
  const shardLog = (m) => { if (cfg.env && cfg.env.RELAY_LOG === "true") console.log(m); };

  // Shard-map fetch-failure logging: ALWAYS-ON (unlike the RELAY_LOG-gated
  // shardLog) because a persistent fetch failure is an operational event you
  // must be able to time and attribute after the fact -- but THROTTLED so a long
  // outage (a poll every ~10s) cannot flood the journal. First failure logs
  // immediately with the classified cause+detail; then a coalesced summary at
  // most once per window; then a RECOVERED line carrying the total duration when
  // a fetch succeeds again. Between the start line and the RECOVERED line you get
  // exactly what was missing: when it began, how long it lasted, and why.
  const SHARD_ERR_LOG_WINDOW_MS = 60_000;
  let shardErrStreak = 0;  // consecutive failures since the last success
  let shardErrSince = 0;   // ms timestamp of the first failure in this streak
  let shardErrLastLog = 0; // ms timestamp of the last summary line emitted
  function noteShardFetchError(error) {
    const { cause, detail } = classifyShardFetchError(error);
    metrics.inc("shard_map_fetch_errors_total");
    metrics.incReason("shard_map_fetch_errors_by_cause_total", cause);
    const now = Date.now();
    shardErrStreak += 1;
    if (shardErrStreak === 1) {
      shardErrSince = now;
      shardErrLastLog = now;
      const pollS = (cfg.pollIntervalMs ?? SHARDMAP_POLL_INTERVAL_MS) / 1000;
      console.warn(`relay: shardmap fetch FAILING cause=${cause} detail=${detail} ` +
        `url=${cfg.shardMapUrl} (poll ${pollS}s; summarizing ~every ` +
        `${SHARD_ERR_LOG_WINDOW_MS / 1000}s until recovery)`);
    } else if (now - shardErrLastLog >= SHARD_ERR_LOG_WINDOW_MS) {
      console.warn(`relay: shardmap fetch still FAILING cause=${cause} detail=${detail} ` +
        `streak=${shardErrStreak} elapsed=${Math.round((now - shardErrSince) / 1000)}s`);
      shardErrLastLog = now;
    }
  }
  function noteShardFetchOk() {
    if (shardErrStreak > 0) {
      console.warn(`relay: shardmap fetch RECOVERED after streak=${shardErrStreak} ` +
        `over ${Math.round((Date.now() - shardErrSince) / 1000)}s`);
      shardErrStreak = 0;
    }
  }
  let shardStore = cfg.shardMapStore || null;
  let shardPoller = null;
  let shardDrain = null;
  // On a reload, relinquished buckets are scheduled to drain; a re-acquired
  // bucket cancels any pending drain (§7.4).
  function applyShardDiff(diff) {
    if (!shardDrain) return;
    for (const b of diff.relinquished) shardDrain.relinquish(b);
    for (const b of diff.acquired) shardDrain.reacquire(b);
  }
  if (shardMode !== MODE_DIRECT && !shardStore) {
    shardStore = new ShardMapStore({ selfHost: cfg.selfHost });
    shardPoller = new ShardMapPoller({
      url: cfg.shardMapUrl,
      // Each poll retries a transient failure on a fresh connection (see
      // fetchShardMapWithRetry); a climbing retries_total with a flat errors_total
      // is the "path is lossy but retries absorb it" signal.
      fetchText: cfg.fetchText || ((url) =>
        fetchShardMapWithRetry(url, { onRetry: () => metrics.inc("shard_map_fetch_retries_total") })),
      store: shardStore,
      onAdopt: (map, diff) => {
        metrics.inc("shard_map_reloads_total");
        shardLog(`shardmap v${map.version} adopted: now own ${shardStore.ownedCount} buckets ` +
          `(+${diff.acquired.size} acquired, -${diff.relinquished.size} relinquished)`);
        applyShardDiff(diff);
      },
      onOk: () => noteShardFetchOk(),
      onError: (error) => noteShardFetchError(error),
      log: shardLog,
    });
  }
  if (shardMode !== MODE_DIRECT) {
    const pollMs = cfg.pollIntervalMs ?? SHARDMAP_POLL_INTERVAL_MS;
    const drainMs = cfg.drainDelayMs ?? RESHARD_DRAIN_DELAY_MS;
    const rate = cfg.evictionRate ?? RESHARD_EVICTION_RATE;
    // §7.4: the drain must defer at least two poll intervals; fail fast on a bad
    // operator override rather than risk bouncing clients between hosts. This is
    // the relay-relevant subset of params.validateParams; the TTL<poll invariant
    // is a CDN publish setting, enforced where the map is published, not here.
    if (drainMs < 2 * pollMs) {
      throw new Error(`drainDelayMs (${drainMs}) must be >= 2x pollIntervalMs (${pollMs})`);
    }
    if (rate <= 0) throw new Error(`evictionRate (${rate}) must be positive`);
    shardDrain = new DrainScheduler({
      drainDelayMs: drainMs,
      evictionRatePerSec: rate,
      now: cfg.now ?? Date.now,
      evict: (roomName) => {
        const n = runtime.closeRoom(roomName, WS_RESHARD_CODE, reshardReason());
        if (n > 0) shardLog(`shardmap drain: evicted room in bucket ${bucketForRoomName(roomName)} ` +
          `(WS 4421, ${n} sockets -> re-resolve)`);
      },
      liveRooms: (bucket) => runtime.roomsInBucket(bucket),
    });
  }
  metrics.inc("shard_reject_total", 0); // pre-register so they always appear
  metrics.inc("shard_map_reloads_total", 0);
  metrics.inc("shard_map_fetch_errors_total", 0);
  function ownershipGate(room) {
    if (shardMode === MODE_DIRECT) return { admit: true };
    return ownershipDecision({
      mode: shardMode, roomName: room, ownsBucket: (b) => shardStore.ownsBucket(b),
    });
  }
  // Point-in-time shard gauges for /metrics. Empty in direct mode, so a
  // self-hosted box's metrics are unchanged.
  function shardGauges() {
    if (shardMode === MODE_DIRECT) return {};
    return {
      shard_map_version: shardStore.version,
      shard_owned_buckets: shardStore.ownedCount,
      shard_draining_buckets: shardDrain ? shardDrain.drainingCount : 0,
    };
  }

  const bootSleep = cfg.bootSleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  // Fetch the map before accepting connections (§6.5), retrying until the first
  // map is adopted: accepting with an empty owned set would 421 every bucket.
  async function bootstrapShardMap() {
    if (!shardPoller) return; // direct mode, or an injected store the caller owns
    // Bounded so a cold boot during a CDN outage fails cleanly (systemd restarts)
    // rather than hanging "running" but never listening. Generous by default, so a
    // brief blip is absorbed; last-known-good cannot help a cold boot.
    const maxRetries = cfg.bootMaxRetries ?? 60;
    let attempts = 0;
    while (!shardStore.hasMap) {
      await shardPoller.fetchOnce();
      if (shardStore.hasMap) break;
      attempts += 1;
      if (attempts >= maxRetries) {
        throw new Error(
          `shard map fetch failed after ${attempts} attempts; refusing to accept ` +
          "connections without ownership (§6.5)");
      }
      if (cfg.env && cfg.env.RELAY_LOG === "true") {
        console.warn(`relay: shard map not available (attempt ${attempts}/${maxRetries}); retrying`);
      }
      await bootSleep(cfg.bootRetryMs ?? 1000);
    }
    shardPoller.start(cfg.pollIntervalMs ?? SHARDMAP_POLL_INTERVAL_MS);
  }

  let drainTimer = null;
  function startDrainTicker() {
    if (!shardDrain) return;
    const si = cfg.setInterval ?? setInterval;
    drainTimer = si(() => shardDrain.run(), cfg.drainTickMs ?? 1000);
    if (drainTimer && typeof drainTimer.unref === "function") drainTimer.unref();
  }
  function stopDrainTicker() {
    if (drainTimer !== null) { clearInterval(drainTimer); drainTimer = null; }
  }

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
        const occ = runtime.occupancy();
        return res.end(metrics.render({
          rooms_live: runtime.size,
          sockets_live: totalSockets,
          rooms_both: occ.both,
          rooms_mac_only: occ.mac_only,
          rooms_phone_only: occ.phone_only,
          rooms_neither: occ.neither,
          ...shardGauges(),
        }));
      }

      const rej = entryReject(headers);
      if (rej) return sendPlain(res, rej.status, rej.message);

      metrics.inc("http_requests_total");
      const room = headers.get(ROOM_HEADER);
      // Reject-on-doubt (§6.5): a bucket this box does not own is refused with 421
      // BEFORE the attest limiter and the body read, so a stale-map bounce is
      // neither an attestation failure nor a drain on the limiter. No-op in direct
      // mode. /metrics is handled above (no room header), so it is never gated.
      const httpGate = ownershipGate(room);
      if (!httpGate.admit) {
        metrics.inc("shard_reject_total");
        return sendPlain(res, httpGate.status, "misdirected");
      }
      const ip = clientIp(headers, req.socket, cfg);
      if (url.pathname.startsWith("/attest") && attestOver(ip)) {
        return sendPlain(res, 429, "rate limited");
      }
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

    const room = headers.get(ROOM_HEADER);
    // Reject-on-doubt (§6.5) BEFORE the rate/cap checks: a non-owned bucket must
    // get 421 (re-resolve), not a 429 (stay here) it would get if the per-IP ws
    // limiter fired first during a reshard reconnect. The gate is cheap (a hash
    // slice + set lookup) and allocates no socket. No-op in direct mode.
    const wsGate = ownershipGate(room);
    if (!wsGate.admit) {
      metrics.inc("shard_reject_total");
      return abortUpgrade(socket, wsGate.status, "misdirected");
    }

    const ip = clientIp(headers, socket, cfg);
    if (wsOver(ip)) return reject(socket, 429, "rate limited", "rate_limited");
    if ((ipSockets.get(ip) || 0) >= cfg.maxSocketsPerIp) {
      return reject(socket, 429, "too many connections", "ip_cap");
    }
    // Check-then-act, like the room cap below: concurrent upgrades can overshoot
    // these totals by the in-flight count before any increments. Fine — soft
    // memory bounds; the counters are decremented on close and self-correct.
    if (totalSockets >= cfg.maxTotalSockets) return reject(socket, 503, "capacity", "total_cap");
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
  // One keepalive sweep: reap sockets that missed the previous cycle's pong,
  // then ping the rest. Factored out of the interval so a test can invoke a
  // single sweep deterministically (a real dead-peer terminate is otherwise
  // timing-dependent, and the ws client auto-pongs so it never "misses").
  function sweepKeepalive() {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        // Missed a full ping/pong cycle: the peer (or its network path) is
        // dead. This is the ONLY place the cause is known — terminate() reaches
        // room.js as a generic remote 1006, indistinguishable from an upstream
        // reset (Caddy dropping an idle proxied leg), so record it HERE.
        // Always-on and PII-safe: opaque tag + role + duration, no room name /
        // IP / content.
        const att = ws._attachment;
        const tag = (att && att.tag) || "????????";
        const lived = ws._openedAt ? Date.now() - ws._openedAt : "?";
        console.log(`relay ${tag} keepalive no-pong; terminating `
          + `role=${(att && att.role) || "?"} lived=${lived}ms`);
        metrics.inc("ws_keepalive_terminated_total");
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }
  let keepaliveTimer = null;
  function startKeepalive() {
    keepaliveTimer = setInterval(sweepKeepalive, cfg.keepaliveMs);
    keepaliveTimer.unref?.();
  }

  // Outbound metrics push to the off-box monitor. Enabled only when both a URL
  // and a token are configured; otherwise the relay has no monitoring transport
  // and /metrics stays loopback-only.
  metrics.inc("metrics_push_errors_total", 0); // pre-register so it always appears
  let stopMetricsPush = null;
  function startMetricsPushIfConfigured() {
    if (!cfg.metricsPushUrl || !cfg.metricsPushToken) return;
    stopMetricsPush = startMetricsPush({
      url: cfg.metricsPushUrl,
      token: cfg.metricsPushToken,
      intervalMs: cfg.metricsPushMs,
      // shardGauges() is {} in direct mode, so snapshot() falls back to its
      // 0 / -1 defaults there; in distributed mode the push carries live
      // ownership, adoption, and drain state off-box.
      buildSnapshot: () => metrics.snapshot({
        rooms_live: runtime.size, sockets_live: totalSockets, ...shardGauges(),
      }),
      onError: () => metrics.inc("metrics_push_errors_total"),
    });
  }

  return {
    httpServer,
    wss,
    runtime,
    backend,
    metrics,
    // Test hook: run one keepalive sweep synchronously (see sweepKeepalive).
    _sweepKeepalive: sweepKeepalive,
    shardStore,
    shardPoller,
    shardDrain,
    async listen(port, host) {
      await runtime.rehydrate();
      await bootstrapShardMap();
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.removeListener("error", reject);
          resolve();
        });
      });
      startKeepalive();
      startMetricsPushIfConfigured();
      startDrainTicker();
      return this;
    },
    address() {
      return httpServer.address();
    },
    async close() {
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (stopMetricsPush) stopMetricsPush();
      if (shardPoller) shardPoller.stop();
      stopDrainTicker();
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
