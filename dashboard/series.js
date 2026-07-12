// Turn stored samples into what the page draws: at-a-glance tiles, historical
// chart series, and a health panel. Pure (rows in, JSON out) so it is unit-tested
// without a DB or a server.
//
// REUSE: the relay already ships a monitor (monitor/src/monitor.js) whose pure,
// unit-tested checks decide when to PAGE. The dashboard SHOWS the same state, so
// it imports those very functions — capAlerts / errorAlert / exceptionAlert /
// deltas — rather than re-deriving thresholds that could drift from what actually
// alerts. The dashboard and the pager therefore always agree on "is this healthy".
//
// The relay's counters are cumulative and reset to ~0 on restart, so every rate
// here is computed from RESET-AWARE adjacent deltas (a negative step is a restart,
// not negative traffic — it contributes 0 and starts a fresh interval).

import { deltas, capAlerts, errorAlert, exceptionAlert } from "../monitor/src/monitor.js";

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

  const gaugeAcc = Array.from({ length: buckets }, () => ({ sockets: 0, rooms: 0, n: 0 }));
  for (const r of rows) {
    const b = gaugeAcc[idx(r.ts)];
    b.sockets += r.sockets_live;
    b.rooms += r.rooms_live;
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
    upgrades: windowTotal(rows, "ws_upgrades"),
    rejected: windowTotal(rows, "ws_rejected"),
    requests,
    errors,
    error_pct: requests > 0 ? +((errors / requests) * 100).toFixed(2) : 0,
    exceptions,
    push_errors: windowTotal(rows, "push_errors"),
    quota_closes: windowTotal(rows, "quota_exceeded"),
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
  // deltas() gives the reset-aware interval shape errorAlert/exceptionAlert want.
  const d = deltas(
    rows.length ? { requests: rows[0].http_requests, errors: rows[0].http_errors, exceptions: rows[0].exceptions } : null,
    { requests: (cur || {}).http_requests || 0, errors: (cur || {}).http_errors || 0, exceptions: (cur || {}).exceptions || 0 },
  );
  if (!d.reset) {
    const e = errorAlert({ requests, errors, ratioThreshold: errorCfg.ratioThreshold, minRequests: errorCfg.minRequests });
    if (e) alerts.push(e);
    const x = exceptionAlert({ count: exceptions, threshold: errorCfg.exceptionThreshold });
    if (x) alerts.push(x);
  }

  return {
    window: { fromMs, toMs, buckets },
    tiles,
    alerts,
    series: bucketize(rows, fromMs, toMs, buckets),
  };
}

// --- Push relay -------------------------------------------------------------
// Same reset-aware treatment as the relay (counters reset to ~0 on restart), for
// the push_samples rows. `devices` is a gauge; everything else is a cumulative
// counter charted as a per-minute rate and summed over the window for a tile.
const PUSH_RATE_FIELDS = [
  "register", "register_written", "register_skipped", "register_rejected",
  "push", "push_delivered", "push_bad_secret", "push_unknown_token",
  "push_apns_error", "rate_limited",
];

function bucketizePush(rows, fromMs, toMs, buckets) {
  const span = Math.max(1, toMs - fromMs);
  const width = span / buckets;
  const idx = (ts) => Math.min(buckets - 1, Math.max(0, Math.floor((ts - fromMs) / width)));

  const gaugeAcc = Array.from({ length: buckets }, () => ({ devices: 0, n: 0 }));
  for (const r of rows) { const b = gaugeAcc[idx(r.ts)]; b.devices += r.devices; b.n += 1; }

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
  const gauge = centers.map((t, i) => { const b = gaugeAcc[i]; return { t, v: b.n ? +(b.devices / b.n).toFixed(2) : null }; });
  const rate = (field) => centers.map((t, i) => {
    const a = rateAcc[i];
    return { t, v: a.elapsedMs > 0 ? +((a[field] / a.elapsedMs) * 60000).toFixed(3) : null };
  });

  return {
    devices: gauge,
    register_written_rate: rate("register_written"),
    register_skipped_rate: rate("register_skipped"),
    push_delivered_rate: rate("push_delivered"),
    push_bad_secret_rate: rate("push_bad_secret"),
  };
}

// Build the push-relay payload for a window. Same args as buildDashboard; returns
// { tiles, series } (no separate alerts panel — bad-secret/APNs-error tiles carry
// the status). `latest` is the newest push sample overall.
export function buildPush(rows, { latest = null, fromMs, toMs, buckets = 240, nowMs } = {}) {
  const cur = latest || (rows.length ? rows[rows.length - 1] : null);
  const registrations = windowTotal(rows, "register");
  const skips = windowTotal(rows, "register_skipped");
  const pushes = windowTotal(rows, "push");
  const delivered = windowTotal(rows, "push_delivered");

  const tiles = {
    devices: cur ? cur.devices : 0,
    registrations,
    writes: windowTotal(rows, "register_written"),
    skips,
    skip_pct: registrations > 0 ? +((skips / registrations) * 100).toFixed(1) : 0,
    pushes,
    delivered,
    deliver_pct: pushes > 0 ? +((delivered / pushes) * 100).toFixed(1) : 0,
    bad_secret: windowTotal(rows, "push_bad_secret"),
    unknown_token: windowTotal(rows, "push_unknown_token"),
    apns_errors: windowTotal(rows, "push_apns_error"),
    rate_limited: windowTotal(rows, "rate_limited"),
    last_sample_ts: latest ? latest.ts : (rows.length ? rows[rows.length - 1].ts : null),
    stale_ms: latest && nowMs ? nowMs - latest.ts : null,
  };

  return { tiles, series: bucketizePush(rows, fromMs, toMs, buckets) };
}
