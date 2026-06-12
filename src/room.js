// The Room Durable Object: one per pairing pseudonym. Admits a Mac and a phone
// (two slots), splices their WebSockets, enforces quotas, and never reads the
// ciphertext flowing between them. See ../../docs/companion-relay-design.md.
//
// Stub: filled in test-first.

import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
  async fetch(request) {
    return new Response("not implemented", { status: 501 });
  }
}
