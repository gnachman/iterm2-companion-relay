import { describe, it, expect } from "vitest";
import { checkBasicAuth, requireAuth } from "../../dashboard/auth.js";

const header = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

describe("checkBasicAuth", () => {
  it("accepts the correct credentials", () => {
    expect(checkBasicAuth(header("admin", "s3cret"), "admin", "s3cret")).toBe(true);
  });

  it("rejects a wrong password, wrong user, or both", () => {
    expect(checkBasicAuth(header("admin", "nope"), "admin", "s3cret")).toBe(false);
    expect(checkBasicAuth(header("root", "s3cret"), "admin", "s3cret")).toBe(false);
    expect(checkBasicAuth(header("x", "y"), "admin", "s3cret")).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(checkBasicAuth(undefined, "admin", "s3cret")).toBe(false);
    expect(checkBasicAuth("Bearer abc", "admin", "s3cret")).toBe(false);
    expect(checkBasicAuth("Basic !!!notbase64", "admin", "s3cret")).toBe(false);
    expect(checkBasicAuth("Basic " + Buffer.from("noColon").toString("base64"), "admin", "s3cret")).toBe(false);
  });

  it("does not treat a password containing a colon as truncated", () => {
    expect(checkBasicAuth(header("admin", "a:b:c"), "admin", "a:b:c")).toBe(true);
  });
});

describe("requireAuth", () => {
  function fakeRes() {
    return {
      code: null, headers: null, body: "",
      writeHead(c, h) { this.code = c; this.headers = h; return this; },
      end(b) { if (b) this.body = b; return this; },
    };
  }

  it("passes a valid request through", () => {
    const res = fakeRes();
    const ok = requireAuth({ headers: { authorization: header("admin", "pw") } }, res, { user: "admin", pass: "pw" });
    expect(ok).toBe(true);
    expect(res.code).toBeNull();
  });

  it("challenges an invalid request with 401", () => {
    const res = fakeRes();
    const ok = requireAuth({ headers: {} }, res, { user: "admin", pass: "pw" });
    expect(ok).toBe(false);
    expect(res.code).toBe(401);
    expect(res.headers["WWW-Authenticate"]).toContain("Basic");
  });
});
