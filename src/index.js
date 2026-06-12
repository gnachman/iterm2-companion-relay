// iTerm2 Companion room relay: entry Worker.
//
// Pre-DO gating lives here (the cheap checks that run before idFromName, so a
// garbage request never instantiates a Durable Object): room-name header
// validation and Origin-header rejection. Everything stateful (admission,
// splice, quotas, tickets) lives in the Room DO. See
// ../../docs/companion-relay-design.md.

export { Room } from "./room.js";

// Room name = lowercase hex SHA-256, exactly 64 chars. Validated before
// idFromName so malformed names never reach DO storage or cardinality.
const ROOM_NAME_RE = /^[0-9a-f]{64}$/;
const ROOM_HEADER = "x-relay-room";

export default {
  async fetch(request, env) {
    // Browsers attach Origin to cross-origin requests (and to all WS
    // upgrades); native clients send none. Reject any request carrying one,
    // removing the in-browser botnet surface at zero cost.
    if (request.headers.get("Origin") !== null) {
      return new Response("forbidden", { status: 403 });
    }

    const room = request.headers.get(ROOM_HEADER);
    if (!room || !ROOM_NAME_RE.test(room)) {
      return new Response("bad room", { status: 400 });
    }

    const id = env.ROOM.idFromName(room);
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  },
};
