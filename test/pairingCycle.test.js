// Pairing-room cycle cap: a photographed-QR attacker who reaches the relay can
// reconnect and re-handshake to grind the ~20-bit SAS. The DO bounds how many
// phone handshake/displacement cycles one mac park tolerates before it kills the
// room (forcing the Mac to mint a fresh pid/QR the attacker's photo no longer
// matches). The budget is per mac PARK, not per QR: a fresh mac park resets it,
// so a confirmed-but-not-yet-established Mac re-parking, or the legitimate phone
// retrying during a Mac restart, is not starved. See
// ../../../docs/companion-relay-design.md (Pairing confirmation).

import { describe, it, expect } from "vitest";
import { admit, closed, freshRoom } from "./helpers.js";

// Must match MAX_PAIRING_CYCLES in src/room.js.
const MAX_PAIRING_CYCLES = 8;

describe("pairing-room handshake/displacement cycle cap", () => {
  it("kills the room after too many phone cycles in a single mac park", async () => {
    const room = freshRoom();
    const mac = await admit(room, "mac"); // open-mode park
    expect(mac.result.ok).toBe(true);
    const macClosed = closed(mac.ws);

    let admitted = 0;
    for (let i = 1; i <= MAX_PAIRING_CYCLES + 1; i++) {
      try {
        const phone = await admit(room, "phone");
        if (phone.result.ok) admitted += 1;
      } catch {
        // The cap-exceeding admit is torn down before a Result frame arrives, so
        // the helper's socket closes mid-handshake.
        break;
      }
    }
    // Exactly the budget is honored; the next cycle trips the cap.
    expect(admitted).toBe(MAX_PAIRING_CYCLES);
    expect((await macClosed).code).toBe(1000);
  });

  it("resets the budget on a fresh mac park", async () => {
    const room = freshRoom();
    await admit(room, "mac");
    // Use up most of the first park's budget.
    for (let i = 0; i < MAX_PAIRING_CYCLES - 1; i++) {
      const phone = await admit(room, "phone");
      expect(phone.result.ok).toBe(true);
    }
    // A fresh mac park (newest-wins) resets the counter, so the next phone
    // cycles do not inherit the prior park's spend.
    const mac2 = await admit(room, "mac");
    expect(mac2.result.ok).toBe(true);
    const macClosed = closed(mac2.ws);
    let raced = false;
    macClosed.then(() => { raced = true; });

    for (let i = 0; i < MAX_PAIRING_CYCLES - 1; i++) {
      const phone = await admit(room, "phone");
      expect(phone.result.ok).toBe(true);
    }
    expect(raced).toBe(false); // room survived: the budget was reset
  });
});
