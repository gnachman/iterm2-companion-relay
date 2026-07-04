// The collector: on a timer, scrape the relay's loopback /metrics, parse it, and
// append one sample to the DB. Modeled on host/metricspush.js — injectable fetch
// and clock, a scrape failure is REPORTED and swallowed (never thrown), and the
// timer is unref'd so it never keeps the process alive on its own.
//
// A failed scrape (relay restarting, briefly unreachable) simply skips that
// sample; the gap is itself the signal — the page shows staleness, and reset-
// aware rate math tolerates missing intervals. Pruning old rows runs on the same
// tick, cheaply, so the DB self-limits without a second timer.

import { parseMetrics } from "./parse.js";

export function startCollector({
  db,
  url,
  intervalMs = 30_000,
  retentionMs = 90 * 24 * 60 * 60 * 1000, // 90 days
  fetchImpl = globalThis.fetch,
  now = Date.now,
  onError,
  onSample,
  // The relay and the push relay expose different metric shapes on different
  // loopback endpoints, so the parse/insert/prune are injectable. Defaults keep
  // the original companion-relay behavior; the push collector passes its own.
  parse = parseMetrics,
  insert = (ts, snap) => db.insert(ts, snap),
  prune = (cutoff) => db.prune(cutoff),
}) {
  let pruneAccum = 0;

  async function tick() {
    try {
      const res = await fetchImpl(url, { headers: { accept: "text/plain" } });
      if (!res || !res.ok) throw new Error(`scrape HTTP ${res ? res.status : "no response"}`);
      const text = await res.text();
      const snapshot = parse(text);
      const ts = now();
      insert(ts, snapshot);
      if (onSample) onSample(ts, snapshot);
    } catch (e) {
      if (onError) onError(e);
    }
    // Prune roughly hourly regardless of scrape cadence.
    pruneAccum += intervalMs;
    if (pruneAccum >= 3_600_000) {
      pruneAccum = 0;
      try { prune(now() - retentionMs); } catch (e) { if (onError) onError(e); }
    }
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick(); // seed immediately so the page has a point within seconds of boot

  return function stop() {
    clearInterval(timer);
  };
}
