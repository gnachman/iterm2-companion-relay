// The push relay (APNs forwarder) on the fleet monitor: parsing its loopback
// /metrics, reset-aware interval checks, the alert rules, the per-tick wiring in
// run() (debounce, state, health entry) and the dashboard card.

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { parsePushMetrics, pushDeltas, pushAlerts, peerAlerts, parseConfig } from "../src/monitor.js";
import { run } from "../src/core.js";
import { fileStore } from "../src/store.js";
import { createServer, fetchText, probePushOrigin } from "../src/server.js";

const CFG = parseConfig({});

const expo = (o = {}) => {
  const v = { push: 0, delivered: 0, failed: 0, timeouts: 0, sessions: 1, devices: 4, last: 0, ...o };
  return `# HELP pushrelay_push_total x
pushrelay_push_total ${v.push}
pushrelay_push_delivered_total ${v.delivered}
pushrelay_push_failed_total ${v.failed}
pushrelay_apns_request_timeouts_total ${v.timeouts}
pushrelay_apns_sessions ${v.sessions}
pushrelay_devices ${v.devices}
pushrelay_last_delivery_timestamp_seconds ${v.last}
pushrelay_apns_rejected_total{reason="BadDeviceToken"} 5
pushrelay_apns_rejected_total{reason="InvalidProviderToken"} ${v.authRejects ?? 0}
pushrelay_apns_rejected_total{reason="BadEnvironmentKeyInToken"} ${v.envRejects ?? 0}
`;
};

// The peering lines a push relay with PUSH_PEER_URL adds. The counters are
// exported even without a peer; the outbox gauge only with one.
const peerExpo = ({ outbox = 0, skew = 0, dropped = 0, rejected = 0, configured = true } = {}) =>
  `pushrelay_peer_forward_dropped_total ${dropped}
pushrelay_peer_rejected_total ${rejected}
` + (configured ? `pushrelay_peer_outbox ${outbox}
pushrelay_peer_clock_skew_ms ${skew}
` : "");

describe("parsePushMetrics", () => {
  it("reads counters, gauges and sums only key/auth-class rejections", () => {
    const { counters, gauges } = parsePushMetrics(expo({ push: 9, delivered: 6, failed: 3, timeouts: 2, authRejects: 1, envRejects: 2, last: 1700000000 }));
    expect(counters).toEqual({ pushes: 9, delivered: 6, failed: 3, timeouts: 2, authRejects: 3 });   // BadDeviceToken excluded
    expect(gauges).toEqual({ sessions: 1, devices: 4, lastDeliveryTs: 1700000000 });
  });
  it("reads the peer metrics only when a peer is configured", () => {
    expect(parsePushMetrics(expo()).peer).toBeNull();
    expect(parsePushMetrics(expo() + peerExpo({ configured: false, dropped: 2 })).peer).toBeNull();
    expect(parsePushMetrics(expo() + peerExpo({ outbox: 3, skew: -40, dropped: 1, rejected: 2 })).peer)
      .toEqual({ outbox: 3, skewMs: -40, dropped: 1, rejected: 2, lastOkTs: 0 });
  });
  it("tolerates garbage and an empty body (everything 0)", () => {
    const { counters } = parsePushMetrics("not metrics\n\n# comment\npushrelay_push_total banana\n");
    expect(counters.pushes).toBe(0);
  });
});

describe("pushDeltas", () => {
  const a = { pushes: 5, delivered: 4, failed: 1, timeouts: 0, authRejects: 0 };
  it("is null without a baseline", () => expect(pushDeltas(undefined, a)).toBeNull());
  it("diffs two snapshots", () => {
    expect(pushDeltas(a, { ...a, delivered: 9, failed: 3 })).toMatchObject({ delivered: 5, failed: 2 });
  });
  it("treats a backwards counter (restart) as an unknown interval, not a negative", () => {
    expect(pushDeltas(a, { ...a, delivered: 1 })).toBeNull();
  });
});

