// Established-room admission: once a verifier is registered, a join must carry
// a valid Ed25519 signature over the bound transcript (version, role, the DO's
// challenge nonce, room name, relay origin), verified against the stored
// verifier. This holds regardless of ATTEST_REQUIRED. Adversarial cases assert
// the threat model: no signature, a forged one, or one bound to the wrong
// nonce/role/room must all be refused. See ../../../docs/companion-relay-design.md.

import { describe, it, expect } from "vitest";
import {
  admit,
  admitSigned,
  next,
  freshRoom,
  makeJoinKey,
  signB64,
  transcript,
  seedVerifier,
  installRelay,
} from "./helpers.js";

installRelay();

describe("established-room signature admission", () => {
  it("admits a join carrying a valid signature, then splices", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    await seedVerifier(room, key.verifierB64);

    const mac = await admitSigned(room, "mac", key.privateKey);
    expect(mac.result.ok).toBe(true);
    const phone = await admitSigned(room, "phone", key.privateKey);
    expect(phone.result.ok).toBe(true);

    const macGot = next(mac.ws);
    phone.ws.send("ping");
    expect(await macGot).toBe("ping");
  });

  it("rejects a join with NO signature (open-mode admit must not apply)", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    await seedVerifier(room, key.verifierB64);
    const res = await admit(room, "phone", () => ({}));
    expect(res.result.ok).toBe(false);
  });

  it("rejects a forged signature", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    await seedVerifier(room, key.verifierB64);
    const res = await admit(room, "phone", () => ({ sig: btoa("\x00".repeat(64)) }));
    expect(res.result.ok).toBe(false);
  });

  it("rejects a signature from a DIFFERENT key (attacker without roomSecret)", async () => {
    const room = freshRoom();
    const registered = await makeJoinKey();
    const attacker = await makeJoinKey();
    await seedVerifier(room, registered.verifierB64);
    const res = await admit(room, "phone", async (ch) => ({
      sig: await signB64(attacker.privateKey, transcript("phone", ch.nonce, room)),
    }));
    expect(res.result.ok).toBe(false);
  });

  it("rejects a signature bound to a STALE nonce (replay)", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    await seedVerifier(room, key.verifierB64);
    const staleNonce = btoa("\x11".repeat(32));
    const res = await admit(room, "phone", async () => ({
      sig: await signB64(key.privateKey, transcript("phone", staleNonce, room)),
    }));
    expect(res.result.ok).toBe(false);
  });

  it("rejects a signature bound to the WRONG role", async () => {
    const room = freshRoom();
    const key = await makeJoinKey();
    await seedVerifier(room, key.verifierB64);
    // Sign as mac, present as phone.
    const res = await admit(room, "phone", async (ch) => ({
      sig: await signB64(key.privateKey, transcript("mac", ch.nonce, room)),
    }));
    expect(res.result.ok).toBe(false);
  });

  it("rejects a signature bound to a DIFFERENT room (cross-room replay)", async () => {
    const room = freshRoom();
    const otherRoom = freshRoom();
    const key = await makeJoinKey();
    await seedVerifier(room, key.verifierB64);
    const res = await admit(room, "phone", async (ch) => ({
      sig: await signB64(key.privateKey, transcript("phone", ch.nonce, otherRoom)),
    }));
    expect(res.result.ok).toBe(false);
  });
});
