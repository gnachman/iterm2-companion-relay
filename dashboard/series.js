// Turn stored samples into what the page draws: at-a-glance tiles, historical
// chart series, and a health panel. Pure (rows in, JSON out) so it is unit-tested
// without a DB or a server.
//
// REUSE: the relay already ships a monitor (monitor/src/monitor.js) whose pure,
// unit-tested checks decide when to PAGE. The dashboard SHOWS the same state, so
// it imports those very functions — capAlerts / errorAlert / exceptionAlert —
// rather than re-deriving thresholds that could drift from what actually alerts.
// The dashboard and the pager therefore always agree on "is this healthy".
// Reset handling here comes from the reset-aware windowTotal/step below (not a
// deltas() gate, which is per-interval and the wrong altitude for a window total).
//
// The relay's counters are cumulative and reset to ~0 on restart, so every rate
// here is computed from RESET-AWARE adjacent deltas (a negative step is a restart,
// not negative traffic — it contributes 0 and starts a fresh interval).

import { capAlerts, errorAlert, exceptionAlert } from "../monitor/src/monitor.js";
import { LAT_BOUNDS_MS, LAT_COLUMNS, REJECT_FIELDS, REJECT_LABELS } from "./parse.js";

// Reset-aware delta of one cumulative column between two rows.
function step(prev, cur, field) {
  const d = cur[field] - prev[field];
  return d < 0 ? 0 : d; // counter went backwards => relay restarted => skip
}

// Sum reset-aware deltas of `field` across a row series.
function windowTotal(rows, field) {
  let total = 0;
  for (let i = 1; i < rows.length; i++) total += step(rows[i - 1], rows[i], field);
  return total;
}

// Bucket the window into `buckets` equal slots and, for each, emit one point.
// Gauges average the samples in the slot; counter RATES sum reset-aware deltas
// and divide by the wall-clock the slot actually observed (per minute). A slot
// with no data is emitted as null so the chart shows a gap, not a false zero.
function bucketize(rows, fromMs, toMs, buckets) {
  const span = Math.max(1, toMs - fromMs);
  const width = span / buckets;
  const idx = (ts) => Math.min(buckets - 1, Math.max(0, Math.floor((ts - fromMs) / width)));

  const gaugeAcc = Array.from({ length: buckets }, () => ({ sockets: 0, rooms: 0, both: 0, macOnly: 0, n: 0 }));
  for (const r of rows) {
    const b = gaugeAcc[idx(r.ts)];
    b.sockets += r.sockets_live;
    b.rooms += r.rooms_live;
    b.both += r.rooms_both;
    b.macOnly += r.rooms_mac_only;
    b.n += 1;
  }

  // Rate/derived accumulators, attributed to the bucket of the later sample.
  const rateFields = ["ws_upgrades", "ws_rejected", "http_requests", "http_errors", "exceptions", "quota_exceeded"];
  const rateAcc = Array.from({ length: buckets }, () => {
    const o = { elapsedMs: 0, closed: 0, shortLived: 0 };
    for (const f of rateFields) o[f] = 0;
    return o;
  });
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    const acc = rateAcc[idx(cur.ts)];
    acc.elapsedMs += Math.max(0, cur.ts - prev.ts);
    for (const f of rateFields) acc[f] += step(prev, cur, f);
    acc.closed += step(prev, cur, "life_count");
    acc.shortLived += step(prev, cur, "life_le1");
  }

  const centers = Array.from({ length: buckets }, (_, i) => Math.round(fromMs + width * (i + 0.5)));
  const gaugeSeries = (pick) => centers.map((t, i) => {
    const b = gaugeAcc[i];
    return { t, v: b.n ? +(pick(b) / b.n).toFixed(2) : null };
  });
  const rateSeries = (field) => centers.map((t, i) => {
    const a = rateAcc[i];
    return { t, v: a.elapsedMs > 0 ? +((a[field] / a.elapsedMs) * 60000).toFixed(3) : null };
  });

  return {
    sockets_live: gaugeSeries((b) => b.sockets),
    rooms_live: gaugeSeries((b) => b.rooms),
    rooms_both: gaugeSeries((b) => b.both),
    rooms_mac_only: gaugeSeries((b) => b.macOnly),
    upgrade_rate: rateSeries("ws_upgrades"),
    request_rate: rateSeries("http_requests"),
    error_rate: rateSeries("http_errors"),
    rejected_rate: rateSeries("ws_rejected"),
    quota_rate: rateSeries("quota_exceeded"),
    // Fraction of connections that closed within 1s in each slot: the flap signal.
    short_lived_frac: centers.map((t, i) => {
      const a = rateAcc[i];
      return { t, v: a.closed > 0 ? +(a.shortLived / a.closed).toFixed(3) : null };
    }),
  };
}

