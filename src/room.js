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

const PROTOCOL_VERSION = 1;
const NONCE_BYTES = 32;
const ROLE_BYTE = { mac: 1, phone: 2 };
// A registration token lives only long enough for the phone to make its
// follow-up /register call within the same confirmed session.
const REG_TOKEN_TTL_MS = 5 * 60 * 1000;

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
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

// The bytes a join signs, identical to Swift's RelayJoin.transcript:
// [version, roleByte] || nonce || roomName(utf8) || origin(utf8).
function joinTranscript(role, nonceB64, roomName, origin) {
  const nonce = b64ToBytes(nonceB64);
  const enc = new TextEncoder();
  const head = new Uint8Array([PROTOCOL_VERSION, ROLE_BYTE[role]]);
  const parts = [head, nonce, enc.encode(roomName), enc.encode(origin)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
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

export class Room extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/register") {
        return this.handleRegister(request);
      }
      // attest, delete are added in later slices.
      return new Response("not implemented", { status: 501 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    // Capture the room name (validated by the entry Worker) so admission can
    // build the join transcript; it's bound into the signature.
    server.serializeAttachment({ state: "hello", roomName: request.headers.get("x-relay-room") });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment() || { state: "hello" };
    switch (att.state) {
      case "hello":
        return this.handleHello(ws, att, message);
      case "challenged":
        return this.handleProof(ws, att, message);
      case "admitted":
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
    });
    ws.send(JSON.stringify({ nonce: b64(nonce) }));
  }

  async handleProof(ws, att, message) {
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
      return this.admit(ws, att.role);
    }

    if (attestationRequired(this.env)) {
      // Pairing ticket verification arrives in a later slice.
      return this.reject(ws, "attestation required");
    }
    // Open-mode pairing: admit on connect (the documented degradation; bounded
    // by the per-park cycle cap and SAS confirmation, added later).
    return this.admit(ws, att.role);
  }

  async admit(ws, role) {
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
        other.close(1000, "displaced");
      }
    }
    ws.serializeAttachment({ state: "admitted", role });
    const result = { ok: true };
    if (role === "phone") {
      // Mint a one-time registration token the phone presents to /register to
      // register its verifier. Bound to this room (it lives in this DO's
      // storage) and short-lived.
      const token = b64(crypto.getRandomValues(new Uint8Array(24)));
      await this.ctx.storage.put(`regtoken:${token}`, { expiresAt: Date.now() + REG_TOKEN_TTL_MS });
      result.registrationToken = token;
    }
    ws.send(JSON.stringify(result));
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
    await this.ctx.storage.delete(key); // single-use
    await this.ctx.storage.put("verifier", verifier);
    return json(200, { ok: true });
  }

  reject(ws, error) {
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

  async webSocketClose(ws) {
    this.closePeerOf(ws);
  }

  async webSocketError(ws) {
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
        try {
          peer.close(1001, "peer gone");
        } catch {
          // ignore
        }
      }
    }
  }
}
