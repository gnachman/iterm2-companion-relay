// One cheap health tick for the Mac-side relay watcher.
//
// This runs with NO LLM. It is the fast, deterministic signal the Claude loop
// samples every iteration: it probes every relay named in the live shard map
// from THIS machine (a second, independent vantage from the mcnachman.cloud
// monitor) with a real owned-room mac-park handshake, plus a few control fetches
// that prove this Mac has working internet. That control set is what tells
// "the relay's inbound path is down" (serious) apart from "this laptop's wifi
// dropped" or "the monitor's own uplink blipped" (the 99% transient).
//
// It prints ONE JSON verdict to stdout and exits 0 when everything is healthy,
// 1 otherwise, so the loop can branch on exit code without parsing while Claude
// reads the JSON for triage. It also writes state/last.json for edge detection
// (ok->fail, fail->ok) and as a liveness heartbeat.
//
// It also checks the push relays (push.iterm2.com, then push2.iterm2.com) with a
// plain GET. While every relay is fine: the primary failing is verdict
// "push-unreachable" (released apps only know the primary, so their pushes
// fail), and only another instance failing is "push-degraded" (no failover,
// but users are unaffected).
//
// The handshake mirrors the monitor's probe (monitor/src/{monitor,server}.js);
// it is kept self-contained here so ops/watch only needs `ws`.

import WebSocket from "ws";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAP_URL = process.env.SHARD_MAP_URL || "https://resolver.iterm2.com/shardmap.json";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 10000);
const STATE_DIR = process.env.WATCH_STATE_DIR || join(HERE, "state");
// The push relays (APNs forwarders). Not in the shard map; each answers a plain
// GET on / with 405, which proves DNS, any CDN, and the origin are all serving.
// Mirrors the monitor's probePushOrigin (monitor/src/server.js). Comma-separated,
// primary first; set to an empty string to skip the push check. The older
// single PUSH_PROBE_URL is still honored when PUSH_PROBE_URLS is unset.
const PUSH_PROBE_URLS = (process.env.PUSH_PROBE_URLS
  ?? process.env.PUSH_PROBE_URL
  ?? "https://push.iterm2.com/,https://push2.iterm2.com/")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Control targets prove this box has working internet independent of the relays.
// Mix providers on purpose: resolver.iterm2.com and cloudflare.com both ride
// Cloudflare, so a Cloudflare-routing problem would fail both while google still
// answers. If NONE answer, the fault is this Mac's connectivity, not the relay.
const CONTROLS = (process.env.CONTROL_URLS
  || "https://resolver.iterm2.com/shardmap.json,https://www.cloudflare.com/cdn-cgi/trace,https://www.google.com/generate_204")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Drill-only fault injection: a comma list of hosts to report as unreachable,
// so the watcher can be exercised end to end without touching a real relay.
// Unset in normal operation.
const FORCE_FAIL = new Set((process.env.WATCH_FORCE_FAIL_HOSTS || "")
  .split(",").map((s) => s.trim()).filter(Boolean));

// Build a 64-hex room whose bucket the host owns, so a sharded host does not
// correctly HTTP 421 us for a foreign room. Ranges cover [low,high] of the
// 16-bit bucket space; pick uniformly across every bucket the host owns.
function ownedRoomForHost(map, host, prefix60, randUnit) {
  const ranges = ((map && map.ranges) || []).filter((r) => r && r.host === host
    && Number.isInteger(r.low) && Number.isInteger(r.high) && r.low <= r.high);
  const total = ranges.reduce((n, r) => n + (r.high - r.low + 1), 0);
  if (total === 0) return null; // host owns nothing (drained): skip, that is normal
  let idx = Math.min(total - 1, Math.max(0, Math.floor(randUnit * total)));
  for (const r of ranges) {
    const size = r.high - r.low + 1;
    if (idx < size) return prefix60 + (r.low + idx).toString(16).padStart(4, "0");
    idx -= size;
  }
  return null;
}

async function fetchControl(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { url, ok: res.ok, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { url, ok: false, detail: String((e && e.message) || e), ms: Date.now() - t0 };
  }
}

// A 405 is the push relay's healthy answer to GET /. Anything else (a 52x from
// Cloudflare when the origin is down, a timeout, a TLS error) is a failure.
async function probePush(url) {
  if (FORCE_FAIL.has(new URL(url).host)) return { ok: false, detail: "timeout after 10000ms" };
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.status === 405
      ? { ok: true, detail: "ok (HTTP 405)" }
      : { ok: false, detail: `unexpected HTTP ${res.status} (expected 405)` };
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e) };
  }
}

