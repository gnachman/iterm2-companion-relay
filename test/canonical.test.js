// canonicalEncode must stay byte-identical to Swift's CanonicalEncoding.encode.
// The shared vector here is the exact one asserted in the Swift
// CanonicalEncodingTests, so a drift on either side fails loudly.

import { describe, it, expect } from "vitest";
// Import the PRODUCTION encoder (the function the admission path actually runs),
// not a test copy, so this byte-vector pins what really ships.
import { canonicalEncode } from "../src/room.js";

const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const enc = (s) => new TextEncoder().encode(s);

describe("canonicalEncode", () => {
  it("matches the shared cross-language vector encode('test', [0x0102, 'hi'])", () => {
    const out = canonicalEncode("test", [new Uint8Array([0x01, 0x02]), enc("hi")]);
    expect(hex(out)).toBe("0000000474657374000000020102000000026869");
  });

  it("is unambiguous across field boundaries", () => {
    expect(hex(canonicalEncode("d", [enc("AB"), enc("C")])))
      .not.toBe(hex(canonicalEncode("d", [enc("A"), enc("BC")])));
  });

  it("domain-separates identical fields", () => {
    expect(hex(canonicalEncode("join", [enc("x")])))
      .not.toBe(hex(canonicalEncode("delete", [enc("x")])));
  });
});
