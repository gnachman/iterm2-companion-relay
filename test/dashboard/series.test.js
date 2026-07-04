import { describe, it, expect } from "vitest";
import { buildDashboard } from "../../dashboard/series.js";

// Minimal DB-shaped row; only the fields under test need be set.
const row = (ts, o = {}) => ({
  ts, ws_upgrades: 0, ws_rejected: 0, http_requests: 0, http_errors: 0,
  exceptions: 0, push_errors: 0, rooms_live: 0, sockets_live: 0,
  life_le1: 0, life_le5: 0, life_le15: 0, life_le60: 0, life_le300: 0, life_le1800: 0,
  life_count: 0, life_sum: 0, ...o,
});

describe("buildDashboard tiles", () => {
  it("sums reset-aware counter deltas over the window", () => {
    const rows = [
      row(1000, { http_requests: 10, http_errors: 1 }),
      row(2000, { http_requests: 30, http_errors: 2 }),
      row(3000, { http_requests: 50, http_errors: 5 }),
    ];
    const d = buildDashboard(rows, { latest: rows[2], fromMs: 0, toMs: 4000, nowMs: 4000 });
    expect(d.tiles.requests).toBe(40); // 50 - 10
    expect(d.tiles.errors).toBe(4);
    expect(d.tiles.error_pct).toBe(10);
  });

  it("treats a counter going backwards as a restart, not negative traffic", () => {
    const rows = [
      row(1000, { http_requests: 100 }),
      row(2000, { http_requests: 5 }),   // relay restarted -> counter reset
      row(3000, { http_requests: 20 }),
    ];
    const d = buildDashboard(rows, { latest: rows[2], fromMs: 0, toMs: 4000, nowMs: 4000 });
    // interval 1->2 contributes 0 (reset), interval 2->3 contributes 15.
    expect(d.tiles.requests).toBe(15);
  });

  it("computes flap fraction and average lifetime from lifetime deltas", () => {
    const rows = [
      row(1000, { life_le1: 0, life_count: 0, life_sum: 0 }),
      row(2000, { life_le1: 8, life_count: 10, life_sum: 200 }),
    ];
    const d = buildDashboard(rows, { latest: rows[1], fromMs: 0, toMs: 3000, nowMs: 3000 });
    expect(d.tiles.closed).toBe(10);
    expect(d.tiles.short_lived_pct).toBe(80);
    expect(d.tiles.avg_lifetime_s).toBe(20); // 200s / 10
  });

  it("reports current gauges from the latest sample", () => {
    const rows = [row(1000, { sockets_live: 2, rooms_live: 3 })];
    const d = buildDashboard(rows, { latest: rows[0], fromMs: 0, toMs: 2000, nowMs: 2000 });
    expect(d.tiles.sockets_live).toBe(2);
    expect(d.tiles.rooms_live).toBe(3);
  });

  it("exposes staleness of the latest sample", () => {
    const rows = [row(1000)];
    const d = buildDashboard(rows, { latest: rows[0], fromMs: 0, toMs: 5000, nowMs: 5000 });
    expect(d.tiles.stale_ms).toBe(4000);
  });
});

describe("buildDashboard health (reuses monitor checks)", () => {
  it("raises a capacity alert as live sockets approach the cap", () => {
    const rows = [row(1000, { sockets_live: 950 })];
    const d = buildDashboard(rows, {
      latest: rows[0], fromMs: 0, toMs: 2000, nowMs: 2000,
      caps: { socketsCap: 1000, roomsCap: 1000, warnFrac: 0.7, critFrac: 0.9 },
    });
    const cap = d.alerts.find((a) => a.key === "cap:sockets");
    expect(cap).toBeTruthy();
    expect(cap.severity).toBe("critical"); // 95% >= 90%
  });

  it("raises an error-rate alert past the volume floor and ratio", () => {
    const rows = [
      row(1000, { http_requests: 0, http_errors: 0 }),
      row(2000, { http_requests: 200, http_errors: 30 }),
    ];
    const d = buildDashboard(rows, {
      latest: rows[1], fromMs: 0, toMs: 3000, nowMs: 3000,
      errorCfg: { ratioThreshold: 0.05, minRequests: 100, exceptionThreshold: 1 },
    });
    expect(d.alerts.find((a) => a.key === "errors")).toBeTruthy();
  });

  it("stays clear when everything is nominal", () => {
    const rows = [
      row(1000, { sockets_live: 2, http_requests: 0 }),
      row(2000, { sockets_live: 3, http_requests: 5 }),
    ];
    const d = buildDashboard(rows, { latest: rows[1], fromMs: 0, toMs: 3000, nowMs: 3000 });
    expect(d.alerts).toEqual([]);
  });
});

describe("buildDashboard series", () => {
  it("bucketizes gauges and rates and marks empty buckets null", () => {
    const rows = [
      row(0, { sockets_live: 2, http_requests: 0 }),
      row(60000, { sockets_live: 4, http_requests: 60 }), // +60 req over 60s => 60/min
    ];
    const d = buildDashboard(rows, { latest: rows[1], fromMs: 0, toMs: 120000, nowMs: 120000, buckets: 2 });
    expect(d.series.sockets_live).toHaveLength(2);
    expect(d.series.sockets_live.map((p) => p.v)).toEqual([2, 4]);
    // request_rate: the +60/60s delta lands in the bucket of the LATER sample
    // (ts=60000 -> bucket 1). Bucket 0 saw no interval -> null (a gap, not a
    // false zero).
    expect(d.series.request_rate[0].v).toBeNull();
    expect(d.series.request_rate[1].v).toBeCloseTo(60, 0);
  });
});
