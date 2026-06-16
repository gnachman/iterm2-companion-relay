// Adversarial integration tests for the relay's hardening / quota controls,
// driven over real WebSockets (and the DO directly, for the alarm). These are
// availability/cost defenses; the relay never sees plaintext. Covered:
//   (1) pre-auth socket cap + admission deadline
//   (2) admission (proof) flood rate limiting
//   (3) spliced frame size + rate caps
//   (4) signed room deletion + housekeeping prune
// See ../../docs/companion-relay-design.md.

import { describe, it, expect } from "vitest";
import { SELF, env, runInDurableObject } from "cloudflare:test";
import {
  openSocket, admit, admitSigned, closed, freshRoom,
  makeJoinKey, signB64, seedVerifier, transcript, canonicalEncode, ORIGIN,
} from "./helpers.js";

const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Mirrors the worker's deleteTranscript: the "delete" domain (vs "join")
// domain-separates a deletion from a join signature.
function deleteTranscript(challengeB64, roomName, origin = ORIGIN) {
  const enc = new TextEncoder();
  return canonicalEncode("iterm2-relay-delete",
    [b64ToBytes(challengeB64), enc.encode(roomName), enc.encode(origin)]);
}

async function getChallenge(room) {
  const res = await SELF.fetch("https://relay.example/attest/challenge", {
    method: "POST", headers: { "x-relay-room": room },
  });
  return (await res.json()).challenge;
}

