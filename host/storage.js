// SQLite-backed stand-in for the subset of the Cloudflare Durable Object
// storage API that Room uses. On Cloudflare each room is a separate Durable
// Object with its own transactional key-value store and a single alarm; here a
// single process owns every room, so one SQLite file holds them all and each
// Room gets a `RoomStorage` scoped to its room name.
//
// Fidelity that Room depends on:
//   - get(missing) === undefined  (Room checks `!== undefined`)
//   - values keep their JS type    (numbers stay numbers, objects stay objects)
//   - list({prefix}) returns a Map, sorted by key
//   - deleteAll() clears the kv but NOT the alarm (deleteAlarm is separate)
//   - getAlarm() === null when unset
//
// CAVEAT (mirrors runtime.js's serializeAttachment note): values round-trip
// through JSON.stringify/parse, whereas Durable Object storage structured-clones.
// Room stores only JSON-safe values today (strings, numbers, plain objects), so
// this is faithful — but a Date, Uint8Array, Map, or BigInt would corrupt
// silently (Date -> string, Uint8Array -> {}, BigInt -> throw) and differ from
// workerd. Keep stored values JSON-safe, or add structured serialization here.
//
// better-sqlite3 is synchronous; the methods are async only to match the
// Durable Object interface Room awaits. Everything runs on one event-loop
// thread, so the strong consistency Room assumed on Cloudflare holds for free.
//
// ATOMICITY INVARIANT — READ BEFORE CHANGING THIS FILE OR room.js:
// The Durable Object input gate serialized a room's event handlers around
// storage ops, giving Room read-modify-write atomicity for free. Several
// security-critical checks depend on it: single-use consumption of tickets /
// attest challenges / registration tokens (room.js handleProof/handleAttest/
// handleRegister/handleDelete), the strictly-increasing assertcounter, and the
// pairing-cycle count that caps SAS grinding (room.js admit()). This shim has NO
// input gate and NO blockConcurrencyWhile. Two things stand in for it:
//
//   1. WebSocket messages on ONE socket are serialized by a per-socket promise
//      chain (host/runtime.js `_dispatch`). Without it, frames a socket delivers
//      in ONE tick (ws emits several 'message' events synchronously) would each
//      run to their first await and interleave. This covers SAME-socket batching
//      only — it does NOT serialize room-level state reachable from different
//      sockets (the pairing-cycle count, ticket consumption): those are separate
//      sockets, hence separate chains.
//
//      What keeps THOSE atomic across sockets is the event-loop model, not #1:
//      each socket's frame is a separate MACROtask, and microtasks (a storage
//      await yields only a microtask, since better-sqlite3 is synchronous) drain
//      fully between macrotasks. So a handler with NO real-async await between a
//      storage read and its dependent write completes that read-modify-write
//      within its own macrotask, before any other socket's macrotask runs. A
//      real-async await (crypto.subtle.*, network) inserted between the read and
//      write would suspend at a MACROtask boundary and let another socket's
//      handler interleave — reopening a cross-socket lost-update (pairingCycles)
//      or ticket double-spend, bounded by MAX_PREAUTH_SOCKETS concurrency. Hence
//      the pointed "no real-async between these lines" comments in room.js admit.
//
//   2. Everything else in a room is NOT serialized against each other: a second
//      socket, the HTTP /register /attest /delete handlers, AND the idle-TTL /
//      housekeeping ALARM (host/runtime.js `_fire` runs on an independent
//      setTimeout, not on any chain). Any of these can interleave with a handler
//      suspended at a real-async `crypto.subtle.*` await (handleProof's verifyJoin,
//      handleRegister's verifyAssertion). Note also that `await storage.get(k)`
//      yields a microtask even though better-sqlite3 is synchronous, so two
//      concurrent invocations CAN interleave between a single-use read and its
//      consuming delete (and the consumers do not check delete's `changes`).
//
//      The load-bearing reason #2 is nonetheless safe is NOT "no real-async
//      between read and write" — that is necessary but not sufficient. It is that
//      each single-use secret is held by ONE legitimate actor: the ticket is
//      returned only to the attesting phone, the regtoken only to the admitted
//      phone, the challenge only to its requester. With no attacker-controlled
//      second actor, there is no concurrent invocation to race the consumption.
//      The alarm is safe for the same class reason: pruneExpired only deletes
//      ALREADY-expired ephemeral records, so it never races the consumption of a
//      live ticket/challenge/regtoken (its worst interleaving is a benign
//      teardownRoom firing mid-crypto on a room already being reaped — which can
//      also orphan a just-written non-ephemeral key like pairingCycles; negligible
//      and not attacker-amplifiable).
//
// THE RULE, when editing room.js:
//   - Same-socket security state stays atomic via #1 (the WS path). Keep it there.
//   - Do NOT introduce a real-async await between a storage read and its dependent
//     write (no async DB driver, no awaited hash between them, no reordering a
//     single-use delete to after an awaited verify).
//   - Above all: any single-use secret that could be consumed by >=2 CONCURRENT
//     actors (e.g. a secret reachable from two connections, or by both a handler
//     and the alarm) MUST be serialized — route those paths through a per-room
//     promise chain (extend `_dispatch` to a ctx-level chain covering the HTTP
//     fetch path and `_fire`). Today no such secret exists, so the shim is safe;
//     the moment one does, the single-actor argument above no longer holds.

