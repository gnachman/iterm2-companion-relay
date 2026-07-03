// Integration tests for the http + ws host: it wires the entry gate, the
// runtime, and the real (unmodified) room.js together, and adds the caps a
// single process needs that the Cloudflare platform used to provide for free
// (global room cardinality, per-IP concurrent sockets). Open admission mode so
// the handshake needs no signatures — the admission/attestation depth is
// covered by the ported integration suite.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import { WebSocket } from "ws";
import { createRelay, clientIp, makeLimiter } from "../../host/server.js";

const OPEN_ENV = {
  ATTEST_REQUIRED: "false",
  RELAY_ORIGIN: "https://relay.example",
  RELAY_LOG: "false",
  RELAY_DAILY_BYTE_QUOTA: "1048576",
};

let relay, base, wsBase;
let roomCounter = 0;
const freshRoom = () => (++roomCounter).toString(16).padStart(64, "0");

async function start(opts = {}) {
  relay = createRelay({ env: OPEN_ENV, dbPath: ":memory:", ...opts });
  await relay.listen(0, "127.0.0.1");
  const port = relay.address().port;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (relay) await relay.close();
  relay = null;
});

// Resolve with the next message (string for text frames, Buffer for binary).
function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (data, isBinary) => resolve(isBinary ? data : data.toString("utf8")));
    ws.once("close", (code, reason) => reject(new Error(`closed ${code} ${reason}`)));
  });
}

