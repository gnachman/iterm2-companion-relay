// Pull mode: the monitor scrapes each relay's /metrics instead of waiting for a
// push (how a mirror monitor watches the fleet). The pulled snapshot must land
// where a push would and read the same to the analysis.

import { describe, it, expect } from "vitest";

import { parseRelayMetrics, normalizeSnapshot } from "../src/monitor.js";
import { pullRelays, run } from "../src/core.js";

function fakeKV() {
  const store = new Map();
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

// Trimmed from a live relay's /metrics.
const SAMPLE = `# HELP relay_http_requests_total HTTP (non-upgrade) requests received.
# TYPE relay_http_requests_total counter
relay_process_exceptions_total 0
relay_ws_upgrades_total 583050
relay_http_requests_total 4518
relay_ws_upgrades_rejected_total{reason="gate"} 91
relay_ws_upgrades_rejected_total{reason="cap"} 9
relay_shard_map_fetch_errors_total 734
relay_shard_map_fetch_errors_by_cause_total{reason="http_4xx"} 689
relay_rooms_live 878
relay_sockets_live 416
relay_shard_map_version 3
relay_shard_owned_buckets 32768
relay_socket_lifetime_seconds_bucket{le="1"} 47613
relay_socket_lifetime_seconds_bucket{le="+Inf"} 582634
relay_socket_lifetime_seconds_sum 1082702110.146013
relay_socket_lifetime_seconds_count 582634
`;

const MAP = {
  version: 3,
  ranges: [
    { low: 0, high: 32767, host: "relay1.example" },
    { low: 32768, high: 65535, host: "relay2.example" },
  ],
};

describe("parseRelayMetrics", () => {
  it("produces the pushed snapshot's fields", () => {
    const s = parseRelayMetrics(SAMPLE);
    expect(s).toMatchObject({
      http_requests_total: 4518,
      process_exceptions_total: 0,
      ws_upgrades_total: 583050,
      shard_map_fetch_errors_total: 734,
      rooms_live: 878,
      sockets_live: 416,
      shard_map_version: 3,
      shard_owned_buckets: 32768,
    });
    expect(normalizeSnapshot(s).gauges).toEqual({ socketsLive: 416, roomsLive: 878 });
  });

  it("sums labeled series and skips the lifetime histogram", () => {
    const s = parseRelayMetrics(SAMPLE);
    expect(s.ws_upgrades_rejected_total).toBe(100);
    expect(Object.keys(s).some((k) => k.startsWith("socket_lifetime"))).toBe(false);
  });

  it("rejects a response with no relay series", () => {
    expect(() => parseRelayMetrics("<html>502 Bad Gateway</html>")).toThrow(/no relay_ metrics/);
    expect(() => parseRelayMetrics("pushrelay_devices 3\n")).toThrow();
  });
});

describe("pullRelays", () => {
  const env = {
    SHARD_MAP_URL: "https://resolver.example/shardmap.json",
    RELAY_PULL_URL_TEMPLATE: "https://{host}/metrics",
    RELAY_PULL_BASIC_AUTH: "monitor:pw",
  };

  it("stores each host's metrics where its push would land", async () => {
    const kv = fakeKV();
    const seen = [];
    const r = await pullRelays(env, 1000, {
      kv,
      fetchMap: async () => MAP,
      scrape: async (url, auth) => { seen.push([url, auth]); return SAMPLE; },
    });
    expect(r).toEqual({ hosts: ["relay1.example", "relay2.example"], ok: 2, failed: [] });
    expect(seen.map((s) => s[0]).sort()).toEqual(["https://relay1.example/metrics", "https://relay2.example/metrics"]);
    expect(seen[0][1]).toBe(`Basic ${Buffer.from("monitor:pw").toString("base64")}`);
    const latest = JSON.parse(kv.store.get("latest:relay2.example"));
    expect(latest.receivedAt).toBe(1000);
    expect(latest.snapshot.sockets_live).toBe(416);
  });

  it("stores nothing for a host it can't read, so liveness catches it", async () => {
    const kv = fakeKV();
    const r = await pullRelays(env, 1000, {
      kv,
      fetchMap: async () => MAP,
      scrape: async (url) => { if (url.includes("relay1")) throw new Error("HTTP 401"); return SAMPLE; },
    });
    expect(r.ok).toBe(1);
    expect(r.failed).toEqual([{ host: "relay1.example", error: "HTTP 401" }]);
    expect(kv.store.has("latest:relay1.example")).toBe(false);
  });

  it("keeps the last host list when the map can't be fetched", async () => {
    const kv = fakeKV();
    const r = await pullRelays(env, 1000, {
      kv,
      fetchMap: async () => { throw new Error("HTTP 503"); },
      scrape: async () => SAMPLE,
    }, ["relay1.example"]);
    expect(r.hosts).toEqual(["relay1.example"]);
    expect(kv.store.has("latest:relay1.example")).toBe(true);
  });

  it("feeds a normal analysis tick", async () => {
    const kv = fakeKV();
    const fetchMap = async () => MAP;
    await pullRelays(env, 1000, { kv, fetchMap, scrape: async () => SAMPLE });
    const health = await run({ ...env, STALE_MINUTES: "9" }, 2000, {
      dry: false, kv, fetchMap, sendEmail: async () => { throw new Error("no alerts expected"); },
    });
    expect(health.summary).toMatchObject({ total: 2, ok: 2 });
    expect(health.hosts.map((h) => h.sockets)).toEqual([416, 416]);
  });
});