// Build the full dashboard payload for a window. `rows` are samples in [fromMs,
// toMs] oldest-first; `latest` is the newest sample overall (may be outside the
// window if the collector recently stalled); `caps` and `errorCfg` mirror the
// monitor's config so the health panel matches the pager.
export function buildDashboard(rows, {
  latest = null,
  fromMs,
  toMs,
  buckets = 240,
  nowMs,
  caps = { socketsCap: 200000, roomsCap: 200000, warnFrac: 0.7, critFrac: 0.9 },
  errorCfg = { ratioThreshold: 0.05, minRequests: 100, exceptionThreshold: 1 },
} = {}) {
  const cur = latest || (rows.length ? rows[rows.length - 1] : null);
  const requests = windowTotal(rows, "http_requests");
  const errors = windowTotal(rows, "http_errors");
  const closed = windowTotal(rows, "life_count");
  const shortLived = windowTotal(rows, "life_le1");
  const lifeSum = windowTotal(rows, "life_sum");
  const exceptions = windowTotal(rows, "exceptions");

  const tiles = {
    sockets_live: cur ? cur.sockets_live : 0,
    rooms_live: cur ? cur.rooms_live : 0,
    // Room occupancy right now: paired (mac+phone spliced), mac parked awaiting
    // a phone, and the phone-only invariant tripwire (should stay 0).
    rooms_both: cur ? (cur.rooms_both || 0) : 0,
    rooms_mac_only: cur ? (cur.rooms_mac_only || 0) : 0,
    rooms_phone_only: cur ? (cur.rooms_phone_only || 0) : 0,
    upgrades: windowTotal(rows, "ws_upgrades"),
    rejected: windowTotal(rows, "ws_rejected"),
    requests,
    errors,
    error_pct: requests > 0 ? +((errors / requests) * 100).toFixed(2) : 0,
    exceptions,
    push_errors: windowTotal(rows, "push_errors"),
    quota_closes: windowTotal(rows, "quota_exceeded"),
    // Shard state: gauges from the newest sample, counters as reset-aware
    // window totals. Direct mode shows version -1 (no map) and zeros; the page
    // renders that as "direct". shard_map_fetch_errors is THE stale-map alarm:
    // a partitioned host serves last-known-good forever by design (§8), so a
    // climbing value here is the operator's cue to intervene.
    shard_map_version: cur ? (cur.shard_map_version ?? -1) : -1,
    shard_owned_buckets: cur ? (cur.shard_owned_buckets || 0) : 0,
    shard_draining_buckets: cur ? (cur.shard_draining_buckets || 0) : 0,
    shard_rejects: windowTotal(rows, "shard_reject"),
    shard_map_reloads: windowTotal(rows, "shard_map_reloads"),
    shard_map_fetch_errors: windowTotal(rows, "shard_map_fetch_errors"),
    closed,
    short_lived_pct: closed > 0 ? +((shortLived / closed) * 100).toFixed(1) : 0,
    avg_lifetime_s: closed > 0 ? +(lifeSum / closed).toFixed(1) : 0,
    last_sample_ts: latest ? latest.ts : (rows.length ? rows[rows.length - 1].ts : null),
    stale_ms: latest && nowMs ? nowMs - latest.ts : null,
  };

  // Health: exactly the checks the off-box monitor runs, over the same window.
  const alerts = [];
  if (cur) {
    alerts.push(...capAlerts([
      { key: "sockets", label: "Live sockets", used: cur.sockets_live, cap: caps.socketsCap, warnFrac: caps.warnFrac, critFrac: caps.critFrac, unit: "" },
      { key: "rooms", label: "Live rooms", used: cur.rooms_live, cap: caps.roomsCap, warnFrac: caps.warnFrac, critFrac: caps.critFrac, unit: "" },
    ]));
  }
  // The window totals (requests/errors/exceptions) are already reset-aware:
  // windowTotal sums per-adjacent-step deltas and clamps a restart's negative step
  // to 0. So no whole-window reset gate is needed here. A newest-vs-oldest deltas()
  // test would be at the wrong altitude -- it reports reset:true whenever the relay
  // restarted anywhere in the window (a routine deploy), which would wrongly suppress
  // BOTH health alerts for the entire range while the tiles on the same page (built
  // from these same totals with no gate) still show the elevated values.
  const e = errorAlert({ requests, errors, ratioThreshold: errorCfg.ratioThreshold, minRequests: errorCfg.minRequests });
  if (e) alerts.push(e);
  const x = exceptionAlert({ count: exceptions, threshold: errorCfg.exceptionThreshold });
  if (x) alerts.push(x);

  return {
    window: { fromMs, toMs, buckets },
    tiles,
    alerts,
    series: bucketize(rows, fromMs, toMs, buckets),
  };
}

