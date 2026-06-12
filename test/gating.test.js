// Pre-DO gating in the entry Worker: the cheap checks that must run before
// idFromName so a garbage request never instantiates a Durable Object.
// Adversarial by intent: each case is something a hostile client would try.
// See ../../../docs/companion-relay-design.md (DO admission / gating sections).

import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

const ROOM = "a".repeat(64); // a syntactically valid room name (64 lc hex)

function req(headers) {
  return new Request("https://relay.example/", { headers });
}

describe("pre-DO gating", () => {
  it("rejects a request carrying an Origin header (browser surface)", async () => {
    const res = await SELF.fetch(
      req({ "x-relay-room": ROOM, Origin: "https://evil.example" })
    );
    expect(res.status).toBe(403);
  });

  it("rejects a missing room-name header", async () => {
    const res = await SELF.fetch(req({}));
    expect(res.status).toBe(400);
  });

  it("rejects a malformed room-name header (wrong length)", async () => {
    const res = await SELF.fetch(req({ "x-relay-room": "abc" }));
    expect(res.status).toBe(400);
  });

  it("rejects a room name with uppercase hex (must be canonical lowercase)", async () => {
    const res = await SELF.fetch(req({ "x-relay-room": "A".repeat(64) }));
    expect(res.status).toBe(400);
  });

  it("rejects a room name with non-hex characters", async () => {
    const res = await SELF.fetch(req({ "x-relay-room": "g".repeat(64) }));
    expect(res.status).toBe(400);
  });

  it("routes a valid room name to the DO (no longer a gating rejection)", async () => {
    const res = await SELF.fetch(req({ "x-relay-room": ROOM }));
    // The DO stub answers 501; the point is gating let it through (not 400/403).
    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(403);
  });
});
