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

export class Room extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      // HTTP endpoints (attest, register, delete) are added in later slices.
      return new Response("not implemented", { status: 501 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ state: "hello" });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const att = ws.deserializeAttachment() || { state: "hello" };
    switch (att.state) {
      case "hello":
        return this.handleHello(ws, message);
      case "challenged":
        return this.handleProof(ws, att, message);
      case "admitted":
        return this.forward(ws, att, message);
      default:
        ws.close(1011, "bad state");
    }
  }

  handleHello(ws, message) {
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
    ws.serializeAttachment({ state: "challenged", role: hello.role, nonce: b64(nonce) });
    ws.send(JSON.stringify({ nonce: b64(nonce) }));
  }

  handleProof(ws, att, message) {
    let proof;
    try {
      proof = JSON.parse(message);
    } catch {
      return this.reject(ws, "bad proof");
    }
    if (attestationRequired(this.env)) {
      // Ticket / signature verification arrives in later slices.
      return this.reject(ws, "attestation required");
    }
    // Open mode: admit on connect (the design's documented degradation; bounded
    // by the per-park cycle cap and SAS confirmation, added later).
    this.admit(ws, att.role);
  }

  admit(ws, role) {
    // Two slots, newest-wins: displace any current holder of this role.
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const a = other.deserializeAttachment();
      if (a && a.state === "admitted" && a.role === role) {
        other.close(1000, "displaced");
      }
    }
    ws.serializeAttachment({ state: "admitted", role });
    ws.send(JSON.stringify({ ok: true }));
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
    // Nothing to persist yet; slot is freed by the socket going away.
  }
}
