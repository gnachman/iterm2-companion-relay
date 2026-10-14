// Pure analysis for the relay monitor. No I/O: the worker shell feeds it the
// aggregate snapshot the relay PUSHED (counts + gauges -- never per-request data
// or IPs, consistent with the relay's no-logging posture) plus prior state from
// KV, and sends whatever alerts come back. Kept pure so the alerting logic is
// unit-tested deterministically.
//
// The relay is self-hosted and exposes /metrics only on loopback, so there is
// nothing to scrape from off-box. Instead the relay posts a snapshot of its own
// counters/gauges to the monitor; this module turns a series of those snapshots
// into alerts:
//   - liveness: the collector saw no fresh snapshot within the staleness window
//   - capacity: live sockets/rooms approaching the relay's configured caps
//   - error rate: HTTP 500s as a fraction of requests over the interval
//   - exceptions: swallowed process exceptions over the interval
//   - anomaly: hourly request volume vs the per-hour-of-week baseline

export function median(nums) {
  if (!nums || nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Append a sample to the per-hour-of-week history (object: "0".."167" -> array),
// keeping only the most recent `maxSamples` so the baseline tracks recent weeks.
export function pushSample(history, hourOfWeek, value, maxSamples) {
  const key = String(hourOfWeek);
  const arr = [...(history[key] || []), value];
  return { ...history, [key]: arr.slice(-maxSamples) };
}

// ISO hour bucket "YYYY-MM-DDTHH:00:00.000Z" for a millisecond timestamp. Stable
// key for detecting a clock-hour rollover and for deriving the hour-of-week.
export function hourKey(ms) {
  return new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();
}

// 0..167, Monday 00:00 UTC = 0. Stable bucket for the weekly baseline.
export function hourOfWeek(iso) {
  const d = new Date(iso);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  return dow * 24 + d.getUTCHours();
}

// Cap proximity: warn/critical when a metered resource crosses a fraction of its
// cap, so there is lead time before it is exhausted.
// meters: [{ key, label, used, cap, warnFrac, critFrac, unit }]
export function capAlerts(meters) {
  const alerts = [];
  for (const m of meters) {
    if (!m.cap) continue;
    const frac = m.used / m.cap;
    const pct = Math.round(frac * 100);
    const u = m.unit ? ` ${m.unit}` : "";
    const detail = `${m.label}: ${m.used}${u} of ${m.cap}${u} (${pct}%) in use.`;
    if (frac >= m.critFrac) {
      alerts.push({ key: `cap:${m.key}`, severity: "critical", title: `${m.label} near cap (${pct}%)`, body: detail });
    } else if (frac >= m.warnFrac) {
      alerts.push({ key: `cap:${m.key}`, severity: "warn", title: `${m.label} elevated (${pct}%)`, body: detail });
    }
  }
  return alerts;
}

// Error-rate alert with an absolute-volume floor so a couple of errors over a
// handful of requests never pages.
export function errorAlert({ requests, errors, ratioThreshold, minRequests }) {
  if (requests < minRequests) return null;
  const ratio = requests > 0 ? errors / requests : 0;
  if (ratio < ratioThreshold) return null;
  const pct = (ratio * 100).toFixed(1);
  return {
    key: "errors",
    severity: ratio >= ratioThreshold * 2 ? "critical" : "warn",
    title: `Error rate ${pct}%`,
    body: `${errors} internal errors of ${requests} requests in the last interval (${pct}%).`,
  };
}

// Swallowed-exception alert. The relay catches process-level exceptions to keep
// serving and self-restarts past a burst; a nonzero count between checks means
// it is hitting unhandled errors and is worth surfacing.
export function exceptionAlert({ count, threshold }) {
  if (!count || count < threshold) return null;
  return {
    key: "exceptions",
    severity: count >= threshold * 5 ? "critical" : "warn",
    title: `Process exceptions: ${count}`,
    body: `${count} swallowed process exception(s) since the last check (threshold ${threshold}).`,
  };
}

// Shard map-fetch failures (distributed mode only; the counter is always 0 in
// direct mode). A host that cannot refresh the map serves last-known-good
// ownership indefinitely BY DESIGN (never fail-open/closed), so this condition
// does not self-heal into safety: across a reshard a partitioned host keeps
// serving buckets it no longer owns. The design's mitigation is operational
// (hard-stop a host that cannot reach the map), which makes this counter the
// operator's only cue, so it must page.
export function shardFetchErrorAlert({ count, threshold }) {
  if (!count || count < threshold) return null;
  return {
    key: "shard_fetch",
    severity: count >= threshold * 5 ? "critical" : "warn",
    title: `Shard-map fetch errors: ${count}`,
    body: `${count} shard-map fetch failure(s) since the last check (threshold ${threshold}). ` +
      `The relay keeps serving its last-known-good map; if this persists across a reshard, ` +
      `hard-stop the host to complete the drain.`,
  };
}

// --- shard-aware probe support (distributed fleets) ---
// Against a sharded fleet a random-room probe is wrong: a host that owns a
// small slice of the ring answers HTTP 421 (reject-on-doubt) for almost every
// random room, which is CORRECT relay behavior, not a broken inbound path. So
// the probe must ask each host about a room it actually owns. The bucket is the
// room name's last two bytes (big-endian), so an owned room can be constructed
// directly: 60 random hex chars + the 4-hex bucket.

// mapHosts(map) -> unique host strings in first-appearance order.
export function mapHosts(map) {
  const hosts = [];
  for (const r of (map && map.ranges) || []) {
    if (r && typeof r.host === "string" && !hosts.includes(r.host)) hosts.push(r.host);
  }
  return hosts;
}

// ownedRoomForHost(map, host, prefix60, randUnit) -> a 64-hex room whose bucket
// the host owns, or null if the map assigns it nothing (a drained host; skip it,
// that is a normal state). prefix60 is 60 caller-supplied lowercase hex chars
// (the caller owns randomness so this stays pure); randUnit in [0,1) picks
// uniformly across every bucket the host owns, so repeated probes exercise the
// whole owned set, disjoint arcs included.
export function ownedRoomForHost(map, host, prefix60, randUnit = 0) {
  if (!/^[0-9a-f]{60}$/.test(prefix60)) throw new Error("prefix60 must be 60 lowercase hex chars");
  const ranges = ((map && map.ranges) || []).filter((r) => r && r.host === host
    && Number.isInteger(r.low) && Number.isInteger(r.high) && r.low <= r.high);
  const total = ranges.reduce((n, r) => n + (r.high - r.low + 1), 0);
  if (total === 0) return null;
  let idx = Math.min(total - 1, Math.max(0, Math.floor(randUnit * total)));
  for (const r of ranges) {
    const size = r.high - r.low + 1;
    if (idx < size) return prefix60 + (r.low + idx).toString(16).padStart(4, "0");
    idx -= size;
  }
  return null; // unreachable: idx < total by construction
}

// Liveness: the collector has no fresh snapshot. This is the dead-man's-switch —
// a wedged or down relay stops pushing, so silence itself is the signal.
export function livenessAlert(detail) {
  return {
    key: "liveness",
    severity: "critical",
    title: "Relay not reporting",
    body: `No fresh metrics from the relay: ${detail}. The relay process or its host may be down.`,
  };
}

// Outside-in synthetic probe: drive a real mac-park pairing handshake over an
// already-open socket, the way a client would. This is what the metrics push
// CANNOT see — it traverses the whole inbound path (DNS, Cloudflare edge, origin
// firewall, proxy, WS upgrade, admission) instead of proving only that the
// process is alive and can reach outbound. A fresh room has no verifier, so the
// mac parks without App Attest; success means the serving path actually works.
//
// `socket` is a transport-agnostic adapter: { send(str), next(): Promise<str>,
// close() }. Pure of timers/transport so it is unit-tested with a scripted
// socket; the worker shell supplies the real WebSocket and the timeout.
export async function probeHandshake(socket) {
  try {
    socket.send(JSON.stringify({ v: 1, role: "mac" }));
    const challenge = JSON.parse(await socket.next());
    if (!challenge || typeof challenge.nonce !== "string") {
      return { ok: false, detail: "no challenge nonce in reply" };
    }
    socket.send(JSON.stringify({})); // empty proof; a fresh-room mac parks freely
    const result = JSON.parse(await socket.next());
    if (result && result.ok) return { ok: true, detail: "mac parked" };
    return { ok: false, detail: `admission rejected: ${(result && result.error) || "unknown"}` };
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e) };
  } finally {
    try { socket.close(); } catch { /* ignore */ }
  }
}

