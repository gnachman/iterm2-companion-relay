import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDashboard } from "../../dashboard/server.js";
import { DashboardDB } from "../../dashboard/db.js";

const snap = (o = {}) => ({ ws_upgrades: 0, ws_rejected: 0, http_requests: 0, http_errors: 0, exceptions: 0, push_errors: 0, rooms_live: 0, sockets_live: 0, life_le1: 0, life_le5: 0, life_le15: 0, life_le60: 0, life_le300: 0, life_le1800: 0, life_count: 0, life_sum: 0, ...o });
const authHeader = "Basic " + Buffer.from("admin:pw").toString("base64");

describe("dashboard server", () => {
  let dash, base, db;

  beforeAll(async () => {
    db = new DashboardDB(":memory:");
    db.insert(Date.now() - 1000, snap({ sockets_live: 2, rooms_live: 3, http_requests: 10 }));
    db.insert(Date.now(), snap({ sockets_live: 4, rooms_live: 3, http_requests: 25 }));
    dash = createDashboard({ db, user: "admin", pass: "pw", startCollectorOnListen: false });
    await dash.listen(0);
    base = `http://127.0.0.1:${dash.address().port}`;
  });

  afterAll(async () => { await dash.close(); db.close(); });

  it("serves /healthz without auth", async () => {
    const res = await fetch(base + "/healthz");
    expect(res.status).toBe(200);
    expect((await res.text()).trim()).toBe("ok");
  });

  it("challenges the page without credentials", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
  });

  it("serves the HTML page with valid credentials", async () => {
    const res = await fetch(base + "/", { headers: { authorization: authHeader } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("iTerm2 Relay");
  });

  it("serves the JSON API with tiles, series, and alerts", async () => {
    const res = await fetch(base + "/api/data?range=24h", { headers: { authorization: authHeader } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tiles.sockets_live).toBe(4);
    expect(data.tiles.requests).toBe(15); // 25 - 10
    expect(Array.isArray(data.series.sockets_live)).toBe(true);
    expect(Array.isArray(data.alerts)).toBe(true);
  });

  it("rejects the API without credentials", async () => {
    const res = await fetch(base + "/api/data");
    expect(res.status).toBe(401);
  });

  it("404s an unknown authed path", async () => {
    const res = await fetch(base + "/nope", { headers: { authorization: authHeader } });
    expect(res.status).toBe(404);
  });
});
