// SQLite store for the dashboard's metric history. One row per scrape; every
// value is an aggregate count/gauge the relay already exposes on /metrics, so
// this file inherits the relay's zero-PII posture — there is never a room name,
// tag, or IP here to leak.
//
// Reuses the same durability posture as host/storage.js (WAL + NORMAL sync):
// readers never block the collector's single writer, and a clean restart keeps
// every committed sample. This DB is SEPARATE from relay.db — the dashboard is a
// read-only observer of the relay and must never share its file or its lock.
//
// better-sqlite3 is synchronous, which is exactly what a once-per-interval
// collector and a handful of range queries want; no async driver, no pool.

import Database from "better-sqlite3";
import { LIFETIME_BUCKETS, PUSH_FIELDS } from "./parse.js";

// Columns in insertion order. Kept as data so the schema, the prepared insert,
// and the row->object mapping can never drift apart.
const COLUMNS = [
  "ws_upgrades", "ws_rejected", "http_requests", "http_errors",
  "exceptions", "push_errors", "rooms_live", "sockets_live",
  ...LIFETIME_BUCKETS.map((b) => `life_le${b}`),
  "life_count", "life_sum",
  // Appended after the initial schema shipped; see ensureColumns() for the
  // in-place migration that adds it to a DB created before this column existed.
  "quota_exceeded",
];

// Push relay columns, in insertion order (mirrors parse.js's PUSH_FIELDS).
const PUSH_COLUMNS = PUSH_FIELDS;

export class DashboardDB {
  constructor(path) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    const cols = COLUMNS.map((c) => `${c} REAL NOT NULL DEFAULT 0`).join(",\n        ");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS samples (
        ts INTEGER PRIMARY KEY,
        ${cols}
      );
    `);
    this.ensureColumns("samples", COLUMNS);
    const names = ["ts", ...COLUMNS];
    this.insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO samples (${names.join(", ")}) ` +
      `VALUES (${names.map((n) => "@" + n).join(", ")})`,
    );
    this.rangeStmt = this.db.prepare(
      "SELECT * FROM samples WHERE ts >= ? AND ts <= ? ORDER BY ts ASC",
    );
    this.latestStmt = this.db.prepare("SELECT * FROM samples ORDER BY ts DESC LIMIT 1");
    this.pruneStmt = this.db.prepare("DELETE FROM samples WHERE ts < ?");

    // Push relay history: a SEPARATE table from `samples`. The push relay is a
    // distinct producer with its own restarts and its own scrape that can fail
    // independently, so keeping it apart means a push-relay outage never looks
    // like a companion-relay counter reset (and vice versa). Every column is an
    // aggregate count/gauge — same zero-PII posture as `samples`.
    const pcols = PUSH_COLUMNS.map((c) => `${c} REAL NOT NULL DEFAULT 0`).join(",\n        ");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_samples (
        ts INTEGER PRIMARY KEY,
        ${pcols}
      );
    `);
    this.ensureColumns("push_samples", PUSH_COLUMNS);
    const pnames = ["ts", ...PUSH_COLUMNS];
    this.pushInsertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO push_samples (${pnames.join(", ")}) ` +
      `VALUES (${pnames.map((n) => "@" + n).join(", ")})`,
    );
    this.pushRangeStmt = this.db.prepare(
      "SELECT * FROM push_samples WHERE ts >= ? AND ts <= ? ORDER BY ts ASC",
    );
    this.pushLatestStmt = this.db.prepare("SELECT * FROM push_samples ORDER BY ts DESC LIMIT 1");
    this.pushPruneStmt = this.db.prepare("DELETE FROM push_samples WHERE ts < ?");
  }

  // Additive, idempotent migration: a column appended to COLUMNS after a DB was
  // first created won't exist yet (CREATE TABLE IF NOT EXISTS is a no-op on an
  // existing table), which would make the prepared insert throw. Add any missing
  // column so an in-place upgrade just works. Existing rows backfill to 0; the
  // reset-aware rate math treats the 0->cumulative first step as one interval,
  // which is harmless since the relay's own counter also restarts at 0 on the
  // deploy that introduced the metric. Column names are code-controlled, never
  // user input, so the string interpolation carries no injection surface.
  ensureColumns(table, columns) {
    const have = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
    for (const c of columns) {
      if (!have.has(c)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} REAL NOT NULL DEFAULT 0`);
    }
  }

  // Store one scrape. `snapshot` is a parseMetrics() result; `ts` is ms epoch.
  insert(ts, snapshot) {
    const row = { ts };
    for (const c of COLUMNS) row[c] = Number(snapshot[c]) || 0;
    this.insertStmt.run(row);
  }

  // Samples in [fromMs, toMs], oldest first.
  range(fromMs, toMs) {
    return this.rangeStmt.all(fromMs, toMs);
  }

  latest() {
    return this.latestStmt.get() || null;
  }

  // Drop samples older than `cutoffMs`; returns the number removed.
  prune(cutoffMs) {
    return this.pruneStmt.run(cutoffMs).changes;
  }

  // --- Push relay samples (parsePushMetrics() results) ---
  insertPush(ts, snapshot) {
    const row = { ts };
    for (const c of PUSH_COLUMNS) row[c] = Number(snapshot[c]) || 0;
    this.pushInsertStmt.run(row);
  }
  rangePush(fromMs, toMs) { return this.pushRangeStmt.all(fromMs, toMs); }
  latestPush() { return this.pushLatestStmt.get() || null; }
  prunePush(cutoffMs) { return this.pushPruneStmt.run(cutoffMs).changes; }

  close() {
    this.db.close();
  }
}

export const SAMPLE_COLUMNS = COLUMNS;
export { PUSH_COLUMNS };
