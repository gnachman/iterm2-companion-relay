// The transport-agnostic orchestration for one monitor tick. Side effects are
// injected so run() stays unit-tested with no network:
//
//   kv          - persistence               (fileStore in prod; a Map fake in tests)
//   sendEmail   - alert delivery             (Resend in prod; a stub in tests)
//   fetchMap    - fetch+parse the shard map  (fetch in prod; a stub in tests)
//   probeOne    - one host's ws handshake    (nodeProbe in prod; a stub in tests)
//   roomForHost - an owned room for a host    (ownedRoomForHost in prod; a stub in tests)
//
// The monitor is fleet-first: with SHARD_MAP_URL set, the shard map is the single
// source of truth for WHICH hosts exist. Each tick we fetch it and, for every host
// it names, check push freshness (liveness), the pushed gauges/counters (capacity,
// errors, exceptions), and drive an owned-room inbound probe. Adding a relay to the
// fleet is therefore zero monitor config: put it in the map and point its push at
// /ingest/<host>; the monitor discovers it and starts watching. Without
// SHARD_MAP_URL this degrades to a single direct-mode relay (one push key + an
// optional random-room probe via RELAY_PROBE_URL), so a non-sharded self-host still
// works. The pure analysis lives in monitor.js; this file wires it to state + I/O.
//
// Each non-dry tick also persists a compact per-host HEALTH doc (status ok/warn/
// crit + a few gauges) that the fleet dashboard renders without re-probing on load.

import {
  parseConfig, normalizeSnapshot, deltas, rollHour, hourKey, analyze, dueAlerts,
  livenessAlert, probeAlert, parsePushMetrics, parseRelayMetrics, pushDeltas, pushAlerts, peerAlerts, pushRelaysFromEnv,
} from "./monitor.js";

// Direct-mode (no shard map) push lands under this single key; fleet-mode pushes
// land under `latest:<host>`.
export const LATEST_KEY = "latest";
export const STATE_KEY = "state";
export const HEALTH_KEY = "health";
export const DIRECT_HOST = "__direct__";

export function latestKeyFor(host) {
  return host === DIRECT_HOST ? LATEST_KEY : `latest:${host}`;
}

// Namespace a per-host alert so its cooldown, escalation, and clear-on-resolve are
// independent per host, and the email names the host. Direct mode (single host)
// keeps the bare keys/titles.
function hostAlert(host, fleet, a) {
  if (!fleet) return a;
  return { ...a, key: `${host}|${a.key}`, title: `[${host}] ${a.title}` };
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return "relay"; }
}

// Total buckets a host owns in the map (for the dashboard's shard-weight readout).
function ownedBucketCount(map, host) {
  let n = 0;
  for (const r of (map && map.ranges) || []) {
    if (r && r.host === host && Number.isInteger(r.low) && Number.isInteger(r.high) && r.low <= r.high) {
      n += r.high - r.low + 1;
    }
  }
  return n;
}