import Database from "better-sqlite3";

export class StorageBackend {
  constructor(path) {
    this.db = new Database(path);
    // WAL: durable, and readers never block the single writer. NORMAL sync is
    // the standard WAL pairing (an OS crash can lose the last transaction; a
    // clean process restart cannot). Losing the tail only forces a re-pair, so
    // this trades a negligible durability edge for far less fsync churn.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        room  TEXT NOT NULL,
        key   TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (room, key)
      );
      CREATE TABLE IF NOT EXISTS alarms (
        room TEXT PRIMARY KEY,
        at   INTEGER NOT NULL
      );
    `);
    this.stmts = {
      get: this.db.prepare("SELECT value FROM kv WHERE room = ? AND key = ?"),
      put: this.db.prepare(
        "INSERT INTO kv (room, key, value) VALUES (?, ?, ?) " +
        "ON CONFLICT(room, key) DO UPDATE SET value = excluded.value"),
      del: this.db.prepare("DELETE FROM kv WHERE room = ? AND key = ?"),
      list: this.db.prepare(
        "SELECT key, value FROM kv WHERE room = ? AND key LIKE ? ESCAPE '\\' ORDER BY key"),
      deleteAll: this.db.prepare("DELETE FROM kv WHERE room = ?"),
      getAlarm: this.db.prepare("SELECT at FROM alarms WHERE room = ?"),
      setAlarm: this.db.prepare(
        "INSERT INTO alarms (room, at) VALUES (?, ?) " +
        "ON CONFLICT(room) DO UPDATE SET at = excluded.at"),
      deleteAlarm: this.db.prepare("DELETE FROM alarms WHERE room = ?"),
      rooms: this.db.prepare(
        "SELECT room FROM kv UNION SELECT room FROM alarms"),
    };
  }

  forRoom(room) {
    return new RoomStorage(this, room);
  }

  // Distinct rooms that hold any persisted state, for boot-time rehydration
  // (re-arming alarms / reaping idle established rooms without a live socket).
  roomsWithState() {
    return this.stmts.rooms.all().map((r) => r.room);
  }

  close() {
    this.db.close();
  }
}

// Escape the LIKE metacharacters so a prefix match is a literal prefix match.
// The prefixes Room uses ("ticket:", etc.) contain none of these, but keeping
// this correct means an arbitrary prefix can never turn into a wildcard.
function likePrefix(prefix) {
  return prefix.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

class RoomStorage {
  constructor(backend, room) {
    this.stmts = backend.stmts;
    this.room = room;
    // Set by the runtime to (re)arm / cancel the room's timer when the alarm
    // time changes. Absent in isolation (pure persistence).
    this.onAlarmChange = null;
  }

  async get(key) {
    const row = this.stmts.get.get(this.room, key);
    return row === undefined ? undefined : JSON.parse(row.value);
  }

  async put(key, value) {
    this.stmts.put.run(this.room, key, JSON.stringify(value));
  }

  async delete(key) {
    return this.stmts.del.run(this.room, key).changes > 0;
  }

  async deleteAll() {
    this.stmts.deleteAll.run(this.room);
  }

  async list({ prefix } = {}) {
    const rows = this.stmts.list.all(this.room, likePrefix(prefix ?? ""));
    const out = new Map();
    for (const r of rows) out.set(r.key, JSON.parse(r.value));
    return out;
  }

  async getAlarm() {
    const row = this.stmts.getAlarm.get(this.room);
    return row === undefined ? null : row.at;
  }

  async setAlarm(at) {
    this.stmts.setAlarm.run(this.room, at);
    if (this.onAlarmChange) this.onAlarmChange(at);
  }

  async deleteAlarm() {
    this.stmts.deleteAlarm.run(this.room);
    if (this.onAlarmChange) this.onAlarmChange(null);
  }
}
