#!/usr/bin/env node
// Manually exercise the relay's hardening defenses against a live deployment
// and report, for each, whether the attack was STOPPED.
//
//   node tools/probe-defenses.mjs [origin]
//
// origin defaults to the production relay. Each probe uses a fresh random room
// name, so it never touches a real pairing. The relay sees only ciphertext;
// these probes drive the admission/forwarding control plane, not user data.
//
// Requires the `ws` package (installed as a dev dependency of this project):
// the WHATWG WebSocket cannot set the x-relay-room header the relay needs.

import WebSocket from "ws";
import crypto from "node:crypto";

const ORIGIN = (process.argv[2] || "https://iterm2-companion-relay.gnachman.workers.dev").replace(/\/$/, "");
const WSURL = ORIGIN.replace(/^http/, "ws") + "/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freshRoom = () => crypto.randomBytes(32).toString("hex");

function openWS(room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WSURL, { headers: { "x-relay-room": room } });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const onMsg = (d) => { cleanup(); resolve(d.toString()); };
    const onClose = (code, reason) => { cleanup(); reject(new Error(`closed ${code} ${reason}`)); };
    const cleanup = () => { ws.off("message", onMsg); ws.off("close", onClose); };
    ws.on("message", onMsg);
    ws.on("close", onClose);
  });
}

function onceClose(ws) {
  return new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
}

// Admit a socket (mac role parks freely, even under attestation, since a fresh
// room has no verifier). Returns the open, admitted socket.
async function admitSocket(room) {
  const ws = await openWS(room);
  ws.send(JSON.stringify({ v: 1, role: "mac" }));
  await nextMessage(ws); // challenge
  ws.send(JSON.stringify({})); // empty proof
  const result = JSON.parse(await nextMessage(ws));
  if (!result.ok) throw new Error(`admit failed: ${result.error}`);
  return ws;
}

// One full admission attempt; returns the Result object (or a closed marker).
async function admitOnce(room) {
  const ws = await openWS(room);
  try {
    ws.send(JSON.stringify({ v: 1, role: "mac" }));
    await nextMessage(ws);
    ws.send(JSON.stringify({}));
    return JSON.parse(await nextMessage(ws));
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

// --- Probes: each returns { stopped: bool, detail: string } ---

async function probePreAuthCap() {
  const room = freshRoom();
  const N = 6; // MAX_PREAUTH_SOCKETS is 4
  const closes = [];
  const sockets = [];
  for (let i = 0; i < N; i++) {
    const ws = await openWS(room).catch(() => null);
    if (!ws) continue;
    ws.on("close", (code) => closes.push(code));
    sockets.push(ws);
    await sleep(80);
  }
  await sleep(600);
  for (const ws of sockets) try { ws.close(); } catch { /* ignore */ }
  const evicted = closes.filter((c) => c === 1008).length;
  return { stopped: evicted > 0, detail: `${evicted}/${N} pending sockets evicted (1008 too many pending)` };
}

async function probeAdmissionFlood() {
  const room = freshRoom();
  let admits = 0;
  for (let i = 0; i < 60; i++) {
    const r = await admitOnce(room);
    if (r && r.error === "rate limited") {
      return { stopped: true, detail: `rate limited after ${admits} admits (cap ~40/window)` };
    }
    if (r && r.ok) admits++;
  }
  return { stopped: false, detail: `${admits} admits, never rate limited` };
}

async function probeOversizedFrame() {
  const ws = await admitSocket(freshRoom());
  const closeP = onceClose(ws);
  ws.send(Buffer.alloc(300 * 1024)); // > MAX_FRAME_BYTES (256 KiB)
  const c = await Promise.race([closeP, sleep(3000).then(() => null)]);
  try { ws.close(); } catch { /* ignore */ }
  return c
    ? { stopped: c.code === 1009, detail: `closed ${c.code} ${c.reason}` }
    : { stopped: false, detail: "300 KiB frame accepted, socket stayed open" };
}

async function probeFrameFlood() {
  const ws = await admitSocket(freshRoom());
  const closeP = onceClose(ws);
  for (let i = 0; i < 700; i++) { // > MAX_FRAMES_PER_WINDOW (500/s)
    try { ws.send(Buffer.from([0])); } catch { break; }
  }
  const c = await Promise.race([closeP, sleep(3000).then(() => null)]);
  try { ws.close(); } catch { /* ignore */ }
  return c
    ? { stopped: c.code === 1008, detail: `closed ${c.code} ${c.reason}` }
    : { stopped: false, detail: "frame flood accepted, socket stayed open" };
}

async function probeUnauthorizedDelete() {
  const room = freshRoom();
  const ch = await (await fetch(`${ORIGIN}/attest/challenge`, {
    method: "POST", headers: { "x-relay-room": room },
  })).json();
  const res = await fetch(`${ORIGIN}/delete`, {
    method: "POST",
    headers: { "x-relay-room": room, "content-type": "application/json" },
    body: JSON.stringify({ challenge: ch.challenge, signature: "AAAA" }),
  });
  const body = await res.json().catch(() => ({}));
  return { stopped: res.status === 403, detail: `HTTP ${res.status} (${body.error ?? "?"})` };
}

const PROBES = [
  ["1  Pre-auth socket cap", probePreAuthCap],
  ["2  Admission flood rate limit", probeAdmissionFlood],
  ["3a Oversized spliced frame", probeOversizedFrame],
  ["3b Spliced frame flood", probeFrameFlood],
  ["4  Unauthorized room delete", probeUnauthorizedDelete],
];

const main = async () => {
  console.log(`iTerm2 relay defense probe -> ${WSURL}\n`);
  let allStopped = true;
  for (const [name, fn] of PROBES) {
    let r;
    try {
      r = await fn();
    } catch (e) {
      r = { stopped: false, detail: `probe error: ${e.message}` };
    }
    allStopped = allStopped && r.stopped;
    const verdict = r.stopped ? "STOPPED  ✓" : "GOT THROUGH ✗";
    console.log(`[${name.padEnd(30)}] ${verdict.padEnd(14)} ${r.detail}`);
  }
  console.log(`\n${allStopped ? "All defenses held." : "Some attacks got through (see above)."}`);
  process.exit(allStopped ? 0 : 1);
};

main();