// env: the flat config/secrets object (process.env in prod). now: ms timestamp.
// deps: { dry, kv, sendEmail, fetchMap, probeOne, roomForHost }. Returns the health
// doc (also persisted when !dry).
export async function run(env, now, { dry, kv, sendEmail, fetchMap, probeOne, roomForHost, scrapePush, probePush }) {
  const cfg = parseConfig(env);
  const state = dry ? {} : ((await kv.get(STATE_KEY, "json")) || {});
  const fleet = !!env.SHARD_MAP_URL;

  // Resolve the shard map (fleet mode). A map that can't be fetched or parsed is
  // itself a pairing-critical failure: if the monitor can't resolve ownership,
  // clients likely can't either, and we can't build owned rooms to probe with.
  let map = null;
  let mapError = null;
  if (fleet && fetchMap) {
    try { map = await fetchMap(env.SHARD_MAP_URL); }
    catch (e) { mapError = String((e && e.message) || e); }
  }

  // The hosts to watch this tick:
  //  - fleet + map ok: exactly the hosts the map names (source of truth). Hosts
  //    that dropped out of the map are no longer watched (drained/removed) and
  //    their stale state is pruned below.
  //  - fleet + map failed: fall back to hosts we watched last tick, so a map
  //    outage doesn't blind liveness for relays we already know about.
  //  - direct mode: one pseudo-host.
  const prevHosts = Object.keys(state.hosts || {});
  const hosts = fleet
    ? (map ? mapHostsFrom(map) : prevHosts)
    : [DIRECT_HOST];

  const alerts = [];
  const nextHosts = {}; // rebuilt from the hosts we actually processed -> prunes drained hosts
  const summaries = [];

  // A map-fetch failure pages once, fleet-wide, distinct from any per-host alert.
  // Debounced (alertFailStreak): a single transient resolver hiccup shouldn't
  // page. A clean fetch resets the streak.
  const mapFailStreak = fleet ? (mapError ? (state.mapFailStreak || 0) + 1 : 0) : 0;
  if (fleet && mapError && mapFailStreak >= cfg.alertFailStreak) {
    alerts.push(probeAlert(`shard map fetch failed: ${mapError}`));
  }

  for (const host of hosts) {
    const latest = await kv.get(latestKeyFor(host), "json");
    const ageMs = latest ? now - latest.receivedAt : null;
    const hs = (state.hosts && state.hosts[host]) || {};
    const reasons = [];        // this host's own alert keys (bare), for the dashboard
    let sockets = null;
    let rooms = null;

    // --- push side: liveness + the pushed-metric checks ---
    if (!latest || ageMs > cfg.staleMs) {
      const detail = latest ? `no snapshot for ${Math.round(ageMs / 60000)} min` : "no snapshot received yet";
      const a = livenessAlert(detail);
      reasons.push(a.key);
      // Debounce (alertFailStreak): a single missed push cycle (e.g. the monitor
      // briefly couldn't receive the relay's push) shouldn't page.
      const livenessFailStreak = (hs.livenessFailStreak || 0) + 1;
      if (livenessFailStreak >= cfg.alertFailStreak) alerts.push(hostAlert(host, fleet, a));
      nextHosts[host] = { ...hs, livenessFailStreak }; // preserve baselines + track the streak
    } else {
      const snap = normalizeSnapshot(latest.snapshot);
      sockets = snap.gauges.socketsLive;
      rooms = snap.gauges.roomsLive;
      const interval = deltas(hs.prev, snap.counters);
      const roll = rollHour(hs.hourAnchor, snap.counters, hourKey(now));
      const analyzed = analyze({ gauges: snap.gauges, interval, lastHour: roll.lastHour }, hs, cfg);
      for (const a of analyzed.alerts) { reasons.push(a.key); alerts.push(hostAlert(host, fleet, a)); }
      nextHosts[host] = {
        prev: snap.counters, hourAnchor: roll.anchor,
        history: analyzed.history, lastRecordedHour: analyzed.lastRecordedHour,
        livenessFailStreak: 0, // fresh push resets the liveness streak
      };
    }

    // --- inbound side: a real pairing handshake ---
    let probe = null;
    if (fleet && map && probeOne && roomForHost) {
      const room = roomForHost(map, host); // null => host owns nothing (drained): skip
      if (room) probe = await probeOne(`https://${host}/`, cfg.probeTimeoutMs, room);
    } else if (!fleet && env.RELAY_PROBE_URL && probeOne) {
      probe = await probeOne(env.RELAY_PROBE_URL, cfg.probeTimeoutMs); // direct mode: random room
    }
    if (probe) {
      // Debounce (alertFailStreak): a single failed handshake over a transiently
      // lossy path (the monitor's own uplink, which holds the probe socket open
      // for seconds) shouldn't page while the relay serves real users fine. A
      // success resets the streak.
      const probeFailStreak = probe.ok ? 0 : (hs.probeFailStreak || 0) + 1;
      nextHosts[host].probeFailStreak = probeFailStreak;
      if (!probe.ok) {
        reasons.push("probe");
        if (probeFailStreak >= cfg.alertFailStreak) alerts.push(hostAlert(host, fleet, probeAlert(probe.detail)));
      }
    } else if (hs.probeFailStreak) {
      nextHosts[host].probeFailStreak = hs.probeFailStreak; // probe not run this tick: preserve the streak
    }

    // Per-host status for the dashboard: liveness (not reporting) or a failed
    // probe (can't pair) is critical; any other alert (capacity/errors/
    // exceptions/shard/anomaly) is a warning; otherwise ok.
    const crit = !latest || (ageMs != null && ageMs > cfg.staleMs) || (probe ? !probe.ok : false);
    const warn = !crit && reasons.some((k) => k !== "liveness" && k !== "probe");
    summaries.push({
      host: fleet ? host : (hostOf(env.RELAY_PROBE_URL || "") || "relay"),
      status: crit ? "crit" : (warn ? "warn" : "ok"),
      ageMs,
      sockets,
      rooms,
      buckets: (fleet && map) ? ownedBucketCount(map, host) : null,
      probeOk: probe ? probe.ok : null,
      reasons,
    });
  }

  // --- push relays (APNs forwarders) ---
  // Optional: PUSH_METRICS_URL enables the first, PUSH2_METRICS_URL a second
  // instance, and so on (see pushRelaysFromEnv). Each is scraped, not pushed,
  // and shows up as one more card in the fleet summary. Failure to scrape is a
  // push relay's liveness signal; its PROBE_URL adds an outside-in check through
  // DNS/edge/proxy. Both are debounced like the relay checks.
  const nextPushes = {};
  for (const relay of scrapePush ? pushRelaysFromEnv(env) : []) {
    const label = relay.label;
    // State is per relay label. (The first relay's used to be state.push.)
    const ps = (state.pushes && state.pushes[label]) || (relay.index === 1 && state.push) || {};
    const reasons = [];
    let cur = null;
    let scrapeErr = null;
    try { cur = parsePushMetrics(await scrapePush(relay.metricsUrl, relay.metricsAuth)); }
    catch (e) { scrapeErr = String((e && e.message) || e); }

    const scrapeFailStreak = cur ? 0 : (ps.scrapeFailStreak || 0) + 1;
    if (!cur) {
      const a = livenessAlert(`push relay /metrics unreachable: ${scrapeErr}`);
      a.title = "Push relay not reporting";
      a.body = `The push relay's metrics endpoint could not be read (${scrapeErr}). The process or its host may be down, so pushes are failing.`;
      reasons.push("liveness");
      if (scrapeFailStreak >= cfg.alertFailStreak) alerts.push(hostAlert(label, true, a));
    }

    let probe = null;
    if (relay.probeUrl && probePush) probe = await probePush(relay.probeUrl, cfg.probeTimeoutMs);
    const probeFailStreak = !probe || probe.ok ? 0 : (ps.probeFailStreak || 0) + 1;
    if (probe && !probe.ok) {
      reasons.push("probe");
      if (probeFailStreak >= cfg.alertFailStreak) alerts.push(hostAlert(label, true, probeAlert(probe.detail)));
    }

    // The interval needs two good scrapes in a row; a gap or a restart (counters
    // went backwards) just skips the rate checks for one tick.
    const interval = cur ? pushDeltas(ps.prev, cur.counters) : null;
    for (const a of pushAlerts(interval, cfg)) { reasons.push(a.key); alerts.push(hostAlert(label, true, a)); }

    // Peering with a second push relay instance (only when it has a peer).
    const peer = cur ? cur.peer : null;
    const peerOutboxStreak = peer && peer.outbox > 0 ? (ps.peerOutboxStreak || 0) + 1 : 0;
    // When we first saw "never answered since it started" (reset once it answers).
    const peerNeverSince = peer && peer.hasLastOk && peer.lastOkTs === 0 ? (ps.peerNeverSince ?? now) : null;
    const peerFindings = peerAlerts(peer, ps.prevPeer || null, peerOutboxStreak, cfg, now, peerNeverSince);
    for (const a of peerFindings) { reasons.push(a.key); alerts.push(hostAlert(label, true, a)); }

    const crit = !cur || (probe ? !probe.ok : false) || reasons.some((k) => k === "apns_auth")
      || pushAlerts(interval, cfg).some((a) => a.severity === "critical")
      || peerFindings.some((a) => a.severity === "critical");
    const warn = !crit && reasons.some((k) => k !== "liveness" && k !== "probe");
    const lastDeliveryAgeMs = cur && cur.gauges.lastDeliveryTs > 0 ? Math.max(0, now - cur.gauges.lastDeliveryTs * 1000) : null;
    summaries.push({
      host: label,
      kind: "push",
      status: crit ? "crit" : (warn ? "warn" : "ok"),
      checkedAt: now,
      ageMs: cur ? 0 : null,
      probeOk: probe ? probe.ok : null,
      reasons,
      detailUrl: relay.dashboardUrl,
      push: cur ? {
        devices: cur.gauges.devices,
        sessions: cur.gauges.sessions,
        lastDeliveryAgeMs,
        delivered: interval ? interval.delivered : null,
        failed: interval ? interval.failed : null,
        timeouts: interval ? interval.timeouts : null,
        peerOutbox: peer ? peer.outbox : null,
        peerSkewMs: peer ? peer.skewMs : null,
        // Known = the relay exports the liveness gauge (older ones don't); then
        // a null age means it hasn't answered since the relay started.
        peerLastOkKnown: !!(peer && peer.hasLastOk),
        peerLastOkAgeMs: peer && peer.hasLastOk && peer.lastOkTs > 0 ? Math.max(0, now - peer.lastOkTs * 1000) : null,
      } : null,
    });
    // Keep the previous good counters across a failed scrape so the next success
    // still has a baseline (a restart is then caught by the backwards counter).
    // The peer baseline and streak carry across a failed scrape the same way.
    nextPushes[label] = {
      prev: cur ? cur.counters : ps.prev,
      prevPeer: cur ? cur.peer : (ps.prevPeer || null),
      peerOutboxStreak: cur ? peerOutboxStreak : (ps.peerOutboxStreak || 0),
      peerNeverSince: cur ? peerNeverSince : (ps.peerNeverSince ?? null),
      scrapeFailStreak,
      probeFailStreak,
    };
  }

  const { due, sentAt } = dueAlerts(alerts, state.sentAt || {}, now, cfg.cooldownMs);

  const counts = summaries.reduce((c, s) => { c[s.status] += 1; return c; }, { ok: 0, warn: 0, crit: 0 });
  const health = {
    at: now,
    fleet,
    mapError,
    mapVersion: map ? (map.version ?? null) : null,
    summary: { total: summaries.length, ...counts },
    hosts: summaries,
    due: due.map((a) => a.key),
  };

  const nextState = { hosts: nextHosts };
  if (fleet) nextState.mapFailStreak = mapFailStreak; // debounce state for the shard-map fetch
  if (Object.keys(nextPushes).length) nextState.pushes = nextPushes;
  if (!dry) {
    let delivered = true;
    if (due.length) {
      try {
        await sendEmail(env, due);
      } catch (e) {
        // A transient delivery failure (Resend 429/5xx, network, bad key, unset
        // ALERT_*) must not lose state. Fall through and persist anyway.
        delivered = false;
        console.error("relay-monitor: alert send failed:", (e && e.message) || e);
      }
    }
    // Advance metric state always (so a send failure can't freeze baselines);
    // advance the cooldown only when the send went out, so an undelivered alert
    // is due again next tick instead of being silently recorded as sent.
    nextState.sentAt = delivered ? sentAt : (state.sentAt || {});
    await kv.put(STATE_KEY, JSON.stringify(nextState));
    await kv.put(HEALTH_KEY, JSON.stringify(health)); // snapshot for the fleet dashboard
  }
  return health;
}

