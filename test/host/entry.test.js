// Unit tests for the shared entry gate (origin + room-name validation) that
// both the legacy Cloudflare Worker and the self-hosted host apply before a
// request may reach a room. Rate limiting differs per platform and is tested
// separately.

import { describe, it, expect } from "vitest";
import { entryReject, ROOM_NAME_RE, ROOM_HEADER } from "../../src/index.js";

const GOOD_ROOM = "a".repeat(64);

function headers(obj) {
  return new Headers(obj);
}

describe("entryReject", () => {
  it("accepts a request with a valid 64-hex room and no Origin", () => {
    expect(entryReject(headers({ [ROOM_HEADER]: GOOD_ROOM }))).toBeNull();
  });

  it("rejects any request carrying an Origin header (browser surface)", () => {
    const rej = entryReject(headers({ [ROOM_HEADER]: GOOD_ROOM, Origin: "https://evil.example" }));
    expect(rej).toEqual({ status: 403, message: "forbidden" });
  });

  it("rejects a missing room header", () => {
    expect(entryReject(headers({}))).toEqual({ status: 400, message: "bad room" });
  });

  it("rejects a malformed room name", () => {
    for (const bad of ["", "xyz", "A".repeat(64), "a".repeat(63), "a".repeat(65), GOOD_ROOM + "g"]) {
      expect(entryReject(headers({ [ROOM_HEADER]: bad }))).toEqual({ status: 400, message: "bad room" });
    }
  });

  it("exposes the room-name pattern and header name", () => {
    expect(ROOM_NAME_RE.test(GOOD_ROOM)).toBe(true);
    expect(ROOM_HEADER).toBe("x-relay-room");
  });
});
