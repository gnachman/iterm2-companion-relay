// Shard-map fetch-failure diagnosability: a persistent fetch failure must be
// attributable (dns vs network path vs Cloudflare vs bad body) from the journal
// and /metrics alone, without a live repro. Covers the classifier (pure) and the
// end-to-end wiring (per-cause counter + always-on throttled log).

import { describe, it, expect, vi } from "vitest";
import {
  createRelay,
  classifyShardFetchError,
  shouldRetryShardFetch,
  fetchShardMapWithRetry,
} from "../../host/server.js";

const N = 65536;
const MAP_JSON = JSON.stringify({
  version: 7,
  ranges: [
    { low: 0, high: 49999, host: "relay2" },
    { low: 50000, high: N - 1, host: "relay1" },
  ],
});

// undici surfaces a network failure as `TypeError: fetch failed` with the real
// errno under .cause; build that shape so the classifier is tested as it is fed.
function fetchFailed(code) {
  const e = new TypeError("fetch failed");
  e.cause = { code };
  return e;
}
function httpErr(status, cfRay) {
  const e = new Error(`shardmap HTTP ${status}`);
  e.httpStatus = status;
  if (cfRay) e.cfRay = cfRay;
  return e;
}

describe("classifyShardFetchError", () => {
  it("maps DNS failures", () => {
    expect(classifyShardFetchError(fetchFailed("ENOTFOUND"))).toEqual({ cause: "dns", detail: "ENOTFOUND" });
    expect(classifyShardFetchError(fetchFailed("EAI_AGAIN")).cause).toBe("dns");
  });
  it("maps timeouts (errno, undici code, and AbortError)", () => {
    expect(classifyShardFetchError(fetchFailed("ETIMEDOUT")).cause).toBe("timeout");
    expect(classifyShardFetchError(fetchFailed("UND_ERR_CONNECT_TIMEOUT")).cause).toBe("timeout");
    const abort = new Error("aborted"); abort.name = "AbortError";
    expect(classifyShardFetchError(abort)).toEqual({ cause: "timeout", detail: "abort" });
  });
  it("maps connection failures", () => {
    expect(classifyShardFetchError(fetchFailed("ECONNREFUSED")).cause).toBe("conn");
    expect(classifyShardFetchError(fetchFailed("ECONNRESET")).cause).toBe("conn");
  });
  it("maps TLS failures", () => {
    expect(classifyShardFetchError(fetchFailed("CERT_HAS_EXPIRED")).cause).toBe("tls");
    expect(classifyShardFetchError(fetchFailed("ERR_TLS_CERT_ALTNAME_INVALID")).cause).toBe("tls");
  });
  it("splits HTTP errors and keeps the cf-ray for Cloudflare attribution", () => {
    expect(classifyShardFetchError(httpErr(503, "8f-abc"))).toEqual({ cause: "http_5xx", detail: "HTTP 503 cf-ray=8f-abc" });
    expect(classifyShardFetchError(httpErr(403)).cause).toBe("http_4xx");
  });
  it("maps parse/validation failures", () => {
    const validation = new Error("gap"); validation.kind = "coverage_gap";
    expect(classifyShardFetchError(validation)).toEqual({ cause: "parse", detail: "coverage_gap" });
    const syntax = new SyntaxError("Unexpected token");
    expect(classifyShardFetchError(syntax)).toEqual({ cause: "parse", detail: "json" });
  });
  it("falls back to other with a code or trimmed message", () => {
    expect(classifyShardFetchError(fetchFailed("EWHATEVER"))).toEqual({ cause: "other", detail: "EWHATEVER" });
    expect(classifyShardFetchError(new Error("weird")).cause).toBe("other");
    expect(classifyShardFetchError(null)).toEqual({ cause: "other", detail: "unknown" });
  });
});

async function boot(fetchText) {
  const relay = createRelay({
    env: { RELAY_ORIGIN: "https://relay1", RELAY_LOG: "false", ATTEST_REQUIRED: "false" },
    dbPath: ":memory:",
    shardMapUrl: "https://cdn/shardmap.json",
    selfHost: "relay1",
    fetchText,
    bootSleep: async () => {},
  });
  await relay.listen(0, "127.0.0.1");
  return { relay, base: `http://127.0.0.1:${relay.address().port}` };
}

