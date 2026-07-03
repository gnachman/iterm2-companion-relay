// Unit tests for the runtime shim: the per-room context (storage + socket set +
// acceptWebSocket wiring) and the alarm scheduler that replaces the Durable
// Object platform. Driven against a fake Room class and fake sockets so the
// runtime is validated independently of the real (hardened) room.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageBackend } from "../../host/storage.js";
import { DurableObject, Runtime, ALARM_RETRY_MS } from "../../host/runtime.js";

// A fake socket shaped like a `ws` WebSocket: an EventEmitter with send/close.
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = null;
  }
  send(data) { this.sent.push(data); }
  close(code, reason) { this.closed = { code, reason }; this.emit("close", code, Buffer.from(reason ?? "")); }
}

// A fake Room recording the platform callbacks the runtime is supposed to make.
class FakeRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.calls = { alarm: 0, message: [], close: [], error: [] };
  }
  async alarm() { this.calls.alarm += 1; }
  async webSocketMessage(ws, msg) { this.calls.message.push({ ws, msg }); }
  async webSocketClose(ws, code, reason) { this.calls.close.push({ ws, code, reason }); }
  async webSocketError(ws) { this.calls.error.push({ ws }); }
}

let dir, backend, runtime;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  dir = mkdtempSync(join(tmpdir(), "relay-runtime-"));
  backend = new StorageBackend(join(dir, "relay.db"));
  runtime = new Runtime({ RoomClass: FakeRoom, env: { RELAY_ORIGIN: "x" }, backend });
});