// Pull mode (RELAY_PULL_URL_TEMPLATE): fetch each relay's /metrics ourselves and
// store it exactly where its push would land, so the rest of the monitor can't
// tell the difference. This lets a second (mirror) monitor watch the fleet
// without every relay having to push to it. A scrape that fails stores nothing,
// so the usual liveness check (STALE_MINUTES) reports the host as not reporting.
// The hosts come from the shard map; if it can't be fetched, the ones we pulled
// last time. deps: { kv, fetchMap, scrape(url, authorization) }. Returns
// { hosts, ok, failed: [{ host, error }] }.
export async function pullRelays(env, now, { kv, fetchMap, scrape }, lastHosts = []) {
  let hosts = lastHosts;
  if (env.SHARD_MAP_URL && fetchMap) {
    try { hosts = mapHostsFrom(await fetchMap(env.SHARD_MAP_URL)); }
    catch { /* keep the last list; the analysis tick reports the map failure */ }
  }
  const authorization = env.RELAY_PULL_BASIC_AUTH
    ? `Basic ${Buffer.from(env.RELAY_PULL_BASIC_AUTH).toString("base64")}` : null;
  const failed = [];
  let ok = 0;
  await Promise.all(hosts.map(async (host) => {
    const url = env.RELAY_PULL_URL_TEMPLATE.replace("{host}", host);
    try {
      const snapshot = parseRelayMetrics(await scrape(url, authorization));
      await kv.put(latestKeyFor(host), JSON.stringify({ receivedAt: now, snapshot, pulled: true }));
      ok += 1;
    } catch (e) {
      failed.push({ host, error: String((e && e.message) || e) });
    }
  }));
  return { hosts, ok, failed };
}

// Local copy of the map->hosts projection so core doesn't depend on server; the
// pure version in monitor.js (mapHosts) is what prod passes for probing.
function mapHostsFrom(map) {
  const hosts = [];
  for (const r of (map && map.ranges) || []) {
    if (r && typeof r.host === "string" && !hosts.includes(r.host)) hosts.push(r.host);
  }
  return hosts;
}
