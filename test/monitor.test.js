import { describe, it, expect } from "vitest";
import { parseConfig } from "../monitor/src/monitor.js";

describe("parseConfig numeric coercion", () => {
  it("falls back to the default for a present-but-empty (or whitespace) var, not 0", () => {
    // Number("") is 0 and Number.isFinite(0) is true, so without the empty-string
    // guard a blanked var would silently coerce to 0 (e.g. STALE_MINUTES="" -> a
    // dead-man's-switch that pages every cron run; SOCKETS_CAP="" -> the capacity
    // check silently disabled).
    const cfg = parseConfig({
      STALE_MINUTES: "",
      COOLDOWN_MINUTES: "  ",
      SOCKETS_CAP: "\n",
      ERROR_MIN_REQUESTS: "",
      SPIKE_FACTOR: "",
    });
    expect(cfg.staleMs).toBe(5 * 60 * 1000);
    expect(cfg.cooldownMs).toBe(360 * 60 * 1000);
    expect(cfg.socketsCap).toBe(200000);
    expect(cfg.errorMinRequests).toBe(100);
    expect(cfg.spikeFactor).toBe(3);
  });

  it("honors an explicit numeric value, including an explicit 0", () => {
    const cfg = parseConfig({ STALE_MINUTES: "10", SOCKETS_CAP: "0" });
    expect(cfg.staleMs).toBe(10 * 60 * 1000);
    // "0" is a real value (not empty), so it is preserved rather than defaulted.
    expect(cfg.socketsCap).toBe(0);
  });
});
