// Push-relay stats end to end in the dashboard: parse the pushrelay_* exposition,
// store it in the separate push_samples table, derive tiles/series, and expose it
// on /api/data as payload.push.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parsePushMetrics } from "../../dashboard/parse.js";
import { DashboardDB } from "../../dashboard/db.js";
import { buildPush } from "../../dashboard/series.js";
import { createDashboard } from "../../dashboard/server.js";

const SAMPLE = `# HELP pushrelay_register_total POST /register calls.
# TYPE pushrelay_register_total counter
pushrelay_register_total 40
pushrelay_register_written_total 5
pushrelay_register_skipped_total 35
pushrelay_register_rejected_total 0
pushrelay_push_total 12
pushrelay_push_delivered_total 10
pushrelay_push_bad_secret_total 2
pushrelay_push_unknown_token_total 0
pushrelay_push_apns_error_total 0
pushrelay_rate_limited_total 0
pushrelay_http_requests_total 52
pushrelay_http_errors_total 0
pushrelay_process_exceptions_total 0
# TYPE pushrelay_devices gauge
pushrelay_devices 3
`;

describe("parsePushMetrics", () => {
  it("flattens the pushrelay_* series (unknowns default 0)", () => {
    const s = parsePushMetrics(SAMPLE);
    expect(s.register).toBe(40);
    expect(s.register_written).toBe(5);
    expect(s.register_skipped).toBe(35);
    expect(s.push_delivered).toBe(10);
    expect(s.push_bad_secret).toBe(2);
    expect(s.devices).toBe(3);
    expect(s.push_apns_error).toBe(0);
  });
});

describe("push_samples storage", () => {
  it("round-trips push rows separately from relay samples", () => {
    const db = new DashboardDB(":memory:");
    db.insert(1000, {}); // a relay sample — must not collide with push
    db.insertPush(1000, parsePushMetrics(SAMPLE));
    db.insertPush(2000, { ...parsePushMetrics(SAMPLE), devices: 4 });
    expect(db.latestPush().devices).toBe(4);
    expect(db.rangePush(0, 5000)).toHaveLength(2);
    expect(db.prunePush(1500)).toBe(1); // drops the ts=1000 push row
    db.close();
  });
});

describe("buildPush", () => {
  it("computes tiles (deliver %, skip %, device gauge) reset-aware", () => {
    const a = parsePushMetrics(SAMPLE);
    const b = { ...a, register: 80, register_written: 10, register_skipped: 70, push: 24, push_delivered: 20, push_bad_secret: 4, devices: 3 };
    const p = buildPush([{ ts: 1000, ...a }, { ts: 2000, ...b }], { fromMs: 0, toMs: 3000, buckets: 4, nowMs: 3000, latest: { ts: 2000, ...b } });
    expect(p.tiles.devices).toBe(3);           // gauge = latest
    expect(p.tiles.registrations).toBe(40);    // 80 - 40
    expect(p.tiles.skips).toBe(35);            // 70 - 35
    expect(p.tiles.skip_pct).toBe(87.5);       // 35/40
    expect(p.tiles.pushes).toBe(12);           // 24 - 12
    expect(p.tiles.delivered).toBe(10);        // 20 - 10
    expect(p.tiles.deliver_pct).toBe(83.3);    // 10/12
    expect(p.tiles.bad_secret).toBe(2);        // 4 - 2
    expect(Array.isArray(p.series.push_delivered_rate)).toBe(true);
    expect(Array.isArray(p.series.devices)).toBe(true);
  });
});

describe("server payload.push", () => {
  let dash, base, db;
  const auth = "Basic " + Buffer.from("admin:pw").toString("base64");
  beforeAll(async () => {
    db = new DashboardDB(":memory:");
    db.insertPush(Date.now() - 1000, { ...parsePushMetrics(SAMPLE) });
    db.insertPush(Date.now(), { ...parsePushMetrics(SAMPLE), devices: 7 });
    dash = createDashboard({ db, user: "admin", pass: "pw", startCollectorOnListen: false });
    await dash.listen(0);
    base = `http://127.0.0.1:${dash.address().port}`;
  });
  afterAll(async () => { await dash.close(); db.close(); });

  it("includes payload.push with the device gauge", async () => {
    const res = await fetch(base + "/api/data?range=24h", { headers: { authorization: auth } });
    const data = await res.json();
    expect(data.push).toBeTruthy();
    expect(data.push.tiles.devices).toBe(7);
    expect(Array.isArray(data.push.series.push_bad_secret_rate)).toBe(true);
  });

  it("omits payload.push when push collection is disabled", async () => {
    const db2 = new DashboardDB(":memory:");
    const d2 = createDashboard({ db: db2, user: "admin", pass: "pw", startCollectorOnListen: false, pushMetricsUrl: "" });
    await d2.listen(0);
    const b2 = `http://127.0.0.1:${d2.address().port}`;
    const data = await (await fetch(b2 + "/api/data", { headers: { authorization: auth } })).json();
    expect(data.push).toBeUndefined();
    await d2.close(); db2.close();
  });
});