// The synthetic handshake failed: the inbound serving path is broken even if the
// process is up and pushing. Distinct from liveness so the two dedupe/escalate
// independently — push-alive + probe-dead is exactly the blind spot this closes.
export function probeAlert(detail) {
  return {
    key: "probe",
    severity: "critical",
    title: "Relay handshake failing",
    body: `A synthetic pairing handshake against the relay failed: ${detail}. `
      + `The inbound path (DNS, Cloudflare, origin firewall, proxy, WS upgrade, or `
      + `admission) may be broken even though the relay process is up.`,
  };
}

// Traffic anomaly vs the baseline for this hour-of-week. Silent until there is
// enough history (minSamples) and the baseline is large enough to be meaningful
// (minBaseline), so it does not cry wolf early or on near-idle hours.
export function anomalyAlert({ key, label, current, samples, spikeFactor, dropFactor, minBaseline, minSamples }) {
  if (!samples || samples.length < minSamples) return null;
  const base = median(samples);
  if (base === null || base < minBaseline) return null;
  if (current >= base * spikeFactor) {
    return {
      key: `anomaly:${key}`, severity: "warn",
      title: `Traffic spike: ${label}`,
      body: `${label} spike: ${current}, ~${(current / base).toFixed(1)}x the usual ${base} for this hour.`,
    };
  }
  if (current <= base * dropFactor) {
    return {
      key: `anomaly:${key}`, severity: "warn",
      title: `Traffic drop: ${label}`,
      body: `${label} drop: ${current}, well below the usual ${base} for this hour (possible outage).`,
    };
  }
  return null;
}