// Drive the real mac-park handshake a client would: park a fresh room (no
// verifier, so no App Attest), and success means the whole inbound serving path
// (DNS, TLS, firewall, proxy, WS upgrade, admission) actually works right now.
function probeRelay(host, room) {
  const url = `wss://${host}/`;
  return new Promise((resolve) => {
    let settled = false;
    let stage = 0;
    let ws;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch { /* ignore */ }
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, detail: `timeout after ${TIMEOUT_MS}ms` }), TIMEOUT_MS);
    try {
      ws = new WebSocket(url, { headers: { "x-relay-room": room }, handshakeTimeout: TIMEOUT_MS });
    } catch (e) {
      return done({ ok: false, detail: String((e && e.message) || e) });
    }
    ws.on("open", () => ws.send(JSON.stringify({ v: 1, role: "mac" })));
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch (e) { return done({ ok: false, detail: `bad reply: ${String((e && e.message) || e)}` }); }
      if (stage === 0) {
        if (!msg || typeof msg.nonce !== "string") return done({ ok: false, detail: "no challenge nonce" });
        stage = 1;
        ws.send(JSON.stringify({})); // empty proof; a fresh-room mac parks freely
      } else if (msg && msg.ok) {
        done({ ok: true, detail: "mac parked" });
      } else {
        done({ ok: false, detail: `admission rejected: ${(msg && msg.error) || "unknown"}` });
      }
    });
    // A non-101 (502/403/421 from a proxy or the origin) surfaces here, not as a
    // socket, and is exactly the broken-inbound signal.
    ws.on("unexpected-response", (_req, res) => done({ ok: false, detail: `no ws upgrade (HTTP ${res.statusCode})` }));
    ws.on("error", (e) => done({ ok: false, detail: String((e && e.message) || e) }));
  });
}

async function main() {
  const startedMs = Date.now();

  const controls = await Promise.all(CONTROLS.map(fetchControl));
  const controlsOk = controls.some((c) => c.ok); // any well-known host up => this Mac has internet

  let map = null;
  let mapErr = null;
  try {
    const res = await fetch(MAP_URL, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    map = JSON.parse(await res.text());
  } catch (e) {
    mapErr = String((e && e.message) || e);
  }

  const hostList = map
    ? [...new Set((map.ranges || []).map((r) => r.host).filter(Boolean))]
    : (process.env.RELAY_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean);

  const hosts = [];
  for (const host of hostList) {
    if (FORCE_FAIL.has(host)) { // drill: pretend this host's inbound path is dead
      hosts.push({ host, ok: false, detail: "timeout after 10000ms", ms: 10000 });
      continue;
    }
    const room = map
      ? ownedRoomForHost(map, host, randomBytes(30).toString("hex"), Math.random())
      : randomBytes(32).toString("hex");
    const t0 = Date.now();
    const r = room
      ? await probeRelay(host, room)
      : { ok: true, detail: "owns nothing (drained); skipped" };
    hosts.push({ host, ok: r.ok, detail: r.detail, ms: Date.now() - t0 });
  }

  const pushes = [];
  for (const url of PUSH_PROBE_URLS) {
    const t0 = Date.now();
    pushes.push({ host: new URL(url).host, ...(await probePush(url)), ms: Date.now() - t0 });
  }
  const push = pushes[0] ?? null; // the primary (kept as its own field for readers of `push`)

  const failed = hosts.filter((h) => !h.ok);
  let verdict;
  if (!controlsOk) verdict = "mac-offline";                       // cannot trust probe results
  else if (mapErr && hosts.length === 0) verdict = "map-unreachable";
  else if (failed.length === 0) {
    verdict = push && !push.ok ? "push-unreachable"
      : pushes.some((p) => !p.ok) ? "push-degraded"
      : "ok";
  }
  else if (failed.length === hosts.length) verdict = "all-relays-unreachable";
  else verdict = "some-relays-unreachable";

  const out = {
    ts: new Date(startedMs).toISOString(),
    tookMs: Date.now() - startedMs,
    verdict,
    controlsOk,
    controls,
    mapVersion: (map && map.version) ?? null,
    mapErr,
    hosts,
    push,
    pushes,
  };

  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(STATE_DIR, "last.json"), JSON.stringify(out, null, 2));
  } catch { /* non-fatal: reporting is stdout */ }

  console.log(JSON.stringify(out, null, 2));
  process.exit(verdict === "ok" ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({ verdict: "tick-error", error: String((e && e.message) || e) }));
  process.exit(2);
});
