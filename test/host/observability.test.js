// Tests for the observability surface added after a real incident where a mac's
// socket was severed but the close never reached it, so it showed "connected"
// while nothing was parked and every phone got "mac offline". The relay behaved
// correctly; what was missing was the ability to SEE it. These cover the signals
// that make that a fast diagnosis next time:
//   - always-on connect/park lifecycle logging (a successful park used to be
//     invisible),
//   - the phone_no_mac_total counter (the direct "phones can't find their mac"
//     signal),
//   - the /metrics room-occupancy gauges (is a mac actually parked?),
//   - the keepalive-termination counter + log (distinguishes a relay-detected
//     dead peer from a generic remote 1006).
// All of it must stay PII-free: opaque tag, role, counts — never a room name.

import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { createRelay } from "../../host/server.js";

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

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (data, isBinary) => resolve(isBinary ? data : data.toString("utf8")));
    ws.once("close", (code, reason) => reject(new Error(`closed ${code} ${reason}`)));
  });
}

function openSocket(room) {
  const ws = new WebSocket(`${wsBase}/`, { headers: { "x-relay-room": room } });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function closed(ws) {
  return new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason })));
}

// Open-mode admission handshake: hello -> challenge -> empty proof -> result.
async function admit(room, role) {
  const ws = await openSocket(room);
  ws.send(JSON.stringify({ v: 1, role }));
  JSON.parse(await nextMessage(ws)); // challenge
  ws.send(JSON.stringify({}));
  const result = JSON.parse(await nextMessage(ws));
  return { ws, result };
}

// Scrape /metrics (loopback) and return the numeric value of a plain metric line.
async function metric(name) {
  const text = await (await fetch(`${base}/metrics`)).text();
  const m = text.match(new RegExp(`^relay_${name} (\\d+)$`, "m"));
  return m ? Number(m[1]) : undefined;
}

describe("room-occupancy gauges (/metrics)", () => {
  it("reports mac_only for a parked mac and both once a phone splices", async () => {
    await start();
    const room = freshRoom();

    const mac = await admit(room, "mac");
    expect(mac.result.ok).toBe(true);
    expect(await metric("rooms_mac_only")).toBe(1);
    expect(await metric("rooms_both")).toBe(0);
    expect(await metric("rooms_phone_only")).toBe(0);

    const phone = await admit(room, "phone");
    expect(phone.result.ok).toBe(true);
    expect(await metric("rooms_both")).toBe(1);
    expect(await metric("rooms_mac_only")).toBe(0);

    mac.ws.close();
    phone.ws.close();
  });

  it("pre-registers all occupancy gauges (they appear even at zero)", async () => {
    await start();
    for (const g of ["rooms_both", "rooms_mac_only", "rooms_phone_only", "rooms_neither"]) {
      expect(await metric(g)).toBe(0);
    }
  });
});

describe("phone_no_mac_total counter", () => {
  it("is pre-registered at 0 and increments when a phone finds no mac", async () => {
    await start();
    expect(await metric("phone_no_mac_total")).toBe(0);

    // A phone whose room has no parked mac is rejected "mac offline".
    const ws = await openSocket(freshRoom());
    ws.send(JSON.stringify({ v: 1, role: "phone" }));
    JSON.parse(await nextMessage(ws)); // challenge
    ws.send(JSON.stringify({}));
    const { reason } = await closed(ws);
    expect(String(reason)).toBe("mac offline");

    expect(await metric("phone_no_mac_total")).toBe(1);
  });
});

describe("keepalive termination (counter + log)", () => {
  it("is pre-registered at 0", async () => {
    await start();
    expect(await metric("ws_keepalive_terminated_total")).toBe(0);
  });

  it("terminates a socket that missed a pong and counts it", async () => {
    await start({ keepaliveMs: 24 * 24 * 60 * 60 * 1000 }); // never fires on its own
    const client = await openSocket(freshRoom());
    // The server-side socket for this connection.
    const server = [...relay.wss.clients][0];
    expect(server).toBeTruthy();

    // Simulate a peer that did not answer the previous ping.
    server.isAlive = false;
    const gone = closed(client);
    relay._sweepKeepalive();

    await gone; // the client observes the terminate
    expect(await metric("ws_keepalive_terminated_total")).toBe(1);
  });
});

describe("lifecycle logging (always-on, PII-free)", () => {
  it("logs connect and park with the opaque tag, never the room name", async () => {
    await start();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const room = freshRoom();
    const mac = await admit(room, "mac");
    expect(mac.result.ok).toBe(true);
    mac.ws.close();
    const lines = spy.mock.calls.map((c) => c.join(" "));
    spy.mockRestore();

    expect(lines.some((l) => /^relay [0-9a-f]{8} connect$/.test(l))).toBe(true);
    expect(lines.some((l) => /^relay [0-9a-f]{8} admit role=mac via=open peer=false$/.test(l))).toBe(true);
    // The room name (64 hex) must never appear in any log line.
    expect(lines.some((l) => l.includes(room))).toBe(false);
  });
});
