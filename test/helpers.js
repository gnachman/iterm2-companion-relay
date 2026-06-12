// Test helpers for driving the relay over real WebSockets in workerd.

import { SELF, env } from "cloudflare:test";
import { expect } from "vitest";

let counter = 0;

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
/// Returns { ws, challenge, result }. proof defaults to empty (open-mode).
export async function admit(room, role, proof = {}) {
  const ws = await openSocket(room);
  ws.send(JSON.stringify({ v: 1, role }));
  const challenge = JSON.parse(await next(ws));
  ws.send(JSON.stringify(proof));
  const result = JSON.parse(await next(ws));
  return { ws, challenge, result };
}

/// Open admission mode is the test-wide default (set in vitest.config.js
/// miniflare bindings). Kept as a no-op so test intent reads clearly.
export function openMode() {}
