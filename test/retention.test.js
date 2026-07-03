// Established-room idle TTL: a successful pairing's room is reusable as long as
// it is used, but an UNUSED room is deleted after the idle window (30 days) so
// abandoned pairings (offline unpair, wiped device, deleted app) do not linger
// in storage forever. A live pairing re-registers/re-parks on every contact,
// which bumps lastActivity, so the TTL never reaps a room in active use. A
// device returning after the room was reaped re-pairs (it is rejected and
// surfaces the re-pair affordance). See
// ../../../docs/companion-relay-design.md (Deletion, revocation, and expiry).

import { describe, it, expect } from "vitest";
import {
  env, runInDurableObject, installRelay,
  admitSigned, freshRoom, makeJoinKey, register, seedVerifier,
} from "./helpers.js";

installRelay();

const stubFor = (room) => env.ROOM.get(env.ROOM.idFromName(room));

// Comfortably past the 30-day TTL, without needing an env override.
const PAST_TTL_MS = 40 * 24 * 60 * 60 * 1000;

async function read(room, key) {
  return runInDurableObject(stubFor(room), (_i, state) => state.storage.get(key));
}
async function put(room, key, value) {
  return runInDurableObject(stubFor(room), (_i, state) => state.storage.put(key, value));
}
async function fireAlarm(room) {
  return runInDurableObject(stubFor(room), (instance) => instance.alarm());
}

describe("established-room idle TTL (30 days)", () => {
  it("wipes an established room whose last activity is older than the TTL", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    await seedVerifier(room, key.verifierB64);
    await put(room, "lastActivity", Date.now() - PAST_TTL_MS);

    await fireAlarm(room);

    expect(await read(room, "verifier")).toBeUndefined();
    expect(await read(room, "lastActivity")).toBeUndefined();
  });

  it("keeps an established room with recent activity and re-arms the deadline", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    await seedVerifier(room, key.verifierB64);
    const now = Date.now();
    await put(room, "lastActivity", now);

    await fireAlarm(room);

    expect(await read(room, "verifier")).toBe(key.verifierB64);
    const alarm = await runInDurableObject(stubFor(room), (_i, state) => state.storage.getAlarm());
    // The next wake is the idle deadline, comfortably in the future.
    expect(alarm).toBeGreaterThan(now + 24 * 60 * 60 * 1000);
  });

  it("does not wipe a legacy established room missing lastActivity; seeds the window", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    await seedVerifier(room, key.verifierB64); // pre-feature room: no lastActivity

    const before = Date.now();
    await fireAlarm(room);

    expect(await read(room, "verifier")).toBe(key.verifierB64);
    expect(await read(room, "lastActivity")).toBeGreaterThanOrEqual(before);
  });

  it("closes the admitted socket when an idle room is swept", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    await seedVerifier(room, key.verifierB64);
    const mac = await admitSigned(room, "mac", key.privateKey);
    expect(mac.result.ok).toBe(true);

    await put(room, "lastActivity", Date.now() - PAST_TTL_MS);
    const onClose = new Promise((resolve) =>
      mac.ws.addEventListener("close", (e) => resolve(e.code), { once: true }));
    await fireAlarm(room);

    expect(await onClose).toBe(1000);
    expect(await read(room, "verifier")).toBeUndefined();
  });

  it("registration marks the room established with a fresh lastActivity", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    // A phone admit mints the registration token, but only once a mac is parked.
    await admitSigned(room, "mac", key.privateKey);
    const phone = await admitSigned(room, "phone", key.privateKey);
    const token = phone.result.registrationToken;
    expect(typeof token).toBe("string");

    const before = Date.now();
    const res = await register(room, { registrationToken: token, verifier: key.verifierB64 });
    expect(res.body.ok).toBe(true);

    expect(await read(room, "lastActivity")).toBeGreaterThanOrEqual(before);
  });

  it("a reconnect to an established room bumps lastActivity (keeps it alive)", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    await seedVerifier(room, key.verifierB64);
    await put(room, "lastActivity", Date.now() - PAST_TTL_MS);

    const before = Date.now();
    const mac = await admitSigned(room, "mac", key.privateKey);
    expect(mac.result.ok).toBe(true);

    expect(await read(room, "lastActivity")).toBeGreaterThanOrEqual(before);
  });
});
