// Outbound metrics push — the off-box monitoring transport.
//
// Instead of exposing /metrics to the internet (a scrape surface + a hostname to
// discover), the relay POSTs an aggregate, PII-free snapshot to a collector on a
// timer. The origin stays outbound-only: nothing new listens, the VPS is never
// named anywhere, and the collector treats a gap in pushes as a dead-man's-switch
// (the relay or the box is down). The body is the same counts /metrics exposes
// locally — never a room name, tag, or IP — so this does not weaken the
// zero-retention posture.
//
// Pure and injectable: `buildSnapshot` supplies the numbers and `fetchImpl` the
// transport, so the pusher is unit-tested without a network or a live relay.

export function startMetricsPush({
  buildSnapshot,
  url,
  token,
  intervalMs = 60_000,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  onError,
}) {
  async function push() {
    try {
      const body = JSON.stringify({ ts: now(), ...buildSnapshot() });
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body,
      });
      // A non-2xx (bad token, collector down) is reported but never thrown: a
      // failed push must not disturb the relay. The collector's staleness alarm
      // covers a sustained outage.
      if (res && !res.ok && onError) onError(new Error(`metrics push HTTP ${res.status}`));
    } catch (e) {
      if (onError) onError(e);
    }
  }

  const timer = setInterval(push, intervalMs);
  timer.unref?.(); // never keep the process alive for a push
  // Fire once immediately so a fresh start is visible to the collector within
  // seconds (and a misconfigured token surfaces at once), not after intervalMs.
  push();

  return function stop() {
    clearInterval(timer);
  };
}
