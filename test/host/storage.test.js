// Unit tests for the SQLite-backed storage shim. This stands in for the subset
// of the Cloudflare Durable Object storage API that Room uses, so the fidelity
// that matters is: value types survive, missing keys read as `undefined` (Room
// checks `!== undefined`), prefix listing returns a Map, rooms are isolated,
// alarms round-trip, and everything survives a process restart (reopen).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageBackend } from "../../host/storage.js";

let dir, backend;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-storage-"));
  backend = new StorageBackend(join(dir, "relay.db"));
});

afterEach(() => {
  backend.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("RoomStorage key/value", () => {
  it("reads a missing key as undefined (not null)", async () => {
    const s = backend.forRoom("room-a");
    expect(await s.get("nope")).toBeUndefined();
  });

  it("round-trips strings, numbers, and objects with types preserved", async () => {
    const s = backend.forRoom("room-a");
    await s.put("verifier", "aGVsbG8=");
    await s.put("pairingCycles", 3);
    await s.put("quota", { dayStart: 123, bytes: 456 });
    expect(await s.get("verifier")).toBe("aGVsbG8=");
    expect(await s.get("pairingCycles")).toBe(3);
    expect(typeof (await s.get("pairingCycles"))).toBe("number");
    expect(await s.get("quota")).toEqual({ dayStart: 123, bytes: 456 });
  });

  it("overwrites an existing key", async () => {
    const s = backend.forRoom("room-a");
    await s.put("k", 1);
    await s.put("k", 2);
    expect(await s.get("k")).toBe(2);
  });

  it("delete removes the key and reports whether it existed", async () => {
    const s = backend.forRoom("room-a");
    await s.put("k", "v");
    expect(await s.delete("k")).toBe(true);
    expect(await s.get("k")).toBeUndefined();
    expect(await s.delete("k")).toBe(false);
  });

  it("isolates keys between rooms", async () => {
    const a = backend.forRoom("room-a");
    const b = backend.forRoom("room-b");
    await a.put("k", "a-value");
    await b.put("k", "b-value");
    expect(await a.get("k")).toBe("a-value");
    expect(await b.get("k")).toBe("b-value");
    await a.delete("k");
    expect(await b.get("k")).toBe("b-value");
  });
});

describe("RoomStorage.list", () => {
  it("returns a Map of prefix-matching entries, sorted by key, values decoded", async () => {
    const s = backend.forRoom("room-a");
    await s.put("ticket:b", { expiresAt: 2 });
    await s.put("ticket:a", { expiresAt: 1 });
    await s.put("verifier", "v"); // non-matching
    const got = await s.list({ prefix: "ticket:" });
    expect(got).toBeInstanceOf(Map);
    expect([...got.keys()]).toEqual(["ticket:a", "ticket:b"]);
    expect(got.get("ticket:a")).toEqual({ expiresAt: 1 });
  });

  it("returns an empty Map when nothing matches", async () => {
    const s = backend.forRoom("room-a");
    await s.put("verifier", "v");
    const got = await s.list({ prefix: "ticket:" });
    expect(got.size).toBe(0);
  });

  it("does not leak entries across rooms", async () => {
    const a = backend.forRoom("room-a");
    const b = backend.forRoom("room-b");
    await a.put("ticket:x", { expiresAt: 1 });
    expect((await b.list({ prefix: "ticket:" })).size).toBe(0);
  });
});

describe("RoomStorage.deleteAll", () => {
  it("clears this room's kv but leaves other rooms untouched", async () => {
    const a = backend.forRoom("room-a");
    const b = backend.forRoom("room-b");
    await a.put("k1", 1);
    await a.put("k2", 2);
    await b.put("k1", 9);
    await a.deleteAll();
    expect(await a.get("k1")).toBeUndefined();
    expect(await a.get("k2")).toBeUndefined();
    expect(await b.get("k1")).toBe(9);
  });
});

describe("RoomStorage alarms", () => {
  it("getAlarm is null with no alarm set", async () => {
    const s = backend.forRoom("room-a");
    expect(await s.getAlarm()).toBeNull();
  });

  it("setAlarm then getAlarm returns the scheduled time", async () => {
    const s = backend.forRoom("room-a");
    await s.setAlarm(1000);
    expect(await s.getAlarm()).toBe(1000);
    await s.setAlarm(2000);
    expect(await s.getAlarm()).toBe(2000);
  });

  it("deleteAlarm clears it", async () => {
    const s = backend.forRoom("room-a");
    await s.setAlarm(1000);
    await s.deleteAlarm();
    expect(await s.getAlarm()).toBeNull();
  });

  it("deleteAll leaves the alarm intact (matches Durable Object semantics)", async () => {
    const s = backend.forRoom("room-a");
    await s.put("k", 1);
    await s.setAlarm(1000);
    await s.deleteAll();
    expect(await s.getAlarm()).toBe(1000);
  });

  it("notifies the scheduler hook on setAlarm/deleteAlarm when present", async () => {
    const s = backend.forRoom("room-a");
    const seen = [];
    s.onAlarmChange = (at) => seen.push(at);
    await s.setAlarm(1000);
    await s.deleteAlarm();
    expect(seen).toEqual([1000, null]);
  });
});

describe("persistence across reopen", () => {
  it("survives closing and reopening the database file", async () => {
    const path = join(dir, "persist.db");
    const b1 = new StorageBackend(path);
    const s1 = b1.forRoom("room-a");
    await s1.put("verifier", "keep-me");
    await s1.put("lastActivity", 42);
    await s1.setAlarm(777);
    b1.close();

    const b2 = new StorageBackend(path);
    const s2 = b2.forRoom("room-a");
    expect(await s2.get("verifier")).toBe("keep-me");
    expect(await s2.get("lastActivity")).toBe(42);
    expect(await s2.getAlarm()).toBe(777);
    b2.close();
  });
});

describe("roomsWithState (rehydration support)", () => {
  it("lists distinct rooms that have kv or an alarm", async () => {
    await backend.forRoom("room-a").put("verifier", "v");
    await backend.forRoom("room-b").setAlarm(1000);
    backend.forRoom("room-empty"); // touched but no state
    expect(new Set(backend.roomsWithState())).toEqual(new Set(["room-a", "room-b"]));
  });
});
