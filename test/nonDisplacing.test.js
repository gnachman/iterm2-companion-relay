// Non-displacing admission: the NSE joins with nonDisplacing so it yields to a
// foreground app holding the phone slot instead of displacing it. The default
// (no flag) keeps newest-wins displacing.

import { describe, it, expect } from "vitest";
import {
  admit, admitSigned, seedVerifier, makeJoinKey, freshRoom, transcript, signB64, closed,
} from "./helpers.js";

// An established room with a mac parked, so phone joins reach the slot logic
// (rather than "mac offline"). Returns the room and the join key.
async function establishedRoomWithMac() {
  const room = freshRoom();
  const key = await makeJoinKey();
  await seedVerifier(room, key.verifierB64);
  const mac = await admitSigned(room, "mac", key.privateKey);
  expect(mac.result.ok).toBe(true);
  return { room, key };
}

function signedPhoneProof(room, key) {
  return async (challenge) => ({
    sig: await signB64(key.privateKey, transcript("phone", challenge.nonce, room)),
  });
}

describe("non-displacing admission", () => {
  it("rejects a non-displacing phone join when the phone slot is occupied", async () => {
    const { room, key } = await establishedRoomWithMac();
    const first = await admitSigned(room, "phone", key.privateKey);
    expect(first.result.ok).toBe(true);

    const second = await admit(room, "phone", signedPhoneProof(room, key), { nonDisplacing: true });
    expect(second.result.ok).toBe(false);
    expect(second.result.error).toBe("slot occupied");
    // The incumbent phone is untouched (not displaced).
    let firstClosed = false;
    first.ws.addEventListener("close", () => { firstClosed = true; }, { once: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(firstClosed).toBe(false);
  });

  it("accepts a non-displacing phone join when the slot is free", async () => {
    const { room, key } = await establishedRoomWithMac();
    const phone = await admit(room, "phone", signedPhoneProof(room, key), { nonDisplacing: true });
    expect(phone.result.ok).toBe(true);
  });

  it("still displaces by default (no flag), closing the incumbent", async () => {
    const { room, key } = await establishedRoomWithMac();
    const first = await admitSigned(room, "phone", key.privateKey);
    expect(first.result.ok).toBe(true);
    const firstClose = closed(first.ws);

    const second = await admitSigned(room, "phone", key.privateKey);
    expect(second.result.ok).toBe(true);
    const ev = await firstClose;          // incumbent is displaced
    expect(ev.reason).toBe("displaced");
  });
});
