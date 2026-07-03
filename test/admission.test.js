// Room DO admission + splice, open mode (ATTEST_REQUIRED=false). The four-
// message handshake (Hello -> Challenge -> Proof -> Result) and, once both
// slots are filled, a transparent bidirectional byte splice. The relay never
// interprets spliced frames. See ../../../docs/companion-relay-design.md.

import { describe, it, expect, beforeEach } from "vitest";
import { admit, openSocket, next, closed, openMode, freshRoom, installRelay } from "./helpers.js";

installRelay();

describe("admission + splice (open mode)", () => {
  beforeEach(() => openMode());

  it("answers Hello with a base64 nonce Challenge", async () => {
    const ws = await openSocket(freshRoom());
    ws.send(JSON.stringify({ v: 1, role: "mac" }));
    const challenge = JSON.parse(await next(ws));
    expect(typeof challenge.nonce).toBe("string");
    expect(atob(challenge.nonce).length).toBeGreaterThanOrEqual(16);
  });

  it("admits a mac and a phone, then splices bytes both ways", async () => {
    const room = freshRoom();
    const mac = await admit(room, "mac");
    expect(mac.result.ok).toBe(true);
    const phone = await admit(room, "phone");
    expect(phone.result.ok).toBe(true);

    // phone -> mac
    const macGot = next(mac.ws);
    phone.ws.send("hello-from-phone");
    expect(await macGot).toBe("hello-from-phone");

    // mac -> phone
    const phoneGot = next(phone.ws);
    mac.ws.send("hello-from-mac");
    expect(await phoneGot).toBe("hello-from-phone".replace("phone", "mac"));
  });

  it("splices binary frames unchanged", async () => {
    const room = freshRoom();
    const mac = await admit(room, "mac");
    const phone = await admit(room, "phone");
    const macGot = next(mac.ws);
    const payload = new Uint8Array([0, 1, 2, 253, 254, 255]);
    phone.ws.send(payload);
    const got = await macGot;
    expect(new Uint8Array(got)).toEqual(payload);
  });

  it("closes the peer when one admitted side disconnects", async () => {
    // The mac's link to the relay stays healthy when the phone vanishes, so
    // without this the mac would wait forever. Closing the peer is what lets
    // the mac notice the disconnect and re-park for a reconnect.
    const room = freshRoom();
    const mac = await admit(room, "mac");
    const phone = await admit(room, "phone");
    const macClosed = closed(mac.ws);
    phone.ws.close(1000, "bye");
    const ev = await macClosed;
    expect(ev.code).toBe(1001);
    expect(ev.reason).toBe("peer gone");
  });

  it("rejects a phone while no mac is parked, then admits once it arrives", async () => {
    // Mac-restart reconnect: the mac is still relaunching when the phone tries
    // to reconnect. The phone must be rejected (not admitted into an empty room
    // where its handshake is dropped) so it retries cheaply. Once the mac parks,
    // the next attempt is admitted and splices.
    const room = freshRoom();

    const early = await admit(room, "phone");
    expect(early.result.ok).toBe(false);
    expect(early.result.error).toBe("mac offline");

    // Mac finishes relaunching and parks; now the phone's retry is admitted.
    const mac = await admit(room, "mac");
    const phone = await admit(room, "phone");
    expect(phone.result.ok).toBe(true);

    const got = next(mac.ws);
    phone.ws.send("reached-the-mac");
    expect(await got).toBe("reached-the-mac");
  });

  it("a reconnecting phone displaces the old one without closing the mac", async () => {
    // Repeated phone retries (each a new socket displacing the prior) must never
    // tear down the parked mac, or reconnect would livelock.
    const room = freshRoom();
    const mac = await admit(room, "mac");
    await admit(room, "phone");
    const phone2 = await admit(room, "phone"); // displaces the first phone

    const got = next(mac.ws);
    phone2.ws.send("still-spliced");
    expect(await got).toBe("still-spliced");
  });

  it("does not forward pre-splice (before the peer is admitted)", async () => {
    const room = freshRoom();
    const mac = await admit(room, "mac");
    // No phone yet. A frame from mac has nowhere to go; it must not error the
    // socket. We assert the socket stays open by completing a later splice.
    mac.ws.send("into-the-void");
    const phone = await admit(room, "phone");
    const phoneGot = next(phone.ws);
    mac.ws.send("after-splice");
    expect(await phoneGot).toBe("after-splice");
  });
});
