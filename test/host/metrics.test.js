// Unit tests for the aggregate metrics registry. Everything here must be
// non-identifying: counts and a socket-lifetime histogram, never a room name,
// room tag, or IP. (The endpoint wiring / localhost-only gating is tested in
// server.test.js.)

import { describe, it, expect } from "vitest";
import { Metrics } from "../../host/metrics.js";

describe("Metrics", () => {
  it("renders counters in Prometheus text format with HELP/TYPE", () => {
    const m = new Metrics();
    m.inc("ws_upgrades_total");
    m.inc("ws_upgrades_total");
    const out = m.render({});
    expect(out).toContain("# TYPE relay_ws_upgrades_total counter");
    expect(out).toMatch(/relay_ws_upgrades_total 2/);
  });

  it("labels rejection reasons", () => {
    const m = new Metrics();
    m.incReason("ws_upgrades_rejected_total", "rate_limited");
    m.incReason("ws_upgrades_rejected_total", "room_cap");
    m.incReason("ws_upgrades_rejected_total", "rate_limited");
    const out = m.render({});
    expect(out).toContain('relay_ws_upgrades_rejected_total{reason="rate_limited"} 2');
    expect(out).toContain('relay_ws_upgrades_rejected_total{reason="room_cap"} 1');
  });

  it("buckets socket lifetimes cumulatively (flap-cadence histogram)", () => {
    const m = new Metrics();
    m.observeSocketLifetime(0.5); // <=1s
    m.observeSocketLifetime(3); // <=5s
    m.observeSocketLifetime(120); // <=300s
    const out = m.render({});
    // Cumulative buckets: le=1 has 1, le=5 has 2, le=+Inf has 3.
    expect(out).toContain('relay_socket_lifetime_seconds_bucket{le="1"} 1');
    expect(out).toContain('relay_socket_lifetime_seconds_bucket{le="5"} 2');
    expect(out).toContain('relay_socket_lifetime_seconds_bucket{le="+Inf"} 3');
    expect(out).toContain("relay_socket_lifetime_seconds_count 3");
  });

  it("emits gauges passed at render time", () => {
    const m = new Metrics();
    const out = m.render({ rooms_live: 4, sockets_live: 7 });
    expect(out).toContain("# TYPE relay_rooms_live gauge");
    expect(out).toContain("relay_rooms_live 4");
    expect(out).toContain("relay_sockets_live 7");
  });

  it("carries no room names, tags, or IPs", () => {
    const m = new Metrics();
    m.inc("ws_upgrades_total");
    m.incReason("ws_upgrades_rejected_total", "ip_cap");
    m.observeSocketLifetime(10);
    const out = m.render({ rooms_live: 1, sockets_live: 1 });
    // Only the allowed reason label values appear; nothing free-form.
    expect(out).not.toMatch(/room=|tag=|ip=|[0-9a-f]{64}/);
  });
});
