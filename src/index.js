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

    // Per-IP caps on the two abuse vectors, BEFORE idFromName so a flood never
    // instantiates a Durable Object or runs the expensive attestation crypto.
    if (await overIpLimit(request, env)) {
      return new Response("rate limited", { status: 429 });
    }

    const id = env.ROOM.idFromName(room);
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  },
};

// True when the request is over its per-IP cap. Two categories, each its own
// limiter: attestation (/attest*) is the most expensive code (CBOR + App Attest
// crypto verify) so it gets the tighter cap; the WebSocket upgrade is the
// connection-flood vector and shares path "/" with the website host, so this
// in-Worker cap is the only thing that can bound it (a zone WAF path rule
// cannot, without also throttling the site). Other paths (/register, /delete)
// are already gated by single-use tokens / signatures, so they are not capped
// here. The client IP is used ONLY as the limiter key, never logged or stored;
// the bindings are optional so a deployment without them still serves.
async function overIpLimit(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (new URL(request.url).pathname.startsWith("/attest")) {
    return env.ATTEST_LIMITER ? !(await env.ATTEST_LIMITER.limit({ key: ip })).success : false;
  }
  if (request.headers.get("Upgrade") === "websocket") {
    return env.WS_LIMITER ? !(await env.WS_LIMITER.limit({ key: ip })).success : false;
  }
  return false;
}
