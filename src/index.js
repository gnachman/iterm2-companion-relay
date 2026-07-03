// Shared entry gate for the relay: the cheap, stateless checks that run before
// a request may reach a room (room-name validation, Origin-header rejection).
// The self-hosted host (host/server.js) applies these ahead of routing to a
// room; everything stateful (admission, splice, quotas, tickets) lives in the
// Room (src/room.js). See ../../docs/companion-relay-design.md.

export { Room } from "./room.js";

// Room name = lowercase hex SHA-256, exactly 64 chars. Validated before a
// request may reach a room so malformed names never touch storage or
// cardinality.
export const ROOM_NAME_RE = /^[0-9a-f]{64}$/;
export const ROOM_HEADER = "x-relay-room";

// Returns null when the request may proceed, or a { status, message } rejection.
// `headers` is a Fetch Headers instance.
export function entryReject(headers) {
  // Browsers attach Origin to cross-origin requests (and to all WS upgrades);
  // native clients send none. Reject any request carrying one, removing the
  // in-browser botnet surface at zero cost.
  if (headers.get("Origin") !== null) {
    return { status: 403, message: "forbidden" };
  }
  const room = headers.get(ROOM_HEADER);
  if (!room || !ROOM_NAME_RE.test(room)) {
    return { status: 400, message: "bad room" };
  }
  return null;
}