function openSocket(room, headers = {}) {
  const ws = new WebSocket(`${wsBase}/`, { headers: { "x-relay-room": room, ...headers } });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

// Attempt an upgrade and resolve with the HTTP status of a pre-handshake
// rejection (0 if it actually opened, -1 on a bare socket error).
function upgradeStatus(room, headers = {}) {
  const ws = new WebSocket(`${wsBase}/`, { headers: { "x-relay-room": room, ...headers } });
  return new Promise((r) => {
    ws.once("open", () => { ws.close(); r(0); });
    ws.once("unexpected-response", (_req, res) => r(res.statusCode));
    ws.once("error", () => r(-1));
  });
}

// Full open-mode admission handshake: hello -> challenge -> empty proof -> result.
async function admit(room, role) {
  const ws = await openSocket(room);
  ws.send(JSON.stringify({ v: 1, role }));
  JSON.parse(await nextMessage(ws)); // challenge
  ws.send(JSON.stringify({}));
  const result = JSON.parse(await nextMessage(ws));
  return { ws, result };
}

describe("entry gate (HTTP)", () => {
  beforeEach(() => start());

  it("rejects a request with no room header (400)", async () => {
    const res = await fetch(`${base}/register`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("rejects a request carrying an Origin header (403)", async () => {
    const res = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "x-relay-room": freshRoom(), Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("routes a valid POST to the room (open-mode /attest is disabled -> 400)", async () => {
    const res = await fetch(`${base}/attest`, {
      method: "POST",
      headers: { "x-relay-room": freshRoom(), "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("attestation disabled");
  });
});

describe("websocket admission + splice", () => {
  beforeEach(() => start());

  it("admits a parked mac", async () => {
    const { result } = await admit(freshRoom(), "mac");
    expect(result.ok).toBe(true);
  });

  it("rejects a phone when no mac is parked", async () => {
    const { result } = await admit(freshRoom(), "phone");
    expect(result).toEqual({ ok: false, error: "mac offline" });
  });

  it("splices binary frames between an admitted mac and phone, both directions", async () => {
    const room = freshRoom();
    const mac = await admit(room, "mac");
    const phone = await admit(room, "phone");
    expect(phone.result.ok).toBe(true);

    const toPhone = nextMessage(phone.ws);
    mac.ws.send(Buffer.from([1, 2, 3, 4]));
    expect(await toPhone).toEqual(Buffer.from([1, 2, 3, 4]));

    const toMac = nextMessage(mac.ws);
    phone.ws.send(Buffer.from([9, 8, 7]));
    expect(await toMac).toEqual(Buffer.from([9, 8, 7]));
  });
});

describe("single-process caps", () => {
  it("rejects a new room once the global room cap is reached (503)", async () => {
    await start({ maxRooms: 1 });
    const { ws: held } = await admit(freshRoom(), "mac"); // fills the one room slot
    // A second, distinct room is refused before the handshake completes.
    const c = new WebSocket(`${wsBase}/`, { headers: { "x-relay-room": freshRoom() } });
    const code = await new Promise((r) => {
      c.once("open", () => r(0));
      c.once("unexpected-response", (_req, res) => r(res.statusCode));
      c.once("error", () => r(-1));
    });
    expect(code).toBe(503);
    held.close();
  });

  it("rejects sockets over the per-IP concurrent cap (429)", async () => {
    await start({ maxSocketsPerIp: 2 });
    const room = freshRoom();
    const a = await openSocket(room);
    const b = await openSocket(room);
    const c = new WebSocket(`${wsBase}/`, { headers: { "x-relay-room": room } });
    const code = await new Promise((r) => {
      c.once("open", () => r(0));
      c.once("unexpected-response", (_req, res) => r(res.statusCode));
      c.once("error", () => r(-1));
    });
    expect(code).toBe(429);
    a.close(); b.close();
  });

  it("rejects sockets over the global total-socket cap (503)", async () => {
    await start({ maxTotalSockets: 2 });
    // Two sockets across two different rooms fill the global budget.
    const a = await openSocket(freshRoom());
    const b = await openSocket(freshRoom());
    expect(await upgradeStatus(freshRoom())).toBe(503);
    a.close(); b.close();
  });
});

describe("request body cap", () => {
  beforeEach(() => start());

  it("413s a request whose Content-Length exceeds the cap", async () => {
    const res = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "x-relay-room": freshRoom(), "content-type": "application/json" },
      body: "x".repeat(256 * 1024),
    });
    expect(res.status).toBe(413);
  });

  it("still accepts a normally-sized body", async () => {
    const res = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "x-relay-room": freshRoom(), "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).not.toBe(413); // reaches the room (400 missing verifier)
  });

  it("rejects an oversized declared Content-Length up front, before reading the body", async () => {
    // Send a huge Content-Length but NO body. The fast path must answer 413
    // immediately; if it were dead, the server would block waiting for a body
    // that never arrives (the request would hang).
    const port = relay.address().port;
    const room = freshRoom();
    const status = await new Promise((resolve) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write(
          `POST /register HTTP/1.1\r\nHost: x\r\nx-relay-room: ${room}\r\n` +
          "Content-Type: application/json\r\nContent-Length: 5000000\r\n\r\n");
      });
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        const m = buf.match(/^HTTP\/1\.1 (\d+)/);
        if (m) { resolve(Number(m[1])); sock.destroy(); }
      });
      sock.on("error", () => resolve("error"));
      setTimeout(() => { sock.destroy(); resolve("timeout"); }, 1500);
    });
    expect(status).toBe(413);
  });

  it("aborts a chunked body that streams past the cap (no Content-Length)", async () => {
    const port = relay.address().port;
    const status = await new Promise((resolve) => {
      const req = http.request({
        host: "127.0.0.1", port, path: "/register", method: "POST",
        headers: { "x-relay-room": freshRoom(), "transfer-encoding": "chunked" },
      });
      let sent = 0;
      const chunk = Buffer.alloc(16 * 1024, 0x78);
      req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", () => resolve("error"));
      const iv = setInterval(() => {
        if (sent > 512 * 1024) { clearInterval(iv); try { req.end(); } catch { /* ignore */ } return; }
        try { req.write(chunk); sent += chunk.length; } catch { clearInterval(iv); }
      }, 3);
    });
    expect([413, "error"]).toContain(status); // rejected, not buffered forever
  });
});

describe("attest HTTP rate limiting", () => {
  async function postAttest(room) {
    const res = await fetch(`${base}/attest`, {
      method: "POST",
      headers: { "x-relay-room": room, "content-type": "application/json" },
      body: "{}",
    });
    return res.status;
  }

  it("429s /attest once the per-IP window is exceeded (before reaching the room)", async () => {
    await start({ attestLimit: { limit: 2, windowMs: 60_000 } });
    const room = freshRoom();
    // Under the limit the request reaches the room (open mode -> 400 disabled).
    expect(await postAttest(room)).toBe(400);
    expect(await postAttest(room)).toBe(400);
    // Over the limit it is rejected before routing.
    expect(await postAttest(room)).toBe(429);
  });

  it("serves unthrottled when the limiter is disabled (attestLimit falsy)", async () => {
    await start({ attestLimit: false });
    const room = freshRoom();
    for (let i = 0; i < 50; i++) expect(await postAttest(room)).toBe(400);
  });
});

describe("ws upgrade rate limiting", () => {
  it("returns 429 once the per-IP websocket window is exceeded", async () => {
    await start({ wsLimit: { limit: 2, windowMs: 60_000 } });
    const room = freshRoom();
    await openSocket(room);
    await openSocket(room);
    // Third upgrade in the window is rate limited before the room is reached.
    const ws = new WebSocket(`${wsBase}/`, { headers: { "x-relay-room": room } });
    const code = await new Promise((r) => {
      ws.once("open", () => r(0));
      ws.once("unexpected-response", (_req, res) => r(res.statusCode));
      ws.once("error", () => r(-1));
    });
    expect(code).toBe(429);
  });
});

describe("metrics endpoint", () => {
  beforeEach(() => start());

  it("serves aggregate metrics to a direct localhost request", async () => {
    await admit(freshRoom(), "mac");
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("relay_rooms_live");
    expect(body).toContain("relay_ws_upgrades_total");
    expect(body).toContain("relay_socket_lifetime_seconds_bucket");
  });

  it("refuses metrics for a proxied (X-Forwarded-For) request", async () => {
    const res = await fetch(`${base}/metrics`, { headers: { "X-Forwarded-For": "1.2.3.4" } });
    expect(res.status).toBe(403);
  });
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe("keepalive", () => {
  it("pings connected sockets; a ponging client survives", async () => {
    await start({ keepaliveMs: 40 });
    const ws = await openSocket(freshRoom());
    let pings = 0;
    ws.on("ping", () => { pings += 1; });
    await delay(220);
    expect(pings).toBeGreaterThanOrEqual(1); // the server actually pinged
    expect(relay.wss.clients.size).toBe(1); // and the auto-pong kept it alive
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("terminates a socket that stops answering pings", async () => {
    await start({ keepaliveMs: 40 });
    const ws = await openSocket(freshRoom());
    ws.pause(); // stop processing frames, so ws never auto-ponds the server's ping
    await delay(260);
    expect(relay.wss.clients.size).toBe(0); // the dead parked socket was reaped
  });
});

describe("reconnect / flap", () => {
  it("re-splices on every phone reconnect while the mac stays parked (displacement flap)", async () => {
    await start();
    const room = freshRoom();
    // The mac parks once and must survive the whole flap storm. Each reconnect
    // is a NEW phone socket that displaces the prior one (server-initiated
    // close, which must NOT tear down the mac) — the pattern that ran up the
    // per-connection bill on Cloudflare. Stay under MAX_PAIRING_CYCLES (8).
    const mac = await admit(room, "mac");
    let prevPhone = null;

    for (let i = 1; i <= 6; i++) {
      const phone = await admit(room, "phone");
      expect(phone.result.ok).toBe(true); // room not killed, mac still parked

      // Splice works this cycle, both directions.
      const toPhone = nextMessage(phone.ws);
      mac.ws.send(Buffer.from([i]));
      expect(await toPhone).toEqual(Buffer.from([i]));

      const toMac = nextMessage(mac.ws);
      phone.ws.send(Buffer.from([100 + i]));
      expect(await toMac).toEqual(Buffer.from([100 + i]));

      // The previous phone socket was displaced (closed) when this one admitted,
      // and the mac was never closed by that displacement.
      if (prevPhone) expect(prevPhone.ws.readyState).not.toBe(WebSocket.OPEN);
      expect(mac.ws.readyState).toBe(WebSocket.OPEN);
      prevPhone = phone;
    }
  });

  it("closes the mac's peer link when the phone cleanly disconnects (re-park signal)", async () => {
    await start();
    const room = freshRoom();
    const mac = await admit(room, "mac");
    const phone = await admit(room, "phone");
    const macClosed = new Promise((r) => mac.ws.once("close", (code, reason) => r({ code, reason: reason.toString() })));
    phone.ws.close(1000, "bye");
    const ev = await macClosed;
    expect(ev.code).toBe(1001);
    expect(ev.reason).toBe("peer gone");
  });
});

describe("same-socket message serialization (input gate)", () => {
  it("does not double-admit from proofs batched on one socket", async () => {
    // The Durable Object input gate serialized a socket's handlers; without it,
    // proofs batched in one tick interleave at the storage await and each
    // admits (a lost-update the anti-grind counter and single-use ticket rely on
    // NOT happening). With per-socket serialization only the first frame is a
    // proof; the rest arrive post-admission.
    await start();
    const room = freshRoom();
    await admit(room, "mac"); // park a mac so the phone can admit
    const ws = await openSocket(room);
    ws.send(JSON.stringify({ v: 1, role: "phone" }));
    JSON.parse(await nextMessage(ws)); // consume the challenge

    const results = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      try { const m = JSON.parse(data.toString("utf8")); if (typeof m.ok === "boolean") results.push(m); } catch { /* ignore */ }
    });
    for (let i = 0; i < 5; i++) ws.send(JSON.stringify({})); // batch 5 proofs
    await delay(150);
    expect(results.filter((r) => r.ok).length).toBe(1); // exactly one admission
  });
});

describe("request-handler errors", () => {
  beforeEach(() => start());

  it("counts a 500 from the request handler in metrics", async () => {
    // A GET carrying a body makes the internal `new Request(GET, body)` throw,
    // hitting the handler's catch -> 500. That path must be observable in
    // /metrics (prod logging is off), like the WS reject path.
    const port = relay.address().port;
    const status = await new Promise((resolve) => {
      const req = http.request({
        host: "127.0.0.1", port, path: "/register", method: "GET",
        headers: { "x-relay-room": freshRoom(), "content-length": 1 },
      });
      req.on("response", (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", () => resolve("error"));
      req.write("x");
      req.end();
    });
    expect(status).toBe(500);
    expect(relay.metrics.render({})).toContain("relay_http_errors_total 1");
  });
});

describe("client-aborted requests", () => {
  beforeEach(() => start());

  it("does not count a client reset mid-body as an internal error", async () => {
    const port = relay.address().port;
    await new Promise((resolve) => {
      const req = http.request({
        host: "127.0.0.1", port, path: "/register", method: "POST",
        headers: { "x-relay-room": freshRoom(), "content-type": "application/json", "content-length": 1000 },
      });
      req.on("error", () => resolve()); // destroy => expected client-side error
      req.write("x"); // 1 of the promised 1000 bytes, then bail
      setTimeout(() => { req.destroy(); resolve(); }, 40);
    });
    await delay(60); // let the server observe the reset
    // The abort is client-side; it must not pollute the internal-error signal.
    expect(relay.metrics.render({})).not.toContain("relay_http_errors_total 1");
  });
});

describe("rate-limiter bucket cap", () => {
  it("hard-bounds the bucket map under high IP cardinality", () => {
    const over = makeLimiter({ limit: 1000, windowMs: 60_000 }, 10);
    for (let i = 0; i < 500; i++) over(`ip-${i}`); // 500 distinct live keys
    expect(over.size()).toBeLessThanOrEqual(10);
  });

  it("still limits correctly within the cap", () => {
    const over = makeLimiter({ limit: 2, windowMs: 60_000 }, 100);
    expect(over("a")).toBe(false);
    expect(over("a")).toBe(false);
    expect(over("a")).toBe(true); // 3rd hit over limit 2
  });
});

describe("clientIp precedence", () => {
  const socket = { remoteAddress: "10.0.0.1" };

  it("trustProxy honors X-Forwarded-For but NOT client-supplied CF-Connecting-IP", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "5.6.7.8" }), socket, { trustProxy: true })).toBe("5.6.7.8");
    // A generic proxy (Caddy) does not authoritatively set CF-Connecting-IP, so a
    // client-supplied one must be ignored — otherwise it defeats every per-IP cap.
    expect(clientIp(new Headers({ "cf-connecting-ip": "1.2.3.4" }), socket, { trustProxy: true })).toBe("10.0.0.1");
  });

  it("takes the rightmost (proxy-observed) X-Forwarded-For hop, not the spoofable leftmost", () => {
    // Under an APPENDING proxy, XFF = "client-supplied..., realPeer"; the trusted
    // hop is the rightmost, so a prepended fake is ignored (fails closed).
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, 9.9.9.9" }), socket, { trustProxy: true })).toBe("9.9.9.9");
    // trustedHops selects the Nth-from-right for a chain of N appending proxies.
    expect(clientIp(new Headers({ "x-forwarded-for": "real, p1, p2" }), socket, { trustProxy: true, trustedHops: 2 })).toBe("p1");
  });

  it("fails closed (rightmost, not spoofable leftmost) when trustedHops exceeds the chain", () => {
    // Misconfig: RELAY_TRUSTED_HOPS bigger than the actual chain. Must not fall to
    // the client-controlled leftmost — pick the rightmost (most-trusted) hop.
    expect(clientIp(new Headers({ "x-forwarded-for": "spoof, realPeer" }), socket, { trustProxy: true, trustedHops: 5 })).toBe("realPeer");
  });

  it("trustCloudflare honors CF-Connecting-IP first (Option B origin behind CF)", () => {
    expect(clientIp(new Headers({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" }), socket, { trustCloudflare: true })).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-forwarded-for": "5.6.7.8" }), socket, { trustCloudflare: true })).toBe("5.6.7.8");
  });

  it("ignores all forwarded headers when neither trust is set (default)", () => {
    const hdrs = new Headers({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" });
    expect(clientIp(hdrs, socket, {})).toBe("10.0.0.1");
    expect(clientIp(hdrs, socket)).toBe("10.0.0.1"); // default is untrusted
  });
});

describe("proxy-header trust (anti-spoof)", () => {
  it("a spoofed CF-Connecting-IP cannot bypass the per-IP cap under generic trustProxy (H1)", async () => {
    // The default documented deployment (Option A: Caddy, trustProxy=true) must
    // NOT honor a client-supplied CF-Connecting-IP — Caddy only sanitizes XFF.
    await start({ maxSocketsPerIp: 2, trustProxy: true });
    const room = freshRoom();
    const a = await openSocket(room, { "CF-Connecting-IP": "1.1.1.1" });
    const b = await openSocket(room, { "CF-Connecting-IP": "2.2.2.2" });
    expect(await upgradeStatus(room, { "CF-Connecting-IP": "3.3.3.3" })).toBe(429);
    a.close(); b.close();
  });

  it("a spoofed CF-Connecting-IP cannot bypass the per-IP cap when untrusted (default)", async () => {
    await start({ maxSocketsPerIp: 2 });
    const room = freshRoom();
    const a = await openSocket(room, { "CF-Connecting-IP": "1.1.1.1" });
    const b = await openSocket(room, { "CF-Connecting-IP": "2.2.2.2" });
    expect(await upgradeStatus(room, { "CF-Connecting-IP": "3.3.3.3" })).toBe(429);
    a.close(); b.close();
  });

  it("honors distinct CF-Connecting-IPs under trustCloudflare (Option B)", async () => {
    await start({ maxSocketsPerIp: 2, trustCloudflare: true });
    const room = freshRoom();
    const a = await openSocket(room, { "CF-Connecting-IP": "1.1.1.1" });
    const b = await openSocket(room, { "CF-Connecting-IP": "2.2.2.2" });
    const c = await openSocket(room, { "CF-Connecting-IP": "3.3.3.3" }); // different bucket
    expect(c.readyState).toBe(WebSocket.OPEN);
    a.close(); b.close(); c.close();
  });
});