afterEach(() => {
  backend.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("context wiring", () => {
  it("exposes storage, getWebSockets, and the instance for a room", async () => {
    const rt = await runtime.get("room-a");
    expect(rt.storage).toBeTruthy();
    expect(rt.getWebSockets()).toEqual([]);
    expect(rt.instance).toBeInstanceOf(FakeRoom);
    expect(rt.instance.env.RELAY_ORIGIN).toBe("x");
  });

  it("returns the same runtime for the same room name", async () => {
    const a1 = await runtime.get("room-a");
    const a2 = await runtime.get("room-a");
    expect(a1).toBe(a2);
  });
});

describe("acceptWebSocket", () => {
  it("registers the socket, gives it attachment methods, and dispatches messages", async () => {
    const rt = await runtime.get("room-a");
    const ws = new FakeSocket();
    rt.acceptWebSocket(ws);
    expect(rt.getWebSockets()).toContain(ws);

    ws.serializeAttachment({ state: "hello" });
    expect(ws.deserializeAttachment()).toEqual({ state: "hello" });

    ws.emit("message", Buffer.from("{\"v\":1}"), false); // text frame
    ws.emit("message", Buffer.from([1, 2, 3]), true); // binary frame
    await ws._chain; // dispatch is serialized through the per-socket chain
    expect(rt.instance.calls.message[0].msg).toBe("{\"v\":1}");
    expect(rt.instance.calls.message[0].msg).toBeTypeOf("string");
    expect(rt.instance.calls.message[1].msg).toBeInstanceOf(Buffer);
  });

  it("removes the socket from the set and notifies the room on close", async () => {
    const rt = await runtime.get("room-a");
    const ws = new FakeSocket();
    rt.acceptWebSocket(ws);
    ws.emit("close", 1000, Buffer.from("bye"));
    expect(rt.getWebSockets()).not.toContain(ws); // removed synchronously
    await ws._chain;
    expect(rt.instance.calls.close[0]).toMatchObject({ ws, code: 1000, reason: "bye" });
  });

  it("forwards socket errors to the room", async () => {
    const rt = await runtime.get("room-a");
    const ws = new FakeSocket();
    rt.acceptWebSocket(ws);
    ws.emit("error", new Error("boom"));
    await ws._chain;
    expect(rt.instance.calls.error[0].ws).toBe(ws);
  });

  it("isolates a rejecting handler: no unhandled rejection, only that socket closes", async () => {
    // A Room handler that rejects (e.g. storage.put on SQLITE_FULL) must not
    // become an unhandledRejection — that would terminate the single process and
    // drop EVERY room. Fail open per socket, not fail stop per process.
    vi.useRealTimers(); // this test needs a real macrotask tick to observe rejections
    class FaultyRoom extends DurableObject {
      async webSocketMessage() { throw new Error("disk full during storage.put"); }
      dlog() {}
    }
    const faulty = new Runtime({ RoomClass: FaultyRoom, env: {}, backend });
    const ctx = await faulty.get("room-x");
    const ws = new FakeSocket();
    ctx.acceptWebSocket(ws);

    let unhandled = null;
    const onUnhandled = (e) => { unhandled = e; };
    process.on("unhandledRejection", onUnhandled);
    ws.emit("message", Buffer.from("{}"), false);
    await new Promise((r) => setTimeout(r, 30)); // let the rejection settle
    process.removeListener("unhandledRejection", onUnhandled);

    expect(unhandled).toBeNull(); // the dispatch was caught, not leaked
    expect(ws.closed).toMatchObject({ code: 1011 }); // only this socket torn down
  });
});

describe("alarm scheduling", () => {
  it("fires room.alarm() at the scheduled absolute time", async () => {
    const rt = await runtime.get("room-a");
    await rt.storage.setAlarm(1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(rt.instance.calls.alarm).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(rt.instance.calls.alarm).toBe(1);
  });

  it("deleteAlarm cancels a pending alarm", async () => {
    const rt = await runtime.get("room-a");
    await rt.storage.setAlarm(1000);
    await rt.storage.deleteAlarm();
    await vi.advanceTimersByTimeAsync(5000);
    expect(rt.instance.calls.alarm).toBe(0);
  });

  it("re-arms a short retry when alarm() throws (no unhandled rejection, no stalled housekeeping)", async () => {
    class FlakyRoom extends DurableObject {
      constructor(ctx, env) { super(ctx, env); this.calls = 0; }
      async alarm() { this.calls += 1; if (this.calls === 1) throw new Error("boom"); }
    }
    const flaky = new Runtime({ RoomClass: FlakyRoom, env: {}, backend });
    const ctx = await flaky.get("room-flaky");
    await ctx.storage.setAlarm(1000);
    await vi.advanceTimersByTimeAsync(1000); // fires -> throws -> caught -> retry armed
    expect(ctx.instance.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(ALARM_RETRY_MS); // retry fires
    expect(ctx.instance.calls).toBe(2); // housekeeping self-healed
  });

  it("re-arms a persisted alarm when a room is (re)loaded", async () => {
    // Persist an alarm, then throw the live runtime away and re-create it, as a
    // process restart or a post-eviction re-access would.
    const rt1 = await runtime.get("room-a");
    await rt1.storage.setAlarm(1000);
    runtime.evict(rt1);

    const rt2 = await runtime.get("room-a");
    expect(rt2).not.toBe(rt1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(rt2.instance.calls.alarm).toBe(1);
  });

  it("rehydrate does not pin rooms that have no pending alarm", async () => {
    // A room with an alarm must stay resident (its idle-TTL / prune must run);
    // a room with only leftover state and no alarm must not be pinned for the
    // process lifetime.
    await backend.forRoom("with-alarm").setAlarm(1_000_000);
    await backend.forRoom("no-alarm").put("ticket:x", { expiresAt: 1 });
    const booted = new Runtime({ RoomClass: FakeRoom, env: {}, backend });
    await booted.rehydrate();
    expect(booted.rooms.has("with-alarm")).toBe(true);
    expect(booted.rooms.has("no-alarm")).toBe(false);
  });

  it("rehydrate re-arms alarms for all rooms with persisted state", async () => {
    const seed = new Runtime({ RoomClass: FakeRoom, env: {}, backend });
    await (await seed.get("room-a")).storage.setAlarm(500);
    await (await seed.get("room-b")).storage.setAlarm(1500);
    // Fresh runtime (as on boot) that has never touched these rooms.
    const booted = new Runtime({ RoomClass: FakeRoom, env: {}, backend });
    await booted.rehydrate();
    // Capture the rehydrated instances before advancing: a one-shot alarm fires
    // and then the (now idle) room is evicted, so a later get() would return a
    // fresh instance with a zeroed count.
    const a = booted.rooms.get("room-a").instance;
    const b = booted.rooms.get("room-b").instance;
    await vi.advanceTimersByTimeAsync(1500);
    expect(a.calls.alarm).toBe(1);
    expect(b.calls.alarm).toBe(1);
  });
});

describe("close discrimination (webSocketClose only on remote close)", () => {
  // Regression guard for the ws._closeFrameReceived-based distinction (an
  // undocumented ws internal): a peer-initiated close must fire webSocketClose
  // (so closePeerOf tears the peer down), while a server-initiated close
  // (displacement/reject/teardown) must NOT — else a parked mac dies on every
  // phone displacement. Pinned to ws 8.21.0.
  it("fires webSocketClose for a remote close but not a server-initiated close", async () => {
    const rt = await runtime.get("room-a");

    const remote = new FakeSocket();
    rt.acceptWebSocket(remote);
    remote.emit("close", 1000, Buffer.from("bye")); // peer dropped, no server close()

    const displaced = new FakeSocket();
    rt.acceptWebSocket(displaced);
    displaced.close(1000, "displaced"); // server-initiated, no close frame received

    const acked = new FakeSocket();
    rt.acceptWebSocket(acked);
    acked._closeFrameReceived = true; // ws's internal close() ACKing a peer frame
    acked.close(1000, "bye");

    await remote._chain; // dispatched close callbacks are serialized per socket
    await acked._chain; // (displaced was suppressed, so it has no chain)
    const closedWs = rt.instance.calls.close.map((c) => c.ws);
    expect(closedWs).toContain(remote); // remote drop -> callback
    expect(closedWs).toContain(acked); // peer-frame ACK -> callback
    expect(closedWs).not.toContain(displaced); // server close -> suppressed
  });
});

describe("shutdown", () => {
  it("does not re-arm a timer after shutdown (no alarm against a closed backend)", async () => {
    const rt = new Runtime({ RoomClass: FakeRoom, env: {}, backend });
    const ctx = await rt.get("room-a");
    await ctx.storage.setAlarm(1000);
    rt.shutdown();
    // An in-flight alarm's retry (or any late onAlarmChange) must not arm a new
    // timer once the runtime is shut down and the backend is closing.
    ctx._reschedule(Date.now() + 5000);
    expect(ctx._timer).toBeNull();
  });

  it("_fire is a no-op after shutdown (does not touch the room)", async () => {
    const rt = new Runtime({ RoomClass: FakeRoom, env: {}, backend });
    const ctx = await rt.get("room-a");
    rt.shutdown();
    await ctx._fire();
    expect(ctx.instance.calls.alarm).toBe(0);
  });
});

describe("eviction (memory bounding)", () => {
  it("evicts a room with no sockets and no alarm after its last socket closes", async () => {
    const rt = await runtime.get("room-a");
    const ws = new FakeSocket();
    rt.acceptWebSocket(ws);
    expect(runtime.size).toBe(1);
    ws.emit("close", 1000, Buffer.from(""));
    expect(runtime.size).toBe(0);
  });

  it("keeps a room with a pending alarm resident even with no sockets", async () => {
    const rt = await runtime.get("room-a");
    await rt.storage.setAlarm(60_000);
    const ws = new FakeSocket();
    rt.acceptWebSocket(ws);
    ws.emit("close", 1000, Buffer.from(""));
    expect(runtime.size).toBe(1);
  });

  it("maybeEvict drops an idle stateless room (e.g. after a failed HTTP call)", async () => {
    await runtime.get("room-a");
    expect(runtime.size).toBe(1);
    runtime.maybeEvict(runtime.rooms.get("room-a"));
    expect(runtime.size).toBe(0);
  });

  it("evict is identity-safe: a stale evict never drops a newer context", async () => {
    const ctx1 = await runtime.get("room-a");
    runtime.evict(ctx1);
    const ctx2 = await runtime.get("room-a"); // fresh context, same name
    expect(ctx2).not.toBe(ctx1);
    runtime.evict(ctx1); // stale reference from an in-flight op
    expect(runtime.rooms.get("room-a")).toBe(ctx2); // ctx2 survives
  });

  it("does not evict a pinned (in-flight) context until it is unpinned", async () => {
    const ctx = await runtime.get("room-a"); // idle: no sockets, no alarm
    ctx.pin();
    runtime.maybeEvict(ctx); // an alarm _fire or a peer request tries to evict
    expect(runtime.rooms.has("room-a")).toBe(true); // pinned -> kept
    ctx.unpin(); // op completes
    expect(runtime.rooms.has("room-a")).toBe(false); // now reclaimed
  });
});
