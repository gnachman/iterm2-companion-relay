import { describe, it, expect } from "vitest";
import { DashboardDB } from "../../dashboard/db.js";

function mk() { return new DashboardDB(":memory:"); }
const snap = (o = {}) => ({ ws_upgrades: 0, ws_rejected: 0, http_requests: 0, http_errors: 0, exceptions: 0, push_errors: 0, rooms_live: 0, sockets_live: 0, life_le1: 0, life_le5: 0, life_le15: 0, life_le60: 0, life_le300: 0, life_le1800: 0, life_count: 0, life_sum: 0, ...o });

describe("DashboardDB", () => {
  it("round-trips a sample and returns the latest", () => {
    const db = mk();
    db.insert(1000, snap({ sockets_live: 2, http_requests: 5 }));
    db.insert(2000, snap({ sockets_live: 3, http_requests: 9 }));
    const latest = db.latest();
    expect(latest.ts).toBe(2000);
    expect(latest.sockets_live).toBe(3);
    expect(latest.http_requests).toBe(9);
    db.close();
  });

  it("returns an inclusive, ordered range", () => {
    const db = mk();
    for (const ts of [3000, 1000, 2000]) db.insert(ts, snap({ sockets_live: ts / 1000 }));
    const rows = db.range(1000, 2000);
    expect(rows.map((r) => r.ts)).toEqual([1000, 2000]);
    db.close();
  });

  it("replaces on duplicate ts (idempotent scrape)", () => {
    const db = mk();
    db.insert(1000, snap({ sockets_live: 1 }));
    db.insert(1000, snap({ sockets_live: 9 }));
    expect(db.range(0, 9999).length).toBe(1);
    expect(db.latest().sockets_live).toBe(9);
    db.close();
  });

  it("prunes samples older than the cutoff", () => {
    const db = mk();
    for (const ts of [100, 200, 300, 400]) db.insert(ts, snap());
    expect(db.prune(300)).toBe(2); // 100, 200 removed
    expect(db.range(0, 9999).map((r) => r.ts)).toEqual([300, 400]);
    db.close();
  });

  it("latest() is null on an empty DB", () => {
    const db = mk();
    expect(db.latest()).toBeNull();
    db.close();
  });
});
