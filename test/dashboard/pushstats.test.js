// APNs-health / delivery stats in the dashboard: parsing the new pushrelay_*
// series, reset-aware tiles (success %, latency quantiles, reasons, last
// delivery), the success-vs-failure series, upgrading an existing DB in place,
// and the push-relay-only mode (relay collector disabled).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { parsePushMetrics, PUSH_FIELDS } from "../../dashboard/parse.js";
import { DashboardDB } from "../../dashboard/db.js";
import { buildPush } from "../../dashboard/series.js";
import { createDashboard } from "../../dashboard/server.js";

const EXPO = `pushrelay_push_total 10
pushrelay_push_delivered_total 7
pushrelay_push_failed_total 3
pushrelay_apns_connects_total 4
pushrelay_apns_connect_throttled_total 1
pushrelay_apns_session_errors_total 2
pushrelay_apns_discarded_idle_total 1
pushrelay_apns_discarded_timeout_total 1
pushrelay_apns_request_timeouts_total 1
# TYPE pushrelay_apns_sessions gauge
pushrelay_apns_sessions 1
pushrelay_apns_oldest_session_age_seconds 600
pushrelay_last_delivery_timestamp_seconds 1699999000
pushrelay_apns_rejected_total{reason="BadDeviceToken"} 2
pushrelay_apns_rejected_total{reason="Unregistered"} 1
pushrelay_apns_rejected_total{reason="SomethingNew"} 1
pushrelay_apns_rejected_total{reason="other"} 2
pushrelay_apns_latency_seconds_bucket{le="0.05"} 1
pushrelay_apns_latency_seconds_bucket{le="0.1"} 5
pushrelay_apns_latency_seconds_bucket{le="0.25"} 8
pushrelay_apns_latency_seconds_bucket{le="0.5"} 9
pushrelay_apns_latency_seconds_bucket{le="1"} 9
pushrelay_apns_latency_seconds_bucket{le="2.5"} 9
pushrelay_apns_latency_seconds_bucket{le="5"} 9
pushrelay_apns_latency_seconds_bucket{le="10"} 9
pushrelay_apns_latency_seconds_bucket{le="+Inf"} 10
pushrelay_apns_latency_seconds_sum 14.2
pushrelay_apns_latency_seconds_count 10
`;

describe("parsePushMetrics (APNs health)", () => {
  it("reads counters, gauges, histogram buckets and reasons", () => {
    const s = parsePushMetrics(EXPO);
    expect(s.push_failed).toBe(3);
    expect(s.apns_connects).toBe(4);
    expect(s.apns_throttled).toBe(1);
    expect(s.apns_session_errors).toBe(2);
    expect(s.apns_discard_idle).toBe(1);
    expect(s.apns_discard_timeout).toBe(1);
    expect(s.apns_timeouts).toBe(1);
    expect(s.apns_sessions).toBe(1);
    expect(s.apns_oldest_session_s).toBe(600);
    expect(s.last_delivery_ts).toBe(1699999000);
    expect(s.lat_le50).toBe(1);
    expect(s.lat_le100).toBe(5);
    expect(s.lat_le10000).toBe(9);
    expect(s.lat_count).toBe(10);                // +Inf is lat_count, not a column
    expect(s.lat_sum).toBe(14.2);
    expect(s.rej_bad_token).toBe(2);
    expect(s.rej_unregistered).toBe(1);
    expect(s.rej_other).toBe(3);                 // unknown reason + the literal "other"
  });

  it("an old push relay (no new series) still parses, new fields 0", () => {
    const s = parsePushMetrics("pushrelay_push_total 5\npushrelay_devices 2\n");
    expect(s.push).toBe(5);
    expect(s.devices).toBe(2);
    expect(s.push_failed).toBe(0);
    expect(s.lat_count).toBe(0);
    expect(Object.keys(s).sort()).toEqual([...PUSH_FIELDS].sort());
  });
});

const ZERO = parsePushMetrics("");
const sample = (ts, over) => ({ ts, ...ZERO, ...over });

