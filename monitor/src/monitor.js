// Pure analysis for the relay monitor. No I/O: the worker shell feeds it the
// aggregate snapshot the relay PUSHED (counts + gauges -- never per-request data
// or IPs, consistent with the relay's no-logging posture) plus prior state from
// KV, and sends whatever alerts come back. Kept pure so the alerting logic is
// unit-tested deterministically.
//
// The relay is self-hosted (a Node process behind Cloudflare), not a Worker, so
// there is no Cloudflare Workers Analytics to query. Instead the relay posts a
// snapshot of its own counters/gauges to the monitor; this module turns a series
// of those snapshots into alerts:
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
  if (!prev) return { reset: true, requests: 0, errors: 0, exceptions: 0 };
  if (cur.requests < prev.requests || cur.errors < prev.errors || cur.exceptions < prev.exceptions) {
    return { reset: true, requests: 0, errors: 0, exceptions: 0 };
  }
  return {
    reset: false,
    requests: cur.requests - prev.requests,
    errors: cur.errors - prev.errors,
    exceptions: cur.exceptions - prev.exceptions,
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
  const n = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
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
    spikeFactor: n(env.SPIKE_FACTOR, 3),
    dropFactor: n(env.DROP_FACTOR, 0.3),
    minBaseline: n(env.MIN_BASELINE, 50),
    minSamples,
    maxSamples: Math.max(maxSamples, minSamples),
    cooldownMs: n(env.COOLDOWN_MINUTES, 360) * 60 * 1000,
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
