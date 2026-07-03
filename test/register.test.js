// Verifier registration: the phone is handed a one-time registration token at
// admission, then POSTs it with its verifier to /register, transitioning the
// room to established. Single-use, TTL'd, and once a verifier exists a second
// registration is refused (overwrite protection). See
// ../../../docs/companion-relay-design.md.

import { describe, it, expect } from "vitest";
import {
  admit,
  admitSigned,
  register,
  freshRoom,
  makeJoinKey,
  seedExpiredToken,
  installRelay,
} from "./helpers.js";

installRelay();

describe("registration token + /register", () => {
  // A phone may only admit while a mac is parked (real pairing always has the
  // mac waiting behind the QR), so these tests park one first.
  it("hands the phone a registration token at admission, but not the mac", async () => {
    const room = freshRoom();
    await admit(room, "mac");
    const phone = await admit(room, "phone");
    expect(typeof phone.result.registrationToken).toBe("string");

    const mac = await admit(freshRoom(), "mac");
    expect(mac.result.registrationToken).toBeUndefined();
  });

  it("registers a verifier with a valid token and establishes the room", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    await admit(room, "mac");
    const phone = await admit(room, "phone");

    const reg = await register(room, {
      registrationToken: phone.result.registrationToken,
      verifier: key.verifierB64,
    });
    expect(reg.status).toBe(200);
    expect(reg.body.ok).toBe(true);

    // Now established: an unsigned join is refused, a signed one is admitted.
    const unsigned = await admit(room, "phone", () => ({}));
    expect(unsigned.result.ok).toBe(false);
    const signed = await admitSigned(room, "phone", key.privateKey);
    expect(signed.result.ok).toBe(true);
  });

  it("rejects an unknown token", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    const reg = await register(room, { registrationToken: "nope", verifier: key.verifierB64 });
    expect(reg.body.ok).toBe(false);
  });

  it("token is single-use", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    await admit(room, "mac");
    const phone = await admit(room, "phone");
    const token = phone.result.registrationToken;

    const first = await register(room, { registrationToken: token, verifier: key.verifierB64 });
    expect(first.body.ok).toBe(true);
    const second = await register(freshRoom(), { registrationToken: token, verifier: key.verifierB64 });
    expect(second.body.ok).toBe(false);
  });

  it("refuses to overwrite an existing verifier (overwrite protection)", async () => {
    const room = freshRoom();
    const key1 = await makeJoinKey();
    await admit(room, "mac");
    const phone1 = await admit(room, "phone");
    await register(room, { registrationToken: phone1.result.registrationToken, verifier: key1.verifierB64 });

    // Attacker gets a fresh token (admission is open) and tries to replace V.
    const key2 = await makeJoinKey();
    const phone2 = await admit(room, "phone");
    const overwrite = await register(room, {
      registrationToken: phone2.result.registrationToken,
      verifier: key2.verifierB64,
    });
    expect(overwrite.body.ok).toBe(false);

    // The original key still admits; the attacker's does not.
    expect((await admitSigned(room, "phone", key1.privateKey)).result.ok).toBe(true);
    expect((await admitSigned(room, "phone", key2.privateKey)).result.ok).toBe(false);
  });

  it("rejects an expired token", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    await seedExpiredToken(room, "stale-token");
    const reg = await register(room, { registrationToken: "stale-token", verifier: key.verifierB64 });
    expect(reg.body.ok).toBe(false);
  });

  it("rejects a token minted in a DIFFERENT room (tokens are per-room)", async () => {
    const roomA = freshRoom();
    const roomB = freshRoom();
    const key = await makeJoinKey();
    await admit(roomA, "mac");
    const phone = await admit(roomA, "phone");
    const reg = await register(roomB, {
      registrationToken: phone.result.registrationToken,
      verifier: key.verifierB64,
    });
    expect(reg.body.ok).toBe(false);
  });
});
