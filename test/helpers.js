// Test helpers for driving the relay over real WebSockets in workerd.

import { SELF, env, runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";

let counter = 0;

/// The relay origin the DO binds into join transcripts (matches the
/// RELAY_ORIGIN test binding in vitest.config.js).
export const ORIGIN = "https://relay.example";

const ROLE_BYTE = { mac: 1, phone: 2 };

function b64ToBytes(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function bytesToB64(b) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/// The PRODUCTION canonicalEncode, imported (and re-exported) so the helpers
/// build transcripts with the exact function the admission path runs, not a copy
/// that could silently drift from it.
import { canonicalEncode } from "../src/room.js";
export { canonicalEncode };

/// Build the join transcript exactly as RelayJoin.transcript does:
/// canonical("iterm2-relay-join", [version, roleByte, nonce, roomName, origin]).
const PROTOCOL_VERSION = 1;
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

/// Seed a registered verifier directly into a room's DO storage, marking it an
/// established room (bypasses /register so signature admission can be tested in
/// isolation).
export async function seedVerifier(room, verifierB64) {
  const id = env.ROOM.idFromName(room);
  const stub = env.ROOM.get(id);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put("verifier", verifierB64);
  });
}

/// Seed an already-expired registration token, to test TTL rejection.
export async function seedExpiredToken(room, token) {
  const id = env.ROOM.idFromName(room);
  const stub = env.ROOM.get(id);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put(`regtoken:${token}`, { expiresAt: Date.now() - 1000 });
  });
}

/// POST /register. Returns { status, body }.
export async function register(room, payload) {
  const res = await SELF.fetch("https://relay.example/register", {
    method: "POST",
    headers: { "x-relay-room": room, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

/// A fresh, syntactically valid (64 lowercase hex) room name, unique per call
/// so tests are isolated without isolated storage.
export function freshRoom() {
  counter += 1;
  return counter.toString(16).padStart(64, "0");
}

/// The next message (string) on a socket, or reject if it closes first.
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
  const res = await SELF.fetch("https://relay.example/", {
    headers: { "x-relay-room": room, Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  ws.accept();
  return ws;
}

/// Run the full admission handshake: Hello -> (Challenge) -> Proof -> Result.
/// `proofFor` is given the parsed Challenge and returns the Proof object; it
/// defaults to an empty proof (open-mode admission).
export async function admit(room, role, proofFor = () => ({})) {
  const ws = await openSocket(room);
  ws.send(JSON.stringify({ v: 1, role }));
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

/// Open admission mode is the test-wide default (set in vitest.config.js
/// miniflare bindings). Kept as a no-op so test intent reads clearly.
export function openMode() {}