async function postDelete(room, payload) {
  const res = await SELF.fetch("https://relay.example/delete", {
    method: "POST",
    headers: { "x-relay-room": room, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

const stubFor = (room) => env.ROOM.get(env.ROOM.idFromName(room));

describe("(1) pre-auth socket cap + deadline", () => {
  it("evicts the oldest pending socket beyond the cap", async () => {
    const room = freshRoom();
    // MAX_PREAUTH_SOCKETS is 4; fill to the cap, then watch the oldest before a
    // 5th connects and triggers its eviction (attach the listener first).
    const socks = [];
    for (let i = 0; i < 4; i++) socks.push(await openSocket(room));
    const ev = closed(socks[0]);
    await openSocket(room);
    const e = await ev;
    expect(e.code).toBe(1008);
    expect(e.reason).toBe("too many pending");
  });

  it("closes a pre-auth socket that never admits within the deadline", async () => {
    const room = freshRoom();
    const ws = await openSocket(room);
    const ev = closed(ws); // watch before the alarm fires the timeout close
    // Backdate the socket past the deadline and run the housekeeping alarm.
    await runInDurableObject(stubFor(room), async (instance, state) => {
      for (const s of state.getWebSockets()) {
        s.serializeAttachment({ ...s.deserializeAttachment(), connectedAt: Date.now() - 10 * 60 * 1000 });
      }
      await instance.alarm();
    });
    const e = await ev;
    expect(e.code).toBe(1008);
    expect(e.reason).toBe("admission timeout");
  });
});

describe("(2) admission flood rate limit", () => {
  it("rejects proof attempts past the per-room window cap", async () => {
    const room = freshRoom();
    // MAX_ADMISSION_ATTEMPTS is 40 per window; the flood must trip "rate limited".
    let limited = null;
    for (let i = 0; i < 50; i++) {
      const { result } = await admit(room, "mac"); // open mode: a mac admits freely
      if (!result.ok) { limited = result.error; break; }
    }
    expect(limited).toBe("rate limited");
  });
});

describe("(3) spliced frame size + rate caps", () => {
  it("closes an admitted socket that sends an oversized frame", async () => {
    const room = freshRoom();
    const { ws } = await admit(room, "mac");
    ws.send(new Uint8Array(300 * 1024)); // > MAX_FRAME_BYTES (256 KiB)
    expect((await closed(ws)).code).toBe(1009);
  });

  it("closes a pre-auth socket that sends an oversized control frame", async () => {
    const room = freshRoom();
    const ws = await openSocket(room);
    ws.send("x".repeat(9 * 1024)); // > MAX_CONTROL_BYTES (8 KiB), still pre-auth
    expect((await closed(ws)).code).toBe(1009);
  });

  it("closes an admitted socket that floods frames", async () => {
    const room = freshRoom();
    const { ws } = await admit(room, "mac");
    const onClose = closed(ws);
    // MAX_FRAMES_PER_WINDOW is 500 per second; overshoot it.
    for (let i = 0; i < 600; i++) {
      try { ws.send(new Uint8Array([0])); } catch { break; }
    }
    expect((await onClose).code).toBe(1008);
  });
});

describe("(5) per-room daily byte quota", () => {
  it("closes the room once the daily byte quota is exceeded", async () => {
    const room = freshRoom();
    const { ws } = await admit(room, "mac");
    const onClose = closed(ws);
    // RELAY_DAILY_BYTE_QUOTA is 1 MiB in the open-mode config; 256 KiB frames
    // (the max allowed size) cross it within a few sends, well under the
    // per-second frame-rate cap.
    const frame = new Uint8Array(256 * 1024);
    for (let i = 0; i < 8; i++) {
      try { ws.send(frame); } catch { break; }
    }
    expect((await onClose).code).toBe(1008);
  });
});

describe("(4) signed room deletion", () => {
  async function established(room) {
    const key = await makeJoinKey();
    await seedVerifier(room, key.verifierB64);
    return key;
  }

  it("wipes the room and disconnects both sides on a valid signed delete", async () => {
    const room = freshRoom();
    const { privateKey } = await established(room);
    const mac = await admitSigned(room, "mac", privateKey);
    expect(mac.result.ok).toBe(true);
    const ev = closed(mac.ws); // watch before the delete closes the socket

    const challenge = await getChallenge(room);
    const sig = await signB64(privateKey, deleteTranscript(challenge, room));
    const res = await postDelete(room, { challenge, signature: sig });

    expect(res.status).toBe(200);
    expect((await ev).code).toBe(1000);
    const verifier = await runInDurableObject(stubFor(room), (_i, s) => s.storage.get("verifier"));
    expect(verifier).toBeUndefined();
  });

  it("refuses to delete an un-established room (no key to authorize with)", async () => {
    const room = freshRoom();
    const challenge = await getChallenge(room);
    const res = await postDelete(room, { challenge, signature: "AAAA" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("not established");
  });

  it("rejects a delete signed by the wrong key", async () => {
    const room = freshRoom();
    await established(room);
    const attacker = await makeJoinKey();
    const challenge = await getChallenge(room);
    const sig = await signB64(attacker.privateKey, deleteTranscript(challenge, room));
    const res = await postDelete(room, { challenge, signature: sig });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bad signature");
  });

  it("rejects a delete over a challenge that was never issued", async () => {
    const room = freshRoom();
    const { privateKey } = await established(room);
    const fake = btoa("x".repeat(32));
    const sig = await signB64(privateKey, deleteTranscript(fake, room));
    const res = await postDelete(room, { challenge: fake, signature: sig });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bad challenge");
  });

  it("rejects a join signature replayed as a delete (domain separation)", async () => {
    const room = freshRoom();
    const { privateKey } = await established(room);
    const challenge = await getChallenge(room);
    // A valid JOIN signature (role mac) over the same challenge must NOT
    // authorize a delete: the transcripts differ by the op byte.
    const joinSig = await signB64(privateKey, transcript("mac", challenge, room));
    const res = await postDelete(room, { challenge, signature: joinSig });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bad signature");
  });

  it("consumes the delete challenge even when the signature is bad (no replay)", async () => {
    const room = freshRoom();
    await established(room);
    const challenge = await getChallenge(room);
    expect((await postDelete(room, { challenge, signature: "AAAA" })).body.error).toBe("bad signature");
    // The challenge was spent on the failed attempt; reusing it is "bad challenge".
    expect((await postDelete(room, { challenge, signature: "AAAA" })).body.error).toBe("bad challenge");
  });
});

describe("(4) housekeeping prune", () => {
  it("deletes expired ephemeral records and keeps live ones", async () => {
    const room = freshRoom();
    await runInDurableObject(stubFor(room), async (instance, state) => {
      await state.storage.put("ticket:old", { expiresAt: Date.now() - 1000 });
      await state.storage.put("attestchallenge:old", { expiresAt: Date.now() - 1000 });
      await state.storage.put("regtoken:live", { expiresAt: Date.now() + 5 * 60 * 1000 });
      await instance.alarm();
      expect(await state.storage.get("ticket:old")).toBeUndefined();
      expect(await state.storage.get("attestchallenge:old")).toBeUndefined();
      expect(await state.storage.get("regtoken:live")).toBeDefined();
    });
  });
});
