// Pure analysis core for the relay monitor: liveness (dead-man's-switch),
// capacity, error-rate, exception, and traffic-anomaly detection, plus interval
// diffing of the pushed counter snapshots and the cooldown that keeps a sustained
// condition from re-paging every run. No I/O here.

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  median, pushSample, hourKey, hourOfWeek,
  capAlerts, errorAlert, exceptionAlert, livenessAlert, anomalyAlert,
  normalizeSnapshot, deltas, rollHour, parseConfig, analyze, dueAlerts,
  probeHandshake, probeAlert,
} from "../src/monitor.js";
import { run } from "../src/worker.js";

// A Map-backed stand-in for a KV namespace: get(key, "json") and put(key, str).
function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, val) { store.set(key, val); },
  };
}

// A scripted socket for probeHandshake: yields `messages` in order (an Error
// entry rejects the read, simulating a mid-handshake close), and records sends.
function scriptedSocket(messages) {
  let i = 0;
  return {
    sent: [],
    closed: false,
    send(s) { this.sent.push(s); },
    async next() {
      if (i >= messages.length) throw new Error("no more messages");
      const m = messages[i++];
      if (m instanceof Error) throw m;
      return m;
    },
    close() { this.closed = true; },
  };
}

const CONFIG = {
  staleMs: 300000,
  socketsCap: 200000, roomsCap: 200000, capWarnFrac: 0.7, capCritFrac: 0.9,
  errorRatio: 0.05, errorMinRequests: 100, exceptionThreshold: 1,
  spikeFactor: 3, dropFactor: 0.3, minBaseline: 50, minSamples: 4, maxSamples: 8,
};

describe("median", () => {
  it("handles odd and even counts and empty", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(null);
  });
});

describe("pushSample", () => {
  it("appends per hour-of-week and bounds the history length", () => {
    let h = {};
    for (let i = 1; i <= 6; i++) h = pushSample(h, 5, i, 4);
    expect(h["5"]).toEqual([3, 4, 5, 6]); // kept the last 4
    expect(h["6"]).toBeUndefined();
  });
});

describe("hourKey / hourOfWeek", () => {
  it("floors to the UTC hour", () => {
    expect(hourKey(Date.parse("2026-06-15T10:37:45.123Z"))).toBe("2026-06-15T10:00:00.000Z");
  });
  it("maps Monday 00:00 UTC to 0 and counts up", () => {
    expect(hourOfWeek("2026-06-15T00:00:00.000Z")).toBe(0);  // 2026-06-15 is a Monday
    expect(hourOfWeek("2026-06-15T10:00:00.000Z")).toBe(10);
    expect(hourOfWeek("2026-06-16T00:00:00.000Z")).toBe(24); // Tuesday
  });
});

describe("capAlerts", () => {
  const meter = { key: "sockets", label: "Live sockets", used: 0, cap: 100000, warnFrac: 0.7, critFrac: 0.9, unit: "" };
  it("is silent below the warn fraction", () => {
    expect(capAlerts([{ ...meter, used: 50000 }])).toEqual([]);
  });
  it("warns past the warn fraction", () => {
    const a = capAlerts([{ ...meter, used: 75000 }]);
    expect(a).toHaveLength(1);
    expect(a[0].severity).toBe("warn");
    expect(a[0].key).toBe("cap:sockets");
  });
  it("escalates to critical past the critical fraction", () => {
    expect(capAlerts([{ ...meter, used: 95000 }])[0].severity).toBe("critical");
  });
});

describe("errorAlert", () => {
  it("trips when the error ratio exceeds the threshold with enough volume", () => {
    const a = errorAlert({ requests: 1000, errors: 60, ratioThreshold: 0.05, minRequests: 100 });
    expect(a?.severity).toBe("warn");
    expect(a.key).toBe("errors");
  });
  it("stays silent on a tiny sample even at a high ratio", () => {
    expect(errorAlert({ requests: 5, errors: 4, ratioThreshold: 0.05, minRequests: 100 })).toBe(null);
  });
  it("stays silent under the ratio threshold", () => {
    expect(errorAlert({ requests: 1000, errors: 10, ratioThreshold: 0.05, minRequests: 100 })).toBe(null);
  });
});

