// HTTP Basic auth for the dashboard. The dashboard binds to loopback behind
// Apache, but the password is enforced HERE, in-app, so "keep randos off" does
// not depend on getting the Apache config exactly right — if the proxy is ever
// misconfigured or bypassed, the app still refuses. Apache may add its own
// .htpasswd on top (defense in depth); this is the floor, not the ceiling.
//
// The comparison is constant-time (crypto.timingSafeEqual over SHA-256 digests
// of the supplied vs expected credential) so a wrong password cannot be teased
// out by timing how long the reject takes. Digesting first makes the compared
// buffers equal-length regardless of input length, which timingSafeEqual
// requires and which also hides the credential lengths.

import { createHash, timingSafeEqual } from "node:crypto";

function digest(s) {
  return createHash("sha256").update(String(s), "utf8").digest();
}

function safeEqual(a, b) {
  const da = digest(a), db = digest(b);
  return timingSafeEqual(da, db); // both are 32 bytes
}

// Returns true when the request carries valid Basic credentials for user/pass.
// A missing/malformed header returns false (the caller sends the 401 challenge).
// Both fields are always compared so the work is independent of which is wrong.
export function checkBasicAuth(header, user, pass) {
  let gotUser = "", gotPass = "";
  if (typeof header === "string" && header.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
      const i = decoded.indexOf(":");
      if (i !== -1) {
        gotUser = decoded.slice(0, i);
        gotPass = decoded.slice(i + 1);
      }
    } catch { /* malformed base64 -> empty creds -> reject */ }
  }
  const okUser = safeEqual(gotUser, user);
  const okPass = safeEqual(gotPass, pass);
  return okUser && okPass;
}

// Guard a request: if auth is configured and the request fails it, write a 401
// challenge and return false. Returns true when the request may proceed (either
// auth passed, or no credentials are configured — the caller decides whether
// unconfigured means open; the server refuses to start unconfigured).
export function requireAuth(req, res, { user, pass, realm = "iTerm2 Relay Dashboard" }) {
  if (!user || !pass) return true; // unconfigured: server-level guard handles this
  const ok = checkBasicAuth(req.headers.authorization, user, pass);
  if (ok) return true;
  res.writeHead(401, {
    "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"`,
    "content-type": "text/plain; charset=utf-8",
  });
  res.end("Authentication required.\n");
  return false;
}
