#!/usr/bin/env node
// Send one visible push to George's phone through a push relay: the Linux stand-in
// for `it2-notify --url`, which is a macOS binary. Same request the notify tool
// makes: POST <relay>/push {token, secret, title, body} (the push relay's API is
// in the iTerm2 repo, Companion/PushRelay/src/worker.js). Credentials come from
// ITERM_PUSH_TOKEN / ITERM_PUSH_SECRET, which pushcreds.sh loads from push.env.
//
// Usage: node push-send.mjs <relay-url> <title> <body>
// Exits 0 when the relay accepted it, 3 when it rejected the credentials (403:
// "bad secret" / "unknown device token", so push.env is stale), 1 otherwise.
// The last line of stderr says why.

const [base, title, body] = process.argv.slice(2);
const token = process.env.ITERM_PUSH_TOKEN;
const secret = process.env.ITERM_PUSH_SECRET;
if (!base || title === undefined || body === undefined) {
  console.error("usage: push-send.mjs <relay-url> <title> <body>");
  process.exit(1);
}
if (!token || !secret) {
  console.error("ITERM_PUSH_TOKEN / ITERM_PUSH_SECRET are not set");
  process.exit(1);
}

const url = base.replace(/\/+$/, "") + "/push";
let res;
try {
  res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, secret, title, body }),
    signal: AbortSignal.timeout(15000),
  });
} catch (e) {
  console.error(`${url}: ${e.cause?.code || e.name}: ${e.cause?.message || e.message}`);
  process.exit(1);
}
const text = await res.text();
if (res.ok) process.exit(0);
let error = text.slice(0, 200);
try { error = JSON.parse(text).error ?? error; } catch { /* not the relay's JSON */ }
console.error(`${url}: HTTP ${res.status}: ${error}`);
process.exit(res.status === 403 ? 3 : 1);
