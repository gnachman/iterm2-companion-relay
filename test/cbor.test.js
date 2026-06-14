// The minimal CBOR codec: round-trips the subset the attestation object uses,
// and rejects malformed / out-of-subset input rather than guessing.

import { describe, it, expect } from "vitest";
import { decode, encode, CBORError } from "../src/cbor.js";

const bytes = (...xs) => new Uint8Array(xs);

describe("cbor", () => {
  it("round-trips ints, byte/text strings, arrays, and maps", () => {
    const value = {
      fmt: "apple-appattest",
      attStmt: { x5c: [bytes(1, 2, 3), bytes(4, 5)], receipt: bytes(9) },
      authData: bytes(0xaa, 0xbb, 0xcc),
      n: 1000000,
    };
    const decoded = decode(encode(value));
    expect(decoded.fmt).toBe("apple-appattest");
    expect(decoded.n).toBe(1000000);
    expect([...decoded.authData]).toEqual([0xaa, 0xbb, 0xcc]);
    expect([...decoded.attStmt.x5c[0]]).toEqual([1, 2, 3]);
    expect([...decoded.attStmt.x5c[1]]).toEqual([4, 5]);
    expect([...decoded.attStmt.receipt]).toEqual([9]);
  });

  it("decodes a known CBOR encoding", () => {
    // {"a": 1} per RFC 8949.
    expect(decode(bytes(0xa1, 0x61, 0x61, 0x01))).toEqual({ a: 1 });
  });

  it("rejects trailing bytes", () => {
    expect(() => decode(bytes(0x01, 0x02))).toThrow(CBORError);
  });

  it("rejects truncated input", () => {
    // byte string claiming 5 bytes, only 2 present.
    expect(() => decode(bytes(0x45, 0x01, 0x02))).toThrow(CBORError);
  });

  it("rejects unsupported major types (e.g. negative int)", () => {
    expect(() => decode(bytes(0x20))).toThrow(CBORError);
  });

  it("rejects non-text map keys", () => {
    // map {1: 2}.
    expect(() => decode(bytes(0xa1, 0x01, 0x02))).toThrow(CBORError);
  });
});
