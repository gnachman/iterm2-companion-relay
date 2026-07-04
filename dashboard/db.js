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
import { LIFETIME_BUCKETS } from "./parse.js";

// Columns in insertion order. Kept as data so the schema, the prepared insert,
// and the row->object mapping can never drift apart.
const COLUMNS = [
  "ws_upgrades", "ws_rejected", "http_requests", "http_errors",
  "exceptions", "push_errors", "rooms_live", "sockets_live",
  ...LIFETIME_BUCKETS.map((b) => `life_le${b}`),
  "life_count", "life_sum",
];

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

  close() {
    this.db.close();
  }
}

export const SAMPLE_COLUMNS = COLUMNS;
