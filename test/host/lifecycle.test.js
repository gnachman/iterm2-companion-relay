// End-to-end persistence: an established pairing must survive both a full
// process restart (new server, same SQLite file) and an in-memory eviction
// (the room dropped from the registry, then rehydrated from storage on the next
// connection). These are the reliability claims of the self-host that were only
// covered in pieces (storage reopen + runtime rehydrate with a fake room); here
// they run through the real server + real room.js + real signatures.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelay } from "../../host/server.js";
import { makeJoinKey, signB64, transcript, ORIGIN } from "../helpers.js";

const ENV = {
  ATTEST_REQUIRED: "false",
  RELAY_ORIGIN: ORIGIN,
  RELAY_LOG: "false",
  RELAY_DAILY_BYTE_QUOTA: "1048576",
};

let dir, dbPath;
const relays = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-lifecycle-"));
  dbPath = join(dir, "relay.db");
});
afterEach(async () => {
  for (const r of relays.splice(0)) await r.close();
  rmSync(dir, { recursive: true, force: true });
});

async function boot() {
  const relay = createRelay({ env: ENV, dbPath });
  await relay.listen(0, "127.0.0.1");
  relays.push(relay);
  const port = relay.address().port;
  return { relay, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` };
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once("message", (data, isBinary) => resolve(isBinary ? data : data.toString("utf8")));
    ws.once("close", (code, reason) => reject(new Error(`closed ${code} ${reason}`)));
  });
}

function openSocket(wsBase, room) {
  const ws = new WebSocket(`${wsBase}/`, { headers: { "x-relay-room": room } });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

async function admit(wsBase, room, role, proofFor = () => ({})) {
  const ws = await openSocket(wsBase, room);
  ws.send(JSON.stringify({ v: 1, role }));
  const challenge = JSON.parse(await nextMessage(ws));
  ws.send(JSON.stringify(await proofFor(challenge)));
  const result = JSON.parse(await nextMessage(ws));
  return { ws, result };
}

function admitSigned(wsBase, room, role, privateKey) {
  return admit(wsBase, room, role, async (ch) => ({
    sig: await signB64(privateKey, transcript(role, ch.nonce, room)),
  }));
}

async function register(base, room, payload) {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "x-relay-room": room, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

describe("persistence across a full server restart", () => {
  it("an established pairing still admits by signature after the process restarts", async () => {
    const room = "a".repeat(64);
    const key = await makeJoinKey();

    // Server A: establish the room through the real register flow.
    const a = await boot();
    const mac = await admit(a.wsBase, room, "mac"); // park
    const phone = await admit(a.wsBase, room, "phone"); // mints the registration token
    expect(typeof phone.result.registrationToken).toBe("string");
    const reg = await register(a.base, room, {
      registrationToken: phone.result.registrationToken,
      verifier: key.verifierB64,
    });
    expect(reg.body.ok).toBe(true);
    mac.ws.close();
    phone.ws.close();
    await a.relay.close();
    relays.length = 0; // a is closed; afterEach should not double-close it

    // Server B: a fresh process on the SAME database file.
    const b = await boot();
    const signed = await admitSigned(b.wsBase, room, "mac", key.privateKey);
    expect(signed.result.ok).toBe(true); // verifier rehydrated from SQLite

    // A join with the WRONG key is still rejected, proving it verified against
    // the persisted verifier (not just admitted anyone).
    const attacker = await makeJoinKey();
    const bad = await admitSigned(b.wsBase, room, "phone", attacker.privateKey);
    expect(bad.result.ok).toBe(false);
  });
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe("idle-TTL alarm scheduling", () => {
  it("does not busy-loop when the idle deadline exceeds the 32-bit timer ceiling", async () => {
    // The default idle TTL is 30 days (2.592e9 ms) — larger than setTimeout's
    // signed-32-bit ceiling (~24.9 days), which Node clamps to 1 ms. A naive
    // reschedule to a 30-day-out deadline therefore fires in 1 ms, re-runs
    // alarm(), reschedules the same far time, and busy-loops forever. Establish
    // a room, go idle, force the housekeeping alarm to run, and confirm it
    // re-arms to the far deadline WITHOUT re-entering alarm() repeatedly.
    const room = "c".repeat(64);
    const key = await makeJoinKey();
    const { relay, base, wsBase } = await boot(); // default env => 30-day TTL

    const mac = await admit(wsBase, room, "mac");
    const phone = await admit(wsBase, room, "phone");
    await register(base, room, {
      registrationToken: phone.result.registrationToken,
      verifier: key.verifierB64,
    });
    mac.ws.close();
    phone.ws.close();
    await delay(30);

    const ctx = relay.runtime.rooms.get(room);
    expect(ctx).toBeTruthy();
    let alarmCalls = 0;
    const realAlarm = ctx.instance.alarm.bind(ctx.instance);
    ctx.instance.alarm = async () => { alarmCalls += 1; return realAlarm(); };

    // Force the housekeeping alarm to fire now; it re-arms to the ~30-day idle
    // deadline. With the clamp bug that reschedule fires in 1 ms and loops.
    await ctx.storage.setAlarm(Date.now());
    await delay(200);
    expect(alarmCalls).toBeLessThan(5); // fixed: 1; bug: hundreds
  });
});

describe("eviction then rehydrate through the real server", () => {
  it("rehydrates an evicted established room from storage on the next connection", async () => {
    const room = "b" + "a".repeat(63);
    const key = await makeJoinKey();
    const { relay, wsBase } = await boot();

    // Establish the room (seed the verifier as a prior registration would have).
    await relay.backend.forRoom(room).put("verifier", key.verifierB64);
    await relay.runtime.get(room); // load it into memory
    expect(relay.runtime.rooms.has(room)).toBe(true);

    // Evict it from memory, as a restart or memory pressure would.
    relay.runtime.evict(relay.runtime.rooms.get(room));
    expect(relay.runtime.rooms.has(room)).toBe(false);

    // A signed reconnect must rehydrate the room from SQLite and admit.
    const mac = await admitSigned(wsBase, room, "mac", key.privateKey);
    expect(mac.result.ok).toBe(true);
    expect(relay.runtime.rooms.has(room)).toBe(true); // back in memory
    mac.ws.close();
  });
});
