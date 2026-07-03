// Test helpers for driving the relay over real WebSockets against the
// self-hosted Node host. Each integration test file calls installRelay() once
// to spin up a real http+ws server (its own in-memory SQLite, its own ephemeral
// port) for the file, then drives it with the same handshake helpers the
// workerd suite used.
//
// SELF / env / runInDurableObject are thin shims over the host so the ported
// test bodies read almost exactly as they did under @cloudflare/vitest-pool-
// workers:
//   - SELF.fetch(url|Request, init) -> fetch against the running host
//   - env.ROOM.idFromName / .get     -> an opaque room-name stub
//   - runInDurableObject(stub, (instance, state) => ...) -> the live RoomContext
//     is `state` (it has .storage and .getWebSockets()); `instance` is the Room.

import { beforeAll, afterAll, expect } from "vitest";
import { WebSocket } from "ws";
import { createRelay } from "../host/server.js";

/// The relay origin the host binds into join transcripts.
export const ORIGIN = "https://relay.example";

const ROLE_BYTE = { mac: 1, phone: 2 };
const PROTOCOL_VERSION = 1;

// Open admission mode is the default; attested files override via installRelay.
const OPEN_ENV = {
  ATTEST_REQUIRED: "false",
  RELAY_ORIGIN: ORIGIN,
  RELAY_LOG: "false",
  // Small daily quota so the quota test can cross it with a few frames.
  RELAY_DAILY_BYTE_QUOTA: "1048576",
};

let relay = null;
let base = null;
let wsBase = null;
let counter = 0;

/// Register beforeAll/afterAll hooks that start and stop a host for this file.
export function installRelay(envOverrides = {}) {
  beforeAll(async () => {
    relay = createRelay({ env: { ...OPEN_ENV, ...envOverrides }, dbPath: ":memory:" });
    await relay.listen(0, "127.0.0.1");
    const port = relay.address().port;
    base = `http://127.0.0.1:${port}`;
    wsBase = `ws://127.0.0.1:${port}`;
    counter = 0;
  });
  afterAll(async () => {
    if (relay) await relay.close();
    relay = null;
  });
}

// --- cloudflare:test shims -------------------------------------------------

export const SELF = {
  fetch(input, init) {
    let path, opts;
    if (typeof input === "string" || input instanceof URL) {
      const u = new URL(input);
      path = u.pathname + u.search;
      opts = init || {};
    } else {
      const u = new URL(input.url);
      path = u.pathname + u.search;
      opts = init || { method: input.method, headers: Object.fromEntries(input.headers) };
    }
    return fetch(base + path, opts);
  },
};

export const env = {
  ROOM: {
    idFromName: (room) => room,
    get: (room) => ({ room }),
  },
};

export async function runInDurableObject(stub, fn) {
  const ctx = await relay.runtime.get(stub.room);
  return fn(ctx.instance, ctx);
}

// --- crypto helpers (unchanged from the workerd suite) ---------------------

function b64ToBytes(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function bytesToB64(b) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/// The PRODUCTION canonicalEncode, imported (and re-exported) so the helpers
/// build transcripts with the exact function the admission path runs.
import { canonicalEncode } from "../src/room.js";
export { canonicalEncode };

/// Build the join transcript exactly as RelayJoin.transcript does.
export function transcript(role, nonceB64, roomName, origin = ORIGIN) {
  const enc = new TextEncoder();
  return canonicalEncode("iterm2-relay-join", [
    new Uint8Array([PROTOCOL_VERSION]),
    new Uint8Array([ROLE_BYTE[role]]),
    b64ToBytes(nonceB64),
    enc.encode(roomName),
    enc.encode(origin),
  ]);
}

/// A fresh Ed25519 join keypair; returns { privateKey, verifierB64 }.
export async function makeJoinKey() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { privateKey: kp.privateKey, verifierB64: bytesToB64(raw) };
}

/// Sign bytes with an Ed25519 private key; returns base64.
export async function signB64(privateKey, bytes) {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, bytes));
  return bytesToB64(sig);
}

/// Seed a registered verifier directly into a room's storage, marking it an
/// established room (bypasses /register so signature admission can be tested in
/// isolation).
export async function seedVerifier(room, verifierB64) {
  await relay.backend.forRoom(room).put("verifier", verifierB64);
}

/// Seed an already-expired registration token, to test TTL rejection.
export async function seedExpiredToken(room, token) {
  await relay.backend.forRoom(room).put(`regtoken:${token}`, { expiresAt: Date.now() - 1000 });
}

/// POST /register. Returns { status, body }.
export async function register(room, payload) {
  const res = await fetch(base + "/register", {
    method: "POST",
    headers: { "x-relay-room": room, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

/// A fresh, syntactically valid (64 lowercase hex) room name, unique per call.
export function freshRoom() {
  counter += 1;
  return counter.toString(16).padStart(64, "0");
}

/// The next message (string for text frames) on a socket, or reject if it
/// closes first.
export function next(ws) {
  return new Promise((resolve, reject) => {
    ws.addEventListener("message", (e) => resolve(e.data), { once: true });
    ws.addEventListener("close", (e) => reject(new Error(`closed ${e.code} ${e.reason}`)), {
      once: true,
    });
  });
}

/// Wait for a socket to close; resolves with {code, reason}.
export function closed(ws) {
  return new Promise((resolve) => {
    ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }), {
      once: true,
    });
  });
}

/// Open a raw (un-admitted) WebSocket to a room.
export async function openSocket(room) {
  const ws = new WebSocket(wsBase + "/", { headers: { "x-relay-room": room } });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", (e) => reject(e.error || new Error("ws error")), { once: true });
  });
  return ws;
}

/// Run the full admission handshake: Hello -> (Challenge) -> Proof -> Result.
export async function admit(room, role, proofFor = () => ({}), { nonDisplacing = false } = {}) {
  const ws = await openSocket(room);
  const hello = { v: 1, role };
  if (nonDisplacing) hello.nonDisplacing = true;
  ws.send(JSON.stringify(hello));
  const challenge = JSON.parse(await next(ws));
  const proof = await proofFor(challenge);
  ws.send(JSON.stringify(proof));
  const result = JSON.parse(await next(ws));
  return { ws, challenge, result };
}

/// Admit using a join signature over the bound transcript (established rooms).
export async function admitSigned(room, role, privateKey) {
  return admit(room, role, async (challenge) => ({
    sig: await signB64(privateKey, transcript(role, challenge.nonce, room)),
  }));
}

/// Open admission mode is the test-wide default; kept as a no-op for intent.
export function openMode() {}