describe("exceptionAlert", () => {
  it("is silent at zero", () => {
    expect(exceptionAlert({ count: 0, threshold: 1 })).toBe(null);
  });
  it("warns at the threshold", () => {
    expect(exceptionAlert({ count: 1, threshold: 1 }).severity).toBe("warn");
  });
  it("escalates to critical at 5x the threshold", () => {
    expect(exceptionAlert({ count: 5, threshold: 1 }).severity).toBe("critical");
  });
});

describe("livenessAlert", () => {
  it("is always a critical liveness alert", () => {
    const a = livenessAlert("no snapshot for 12 min");
    expect(a.key).toBe("liveness");
    expect(a.severity).toBe("critical");
    expect(a.body).toMatch(/12 min/);
  });
});

describe("anomalyAlert", () => {
  const base = { key: "traffic", label: "Hourly requests", spikeFactor: 3, dropFactor: 0.3, minBaseline: 50, minSamples: 4 };
  const samples = Array(6).fill(100);
  it("flags a spike above the baseline", () => {
    const a = anomalyAlert({ ...base, current: 400, samples });
    expect(a?.key).toBe("anomaly:traffic");
    expect(a.body).toMatch(/spike/i);
  });
  it("flags a drop below the baseline", () => {
    expect(anomalyAlert({ ...base, current: 20, samples }).body).toMatch(/drop/i);
  });
  it("stays silent within normal range", () => {
    expect(anomalyAlert({ ...base, current: 130, samples })).toBe(null);
  });
  it("stays silent until enough history exists", () => {
    expect(anomalyAlert({ ...base, current: 999, samples: Array(3).fill(100) })).toBe(null);
  });
  it("stays silent when the baseline is too small to be meaningful", () => {
    expect(anomalyAlert({ ...base, current: 999, samples: Array(6).fill(1) })).toBe(null);
  });
});

describe("normalizeSnapshot", () => {
  it("splits a pushed snapshot into counters and gauges, defaulting to 0", () => {
    const n = normalizeSnapshot({ http_requests_total: 40, http_errors_total: 2, sockets_live: 6 });
    expect(n.counters).toEqual({ requests: 40, errors: 2, exceptions: 0 });
    expect(n.gauges).toEqual({ socketsLive: 6, roomsLive: 0 });
  });
});

describe("deltas", () => {
  it("flags reset on the first snapshot (no prior)", () => {
    expect(deltas(null, { requests: 5, errors: 0, exceptions: 0 }).reset).toBe(true);
  });
  it("diffs monotonic counters", () => {
    const d = deltas({ requests: 100, errors: 1, exceptions: 0 }, { requests: 160, errors: 4, exceptions: 2 });
    expect(d).toEqual({ reset: false, requests: 60, errors: 3, exceptions: 2 });
  });
  it("flags reset when any counter goes backwards (relay restart)", () => {
    const d = deltas({ requests: 100, errors: 5, exceptions: 0 }, { requests: 3, errors: 0, exceptions: 0 });
    expect(d.reset).toBe(true);
  });
});

describe("rollHour", () => {
  const cur = { requests: 500, errors: 3 };
  it("seeds an anchor on first observation with no completed hour", () => {
    const r = rollHour(null, cur, "2026-06-15T10:00:00.000Z");
    expect(r.lastHour).toBe(null);
    expect(r.anchor).toEqual({ key: "2026-06-15T10:00:00.000Z", requests: 500, errors: 3 });
  });
  it("returns null and keeps the anchor within the same hour", () => {
    const anchor = { key: "2026-06-15T10:00:00.000Z", requests: 400, errors: 1 };
    const r = rollHour(anchor, cur, "2026-06-15T10:00:00.000Z");
    expect(r.lastHour).toBe(null);
    expect(r.anchor).toBe(anchor);
  });
  it("emits the completed hour's delta and re-seeds on rollover", () => {
    const anchor = { key: "2026-06-15T10:00:00.000Z", requests: 400, errors: 1 };
    const r = rollHour(anchor, cur, "2026-06-15T11:00:00.000Z");
    expect(r.lastHour).toEqual({ key: "2026-06-15T10:00:00.000Z", requests: 100, errors: 2 });
    expect(r.anchor).toEqual({ key: "2026-06-15T11:00:00.000Z", requests: 500, errors: 3 });
  });
  it("reseeds without a bucket when the counter reset", () => {
    const anchor = { key: "2026-06-15T10:00:00.000Z", requests: 900, errors: 5 };
    const r = rollHour(anchor, cur, "2026-06-15T11:00:00.000Z");
    expect(r.lastHour).toBe(null);
    expect(r.anchor.requests).toBe(500);
  });
});

