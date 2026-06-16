// The Room Durable Object: one per pairing pseudonym. Admits a Mac and a phone
// (two slots, one per role), splices their WebSockets, and never reads the
// ciphertext flowing between them. See ../../docs/companion-relay-design.md.
//
// Per-socket state lives in serializeAttachment() so the DO can hibernate
// (a parked Mac costs nothing). The admission state machine:
//   "hello"      just connected; awaiting Hello {v, role}
//   "challenged" sent Challenge {nonce}; awaiting Proof
//   "admitted"   holds its role slot; frames are spliced to the peer

import { DurableObject } from "cloudflare:workers";
import { verifyAttestation, verifyAssertion } from "./appattest.js";
import { APPLE_APP_ATTEST_ROOT_PEM } from "./appleRoot.js";

const PROTOCOL_VERSION = 1;
const NONCE_BYTES = 32;
const ROLE_BYTE = { mac: 1, phone: 2 };
// A registration token lives only long enough for the phone to make its
// follow-up /register call within the same confirmed session.
const REG_TOKEN_TTL_MS = 5 * 60 * 1000;
// Attestation challenges and the pairing-room tickets they yield are both
// short-lived and single-use; the challenge cap keeps issuance from being a
// storage-fill vector.
const ATTEST_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TICKET_TTL_MS = 5 * 60 * 1000;
const MAX_OUTSTANDING_CHALLENGES = 16;

// --- Hardening / quotas (availability + cost; the relay sees only ciphertext) ---
// (1) Pre-auth loitering: a socket that connects but never admits holds a
//     hibernatable WebSocket. Cap how many may be outstanding at once (drop the
//     oldest) and close any that do not admit within the deadline.
const MAX_PREAUTH_SOCKETS = 4;
const PREAUTH_DEADLINE_MS = 15 * 1000;
// (2) Admission flood: an attacker who knows the room name can churn
//     connect -> proof -> reject, forcing signature verifies. Cap proof
//     attempts per room per window (in-memory; resets on hibernation, which
//     only happens when the room is idle, i.e. not under attack).
const ADMISSION_WINDOW_MS = 10 * 1000;
const MAX_ADMISSION_ATTEMPTS = 40;
// (3) Splice abuse: cap spliced frame size and rate. Noise transport messages
//     are <= 65535 bytes; control frames (hello/proof) are tiny.
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_CONTROL_BYTES = 8 * 1024;
const FRAME_WINDOW_MS = 1000;
const MAX_FRAMES_PER_WINDOW = 500;
// (5) Pipe abuse / cost: cap relayed bytes per room per rolling 24h. The relay
//     only sees ciphertext, so this bounds throughput regardless of content.
//     Persisted (survives hibernation), flushed every QUOTA_FLUSH_BYTES to keep
//     per-frame storage writes out of the hot path. Override with the
//     RELAY_DAILY_BYTE_QUOTA env var.
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_BYTE_QUOTA = 512 * 1024 * 1024;
const QUOTA_FLUSH_BYTES = 4 * 1024 * 1024;
// (1)+(4) Housekeeping alarm cadence, and how long a never-established room may
//     sit idle before its leftover state is reclaimed.
const HOUSEKEEPING_INTERVAL_MS = 15 * 1000;
const EPHEMERAL_PREFIXES = ["ticket:", "regtoken:", "attestchallenge:"];

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A short, opaque, non-reversible log tag for a room. The room name is itself a
// rendezvous secret (knowing it lets an attacker target the room for DoS), so
// logs identify a room by hash(roomName), enough to correlate events without
// leaking the name. Computed once per connection and carried in the socket
// attachment so the synchronous log sites can read it.
async function roomTag(roomName) {
  if (!roomName) return "????????";
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(roomName)));
  return [...h.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function tagOf(att) {
  return (att && att.tag) || "????????";
}

// Fail closed: only an explicit "false" disables attestation. Unset, empty,
// or any other value means required (the hosted posture). Exported for a
// direct unit test of the fail-closed logic.
export function attestationRequired(env) {
  return env.ATTEST_REQUIRED !== "false";
}

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64ToBytes(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Unambiguous, domain-separated encoding, byte-identical to Swift's
// CanonicalEncoding.encode: len32be(domain) || domain || for each field
// len32be(field) || field. A leading domain string plus per-element 4-byte
// big-endian length prefixes make distinct field tuples impossible to confuse.
// `fields` are Uint8Array; `domain` is a string.
function canonicalEncode(domain, fields) {
  const elems = [new TextEncoder().encode(domain), ...fields];
  let total = 0;
  for (const e of elems) total += 4 + e.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const e of elems) {
    out[o++] = (e.length >>> 24) & 0xff;
    out[o++] = (e.length >>> 16) & 0xff;
    out[o++] = (e.length >>> 8) & 0xff;
    out[o++] = e.length & 0xff;
    out.set(e, o);
    o += e.length;
  }
  return out;
}

// The bytes a join signs, identical to Swift's RelayJoin.transcript:
// canonical("iterm2-relay-join", [roleByte, nonce, roomName, origin]).
function joinTranscript(role, nonceB64, roomName, origin) {
  const enc = new TextEncoder();
  return canonicalEncode("iterm2-relay-join", [
    new Uint8Array([ROLE_BYTE[role]]),
    b64ToBytes(nonceB64),
    enc.encode(roomName),
    enc.encode(origin),
  ]);
}

async function verifyJoin(sigB64, transcriptBytes, verifierB64) {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      b64ToBytes(verifierB64),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, key, b64ToBytes(sigB64), transcriptBytes);
  } catch {
    return false;
  }
}