// --- Push relay -------------------------------------------------------------
// Same reset-aware treatment as the relay (counters reset to ~0 on restart), for
// the push_samples rows. Gauges (devices, apns_sessions, session age) are
// averaged per slot; everything else is a cumulative counter charted as a
// per-minute rate and summed over the window for a tile.
const PUSH_RATE_FIELDS = [
  "register", "register_written", "register_skipped", "register_rejected",
  "push", "push_delivered", "push_failed", "push_bad_secret", "push_unknown_token",
  "push_apns_error", "rate_limited",
  "apns_connects", "apns_throttled", "apns_session_errors", "apns_discard_idle",
  "apns_discard_timeout", "apns_timeouts", "lat_count",
  ...LAT_COLUMNS, ...REJECT_FIELDS,
];
const PUSH_GAUGES = ["devices", "apns_sessions", "apns_oldest_session_s"];

// Estimate a latency quantile (ms) from per-bound CUMULATIVE counts, interpolating
// linearly inside the bucket like Prometheus' histogram_quantile. Observations
// above the last bound can only be reported as that bound (the true value is at
// least that), which is the conservative reading. null when nothing was observed.
function latencyQuantile(q, cum, total) {
  if (!(total > 0)) return null;
  const rank = q * total;
  let prevCount = 0, prevBound = 0;
  for (let i = 0; i < LAT_BOUNDS_MS.length; i++) {
    if (cum[i] >= rank) {
      const inBucket = cum[i] - prevCount;
      if (inBucket <= 0) return LAT_BOUNDS_MS[i];
      return Math.round(prevBound + (LAT_BOUNDS_MS[i] - prevBound) * ((rank - prevCount) / inBucket));
    }
    prevCount = cum[i];
    prevBound = LAT_BOUNDS_MS[i];
  }
  return LAT_BOUNDS_MS[LAT_BOUNDS_MS.length - 1];
}

function bucketizePush(rows, fromMs, toMs, buckets) {
  const span = Math.max(1, toMs - fromMs);
  const width = span / buckets;
  const idx = (ts) => Math.min(buckets - 1, Math.max(0, Math.floor((ts - fromMs) / width)));

  const gaugeAcc = Array.from({ length: buckets }, () => {
    const o = { n: 0 };
    for (const g of PUSH_GAUGES) o[g] = 0;
    return o;
  });
  for (const r of rows) {
    const b = gaugeAcc[idx(r.ts)];
    for (const g of PUSH_GAUGES) b[g] += r[g];
    b.n += 1;
  }

  const rateAcc = Array.from({ length: buckets }, () => {
    const o = { elapsedMs: 0 };
    for (const f of PUSH_RATE_FIELDS) o[f] = 0;
    return o;
  });
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    const acc = rateAcc[idx(cur.ts)];
    acc.elapsedMs += Math.max(0, cur.ts - prev.ts);
    for (const f of PUSH_RATE_FIELDS) acc[f] += step(prev, cur, f);
  }

  const centers = Array.from({ length: buckets }, (_, i) => Math.round(fromMs + width * (i + 0.5)));
  const gauge = (field) => centers.map((t, i) => { const b = gaugeAcc[i]; return { t, v: b.n ? +(b[field] / b.n).toFixed(2) : null }; });
  const rate = (field) => centers.map((t, i) => {
    const a = rateAcc[i];
    return { t, v: a.elapsedMs > 0 ? +((a[field] / a.elapsedMs) * 60000).toFixed(3) : null };
  });
  const quantile = (q) => centers.map((t, i) => {
    const a = rateAcc[i];
    return { t, v: latencyQuantile(q, LAT_COLUMNS.map((c) => a[c]), a.lat_count) };
  });

  return {
    devices: gauge("devices"),
    register_written_rate: rate("register_written"),
    register_skipped_rate: rate("register_skipped"),
    push_delivered_rate: rate("push_delivered"),
    push_failed_rate: rate("push_failed"),
    push_bad_secret_rate: rate("push_bad_secret"),
    apns_connects_rate: rate("apns_connects"),
    apns_timeouts_rate: rate("apns_timeouts"),
    apns_sessions: gauge("apns_sessions"),
    apns_latency_p50: quantile(0.5),
    apns_latency_p95: quantile(0.95),
  };
}