describe("pushAlerts", () => {
  const iv = (o) => ({ pushes: 0, delivered: 0, failed: 0, timeouts: 0, authRejects: 0, ...o });
  it("is silent for a quiet or healthy interval and for an unknown one", () => {
    expect(pushAlerts(null, CFG)).toEqual([]);
    expect(pushAlerts(iv({}), CFG)).toEqual([]);
    expect(pushAlerts(iv({ delivered: 20, failed: 1 }), CFG)).toEqual([]);   // a stale token is routine
  });
  it("one APNs timeout with deliveries is a warning; several or none-delivered is critical", () => {
    expect(pushAlerts(iv({ timeouts: 1, delivered: 5 }), CFG)[0]).toMatchObject({ key: "apns_timeouts", severity: "warn" });
    expect(pushAlerts(iv({ timeouts: 3, delivered: 5 }), CFG)[0].severity).toBe("critical");
    expect(pushAlerts(iv({ timeouts: 1, delivered: 0 }), CFG)[0].severity).toBe("critical");   // today's failure mode
  });
  it("a rejected signing key is critical", () => {
    expect(pushAlerts(iv({ authRejects: 1 }), CFG)[0]).toMatchObject({ key: "apns_auth", severity: "critical" });
  });
  it("flags everything failing only over enough attempts", () => {
    expect(pushAlerts(iv({ delivered: 1, failed: 4 }), CFG)[0]).toMatchObject({ key: "push_failures", severity: "warn" });
    expect(pushAlerts(iv({ delivered: 0, failed: 2 }), CFG)).toEqual([]);    // too few to say
  });
});

describe("peerAlerts", () => {
  const peer = (o) => ({ outbox: 0, skewMs: 0, dropped: 0, rejected: 0, ...o });
  const keys = (alerts) => alerts.map((a) => a.key);

  it("is silent without a peer and for a healthy one", () => {
    expect(peerAlerts(null, null, 9, CFG)).toEqual([]);
    expect(peerAlerts(peer({ skewMs: 18 }), peer({}), 0, CFG)).toEqual([]);
  });
  it("warns on an outbox that stays non-empty for the streak", () => {
    expect(peerAlerts(peer({ outbox: 4 }), null, CFG.peerOutboxStreak - 1, CFG)).toEqual([]);
    const [a] = peerAlerts(peer({ outbox: 4 }), null, CFG.peerOutboxStreak, CFG);
    expect(a).toMatchObject({ key: "peer_outbox", severity: "warn" });
  });
  it("grades clock skew in either direction", () => {
    expect(peerAlerts(peer({ skewMs: -2500 }), null, 0, CFG)[0]).toMatchObject({ key: "peer_skew", severity: "warn" });
    expect(peerAlerts(peer({ skewMs: 45_000 }), null, 0, CFG)[0]).toMatchObject({ key: "peer_skew", severity: "critical" });
  });
  it("warns when the peer hasn't answered for a while (if the relay reports it)", () => {
    const NOW = 1_800_000_000_000;
    const live = peer({ hasLastOk: true, lastOkTs: NOW / 1000 - 60 });
    expect(peerAlerts(live, null, 0, CFG, NOW)).toEqual([]);
    const stale = peer({ hasLastOk: true, lastOkTs: NOW / 1000 - 3600 });
    expect(peerAlerts(stale, null, 0, CFG, NOW)[0]).toMatchObject({ key: "peer_silent", severity: "warn" });
    // "Never answered" only counts once it has lasted the silence threshold.
    const never = peer({ hasLastOk: true, lastOkTs: 0 });
    expect(peerAlerts(never, null, 0, CFG, NOW, NOW)).toEqual([]);
    expect(peerAlerts(never, null, 0, CFG, NOW, NOW - CFG.peerSilentMs)[0]).toMatchObject({ key: "peer_silent" });
    expect(peerAlerts(peer({ lastOkTs: 0 }), null, 0, CFG, NOW)).toEqual([]); // older relay: no gauge
  });
  it("warns on new drops and bad peer requests, but needs a baseline", () => {
    expect(peerAlerts(peer({ dropped: 5, rejected: 5 }), null, 0, CFG)).toEqual([]);
    expect(keys(peerAlerts(peer({ dropped: 5, rejected: 7 }), peer({ dropped: 4, rejected: 7 }), 0, CFG)))
      .toEqual(["peer_dropped"]);
    expect(keys(peerAlerts(peer({ rejected: 1 }), peer({}), 0, CFG))).toEqual(["peer_rejected"]);
  });
});