describe("shard-map fetch-failure wiring", () => {
  it("counts a failure by cause on /metrics and logs an always-on FAILING line", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let boot0 = true;
    const fetchText = async () => {
      if (boot0) { boot0 = false; return MAP_JSON; }
      throw fetchFailed("ENOTFOUND");
    };
    const { relay, base } = await boot(fetchText);
    try {
      await relay.shardPoller.fetchOnce(); // one failing poll after boot
      const text = await (await fetch(base + "/metrics")).text();
      expect(text).toContain('relay_shard_map_fetch_errors_by_cause_total{reason="dns"} 1');
      expect(text).toMatch(/relay_shard_map_fetch_errors_total \d+/);
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toMatch(/shardmap fetch FAILING cause=dns detail=ENOTFOUND/);
    } finally {
      await relay.close();
      warn.mockRestore();
    }
  });

  it("logs a RECOVERED line (with duration) when a fetch succeeds after failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const fetchText = async () => {
      n += 1;
      if (n === 1) return MAP_JSON;        // boot
      if (n === 2) throw fetchFailed("ETIMEDOUT"); // one failure
      return MAP_JSON;                     // then recover
    };
    const { relay } = await boot(fetchText);
    try {
      await relay.shardPoller.fetchOnce(); // fails
      await relay.shardPoller.fetchOnce(); // recovers
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toMatch(/shardmap fetch FAILING cause=timeout/);
      expect(logged).toMatch(/shardmap fetch RECOVERED after streak=1 over \d+s/);
    } finally {
      await relay.close();
      warn.mockRestore();
    }
  });
});

// A minimal Response-like for a fake fetchImpl (undici Response shape the GET uses).
const okResp = (body) => ({ ok: true, status: 200, headers: { get: () => "" }, text: async () => body });
const httpResp = (status) => ({ ok: false, status, headers: { get: () => "" } });

describe("shouldRetryShardFetch", () => {
  it("does not retry a definitive 4xx (WAF / bad URL -- a retry only repeats it)", () => {
    expect(shouldRetryShardFetch(httpErr(403))).toBe(false);
    expect(shouldRetryShardFetch(httpErr(404))).toBe(false);
  });
  it("retries aborts, network errors, and 5xx (transient, a fresh connection may dodge it)", () => {
    const abort = new Error("aborted"); abort.name = "AbortError";
    expect(shouldRetryShardFetch(abort)).toBe(true);
    expect(shouldRetryShardFetch(fetchFailed("ETIMEDOUT"))).toBe(true);
    expect(shouldRetryShardFetch(fetchFailed("ECONNRESET"))).toBe(true);
    expect(shouldRetryShardFetch(httpErr(503))).toBe(true);
  });
});

describe("fetchShardMapWithRetry", () => {
  it("returns the first success without retrying", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return okResp("MAP"); };
    const onRetry = vi.fn();
    expect(await fetchShardMapWithRetry("u", { fetchImpl, onRetry })).toBe("MAP");
    expect(calls).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("absorbs a transient failure on a fresh attempt and succeeds", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; if (calls < 2) throw fetchFailed("ETIMEDOUT"); return okResp("MAP"); };
    const onRetry = vi.fn();
    expect(await fetchShardMapWithRetry("u", { fetchImpl, onRetry, attempts: 3 })).toBe("MAP");
    expect(calls).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("throws the last error after exhausting attempts (one failure surfaced, not N)", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; throw fetchFailed("ETIMEDOUT"); };
    const onRetry = vi.fn();
    await expect(fetchShardMapWithRetry("u", { fetchImpl, onRetry, attempts: 3 })).rejects.toThrow();
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2); // fired between the 3 attempts, not on the final give-up
  });

  it("does not retry a 4xx", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return httpResp(403); };
    const onRetry = vi.fn();
    await expect(fetchShardMapWithRetry("u", { fetchImpl, onRetry, attempts: 3 }))
      .rejects.toMatchObject({ httpStatus: 403 });
    expect(calls).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe("shard-map fetch retry wiring (through the poller)", () => {
  it("a transient blip a retry absorbs is NOT counted as a fetch failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    // boot (n=1) succeeds; the manual poll's first attempt (n=2) fails, retry (n=3) succeeds.
    const fetchImpl = async () => { n += 1; if (n === 2) throw fetchFailed("ETIMEDOUT"); return okResp(MAP_JSON); };
    const { relay, base } = await boot((url) => fetchShardMapWithRetry(url, { fetchImpl, attempts: 3 }));
    try {
      await relay.shardPoller.fetchOnce();
      const text = await (await fetch(base + "/metrics")).text();
      expect(text).toMatch(/relay_shard_map_fetch_errors_total 0\b/);
      const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).not.toMatch(/FAILING/);
    } finally {
      await relay.close();
      warn.mockRestore();
    }
  });

  it("counts exactly one failure (one FAILING line) when every attempt fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let boot0 = true;
    const fetchImpl = async () => {
      if (boot0) { boot0 = false; return okResp(MAP_JSON); }
      throw fetchFailed("ETIMEDOUT");
    };
    const { relay, base } = await boot((url) => fetchShardMapWithRetry(url, { fetchImpl, attempts: 3 }));
    try {
      await relay.shardPoller.fetchOnce(); // all 3 attempts fail -> one counted failure
      const text = await (await fetch(base + "/metrics")).text();
      expect(text).toMatch(/relay_shard_map_fetch_errors_total 1\b/);
      const failing = warn.mock.calls.map((c) => c.join(" ")).filter((l) => /FAILING/.test(l));
      expect(failing).toHaveLength(1);
    } finally {
      await relay.close();
      warn.mockRestore();
    }
  });
});