// Map a pushed snapshot (flat counter/gauge object) to the shapes the checks
// need: cumulative counters for interval diffing, and point-in-time gauges.
export function normalizeSnapshot(s = {}) {
  return {
    counters: {
      requests: s.http_requests_total || 0,
      errors: s.http_errors_total || 0,
      exceptions: s.process_exceptions_total || 0,
      shardMapFetchErrors: s.shard_map_fetch_errors_total || 0,
    },
    gauges: {
      socketsLive: s.sockets_live || 0,
      roomsLive: s.rooms_live || 0,
    },
  };
}

// Per-interval deltas between the previous snapshot's counters and the current
// one. A counter that went backwards means the relay restarted (counters reset
// to ~0), so the interval is unmeasurable: flag `reset` and skip rate checks
// rather than emit a bogus negative or huge delta.
export function deltas(prev, cur) {
  // `|| 0` throughout: KV state written by an older monitor build predates the
  // shard counter, and a missing field must read as 0, not NaN-poison the
  // deltas or fake a reset.
  const reset = { reset: true, requests: 0, errors: 0, exceptions: 0, shardMapFetchErrors: 0 };
  if (!prev) return reset;
  if (cur.requests < prev.requests || cur.errors < prev.errors || cur.exceptions < prev.exceptions ||
      (cur.shardMapFetchErrors || 0) < (prev.shardMapFetchErrors || 0)) {
    return reset;
  }
  return {
    reset: false,
    requests: cur.requests - prev.requests,
    errors: cur.errors - prev.errors,
    exceptions: cur.exceptions - prev.exceptions,
    shardMapFetchErrors: (cur.shardMapFetchErrors || 0) - (prev.shardMapFetchErrors || 0),
  };
}

