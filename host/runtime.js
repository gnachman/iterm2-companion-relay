// The runtime shim that replaces the Cloudflare Durable Object platform for a
// single self-hosted process. It provides:
//
//   - DurableObject: the base class Room extends (just holds ctx + env).
//   - RoomContext: the per-room `this.ctx` — storage, the live socket set,
//     acceptWebSocket() wiring, and the alarm timer that fires room.alarm().
//   - Runtime: the registry that maps room name -> live RoomContext, rehydrates
//     persisted alarms on boot, and evicts idle rooms to bound memory.
//
// On Cloudflare each room was its own Durable Object, sharded across the edge,
// hibernated when idle, and woken by the platform to run its alarm. Here one
// process owns every room; an idle socket costs only a file descriptor, so
// there is no hibernation — a parked Mac just stays connected. The one thing
// the platform did for free that a single process must do explicitly is bound
// room cardinality: a room with no sockets and no pending alarm holds nothing
// worth keeping in memory, so it is evicted (its persisted state stays in
// SQLite and is rehydrated on next access).

// setTimeout stores its delay in a signed 32-bit int; a larger delay is clamped
// to 1 ms (and warns), so long waits must be chunked. ~24.9 days.
const MAX_DELAY = 2 ** 31 - 1;

// After an alarm() that throws, re-arm this soon so housekeeping self-heals
// (the Durable Object platform retried failed alarms).
export const ALARM_RETRY_MS = 30 * 1000;

// Base class for Room. The Cloudflare `DurableObject` stored ctx/env the same
// way; keeping the shape means room.js only swaps its import.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

// One live room: the object Room sees as `this.ctx`.
class RoomContext {
  constructor(runtime, roomName) {
    this.runtime = runtime;
    this.roomName = roomName;
    this.storage = runtime.backend.forRoom(roomName);
    // Room calls ctx.storage.setAlarm/deleteAlarm; route those through to the
    // timer so persistence and scheduling stay in lockstep, exactly as the
    // Durable Object platform coupled them.
    this.storage.onAlarmChange = (at) => this._reschedule(at);
    this._sockets = new Set();
    this._timer = null;
    this._alarmAt = null;
    // In-flight operation count. A single process (unlike the platform-managed
    // Durable Object singleton) can evict a shared idle context mid-await — from
    // a concurrent request's cleanup or the room's own alarm — leaving the
    // running op on an out-of-registry context while the next get() builds a
    // second live context for the same name (split brain). Pinning during
    // fetch/handleUpgrade forbids eviction until the op completes.
    this._pending = 0;
    // Room extends DurableObject(ctx, env); `this` is the ctx.
    this.instance = new runtime.RoomClass(this, runtime.env);
  }

  pin() {
    this._pending += 1;
  }

  unpin() {
    this._pending -= 1;
    this.runtime.maybeEvict(this);
  }

  // Arm the timer for any alarm already persisted (boot rehydration or a
  // re-access after eviction). setAlarm made during normal operation arms via
  // onAlarmChange instead.
  async init() {
    const at = await this.storage.getAlarm();
    if (at !== null) this._reschedule(at);
  }

  getWebSockets() {
    return [...this._sockets];
  }