describe("run(): push relay wiring", () => {
  const NOW = Date.parse("2026-10-14T12:00:00.000Z");
  const env = (extra = {}) => ({
    ALERT_FROM: "f", ALERT_TO: "t", RESEND_API_KEY: "k",
    PUSH_METRICS_URL: "http://127.0.0.1:8790/metrics", PUSH_PROBE_URL: "https://push.example/",
    PUSH_HOST_LABEL: "push.example", PUSH_DASHBOARD_URL: "https://dash.example/push/",
    ...extra,
  });
  const kvOf = () => {
    const m = new Map();
    return { m, async get(k, t) { const v = m.get(k); return v == null ? null : (t === "json" ? JSON.parse(v) : v); }, async put(k, v) { m.set(k, v); } };
  };
  // A direct-mode relay snapshot so the unrelated relay half stays quiet.
  const seed = (kv) => kv.put("latest", JSON.stringify({ receivedAt: NOW, snapshot: { sockets_live: 1 } }));
  const okProbe = async () => ({ ok: true, detail: "ok" });
  const tick = async (kv, body, over = {}) => {
    const sent = [];
    const health = await run(env(over.env), over.now ?? NOW, {
      dry: false, kv, sendEmail: async (_e, a) => { sent.push(...a); },
      scrapePush: over.scrape ?? (async () => body), probePush: over.probe ?? okProbe,
    });
    return { health, sent };
  };
  const pushHost = (h) => h.hosts.find((x) => x.kind === "push");

  it("adds an ok push card to the summary with live details", async () => {
    const kv = kvOf(); await seed(kv);
    const { health } = await tick(kv, expo({ delivered: 4, last: Math.floor(NOW / 1000) - 90 }));
    const p = pushHost(health);
    expect(p).toMatchObject({ host: "push.example", status: "ok", probeOk: true, detailUrl: "https://dash.example/push/" });
    expect(p.push.sessions).toBe(1);
    expect(p.push.lastDeliveryAgeMs).toBe(90_000);
    expect(p.push.delivered).toBeNull();            // first tick: no baseline yet
    expect(health.summary.total).toBe(2);           // relay + push
  });

  it("is a no-op when PUSH_METRICS_URL is unset", async () => {
    const kv = kvOf(); await seed(kv);
    const health = await run({ ALERT_FROM: "f", ALERT_TO: "t", RESEND_API_KEY: "k" }, NOW,
      { dry: false, kv, sendEmail: async () => {}, scrapePush: async () => { throw new Error("must not be called"); } });
    expect(pushHost(health)).toBeUndefined();
  });

  it("pages (once) on APNs timeouts across two ticks, naming the push host", async () => {
    const kv = kvOf(); await seed(kv);
    await tick(kv, expo({ push: 5, delivered: 5 }));
    const { health, sent } = await tick(kv, expo({ push: 8, delivered: 5, timeouts: 3 }), { now: NOW + 300_000 });
    expect(pushHost(health).status).toBe("crit");
    expect(pushHost(health).reasons).toContain("apns_timeouts");
    expect(sent.map((a) => a.title)).toContain("[push.example] APNs timeouts: 3");
  });

  it("shows the peer on the card and pages only after the outbox stays stuck", async () => {
    const kv = kvOf(); await seed(kv);
    const stuck = expo() + peerExpo({ outbox: 12, skew: 18 });
    for (let i = 0; i < CFG.peerOutboxStreak - 1; i++) {
      const { health, sent } = await tick(kv, stuck, { now: NOW + i * 300_000 });
      expect(pushHost(health).status).toBe("ok");
      expect(pushHost(health).push).toMatchObject({ peerOutbox: 12, peerSkewMs: 18 });
      expect(sent).toEqual([]);
    }
    const { health, sent } = await tick(kv, stuck, { now: NOW + CFG.peerOutboxStreak * 300_000 });
    expect(pushHost(health).status).toBe("warn");
    expect(pushHost(health).reasons).toContain("peer_outbox");
    expect(sent.map((a) => a.title)).toContain("[push.example] Push relay peer not receiving (12 queued)");

    // Drained: the streak resets.
    const drained = await tick(kv, expo() + peerExpo({ outbox: 0 }), { now: NOW + 10 * 300_000 });
    expect(pushHost(drained.health).status).toBe("ok");
  });

  it("doesn't warn about a peer right after the push relay restarts", async () => {
    const kv = kvOf(); await seed(kv);
    const restarted = expo() + peerExpo() + "pushrelay_peer_last_ok_timestamp_seconds 0\n";
    const first = await tick(kv, restarted);
    expect(pushHost(first.health).reasons).not.toContain("peer_silent");
    expect(first.sent).toEqual([]);
    // Still never answered 15 minutes later: now it warns.
    const later = await tick(kv, restarted, { now: NOW + 15 * 60 * 1000 });
    expect(pushHost(later.health).reasons).toContain("peer_silent");
  });

  it("a large peer clock difference makes the card critical", async () => {
    const kv = kvOf(); await seed(kv);
    const { health } = await tick(kv, expo() + peerExpo({ skew: 60_000 }));
    expect(pushHost(health).status).toBe("crit");
    expect(pushHost(health).reasons).toContain("peer_skew");
  });

  it("a push-relay restart (counters reset) does not alert", async () => {
    const kv = kvOf(); await seed(kv);
    await tick(kv, expo({ push: 50, delivered: 50, timeouts: 0 }));
    const { health, sent } = await tick(kv, expo({ push: 1, delivered: 1, failed: 0 }), { now: NOW + 300_000 });
    expect(pushHost(health).status).toBe("ok");
    expect(sent).toEqual([]);
  });

  it("debounces: an unreachable /metrics is crit on the card at once but pages only on the 2nd tick", async () => {
    const kv = kvOf(); await seed(kv);
    const down = async () => { throw new Error("ECONNREFUSED"); };
    const t1 = await tick(kv, "", { scrape: down });
    expect(pushHost(t1.health).status).toBe("crit");
    expect(t1.sent.some((a) => /Push relay not reporting/.test(a.title))).toBe(false);
    const t2 = await tick(kv, "", { scrape: down, now: NOW + 300_000 });
    expect(t2.sent.map((a) => a.title)).toContain("[push.example] Push relay not reporting");
  });

  it("keeps the previous baseline across a failed scrape", async () => {
    const kv = kvOf(); await seed(kv);
    await tick(kv, expo({ push: 5, delivered: 5 }));
    await tick(kv, "", { scrape: async () => { throw new Error("x"); }, now: NOW + 300_000 });
    const { health } = await tick(kv, expo({ push: 9, delivered: 9 }), { now: NOW + 600_000 });
    expect(pushHost(health).push.delivered).toBe(4);   // 9 - 5, spanning the gap
  });

  it("a failing public probe makes the card critical and pages after the streak", async () => {
    const kv = kvOf(); await seed(kv);
    const bad = async () => ({ ok: false, detail: "unexpected HTTP 502" });
    const t1 = await tick(kv, expo({}), { probe: bad });
    expect(pushHost(t1.health)).toMatchObject({ status: "crit", probeOk: false });
    const t2 = await tick(kv, expo({}), { probe: bad, now: NOW + 300_000 });
    expect(t2.sent.some((a) => a.key === "push.example|probe")).toBe(true);
  });
});