// (4) The bytes a room-deletion request signs. The distinct "delete" domain
// (vs "join") means a captured join signature can never be replayed to
// authorize a deletion. Bound to a fresh single-use challenge (anti-replay),
// the room name, and the origin.
function deleteTranscript(challengeB64, roomName, origin) {
  const enc = new TextEncoder();
  return canonicalEncode("iterm2-relay-delete", [
    b64ToBytes(challengeB64),
    enc.encode(roomName),
    enc.encode(origin),
  ]);
}

function safeAttachment(ws) {
  try {
    return ws.deserializeAttachment();
  } catch {
    return null;
  }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // In-memory fixed-window rate counters (per live DO instance). Lost on
    // hibernation, which only occurs when the room is idle, so a flood (which
    // keeps the DO live) is still bounded.
    this.admissionWindow = { start: 0, count: 0 };
    this.frameWindow = { start: 0, count: 0 };
    // Per-room daily byte quota, loaded lazily from storage on first relayed
    // frame. quotaFlushedBytes tracks the last value written to storage.
    this.quota = null;
    this.quotaFlushedBytes = 0;
  }

  // Diagnostic logging is OFF by default: production retains and emits nothing
  // (no log retention, no personal data, for GDPR comfort). Set the RELAY_LOG
  // env var to "true" to stream these lines to `wrangler tail` while debugging;
  // even then nothing is retained, observability is disabled.
  dlog(...args) {
    if (this.env.RELAY_LOG === "true") {
      console.log(...args);
    }
  }

  // (5) Per-room daily byte quota. Accumulates relayed bytes; once the room has
  // relayed more than the quota within the current 24h window it tears the room
  // down (closes every socket) and returns true. The window rolls every 24h.
  async overQuota(att, size) {
    const now = Date.now();
    const limit = parseInt(this.env.RELAY_DAILY_BYTE_QUOTA, 10) || DEFAULT_DAILY_BYTE_QUOTA;
    if (this.quota === null) {
      this.quota = (await this.ctx.storage.get("quota")) || { dayStart: now, bytes: 0 };
      this.quotaFlushedBytes = this.quota.bytes;
    }
    if (now - this.quota.dayStart >= QUOTA_WINDOW_MS) {
      this.quota = { dayStart: now, bytes: 0 };
      this.quotaFlushedBytes = 0;
      await this.ctx.storage.put("quota", this.quota);
    }
    this.quota.bytes += size;
    if (this.quota.bytes > limit) {
      await this.ctx.storage.put("quota", this.quota);
      this.dlog(`relay ${tagOf(att)} daily byte quota exceeded (${this.quota.bytes} > ${limit}); closing room`);
      for (const sock of this.ctx.getWebSockets()) {
        try { sock.close(1008, "daily quota exceeded"); } catch { /* ignore */ }
      }
      return true;
    }
    if (this.quota.bytes - this.quotaFlushedBytes >= QUOTA_FLUSH_BYTES) {
      this.quotaFlushedBytes = this.quota.bytes;
      await this.ctx.storage.put("quota", this.quota);
    }
    return false;
  }

  // Fixed-window limiter: bumps the window's count and reports whether it now
  // exceeds max. Resets the window after windowMs.
  rateLimited(window, max, windowMs) {
    const now = Date.now();
    if (now - window.start > windowMs) {
      window.start = now;
      window.count = 0;
    }
    window.count += 1;
    return window.count > max;
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      const url = new URL(request.url);
      const res = await this.handleHttp(request, url);
      // One explicit line per HTTP request (auto invocation logs are off), so
      // /attest and /register stay visible. Identified by the opaque room tag.
      const tag = await roomTag(request.headers.get("x-relay-room"));
      this.dlog(`relay ${tag} ${request.method} ${url.pathname} -> ${res.status}`);
      return res;
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    // Capture the room name (validated by the entry Worker) so admission can
    // build the join transcript; it's bound into the signature. Also derive a
    // short log tag = hash(roomName): the room name is itself a rendezvous
    // secret (knowing it lets an attacker target the room), so logs correlate
    // by an opaque, non-reversible tag instead of leaking the name.
    const roomName = request.headers.get("x-relay-room");
    const tag = await roomTag(roomName);
    server.serializeAttachment({ state: "hello", roomName, tag, connectedAt: Date.now() });
    // (1) Bound simultaneous un-admitted sockets, and arm the deadline sweep.
    this.evictExcessPreAuth(tag);
    await this.ensureAlarm();
    this.dlog(`relay ${tag} connect`);
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleHttp(request, url) {
    if (request.method === "POST" && url.pathname === "/register") {
      return this.handleRegister(request);
    }
    if (request.method === "POST" && url.pathname === "/attest/challenge") {
      return this.handleAttestChallenge();
    }
    if (request.method === "POST" && url.pathname === "/attest") {
      return this.handleAttest(request);
    }
    if (request.method === "POST" && url.pathname === "/delete") {
      return this.handleDelete(request);
    }
    return new Response("not implemented", { status: 501 });
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment() || { state: "hello" };
    // (3) Cap frame size: huge frames (control or spliced) are abuse. Noise
    //     transport messages are <= 65535 bytes; control frames are tiny.
    const size = typeof message === "string" ? message.length : message.byteLength;
    const cap = att.state === "admitted" ? MAX_FRAME_BYTES : MAX_CONTROL_BYTES;
    if (size > cap) {
      this.dlog(`relay ${tagOf(att)} frame too large (${size} > ${cap}); closing`);
      try { ws.close(1009, "frame too large"); } catch { /* ignore */ }
      return;
    }
    switch (att.state) {
      case "hello":
        return this.handleHello(ws, att, message);
      case "challenged":
        return this.handleProof(ws, att, message);
      case "admitted":
        // (3) Cap spliced frame rate per room.
        if (this.rateLimited(this.frameWindow, MAX_FRAMES_PER_WINDOW, FRAME_WINDOW_MS)) {
          this.dlog(`relay ${tagOf(att)} frame rate exceeded; closing`);
          try { ws.close(1008, "frame rate exceeded"); } catch { /* ignore */ }
          return;
        }
        // (5) Cap relayed bytes per room per day; overQuota tears the room down.
        if (await this.overQuota(att, size)) {
          return;
        }
        return this.forward(ws, att, message);
      default:
        ws.close(1011, "bad state");
    }
  }

  handleHello(ws, att, message) {
    let hello;
    try {
      hello = JSON.parse(message);
    } catch {
      return ws.close(1008, "bad hello");
    }
    if (hello.v !== PROTOCOL_VERSION || (hello.role !== "mac" && hello.role !== "phone")) {
      return ws.close(1008, "bad hello");
    }
    // Uniform first response: always a fresh nonce, regardless of admission
    // mode, so a connector cannot probe the room's state.
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    ws.serializeAttachment({
      state: "challenged",
      role: hello.role,
      nonce: b64(nonce),
      roomName: att.roomName,
      tag: att.tag,
    });
    this.dlog(`relay ${tagOf(att)} hello role=${hello.role} -> challenged`);
    ws.send(JSON.stringify({ nonce: b64(nonce) }));
  }

  async handleProof(ws, att, message) {
    // (2) Rate-limit proof attempts per room BEFORE any signature verify, so a
    //     flood of bogus proofs cannot force unbounded crypto work.
    if (this.rateLimited(this.admissionWindow, MAX_ADMISSION_ATTEMPTS, ADMISSION_WINDOW_MS)) {
      return this.reject(ws, "rate limited");
    }
    let proof;
    try {
      proof = JSON.parse(message);
    } catch {
      return this.reject(ws, "bad proof");
    }

    // Established room: a verifier is registered, so a join must sign the
    // bound transcript. Holds in every mode.
    const verifier = await this.ctx.storage.get("verifier");
    if (verifier) {
      if (typeof proof.sig !== "string") {
        return this.reject(ws, "signature required");
      }
      const transcript = joinTranscript(att.role, att.nonce, att.roomName, this.env.RELAY_ORIGIN);
      if (!(await verifyJoin(proof.sig, transcript, verifier))) {
        return this.reject(ws, "bad signature");
      }
      return this.admit(ws, att.role, null, "signed");
    }

    if (attestationRequired(this.env)) {
      // Pairing mode under attestation. The mac cannot attest (no App Attest off
      // the Mac App Store), so it parks pre-auth; its legitimacy is the Noise
      // handshake (it alone holds the static private key the phone pinned from
      // the QR). The phone must present a valid, single-use ticket it earned by
      // attesting over /attest.
      if (att.role === "mac") {
        return this.admit(ws, att.role, null, "park(pre-auth mac)");
      }
      if (typeof proof.ticket !== "string") {
        return this.reject(ws, "ticket required");
      }
      const ticketKey = `ticket:${proof.ticket}`;
      const ticketRec = await this.ctx.storage.get(ticketKey);
      if (!ticketRec || ticketRec.expiresAt < Date.now()) {
        return this.reject(ws, "bad ticket");
      }
      await this.ctx.storage.delete(ticketKey); // single-use
      return this.admit(ws, att.role, { keyId: ticketRec.keyId, publicKey: ticketRec.publicKey }, "ticket");
    }
    // Open-mode pairing: admit on connect (the documented degradation; bounded
    // by the per-park cycle cap and SAS confirmation, added later).
    return this.admit(ws, att.role, null, "open");
  }

  async admit(ws, role, attest = null, via = "?") {
    const prev = ws.deserializeAttachment() || {};
    // A phone may only join while a mac is parked. Otherwise its Noise
    // handshake would be sent into an empty room and silently dropped, and it
    // would sit on a handshake timeout. Reject instead, so the phone retries
    // cheaply until the mac is present (e.g. while the mac app relaunches) and
    // lands within one retry of the mac parking. The mac itself parks anytime.
    if (role === "phone") {
      const macParked = this.ctx.getWebSockets().some((s) => {
        if (s === ws) return false;
        const a = s.deserializeAttachment();
        return a && a.state === "admitted" && a.role === "mac";
      });
      if (!macParked) {
        return this.reject(ws, "mac offline");
      }
    }
    // Two slots, newest-wins: displace any current holder of this role. Do NOT
    // close that holder's peer here: during a mac restart the phone retries its
    // handshake every few seconds (each retry a new phone socket that displaces
    // the prior one), and closing the peer would kill the freshly parked mac on
    // every retry, livelocking reconnect. A stale mac (e.g. after a phone-side
    // network hiccup) is instead torn down when the reconnecting phone's
    // handshake reaches it and fails to decrypt, after which the mac re-parks
    // and the phone's next retry lands. A cleanly closed socket is still handled
    // by webSocketClose -> closePeerOf.
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const a = other.deserializeAttachment();
      if (a && a.state === "admitted" && a.role === role) {
        this.dlog(`relay ${tagOf(prev)} displacing existing ${role}`);
        other.close(1000, "displaced");
      }
    }
    // Preserve roomName/tag across the state change so forwarding/close logging
    // can still identify the room.
    ws.serializeAttachment({ state: "admitted", role, roomName: prev.roomName, tag: prev.tag });
    const peerPresent = this.ctx.getWebSockets().some((s) => {
      if (s === ws) return false;
      const a = s.deserializeAttachment();
      return a && a.state === "admitted" && a.role !== role;
    });
    this.dlog(`relay ${tagOf(prev)} admit role=${role} via=${via} peer=${peerPresent}`
      + (peerPresent ? " (spliced)" : ""));
    const result = { ok: true };
    if (role === "phone") {
      // Mint a one-time registration token the phone presents to /register to
      // register its verifier. Bound to this room (it lives in this DO's
      // storage) and short-lived.
      const token = b64(crypto.getRandomValues(new Uint8Array(24)));
      const rec = { expiresAt: Date.now() + REG_TOKEN_TTL_MS };
      // Carry the attested key id so first registration can pin it (the phone
      // earned the ticket by attesting; the registration inherits that identity).
      if (attest) {
        rec.attestKeyId = attest.keyId;
        rec.attestPublicKey = attest.publicKey;
      }
      await this.ctx.storage.put(`regtoken:${token}`, rec);
      await this.ensureAlarm(); // (4) so the token is pruned if never used
      result.registrationToken = token;
    }
    ws.send(JSON.stringify(result));
  }

  // Issue a single-use attestation challenge (App Attest needs a server nonce
  // to bind the clientDataHash). Capped + TTL'd so issuance isn't a storage
  // fill vector. No attestation needed to ASK for a challenge.
  async handleAttestChallenge() {
    const now = Date.now();
    let live = 0;
    for (const [key, rec] of await this.ctx.storage.list({ prefix: "attestchallenge:" })) {
      if (rec.expiresAt < now) {
        await this.ctx.storage.delete(key);
      } else {
        live += 1;
      }
    }
    if (live >= MAX_OUTSTANDING_CHALLENGES) {
      return json(429, { ok: false, error: "too many outstanding challenges" });
    }
    const challenge = b64(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
    await this.ctx.storage.put(`attestchallenge:${challenge}`, { expiresAt: now + ATTEST_CHALLENGE_TTL_MS });
    await this.ensureAlarm(); // (4) so an unused challenge is pruned, not left to the cap
    return json(200, { ok: true, challenge });
  }

  // Verify an App Attest attestation over a previously issued challenge and, on
  // success, mint a single-use pairing-room ticket bound to the attested key id
  // (and to this room, since it lives in this DO). The phone presents the ticket
  // in its WebSocket Proof to take the phone slot.
  async handleAttest(request) {
    if (!attestationRequired(this.env)) {
      return json(400, { ok: false, error: "attestation disabled" });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { ok: false, error: "bad json" });
    }
    const { challenge, attestationObject } = body;
    if (typeof challenge !== "string" || typeof attestationObject !== "string") {
      return json(400, { ok: false, error: "missing fields" });
    }
    const challengeKey = `attestchallenge:${challenge}`;
    const challengeRec = await this.ctx.storage.get(challengeKey);
    if (!challengeRec || challengeRec.expiresAt < Date.now()) {
      return json(403, { ok: false, error: "bad challenge" });
    }
    await this.ctx.storage.delete(challengeKey); // single-use

    // clientDataHash = SHA256(canonical("iterm2-relay-attest",
    // [challengeBytes, origin])), the same value the phone attested over. Origin
    // binding stops a hostile relay from proxying a genuine challenge from the
    // official relay.
    const origin = this.env.RELAY_ORIGIN;
    const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256",
      canonicalEncode("iterm2-relay-attest",
        [b64ToBytes(challenge), new TextEncoder().encode(origin)])));

    let attested;
    try {
      attested = await verifyAttestation({
        attestationObject: b64ToBytes(attestationObject),
        clientDataHash,
        appId: this.env.APP_ID,
        environment: this.env.APPATTEST_ENV,
        trustedRootPem: this.env.APPATTEST_ROOT_PEM || APPLE_APP_ATTEST_ROOT_PEM,
      });
    } catch (e) {
      // Log the specific reason (chain, nonce, AAGUID/environment, app id) so
      // `wrangler tail` reveals which check failed during device testing. The
      // body stays generic, since the client cannot act on the detail. The
      // attestation is opaque to the relay, so the message leaks nothing.
      this.dlog("attest rejected:", e?.message);
      return json(403, { ok: false, error: "attestation rejected" });
    }

    const ticket = b64(crypto.getRandomValues(new Uint8Array(24)));
    await this.ctx.storage.put(`ticket:${ticket}`, {
      expiresAt: Date.now() + TICKET_TTL_MS,
      keyId: b64(attested.keyId),
      publicKey: b64(attested.publicKeyRaw),
    });
    await this.ensureAlarm(); // (4) so an unredeemed ticket is pruned
    return json(200, { ok: true, ticket });
  }

  async handleRegister(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { ok: false, error: "bad json" });
    }
    const { registrationToken, verifier } = body;
    if (typeof verifier !== "string") {
      return json(400, { ok: false, error: "missing verifier" });
    }
    // Overwrite protection: once a verifier is registered, it can only be
    // changed by proving the current key (a later slice). A second
    // first-registration is refused, so a room-name holder cannot hijack V.
    if (await this.ctx.storage.get("verifier")) {
      return json(403, { ok: false, error: "already registered" });
    }
    if (typeof registrationToken !== "string") {
      return json(403, { ok: false, error: "token required" });
    }
    const key = `regtoken:${registrationToken}`;
    const rec = await this.ctx.storage.get(key);
    if (!rec || rec.expiresAt < Date.now()) {
      return json(403, { ok: false, error: "bad token" });
    }

    // Under attestation, registration must ALSO prove CURRENT possession of the
    // attested key with an assertion over a fresh challenge (the token alone
    // proves attestation happened at admission; the assertion proves it again,
    // now, and is replay-bound by the single-use challenge and a strictly
    // increasing counter). The attested key id is pinned as the registrant.
    if (attestationRequired(this.env)) {
      if (!rec.attestKeyId || !rec.attestPublicKey) {
        return json(403, { ok: false, error: "token not attested" });
      }
      if (typeof body.challenge !== "string" || typeof body.assertion !== "string") {
        return json(403, { ok: false, error: "assertion required" });
      }
      const challengeKey = `attestchallenge:${body.challenge}`;
      const challengeRec = await this.ctx.storage.get(challengeKey);
      if (!challengeRec || challengeRec.expiresAt < Date.now()) {
        return json(403, { ok: false, error: "bad challenge" });
      }
      await this.ctx.storage.delete(challengeKey); // single-use
      const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256",
        canonicalEncode("iterm2-relay-attest",
          [b64ToBytes(body.challenge), new TextEncoder().encode(this.env.RELAY_ORIGIN)])));
      let asserted;
      try {
        asserted = await verifyAssertion({
          assertion: b64ToBytes(body.assertion),
          clientDataHash,
          publicKeyRaw: b64ToBytes(rec.attestPublicKey),
          appId: this.env.APP_ID,
        });
      } catch {
        return json(403, { ok: false, error: "assertion rejected" });
      }
      const counterKey = `assertcounter:${rec.attestKeyId}`;
      const lastCounter = await this.ctx.storage.get(counterKey);
      if (lastCounter !== undefined && asserted.counter <= lastCounter) {
        return json(403, { ok: false, error: "stale assertion" });
      }
      await this.ctx.storage.put(counterKey, asserted.counter);
      await this.ctx.storage.put("registrantKeyId", rec.attestKeyId);
    }

    await this.ctx.storage.delete(key); // single-use
    await this.ctx.storage.put("verifier", verifier);
    return json(200, { ok: true });
  }

  // (4) Signed room deletion / revocation. Proves possession of the room key by
  // signing a delete transcript over a fresh single-use challenge, then wipes
  // all state and disconnects both sides. Only an established room (a verifier
  // exists) can be deleted; an un-established room has no key to authorize with.
  async handleDelete(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { ok: false, error: "bad json" });
    }
    const verifier = await this.ctx.storage.get("verifier");
    if (!verifier) return json(403, { ok: false, error: "not established" });
    if (typeof body.challenge !== "string" || typeof body.signature !== "string") {
      return json(403, { ok: false, error: "signature required" });
    }
    const challengeKey = `attestchallenge:${body.challenge}`;
    const challengeRec = await this.ctx.storage.get(challengeKey);
    if (!challengeRec || challengeRec.expiresAt < Date.now()) {
      return json(403, { ok: false, error: "bad challenge" });
    }
    await this.ctx.storage.delete(challengeKey); // single-use
    const roomName = request.headers.get("x-relay-room");
    const transcript = deleteTranscript(body.challenge, roomName, this.env.RELAY_ORIGIN);
    if (!(await verifyJoin(body.signature, transcript, verifier))) {
      return json(403, { ok: false, error: "bad signature" });
    }
    this.dlog(`relay ${await roomTag(roomName)} DELETE authorized; wiping room`);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "room deleted");
      } catch {
        // ignore
      }
    }
    await this.ctx.storage.deleteAll();
    return json(200, { ok: true });
  }

  // (1) Drop the oldest un-admitted sockets over the cap, so a loiterer flood
  // cannot pin unbounded pre-auth sockets.
  evictExcessPreAuth(tag) {
    const preAuth = this.ctx.getWebSockets()
      .map((ws) => ({ ws, a: safeAttachment(ws) }))
      .filter(({ a }) => a && a.state !== "admitted")
      .sort((x, y) => (x.a.connectedAt || 0) - (y.a.connectedAt || 0));
    for (let i = 0; i < preAuth.length - MAX_PREAUTH_SOCKETS; i++) {
      this.dlog(`relay ${tag} evicting oldest pre-auth socket (cap ${MAX_PREAUTH_SOCKETS})`);
      try {
        preAuth[i].ws.close(1008, "too many pending");
      } catch {
        // ignore
      }
    }
  }

  // Arm the housekeeping alarm if one is not already pending.
  async ensureAlarm() {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + HOUSEKEEPING_INTERVAL_MS);
    }
  }

  // Housekeeping: (1) close pre-auth sockets past the admission deadline, and
  // (4) prune expired ephemeral state. Reschedules only while there is
  // something left to watch, so an idle/established room lets the DO hibernate.
  async alarm() {
    const now = Date.now();
    let pendingPreAuth = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const a = safeAttachment(ws);
      if (!a || a.state === "admitted") continue;
      if (a.connectedAt && now - a.connectedAt > PREAUTH_DEADLINE_MS) {
        this.dlog(`relay ${tagOf(a)} pre-auth socket timed out; closing`);
        try {
          ws.close(1008, "admission timeout");
        } catch {
          // ignore
        }
      } else {
        pendingPreAuth += 1;
      }
    }
    const remainingEphemeral = await this.pruneExpired(now);
    if (pendingPreAuth > 0 || remainingEphemeral > 0) {
      await this.ctx.storage.setAlarm(now + HOUSEKEEPING_INTERVAL_MS);
    }
  }

  // Delete expired single-use ephemeral records (tickets, registration tokens,
  // attest challenges). Returns the count of still-live ephemeral records, so a
  // never-established room is reclaimed (storage emptied, alarm lapses, DO goes
  // dormant) once its leftovers age out. The verifier is intentionally NOT
  // touched: an established room must survive idle periods to reconnect.
  async pruneExpired(now) {
    let live = 0;
    for (const prefix of EPHEMERAL_PREFIXES) {
      for (const [k, rec] of await this.ctx.storage.list({ prefix })) {
        if (rec && typeof rec.expiresAt === "number" && rec.expiresAt < now) {
          await this.ctx.storage.delete(k);
        } else {
          live += 1;
        }
      }
    }
    return live;
  }

  reject(ws, error) {
    let att;
    try {
      att = ws.deserializeAttachment();
    } catch {
      // ignore
    }
    this.dlog(`relay ${tagOf(att)} reject role=${att?.role ?? "?"}: ${error}`);
    try {
      ws.send(JSON.stringify({ ok: false, error }));
    } catch {
      // ignore
    }
    ws.close(1008, error);
  }

  forward(ws, att, message) {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      const a = peer.deserializeAttachment();
      if (a && a.state === "admitted" && a.role !== att.role) {
        peer.send(message);
        return;
      }
    }
    // No peer yet (pre-splice): drop silently, do not error the socket.
  }

  async webSocketClose(ws, code, reason) {
    let att;
    try { att = ws.deserializeAttachment(); } catch { /* ignore */ }
    this.dlog(`relay ${tagOf(att)} close role=${att?.role ?? "?"} state=${att?.state ?? "?"} `
      + `code=${code ?? "?"}${reason ? ` reason=${reason}` : ""}`);
    this.closePeerOf(ws);
  }

  async webSocketError(ws) {
    let att;
    try { att = ws.deserializeAttachment(); } catch { /* ignore */ }
    this.dlog(`relay ${tagOf(att)} socket error role=${att?.role ?? "?"} state=${att?.state ?? "?"}`);
    this.closePeerOf(ws);
  }

  // When one admitted side goes away, close the other so it learns the peer is
  // gone instead of waiting forever (its own link to the relay stays healthy).
  // This is what lets the mac notice a disconnect and re-park for a reconnect.
  closePeerOf(ws) {
    let att;
    try {
      att = ws.deserializeAttachment();
    } catch {
      return;
    }
    if (!att || att.state !== "admitted") {
      return;
    }
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      const a = peer.deserializeAttachment();
      if (a && a.state === "admitted" && a.role !== att.role) {
        this.dlog(`relay ${tagOf(att)} peer gone (role=${att.role}); closing ${a.role}`);
        try {
          peer.close(1001, "peer gone");
        } catch {
          // ignore
        }
      }
    }
  }
}