  // Register a `ws` WebSocket for this room: track it, give it the attachment
  // methods Room uses (in-memory, since there is no hibernation to serialize
  // for), and dispatch its events to the Room callbacks. Text frames arrive as
  // strings and binary as Buffers, matching the workerd contract Room relies on
  // (`typeof message === "string"`).
  acceptWebSocket(ws) {
    this._sockets.add(ws);
    // CONTRACT: an attachment must be treated as immutable. workerd structured-
    // clones on serialize/deserialize; here the SAME object reference is stored
    // and handed back (no per-frame clone, since deserialize runs on every
    // message). room.js always writes a fresh literal and never mutates a
    // returned attachment in place — keep it that way. An in-place mutation would
    // silently persist here while being a no-op on workerd (a portability trap);
    // if that ever becomes necessary, structuredClone here instead.
    ws.serializeAttachment = (value) => { ws._attachment = value; };
    ws.deserializeAttachment = () => (ws._attachment === undefined ? null : ws._attachment);
    // Match the Durable Object hibernation contract: webSocketClose fires only
    // for REMOTE-initiated closes. When the server closes a socket itself
    // (displacement, reject, teardown, quota), it already handled the peer
    // semantics, so the close callback must NOT run — otherwise closePeerOf
    // would tear down the peer on every displacement (killing a parked mac while
    // a phone retries). terminate() is left unwrapped: a keepalive-detected dead
    // socket IS a remote failure and should notify the peer.
    //
    // ws also calls the public close() itself to ACK a close frame the PEER
    // sent; in that case `_closeFrameReceived` is already set. So only a call
    // made before any close frame arrived is a genuine local close.
    //
    // FRAGILE: `_closeFrameReceived` is an undocumented ws internal, and this
    // whole "don't tear down the parked mac on displacement" behavior (the
    // reconnect storm the migration exists to prevent) rests on it. ws is pinned
    // exactly (package.json "ws": "8.21.0"). BEFORE bumping ws, re-run the
    // close-discrimination regression (test/host/runtime.test.js) AND the
    // displacement flap integration test (test/host/server.test.js) — a silent
    // break degrades to exactly the failure mode being avoided.
    const rawClose = ws.close.bind(ws);
    ws.close = (code, reason) => {
      if (!ws._closeFrameReceived) ws._serverClosed = true;
      // Remove a closing socket from the routable set immediately, not on the
      // async 'close' event, so forward()/admit() never route a frame to a
      // just-displaced peer (workerd drops a closed socket synchronously; the ws
      // 'close' event lags). getWebSockets() returns a snapshot, so deleting
      // here mid-iteration is safe.
      this._sockets.delete(ws);
      return rawClose(code, reason);
    };
    ws.on("message", (data, isBinary) => {
      const msg = isBinary ? data : data.toString("utf8");
      this._dispatch(ws, "message", () => this.instance.webSocketMessage(ws, msg));
    });
    ws.on("close", (code, reason) => {
      this._sockets.delete(ws);
      if (!ws._serverClosed) {
        this._dispatch(ws, "close", () => this.instance.webSocketClose(ws, code, reason?.toString?.() ?? reason));
      }
      this.runtime.maybeEvict(this);
    });
    ws.on("error", (err) => {
      this._dispatch(ws, "error", () => this.instance.webSocketError(ws, err));
    });
  }

  // Serialize a socket's handlers through a per-socket promise chain, emulating
  // the Durable Object input gate: batched frames delivered in one tick can no
  // longer interleave at a storage await, so Room's read-modify-write atomicity
  // (single-use ticket consumption, the pairing-cycle count) holds — without it,
  // proofs batched on one socket each admit (a lost update).
  //
  // Also isolates and pins:
  //  - Isolation: a rejecting async handler must never become an unhandled
  //    rejection, which in this single process would terminate it and drop EVERY
  //    room. Fail open per socket — log, and for an inbound frame close only that
  //    socket (1011). On Cloudflare each Room was an isolated Durable Object;
  //    here isolation is on us.
  //  - Pin: a message handler awaits storage, so pin the context across it so the
  //    room cannot be evicted mid-handler (which would strand the handler on an
  //    out-of-registry context while the next connection builds a second one).
  _dispatch(ws, kind, fn) {
    const pinned = kind === "message";
    const onErr = (e) => {
      try { this.instance.dlog?.(`webSocket ${kind} handler failed: ${e?.message ?? e}`); } catch { /* ignore */ }
      if (kind === "message") {
        try { ws.close(1011, "internal error"); } catch { /* ignore */ }
      }
    };
    const run = async () => {
      if (pinned) this.pin();
      try {
        await fn();
      } catch (e) {
        onErr(e);
      } finally {
        if (pinned) this.unpin();
      }
    };
    // Chain so the next frame waits for this one to fully settle. run never
    // rejects (it catches), so the chain stays alive.
    ws._chain = (ws._chain || Promise.resolve()).then(run);
  }