// Fold cumulative counters into completed-clock-hour buckets for the weekly
// baseline. `anchor` holds the counter values captured at the start of the
// current hour; when the hour rolls over, the just-completed hour's requests are
// the difference. Returns the completed hour (or null) and the new anchor. A
// backwards counter (restart) reseeds the anchor without emitting a bucket.
export function rollHour(anchor, cur, nowHourKey) {
  const seed = { key: nowHourKey, requests: cur.requests, errors: cur.errors };
  if (!anchor || cur.requests < anchor.requests) return { lastHour: null, anchor: seed };
  if (nowHourKey === anchor.key) return { lastHour: null, anchor };
  const lastHour = {
    key: anchor.key,
    requests: cur.requests - anchor.requests,
    errors: cur.errors - anchor.errors,
  };
  return { lastHour, anchor: seed };
}

// Parse env strings into a typed config. The one guard that matters: retained
// history (maxSamples) must be at least the number of samples the anomaly check
// requires (minSamples), or the baseline can never reach the threshold and the
// check is silently dead. The original shipped config had maxSamples=6 <
// minSamples=14, which disabled anomaly detection entirely; clamp so a
// misconfiguration can never do that again.
export function parseConfig(env = {}) {
  // Treat a present-but-empty (or whitespace) var as unset: Number("") is 0 and
  // Number.isFinite(0) is true, so without this a blanked var (a plausible "disable
  // this knob" edit) would silently coerce to 0 instead of the default -- e.g.
  // STALE_MINUTES="" -> staleMs 0 -> a false "relay not reporting" page every run.
  const n = (v, d) => {
    if (v == null || String(v).trim() === "") return d;
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
  };
  const minSamples = n(env.MIN_SAMPLES, 4);
  const maxSamples = n(env.MAX_SAMPLES, 8);
  return {
    staleMs: n(env.STALE_MINUTES, 5) * 60 * 1000,
    probeTimeoutMs: n(env.PROBE_TIMEOUT_MS, 10000),
    socketsCap: n(env.SOCKETS_CAP, 200000),
    roomsCap: n(env.ROOMS_CAP, 200000),
    capWarnFrac: n(env.CAP_WARN_FRAC, 0.7),
    capCritFrac: n(env.CAP_CRIT_FRAC, 0.9),
    errorRatio: n(env.ERROR_RATIO, 0.05),
    errorMinRequests: n(env.ERROR_MIN_REQUESTS, 100),
    exceptionThreshold: n(env.EXCEPTION_THRESHOLD, 1),
    shardFetchThreshold: n(env.SHARD_FETCH_THRESHOLD, 1),
    spikeFactor: n(env.SPIKE_FACTOR, 3),
    dropFactor: n(env.DROP_FACTOR, 0.3),
    minBaseline: n(env.MIN_BASELINE, 50),
    minSamples,
    maxSamples: Math.max(maxSamples, minSamples),
    cooldownMs: n(env.COOLDOWN_MINUTES, 360) * 60 * 1000,
    // The two vantage-sensitive checks (liveness, inbound probe) and the shard-map
    // fetch page from the monitor's own network position, so a transient blip on
    // the monitor's uplink or the monitor->relay path false-pages even while the
    // relay serves real users fine. Require this many CONSECUTIVE failing ticks
    // before paging; a single success resets the streak. Default 2; clamp to >=1
    // so a blanked/0 value can't restore fire-on-first-failure. Set to 1 to keep
    // the old immediate behavior.
    alertFailStreak: Math.max(1, n(env.ALERT_FAIL_STREAK, 2)),
    // Push relay (APNs forwarder) thresholds, over one analysis interval.
    pushTimeoutCrit: n(env.PUSH_TIMEOUT_CRIT, 3),       // APNs timeouts => critical
    pushFailMinAttempts: n(env.PUSH_FAIL_MIN_ATTEMPTS, 5),
    pushFailRatio: n(env.PUSH_FAIL_RATIO, 0.8),          // failed/(delivered+failed) => warn
  };
}

