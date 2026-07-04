import { describe, it, expect, vi } from "vitest";
import { startCollector } from "../../dashboard/collector.js";

const flush = () => new Promise((r) => setTimeout(r, 10));

function fakeDb() {
  return { rows: [], pruned: [], insert(ts, s) { this.rows.push({ ts, s }); }, prune(c) { this.pruned.push(c); return 0; } };
}
const okResponse = (text) => ({ ok: true, status: 200, text: async () => text });

describe("startCollector", () => {
  it("scrapes, parses, and inserts a sample on the seed tick", async () => {
    const db = fakeDb();
    const fetchImpl = vi.fn(async () => okResponse("relay_sockets_live 7\n"));
    const stop = startCollector({ db, url: "http://x/metrics", intervalMs: 999999, fetchImpl, now: () => 1234 });
    await flush();
    stop();
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].ts).toBe(1234);
    expect(db.rows[0].s.sockets_live).toBe(7);
  });

  it("reports and swallows a failed scrape without inserting", async () => {
    const db = fakeDb();
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, text: async () => "" }));
    const stop = startCollector({ db, url: "http://x/metrics", intervalMs: 999999, fetchImpl, onError });
    await flush();
    stop();
    expect(db.rows).toHaveLength(0);
    expect(onError).toHaveBeenCalled();
  });

  it("swallows a thrown fetch (relay unreachable)", async () => {
    const db = fakeDb();
    const onError = vi.fn();
    const stop = startCollector({ db, url: "http://x/metrics", intervalMs: 999999, fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, onError });
    await flush();
    stop();
    expect(db.rows).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "ECONNREFUSED" }));
  });
});