  _reschedule(at) {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    // After shutdown, never arm a new timer — an alarm firing against a closed
    // backend would throw, and _fire's catch would otherwise re-arm a stray
    // (non-unref'd) retry timer.
    if (this.runtime._closed) return;
    this._alarmAt = at;
    if (at === null) return;
    this._armTimer();
  }

  // setTimeout takes a signed-32-bit delay; anything larger (the 30-day idle
  // TTL is ~2.59e9 ms, past the ~24.9-day / 2^31-1 ceiling) is silently clamped
  // to 1 ms, which would fire immediately and busy-loop. Cap each hop at
  // MAX_DELAY and re-arm the remainder until the real deadline arrives.
  _armTimer() {
    const remaining = this._alarmAt - Date.now();
    if (remaining <= 0) {
      this._fire();
      return;
    }
    this._timer = setTimeout(() => this._armTimer(), Math.min(remaining, MAX_DELAY));
  }

  async _fire() {
    this._timer = null;
    if (this.runtime._closed) return; // don't run alarm() against a closing backend
    this._alarmAt = null; // if alarm() reschedules, onAlarmChange sets it again
    try {
      await this.instance.alarm();
    } catch (e) {
      // A housekeeping failure must never become an unhandled rejection or stop
      // the room's sweeps. The throw precedes alarm()'s own reschedule, so
      // without this the deadline/idle sweeps would stall until a new
      // connection re-armed. Log (diagnostic only) and re-arm a short retry.
      try { this.instance.dlog?.(`alarm failed: ${e?.message ?? e}`); } catch { /* ignore */ }
      this._reschedule(Date.now() + ALARM_RETRY_MS);
    } finally {
      this.runtime.maybeEvict(this);
    }
  }

  _dispose() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  _idle() {
    return this._sockets.size === 0 && this._alarmAt === null && this._pending === 0;
  }
}

export class Runtime {
  constructor({ RoomClass, env, backend }) {
    this.RoomClass = RoomClass;
    this.env = env;
    this.backend = backend;
    this.rooms = new Map();
    this._closed = false;
  }

  get size() {
    return this.rooms.size;
  }

  // Get-or-create the live context for a room, arming any persisted alarm.
  async get(roomName) {
    let ctx = this.rooms.get(roomName);
    if (!ctx) {
      ctx = new RoomContext(this, roomName);
      this.rooms.set(roomName, ctx);
      await ctx.init();
    }
    return ctx;
  }

  // Drop an idle room from memory (no sockets, no pending alarm). Persisted
  // state remains in SQLite and is rehydrated on next access. Called after a
  // socket closes, after an alarm fires, and after an HTTP request completes.
  maybeEvict(ctx) {
    if (ctx._idle()) this.evict(ctx);
  }

  // Remove a room from memory. Identity-safe: a stale reference (from an op that
  // was in flight while a newer context took the slot) must never drop the
  // live context. Cancels the timer; storage is untouched.
  evict(ctx) {
    if (this.rooms.get(ctx.roomName) !== ctx) return;
    ctx._dispose();
    this.rooms.delete(ctx.roomName);
  }

  // On boot, re-arm alarms for every room that has persisted state so idle-TTL
  // reaping and ephemeral pruning resume without waiting for a reconnect. A room
  // whose persisted alarm is armed stays resident (it must, to run its sweep);
  // one with no pending alarm is not pinned for the process lifetime. Note:
  // established rooms carry an idle-TTL alarm, so they remain resident — bounded
  // by the number of live pairings, not maxRooms; a global storage sweep would
  // be the move if that ever needs to scale past memory.
  async rehydrate() {
    for (const roomName of this.backend.roomsWithState()) {
      const ctx = await this.get(roomName);
      this.maybeEvict(ctx);
    }
  }

  // Cancel every room's alarm timer and drop all rooms, so no timer fires after
  // the process (and its storage) is shut down. The _closed flag makes any
  // in-flight _fire (and its retry re-arm) a no-op, so a late alarm can't hit a
  // closing backend or leave a stray timer.
  shutdown() {
    this._closed = true;
    for (const ctx of this.rooms.values()) ctx._dispose();
    this.rooms.clear();
  }
}