// Run the checks against the current snapshot's gauges, the interval deltas, and
// the just-completed hour, and fold that hour into the baseline history (once
// per hour, guarded by lastRecordedHour so a sub-hourly cron does not record
// duplicates). Pure: the worker shell supplies gauges/interval/lastHour, prior
// state (from KV), and parsed config.
export function analyze({ gauges, interval, lastHour }, state, config) {
  const history = state.history || {};
  const alerts = [];

  alerts.push(...capAlerts([
    {
      key: "sockets", label: "Live sockets", used: gauges.socketsLive,
      cap: config.socketsCap, warnFrac: config.capWarnFrac, critFrac: config.capCritFrac, unit: "",
    },
    {
      key: "rooms", label: "Live rooms", used: gauges.roomsLive,
      cap: config.roomsCap, warnFrac: config.capWarnFrac, critFrac: config.capCritFrac, unit: "",
    },
  ]));

  if (interval && !interval.reset) {
    const e = errorAlert({
      requests: interval.requests, errors: interval.errors,
      ratioThreshold: config.errorRatio, minRequests: config.errorMinRequests,
    });
    if (e) alerts.push(e);
    const x = exceptionAlert({ count: interval.exceptions, threshold: config.exceptionThreshold });
    if (x) alerts.push(x);
    // `?? 1` so a config parsed by an older build (no shardFetchThreshold)
    // still alerts rather than silently disabling the check.
    const sf = shardFetchErrorAlert({
      count: interval.shardMapFetchErrors, threshold: config.shardFetchThreshold ?? 1,
    });
    if (sf) alerts.push(sf);
  }

  let newHistory = history;
  let lastRecordedHour = state.lastRecordedHour;
  if (lastHour) {
    const how = hourOfWeek(lastHour.key);
    const priorSamples = history[String(how)] || []; // read BEFORE recording
    const an = anomalyAlert({
      key: "requests", label: "Hourly requests", current: lastHour.requests, samples: priorSamples,
      spikeFactor: config.spikeFactor, dropFactor: config.dropFactor,
      minBaseline: config.minBaseline, minSamples: config.minSamples,
    });
    if (an) alerts.push(an);
    if (lastHour.key !== state.lastRecordedHour) {
      newHistory = pushSample(history, how, lastHour.requests, config.maxSamples);
      lastRecordedHour = lastHour.key;
    }
  }
  return { alerts, history: newHistory, lastRecordedHour };
}

// Cooldown / dedupe: send an alert only if it is newly active, its severity
// escalated, or the cooldown has elapsed; otherwise hold it. Returns the alerts
// to send now and the updated per-key state (last-sent time + last severity).
// Conditions absent from `alerts` are cleared from state, so they re-page if
// they recur after resolving.
export function dueAlerts(alerts, prev, now, cooldownMs) {
  const sentAt = {};
  const due = [];
  for (const a of alerts) {
    const last = prev[a.key];
    const lastSev = prev[`${a.key}:sev`];
    const escalated = lastSev === "warn" && a.severity === "critical";
    const cool = last === undefined || now - last >= cooldownMs;
    if (escalated || cool) {
      due.push(a);
      sentAt[a.key] = now;
    } else {
      sentAt[a.key] = last; // still active, keep the original send time
    }
    sentAt[`${a.key}:sev`] = a.severity;
  }
  return { due, sentAt };
}

// --- push relay (the APNs forwarder) ---
// Unlike the relays, the push relay does not push to us: it is on the monitor's
// own box, so each tick scrapes its loopback /metrics (Prometheus text) and
// compares to the previous tick. These are pure: text/counters in, alerts out.

