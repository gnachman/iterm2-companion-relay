import { describe, it, expect } from "vitest";
import { parseMetrics } from "../../dashboard/parse.js";

const SAMPLE = `# HELP relay_metrics_push_errors_total Outbound metrics-push attempts that failed.
# TYPE relay_metrics_push_errors_total counter
relay_metrics_push_errors_total 0
# TYPE relay_ws_upgrades_total counter
relay_ws_upgrades_total 16
relay_ws_upgrades_rejected_total{reason="slot_occupied"} 3
relay_ws_upgrades_rejected_total{reason="bad_room"} 4
relay_http_requests_total 4
relay_http_errors_total 1
relay_process_exceptions_total 2
relay_quota_exceeded_total 5
relay_rooms_live 3
relay_sockets_live 2
# TYPE relay_socket_lifetime_seconds histogram
relay_socket_lifetime_seconds_bucket{le="1"} 12
relay_socket_lifetime_seconds_bucket{le="5"} 12
relay_socket_lifetime_seconds_bucket{le="15"} 12
relay_socket_lifetime_seconds_bucket{le="60"} 12
relay_socket_lifetime_seconds_bucket{le="300"} 14
relay_socket_lifetime_seconds_bucket{le="1800"} 14
relay_socket_lifetime_seconds_bucket{le="+Inf"} 14
relay_socket_lifetime_seconds_sum 486.899
relay_socket_lifetime_seconds_count 14
`;

describe("parseMetrics", () => {
  it("parses plain counters and gauges", () => {
    const s = parseMetrics(SAMPLE);
    expect(s.ws_upgrades).toBe(16);
    expect(s.http_requests).toBe(4);
    expect(s.http_errors).toBe(1);
    expect(s.exceptions).toBe(2);
    expect(s.push_errors).toBe(0);
    expect(s.quota_exceeded).toBe(5);
    expect(s.rooms_live).toBe(3);
    expect(s.sockets_live).toBe(2);
  });

  it("sums reason-labeled rejections into a single total", () => {
    expect(parseMetrics(SAMPLE).ws_rejected).toBe(7);
  });

  it("captures cumulative lifetime buckets, sum, and count; ignores +Inf as a column", () => {
    const s = parseMetrics(SAMPLE);
    expect(s.life_le1).toBe(12);
    expect(s.life_le300).toBe(14);
    expect(s.life_le1800).toBe(14);
    expect(s.life_count).toBe(14);
    expect(s.life_sum).toBeCloseTo(486.899, 3);
  });

  it("defaults every field to 0 on empty input", () => {
    const s = parseMetrics("");
    for (const k of ["ws_upgrades", "ws_rejected", "http_requests", "http_errors", "exceptions", "push_errors", "quota_exceeded", "rooms_live", "sockets_live", "life_le1", "life_count", "life_sum"]) {
      expect(s[k]).toBe(0);
    }
  });

  it("ignores unknown series and malformed lines", () => {
    const s = parseMetrics("garbage line\nrelay_unknown_total 99\nrelay_sockets_live 5\n# comment\n");
    expect(s.sockets_live).toBe(5);
    expect(s.ws_upgrades).toBe(0);
  });
});