describe("parseConfig", () => {
  it("applies defaults", () => {
    const c = parseConfig({});
    expect(c.errorRatio).toBe(0.05);
    expect(c.staleMs).toBe(5 * 60 * 1000);
  });
  // Regression: the original config shipped MAX_SAMPLES=6 < MIN_SAMPLES=14, so the
  // baseline could never reach the sample count the anomaly check required and the
  // check was silently dead. Retention must always be >= the required minimum.
  it("clamps maxSamples up to at least minSamples so the anomaly can warm up", () => {
    const c = parseConfig({ MIN_SAMPLES: "14", MAX_SAMPLES: "6" });
    expect(c.maxSamples).toBeGreaterThanOrEqual(c.minSamples);
  });
  it("leaves a valid maxSamples >= minSamples untouched", () => {
    const c = parseConfig({ MIN_SAMPLES: "4", MAX_SAMPLES: "8" });
    expect(c.maxSamples).toBe(8);
  });
});

describe("analyze", () => {
  const gauges = { socketsLive: 10, roomsLive: 5 };
  const okInterval = { reset: false, requests: 1000, errors: 1, exceptions: 0 };

  it("raises a capacity alert when a gauge nears its cap", () => {
    const cfg = { ...CONFIG, socketsCap: 12 }; // 10/12 = 83% -> warn
    const { alerts } = analyze({ gauges, interval: okInterval, lastHour: null }, {}, cfg);
    expect(alerts.some((a) => a.key === "cap:sockets" && a.severity === "warn")).toBe(true);
  });

  it("raises an error alert on a bad interval and an exception alert", () => {
    const interval = { reset: false, requests: 1000, errors: 80, exceptions: 2 };
    const { alerts } = analyze({ gauges, interval, lastHour: null }, {}, CONFIG);
    expect(alerts.some((a) => a.key === "errors")).toBe(true);
    expect(alerts.some((a) => a.key === "exceptions")).toBe(true);
  });

  it("skips rate checks on a reset interval (relay restart)", () => {
    const interval = { reset: true, requests: 0, errors: 0, exceptions: 0 };
    const { alerts } = analyze({ gauges, interval, lastHour: null }, {}, CONFIG);
    expect(alerts.some((a) => a.key === "errors" || a.key === "exceptions")).toBe(false);
  });

  it("records the completed hour into the per-hour-of-week history once", () => {
    const lastHour = { key: "2026-06-15T10:00:00.000Z", requests: 500, errors: 1 };
    const how = String(hourOfWeek(lastHour.key));
    const first = analyze({ gauges, interval: okInterval, lastHour }, { history: {}, lastRecordedHour: null }, CONFIG);
    expect(first.history[how]).toEqual([500]);
    expect(first.lastRecordedHour).toBe(lastHour.key);
    // A second sub-hourly run over the same completed hour does not double-record.
    const second = analyze({ gauges, interval: okInterval, lastHour }, first, CONFIG);
    expect(second.history[how]).toEqual([500]);
  });

  it("flags a spike using the prior weeks' baseline for that hour", () => {
    const lastHour = { key: "2026-06-15T10:00:00.000Z", requests: 600, errors: 1 };
    const how = String(hourOfWeek(lastHour.key));
    const state = { history: { [how]: Array(6).fill(100) }, lastRecordedHour: "older" };
    const { alerts } = analyze({ gauges, interval: okInterval, lastHour }, state, CONFIG);
    expect(alerts.some((a) => a.key === "anomaly:requests")).toBe(true);
  });
});

