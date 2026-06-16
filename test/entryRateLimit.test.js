// Entry-Worker per-IP rate limits. The two abuse vectors are (1) attestation
// (/attest*), the most expensive code (CBOR + App Attest crypto), and (2) the
// WebSocket upgrade, the connection-flood vector. The entry Worker caps each per
// client IP BEFORE idFromName, so an over-limit source never instantiates a DO
// or runs the crypto. The IP is only the limiter key (never logged/stored). The
// bindings are optional, so a deployment/test without them still serves. The
// WS upgrade is at path "/" (shared with the website host), so this in-Worker
// cap is what protects it; a zone WAF path rule cannot. See
// ../../../docs/companion-relay-design.md (Gating ahead of the DO).

import { describe, it, expect } from "vitest";
import worker from "../src/index.js";

const VALID_ROOM = "a".repeat(64);

function req(path, headers) {
  return new Request("https://relay.example" + path, { headers });
}

function fakeRoom() {
  const calls = { idFromName: 0, fetched: 0 };
  return {
    calls,
    idFromName() { calls.idFromName += 1; return {}; },
    get() { return { fetch: async () => { calls.fetched += 1; return new Response("ok"); } }; },
  };
}

// A limiter that always allows or always denies, recording the keys it saw.
function limiter(allow) {
  const keys = [];
  return { keys, limit: async (o) => { keys.push(o.key); return { success: allow }; } };
}

describe("entry-Worker per-IP rate limits", () => {
  it("429s an over-limit /attest request and never instantiates a DO", async () => {
    const ROOM = fakeRoom();
    const ATTEST_LIMITER = limiter(false);
    const res = await worker.fetch(
      req("/attest", { "x-relay-room": VALID_ROOM, "CF-Connecting-IP": "1.2.3.4" }),
      { ROOM, ATTEST_LIMITER, WS_LIMITER: limiter(true) });
    expect(res.status).toBe(429);
    expect(ROOM.calls.idFromName).toBe(0);
    expect(ATTEST_LIMITER.keys).toEqual(["1.2.3.4"]);
  });

  it("forwards /attest under the limit", async () => {
    const ROOM = fakeRoom();
    const res = await worker.fetch(
      req("/attest/challenge", { "x-relay-room": VALID_ROOM, "CF-Connecting-IP": "5.5.5.5" }),
      { ROOM, ATTEST_LIMITER: limiter(true), WS_LIMITER: limiter(false) });
    expect(res.status).toBe(200);
    expect(ROOM.calls.fetched).toBe(1);
  });

  it("429s an over-limit WebSocket upgrade and never instantiates a DO", async () => {
    const ROOM = fakeRoom();
    const WS_LIMITER = limiter(false);
    const res = await worker.fetch(
      req("/", { "x-relay-room": VALID_ROOM, "CF-Connecting-IP": "2.3.4.5", Upgrade: "websocket" }),
      { ROOM, ATTEST_LIMITER: limiter(true), WS_LIMITER });
    expect(res.status).toBe(429);
    expect(ROOM.calls.idFromName).toBe(0);
    expect(WS_LIMITER.keys).toEqual(["2.3.4.5"]);
  });

  it("forwards a WebSocket upgrade under the limit", async () => {
    const ROOM = fakeRoom();
    const res = await worker.fetch(
      req("/", { "x-relay-room": VALID_ROOM, Upgrade: "websocket" }),
      { ROOM, ATTEST_LIMITER: limiter(false), WS_LIMITER: limiter(true) });
    expect(res.status).toBe(200);
    expect(ROOM.calls.fetched).toBe(1);
  });

  it("does not rate-limit token/signature-gated paths (/register, /delete)", async () => {
    const ROOM = fakeRoom();
    // Both limiters would deny, but a plain POST to /register is not a hot path,
    // so neither is consulted and it forwards.
    const res = await worker.fetch(
      req("/register", { "x-relay-room": VALID_ROOM }),
      { ROOM, ATTEST_LIMITER: limiter(false), WS_LIMITER: limiter(false) });
    expect(res.status).toBe(200);
    expect(ROOM.calls.fetched).toBe(1);
  });

  it("serves when the limiter bindings are absent (backward compatible)", async () => {
    const ROOM = fakeRoom();
    const res = await worker.fetch(req("/attest", { "x-relay-room": VALID_ROOM }), { ROOM });
    expect(res.status).toBe(200);
    expect(ROOM.calls.fetched).toBe(1);
  });

  it("rejects a bad room before consulting any limiter", async () => {
    const ATTEST_LIMITER = limiter(false);
    const res = await worker.fetch(
      req("/attest", {}), { ROOM: fakeRoom(), ATTEST_LIMITER, WS_LIMITER: limiter(false) });
    expect(res.status).toBe(400);
    expect(ATTEST_LIMITER.keys).toEqual([]);
  });
});