// Rejections that mean our APNs signing identity itself is wrong or expired, so
// EVERY push fails until someone fixes the key. (A BadDeviceToken/Unregistered
// is just a stale device and is normal, so it is deliberately not here.)
const PUSH_AUTH_REASONS = new Set([
  "ExpiredProviderToken", "InvalidProviderToken", "MissingProviderToken", "BadEnvironmentKeyInToken",
]);

// Parse the `pushrelay_*` exposition into the few cumulative counters and gauges
// the checks use. Tolerant: unknown lines ignored, missing series read as 0.
export function parsePushMetrics(text) {
  const counters = { pushes: 0, delivered: 0, failed: 0, timeouts: 0, authRejects: 0 };
  const gauges = { sessions: 0, devices: 0, lastDeliveryTs: 0 };
  const plain = {
    pushrelay_push_total: ["c", "pushes"],
    pushrelay_push_delivered_total: ["c", "delivered"],
    pushrelay_push_failed_total: ["c", "failed"],
    pushrelay_apns_request_timeouts_total: ["c", "timeouts"],
    pushrelay_apns_sessions: ["g", "sessions"],
    pushrelay_devices: ["g", "devices"],
    pushrelay_last_delivery_timestamp_seconds: ["g", "lastDeliveryTs"],
  };
  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)$/.exec(line);
    if (!m) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    const hit = plain[m[1]];
    if (hit && !m[2]) { (hit[0] === "c" ? counters : gauges)[hit[1]] = value; continue; }
    if (m[1] === "pushrelay_apns_rejected_total") {
      const reason = /reason="([^"]*)"/.exec(m[2] || "");
      if (reason && PUSH_AUTH_REASONS.has(reason[1])) counters.authRejects += value;
    }
  }
  return { counters, gauges };
}

// Reset-aware interval between two counter snapshots. A counter that went
// backwards means the push relay restarted, so that interval is unknowable
// (null) rather than negative or a spike.
export function pushDeltas(prev, cur) {
  if (!prev) return null;
  const out = {};
  for (const k of Object.keys(cur)) {
    const d = cur[k] - (prev[k] || 0);
    if (d < 0) return null;
    out[k] = d;
  }
  return out;
}

// Alerts for one interval of push-relay activity. `interval` is pushDeltas().
//  - APNs timeouts: Apple not answering (the dead-connection failure mode). One
//    is a warning; several, or any with nothing delivered, is critical.
//  - Auth rejections: the signing key is bad/expired/wrong environment: every
//    push fails until fixed, so critical.
//  - Everything failing: a high failure ratio over enough attempts, whatever the
//    reason. Ratio is over pushes that reached an outcome at Apple; client faults
//    never count, and the ratio threshold is high because a few stale device
//    tokens (Unregistered) are routine.
export function pushAlerts(interval, cfg) {
  const alerts = [];
  if (!interval) return alerts;
  if (interval.timeouts >= 1) {
    const crit = interval.timeouts >= cfg.pushTimeoutCrit || interval.delivered === 0;
    alerts.push({
      key: "apns_timeouts",
      severity: crit ? "critical" : "warn",
      title: `APNs timeouts: ${interval.timeouts}`,
      body: `${interval.timeouts} push request(s) got no answer from Apple since the last check ` +
        `(${interval.delivered} delivered). The connection to APNs may be stuck.`,
    });
  }
  if (interval.authRejects >= 1) {
    alerts.push({
      key: "apns_auth",
      severity: "critical",
      title: "APNs rejecting our signing key",
      body: `Apple rejected ${interval.authRejects} push(es) as a provider-token/key problem since the ` +
        `last check. Every push fails until the key (or its environment scope) is fixed.`,
    });
  }
  const attempts = interval.delivered + interval.failed;
  if (attempts >= cfg.pushFailMinAttempts && interval.failed / attempts >= cfg.pushFailRatio) {
    alerts.push({
      key: "push_failures",
      severity: "warn",
      title: `Push delivery failing (${interval.failed}/${attempts})`,
      body: `${interval.failed} of ${attempts} pushes that reached APNs handling failed since the last check.`,
    });
  }
  return alerts;
}