describe("probeHandshake", () => {
  it("succeeds on a challenge then an ok result, sending mac hello + empty proof", async () => {
    const sock = scriptedSocket(['{"nonce":"abc"}', '{"ok":true}']);
    const r = await probeHandshake(sock);
    expect(r.ok).toBe(true);
    expect(JSON.parse(sock.sent[0])).toEqual({ v: 1, role: "mac" });
    expect(JSON.parse(sock.sent[1])).toEqual({}); // empty proof
    expect(sock.closed).toBe(true); // always closes
  });

  it("fails (not ok) when admission rejects, surfacing the error", async () => {
    const sock = scriptedSocket(['{"nonce":"abc"}', '{"ok":false,"error":"bad ticket"}']);
    const r = await probeHandshake(sock);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/bad ticket/);
  });

  it("fails when the first reply carries no challenge nonce", async () => {
    const r = await probeHandshake(scriptedSocket(['{"hello":1}', '{"ok":true}']));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/nonce/);
  });

  it("fails when the socket closes mid-handshake", async () => {
    const sock = scriptedSocket(['{"nonce":"abc"}', new Error("socket closed before reply")]);
    const r = await probeHandshake(sock);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/closed/);
    expect(sock.closed).toBe(true);
  });

  it("fails on non-JSON garbage without throwing", async () => {
    const r = await probeHandshake(scriptedSocket(["<html>502 Bad Gateway</html>"]));
    expect(r.ok).toBe(false);
  });
});

describe("probeAlert", () => {
  it("is a critical probe alert carrying the failure detail", () => {
    const a = probeAlert("timeout after 10000ms");
    expect(a.key).toBe("probe");
    expect(a.severity).toBe("critical");
    expect(a.body).toMatch(/timeout after 10000ms/);
  });
});

describe("dueAlerts (cooldown)", () => {
  const A = { key: "errors", severity: "warn", title: "x", body: "y" };
  it("sends a newly-seen alert and records the time", () => {
    const { due, sentAt } = dueAlerts([A], {}, 1000, 60000);
    expect(due).toHaveLength(1);
    expect(sentAt.errors).toBe(1000);
  });
  it("suppresses the same alert within the cooldown", () => {
    const { due } = dueAlerts([A], { errors: 1000 }, 1000 + 30000, 60000);
    expect(due).toHaveLength(0);
  });
  it("re-sends after the cooldown elapses", () => {
    const { due } = dueAlerts([A], { errors: 1000 }, 1000 + 61000, 60000);
    expect(due).toHaveLength(1);
  });
  it("sends immediately when severity escalates, even within cooldown", () => {
    const crit = { ...A, severity: "critical" };
    const { due } = dueAlerts([crit], { errors: 1000, "errors:sev": "warn" }, 1000 + 1000, 60000);
    expect(due).toHaveLength(1);
  });
  it("clears state for conditions that are no longer alerting", () => {
    const { sentAt } = dueAlerts([], { errors: 1000 }, 5000, 60000);
    expect(sentAt.errors).toBeUndefined();
  });
});

describe("run() — state persistence and probe gating", () => {
  const NOW = Date.parse("2026-06-15T10:30:00.000Z");
  // A snapshot that trips a capacity alert (100 sockets vs a cap of 10), so the
  // run always has a due alert to (try to) send.
  const latest = { receivedAt: NOW, snapshot: { http_requests_total: 1000, sockets_live: 100 } };
  const baseEnv = (kv) => ({
    MONITOR_KV: kv, SOCKETS_CAP: "10",
    ALERT_FROM: "from", ALERT_TO: "to", RESEND_API_KEY: "key",
  });

  afterEach(() => vi.unstubAllGlobals());

  it("advances the baselines but NOT the cooldown when the email send fails", async () => {
    const kv = fakeKV({ latest });
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500, text: async () => "boom" }));
    const res = await run(baseEnv(kv), NOW, { dry: false });

    expect(res.due).toContain("cap:sockets");
    const state = JSON.parse(kv.store.get("state"));
    expect(state.prev).toBeTruthy();                     // baseline advanced despite the failure
    expect(state.sentAt["cap:sockets"]).toBeUndefined(); // not recorded as sent -> retries next tick
  });

  it("advances the cooldown when the email send succeeds", async () => {
    const kv = fakeKV({ latest });
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200 }));
    await run(baseEnv(kv), NOW, { dry: false });

    const state = JSON.parse(kv.store.get("state"));
    expect(state.sentAt["cap:sockets"]).toBe(NOW);
  });

  it("does not run the probe when RELAY_PROBE_URL is empty (opt-in)", async () => {
    const kv = fakeKV({ latest });
    let fetchCalls = 0;
    vi.stubGlobal("fetch", async () => { fetchCalls += 1; return { ok: true, status: 200 }; });
    await run({ ...baseEnv(kv), RELAY_PROBE_URL: "" }, NOW, { dry: false });

    // Only the email send hits fetch; an empty probe URL means no handshake attempt.
    expect(fetchCalls).toBe(1);
  });
});