describe("buildPush: APNs stats", () => {
  const window = { fromMs: 0, toMs: 400_000, buckets: 4, nowMs: 400_000 };

  it("computes success %, latency quantiles, reasons, connection tiles", () => {
    const a = sample(100_000, {});
    const b = sample(200_000, {
      ...parsePushMetrics(EXPO), apns_sessions: 1, apns_oldest_session_s: 600,
    });
    const p = buildPush([a, b], { ...window, latest: b });
    const t = p.tiles;
    expect(t.delivered).toBe(7);
    expect(t.failed).toBe(3);
    expect(t.success_pct).toBe(70);                       // 7 / (7+3)
    expect(t.rejected_total).toBe(6);
    expect(t.reasons[0]).toEqual({ reason: "other", count: 3 });   // biggest first
    expect(t.reasons.map((r) => r.reason)).toEqual(["other", "BadDeviceToken", "Unregistered"]);
    expect(t.apns_connects).toBe(4);
    expect(t.apns_throttled).toBe(1);
    expect(t.apns_discarded).toBe(2);
    expect(t.apns_timeouts).toBe(1);
    expect(t.apns_sessions).toBe(1);
    expect(t.apns_session_age_s).toBe(600);
    expect(t.latency_samples).toBe(10);
    // 10 samples: p50 rank 5 falls in (50,100]ms (cum 1 -> 5) => the top of it
    expect(t.latency_p50_ms).toBe(100);
    // p95 rank 9.5 is above every finite bucket (9) => reported as the last bound
    expect(t.latency_p95_ms).toBe(10000);
  });

  it("reports last-delivery age from the gauge, and none when 0", () => {
    const withDelivery = sample(1_700_000_000_000, { last_delivery_ts: 1_699_999_000 });
    let p = buildPush([withDelivery], { ...window, latest: withDelivery });
    expect(p.tiles.last_delivery_age_ms).toBe(1_000_000);   // 1000s earlier
    const none = sample(1_700_000_000_000, { last_delivery_ts: 0 });
    p = buildPush([none], { ...window, latest: none });
    expect(p.tiles.last_delivery_age_ms).toBeNull();
  });

  it("success % is null (not 100) when nothing reached Apple", () => {
    const a = sample(1, {}), b = sample(2, { push: 3, push_bad_secret: 3 });
    expect(buildPush([a, b], { ...window, latest: b }).tiles.success_pct).toBeNull();
  });

  it("a relay restart (counters reset) contributes no negative traffic", () => {
    const a = sample(1, { push_delivered: 50, push_failed: 5, lat_count: 55, lat_le100: 55 });
    const b = sample(2, { push_delivered: 2, push_failed: 0, lat_count: 2, lat_le100: 2 });  // restarted
    const t = buildPush([a, b], { ...window, latest: b }).tiles;
    expect(t.delivered).toBe(0);
    expect(t.failed).toBe(0);
    expect(t.latency_samples).toBe(0);
    expect(t.latency_p50_ms).toBeNull();
  });

  it("charts delivered vs failed per minute and latency p50/p95 per slot", () => {
    const rows = [
      sample(0, {}),
      sample(60_000, { push_delivered: 10, push_failed: 2, lat_count: 12, lat_le50: 12, lat_le100: 12, lat_le250: 12, lat_le500: 12, lat_le1000: 12, lat_le2500: 12, lat_le5000: 12, lat_le10000: 12 }),
    ];
    const p = buildPush(rows, { fromMs: 0, toMs: 120_000, buckets: 2, nowMs: 120_000, latest: rows[1] });
    const slot1 = (k) => p.series[k][1];   // a rate lands in the slot of the LATER sample (t=60s -> slot 1)
    expect(slot1("push_delivered_rate").v).toBe(10);   // 10 over 60s = 10/min
    expect(slot1("push_failed_rate").v).toBe(2);
    expect(slot1("apns_latency_p50").v).toBeLessThanOrEqual(50);   // all 12 under 50ms
    expect(slot1("apns_latency_p95").v).toBeLessThanOrEqual(50);
    expect(p.series.push_delivered_rate[0].v).toBeNull();           // no data => gap, not 0
    expect(p.series.apns_latency_p50[0].v).toBeNull();
  });
});

describe("DashboardDB upgrade", () => {
  it("adds the new push columns to a push_samples table created by an older version", () => {
    // An old DB: push_samples with only a few of the columns.
    const raw = new Database(":memory:");
    raw.exec("CREATE TABLE push_samples (ts INTEGER PRIMARY KEY, devices REAL NOT NULL DEFAULT 0, push REAL NOT NULL DEFAULT 0)");
    raw.prepare("INSERT INTO push_samples (ts, devices, push) VALUES (1, 3, 9)").run();
    const db = new DashboardDB(":memory:");
    db.db = raw; // exercise ensureColumns against the legacy table
    db.ensureColumns("push_samples", PUSH_FIELDS);
    const cols = raw.prepare("PRAGMA table_info(push_samples)").all().map((c) => c.name);
    for (const f of PUSH_FIELDS) expect(cols).toContain(f);
    expect(raw.prepare("SELECT * FROM push_samples").get().push_failed).toBe(0);   // backfilled
    raw.close();
  });
});

describe("push-relay-only dashboard (relay collector disabled)", () => {
  let dash, base;
  const auth = "Basic " + Buffer.from("admin:pw").toString("base64");
  beforeAll(async () => {
    const db = new DashboardDB(":memory:");
    db.insertPush(Date.now() - 1000, parsePushMetrics(EXPO));
    db.insertPush(Date.now(), parsePushMetrics(EXPO));
    dash = createDashboard({
      db, user: "admin", pass: "pw",
      metricsUrl: "", pushMetricsUrl: "http://127.0.0.1:1/metrics",
      startCollectorOnListen: false,
    });
    await dash.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${dash.address().port}`;
  });
  afterAll(async () => { await dash.close(); });

  it("serves a push-only payload and the page", async () => {
    const data = await (await fetch(base + "/api/data?range=1h", { headers: { authorization: auth } })).json();
    expect(data.relay_enabled).toBe(false);
    expect(data.tiles).toBeNull();
    expect(data.push.tiles.apns_connects).toBeGreaterThanOrEqual(0);
    expect(data.push.series.push_failed_rate).toBeDefined();
    const page = await (await fetch(base + "/", { headers: { authorization: auth } })).text();
    expect(page).toContain("relay_enabled");
  });
});
