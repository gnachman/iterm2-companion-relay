// Unit tests for the outbound metrics pusher. It POSTs an aggregate snapshot to
// the collector on a timer; a failed push must never throw into the relay. Fetch
// and the clock are injected so no network or real timers are involved.

import { describe, it, expect, vi } from "vitest";
import { startMetricsPush } from "../../host/metricspush.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeFetch(impl) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return impl ? impl(url, opts) : { ok: true, status: 204 };
  };
  fn.calls = calls;
  return fn;
}

describe("startMetricsPush", () => {
  it("POSTs the snapshot immediately with a bearer token and a timestamp", async () => {
    const fetchImpl = fakeFetch();
    const stop = startMetricsPush({
      url: "https://monitor.example/ingest",
      token: "shhh",
      intervalMs: 1_000_000, // large: only the immediate push fires
      fetchImpl,
      now: () => 1234,
      buildSnapshot: () => ({ http_requests_total: 7 }),
    });
    await tick();
    stop();

    expect(fetchImpl.calls).toHaveLength(1);
    const { url, opts } = fetchImpl.calls[0];
    expect(url).toBe("https://monitor.example/ingest");
    expect(opts.method).toBe("POST");
    expect(opts.headers.authorization).toBe("Bearer shhh");
    expect(JSON.parse(opts.body)).toEqual({ ts: 1234, http_requests_total: 7 });
  });

  it("swallows a network error and reports it via onError (never throws)", async () => {
    const onError = vi.fn();
    const fetchImpl = fakeFetch(() => { throw new Error("ECONNREFUSED"); });
    const stop = startMetricsPush({
      url: "u", token: "t", intervalMs: 1_000_000, fetchImpl, onError,
      buildSnapshot: () => ({}),
    });
    await tick();
    stop();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("reports a non-2xx response via onError", async () => {
    const onError = vi.fn();
    const fetchImpl = fakeFetch(() => ({ ok: false, status: 401 }));
    const stop = startMetricsPush({
      url: "u", token: "t", intervalMs: 1_000_000, fetchImpl, onError,
      buildSnapshot: () => ({}),
    });
    await tick();
    stop();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toMatch(/401/);
  });

  it("pushes again on each interval and stops after stop()", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = fakeFetch();
      const stop = startMetricsPush({
        url: "u", token: "t", intervalMs: 50, fetchImpl, now: () => 0,
        buildSnapshot: () => ({}),
      });
      // Immediate push, then one per interval.
      await vi.advanceTimersByTimeAsync(120); // ~2 more
      const after = fetchImpl.calls.length;
      expect(after).toBeGreaterThanOrEqual(3);
      stop();
      await vi.advanceTimersByTimeAsync(200);
      expect(fetchImpl.calls.length).toBe(after); // no more after stop()
    } finally {
      vi.useRealTimers();
    }
  });
});