// Build the push-relay payload for a window. Same args as buildDashboard; returns
// { tiles, series } (no separate alerts panel — failure/timeout tiles carry the
// status). `latest` is the newest push sample overall.
export function buildPush(rows, { latest = null, fromMs, toMs, buckets = 240, nowMs } = {}) {
  const cur = latest || (rows.length ? rows[rows.length - 1] : null);
  const registrations = windowTotal(rows, "register");
  const skips = windowTotal(rows, "register_skipped");
  const pushes = windowTotal(rows, "push");
  const delivered = windowTotal(rows, "push_delivered");
  const failed = windowTotal(rows, "push_failed");
  const attempts = delivered + failed;   // pushes that actually reached an outcome at APNs

  // Window-wide latency quantiles from the summed per-bound deltas.
  const latCum = LAT_COLUMNS.map((c) => windowTotal(rows, c));
  const latCount = windowTotal(rows, "lat_count");

  // Apple's rejections by reason, nonzero only, biggest first.
  const reasons = REJECT_FIELDS
    .map((f) => ({ reason: REJECT_LABELS[f], count: windowTotal(rows, f) }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);

  // Age of the last delivery as of the newest sample. The relay reports 0 until
  // it delivers something after (re)start, so that reads as "none yet" (null).
  const lastDeliveryMs = cur && cur.last_delivery_ts > 0 ? cur.last_delivery_ts * 1000 : null;

  const tiles = {
    devices: cur ? cur.devices : 0,
    registrations,
    writes: windowTotal(rows, "register_written"),
    skips,
    skip_pct: registrations > 0 ? +((skips / registrations) * 100).toFixed(1) : 0,
    pushes,
    delivered,
    deliver_pct: pushes > 0 ? +((delivered / pushes) * 100).toFixed(1) : 0,
    failed,
    // Of pushes that were attempted against Apple, how many succeeded. Client
    // faults (bad secret, unknown token) are excluded: they never reach APNs.
    success_pct: attempts > 0 ? +((delivered / attempts) * 100).toFixed(1) : null,
    bad_secret: windowTotal(rows, "push_bad_secret"),
    unknown_token: windowTotal(rows, "push_unknown_token"),
    apns_errors: windowTotal(rows, "push_apns_error"),
    rate_limited: windowTotal(rows, "rate_limited"),
    reasons,
    rejected_total: reasons.reduce((n, r) => n + r.count, 0),
    latency_p50_ms: latencyQuantile(0.5, latCum, latCount),
    latency_p95_ms: latencyQuantile(0.95, latCum, latCount),
    latency_samples: latCount,
    apns_sessions: cur ? cur.apns_sessions : 0,
    apns_session_age_s: cur ? cur.apns_oldest_session_s : 0,
    apns_connects: windowTotal(rows, "apns_connects"),
    apns_throttled: windowTotal(rows, "apns_throttled"),
    apns_timeouts: windowTotal(rows, "apns_timeouts"),
    apns_session_errors: windowTotal(rows, "apns_session_errors"),
    apns_discarded: windowTotal(rows, "apns_discard_idle") + windowTotal(rows, "apns_discard_timeout"),
    last_delivery_age_ms: lastDeliveryMs != null && cur ? Math.max(0, cur.ts - lastDeliveryMs) : null,
    last_sample_ts: latest ? latest.ts : (rows.length ? rows[rows.length - 1].ts : null),
    stale_ms: latest && nowMs ? nowMs - latest.ts : null,
  };

  return { tiles, series: bucketizePush(rows, fromMs, toMs, buckets) };
}