describe("scrape + probe helpers (real http)", () => {
  const closers = [];
  afterEach(() => { while (closers.length) closers.pop()(); });
  const serve = (handler) => new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => { closers.push(() => s.close()); resolve(`http://127.0.0.1:${s.address().port}/`); });
  });

  it("fetchText returns the body and throws on non-2xx", async () => {
    expect(await fetchText(await serve((_q, r) => r.end("hello")))).toBe("hello");
    await expect(fetchText(await serve((_q, r) => { r.writeHead(500); r.end(); }))).rejects.toThrow("HTTP 500");
  });
  it("probePushOrigin passes only on the worker's 405", async () => {
    expect((await probePushOrigin(await serve((_q, r) => { r.writeHead(405); r.end('{"error":"POST only"}'); }))).ok).toBe(true);
    const bad = await probePushOrigin(await serve((_q, r) => { r.writeHead(502); r.end("cloudflare"); }));
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/502/);
    expect((await probePushOrigin("http://127.0.0.1:1/", 500)).ok).toBe(false);   // refused
  });
});

describe("dashboard card for the push relay", () => {
  const dirs = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
  it("renders a push card that links to the push dashboard and is not re-judged as a relay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mon-")); dirs.push(dir);
    const kv = fileStore(dir);
    await kv.put("health", JSON.stringify({
      at: Date.now(), fleet: true, mapError: null, mapVersion: 1,
      summary: { total: 3, ok: 3, warn: 0, crit: 0 },
      hosts: [
        { host: "relay1.iterm2.com", status: "ok", ageMs: 1000, sockets: 1, rooms: 0, buckets: 65536, probeOk: true, reasons: [] },
        { host: "push.iterm2.com", kind: "push", status: "ok", checkedAt: Date.now() - 60_000, ageMs: 0, probeOk: true, reasons: [],
          detailUrl: "https://mcnachman.cloud/push-dashboard/",
          push: { devices: 7, sessions: 1, lastDeliveryAgeMs: 120_000, delivered: 4, failed: 1, timeouts: 0,
            peerOutbox: 3, peerSkewMs: 18, peerLastOkKnown: true, peerLastOkAgeMs: 30_000 } },
        { host: "old-push.example", kind: "push", status: "ok", checkedAt: Date.now(), ageMs: 0, probeOk: true, reasons: [],
          push: { devices: 1, sessions: 1, lastDeliveryAgeMs: null, peerOutbox: 0, peerSkewMs: 0,
            peerLastOkKnown: false, peerLastOkAgeMs: null } },
      ],
      due: [],
    }));
    await kv.put("latest:relay1.iterm2.com", JSON.stringify({ receivedAt: Date.now(), snapshot: { sockets_live: 1 } }));
    const server = createServer({ MANUAL_TRIGGER_SECRET: "k" }, { kv });
    const base = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
    try {
      const html = await (await fetch(`${base}/dashboard`, { headers: { authorization: "Basic " + Buffer.from("a:k").toString("base64") } })).text();
      expect(html).toContain("3/3 healthy");                       // push counts, and was not flipped to crit for lacking latest:<host>
      expect(html).toContain("push.iterm2.com");
      expect(html).toContain('href="https://mcnachman.cloud/push-dashboard/"');
      expect(html).toContain("4 ok / 1 failed");
      expect(html).toContain("last delivery");
      expect(html).toMatch(/checked<\/span><span class=v>60s ago/);
      expect(html).toMatch(/peer queue<\/span><span class=v>3</);
      expect(html).toMatch(/peer clock<\/span><span class=v>\+18ms</);
      expect(html).toMatch(/peer answered<\/span><span class=v>30s ago</);
      // An older relay without the liveness gauge gets no "peer answered" row.
      expect(html.match(/peer answered/g).length).toBe(1);
    } finally { server.close(); }
  });
});
