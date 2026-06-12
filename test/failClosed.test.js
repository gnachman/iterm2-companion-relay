// The attestation gate must fail CLOSED: a botched or missing ATTEST_REQUIRED
// must mean "required", never silently turn the hosted instance into an open
// relay. See the abuse-control section of ../../../docs/companion-relay-design.md.

import { describe, it, expect } from "vitest";
import { attestationRequired } from "../src/room.js";

describe("ATTEST_REQUIRED fails closed", () => {
  it("requires attestation when unset", () => {
    expect(attestationRequired({})).toBe(true);
  });

  it("requires attestation when empty", () => {
    expect(attestationRequired({ ATTEST_REQUIRED: "" })).toBe(true);
  });

  it("requires attestation for any value other than the exact 'false'", () => {
    for (const v of ["true", "0", "no", "FALSE", "False", "off", "disabled"]) {
      expect(attestationRequired({ ATTEST_REQUIRED: v })).toBe(true);
    }
  });

  it("only the exact string 'false' disables attestation (BYO path)", () => {
    expect(attestationRequired({ ATTEST_REQUIRED: "false" })).toBe(false);
  });
});
