// The dashboard page: one self-contained HTML document (inline CSS + JS + SVG),
// no external requests — it renders behind Apache on the box with no CDN reach.
// The server serves this string at "/"; all data arrives from GET /api/data as
// JSON and is drawn client-side.
//
// Design follows the repo's data-viz method: small-multiple SINGLE-series line
// charts (so each needs no legend — its title names it), the validated
// categorical/status palette wired as CSS custom properties that swap for dark
// mode, thin 2px marks over recessive grid/axes, and a crosshair+tooltip hover
// layer. Colors follow the entity, not its rank.

export function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>iTerm2 Relay Dashboard</title>
<style>
  :root {
    --plane: #f9f9f7; --surface: #fcfcfb;
    --ink: #0b0b0b; --ink2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
    --blue: #2a78d6; --aqua: #1baf7a; --yellow: #eda100; --violet: #4a3aa7;
    --red: #e34948; --magenta: #e87ba4; --orange: #eb6834;
    --good: #0ca30c; --warn: #fab219; --serious: #ec835a; --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --plane: #0d0d0d; --surface: #1a1a19;
      --ink: #ffffff; --ink2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
      --blue: #3987e5; --aqua: #199e70; --yellow: #c98500; --violet: #9085e9;
      --red: #e66767; --magenta: #d55181; --orange: #d95926;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--plane); color: var(--ink);
    font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap;
    padding: 16px 20px; border-bottom: 1px solid var(--border);
  }
  h1 { font-size: 16px; font-weight: 650; margin: 0; }
  .sub { color: var(--muted); font-size: 12px; }
  .spacer { flex: 1; }
  .ranges { display: flex; gap: 4px; }
  .ranges button {
    font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer;
    background: var(--surface); color: var(--ink2);
    border: 1px solid var(--border); border-radius: 6px;
  }
  .ranges button[aria-pressed="true"] { color: var(--ink); border-color: var(--blue); font-weight: 600; }
  main { padding: 16px 20px 40px; max-width: 1200px; margin: 0 auto; }
  #health {
    margin-bottom: 16px; padding: 10px 14px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--surface);
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  #health .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  #health .msg { font-weight: 600; }
  .alert { display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
    padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-bottom: 20px; }
  .tile { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .tile .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .tile .value { font-size: 26px; font-weight: 650; margin-top: 4px; line-height: 1.1; }
  .tile .value .unit { font-size: 13px; font-weight: 500; color: var(--ink2); margin-left: 2px; }
  .tile .note { color: var(--muted); font-size: 11px; margin-top: 2px; }
  .tile.status-good .value { color: var(--good); }
  .tile.status-warn .value { color: var(--serious); }
  .tile.status-critical .value { color: var(--critical); }
  .charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
  .chart { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px 8px; }
  .chart h3 { margin: 0 0 2px; font-size: 13px; font-weight: 600; }
  .chart .cur { color: var(--ink2); font-size: 12px; font-variant-numeric: tabular-nums; }
  .chart svg { display: block; width: 100%; height: 120px; overflow: visible; touch-action: none; }
  .chart .empty { color: var(--muted); font-size: 12px; padding: 40px 0; text-align: center; }
  .tt { position: fixed; pointer-events: none; z-index: 10; background: var(--surface);
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 12px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.18); opacity: 0; transition: opacity .08s; }
  .tt .t { color: var(--muted); }
  .tt .v { font-weight: 650; font-variant-numeric: tabular-nums; }
  footer { color: var(--muted); font-size: 11px; padding: 0 20px 24px; max-width: 1200px; margin: 0 auto; }
  a { color: var(--blue); }
</style>
</head>
<body>
<header>
  <h1>iTerm2 Relay</h1>
  <span class="sub" id="freshness">loading…</span>
  <span class="spacer"></span>
  <div class="ranges" id="ranges" role="group" aria-label="Time range"></div>
</header>
<main>
  <div id="health" hidden></div>
  <div class="tiles" id="tiles"></div>
  <div class="charts" id="charts"></div>
</main>
<footer id="foot"></footer>
<div class="tt" id="tt"></div>
<script>
${CLIENT_JS}
</script>
</body>
</html>`;
}

// Client script kept as a separate template so the HTML above stays readable.
const CLIENT_JS = String.raw`
const RANGES = [
  { key: "1h", label: "1h", ms: 3600e3 },
  { key: "6h", label: "6h", ms: 6*3600e3 },
  { key: "24h", label: "24h", ms: 24*3600e3 },
  { key: "7d", label: "7d", ms: 7*24*3600e3 },
  { key: "30d", label: "30d", ms: 30*24*3600e3 },
];
let curRange = localStorage.getItem("range") || "24h";
let timer = null;

// --- tiles: [key, label, formatter, statusFn?, noteFn?] -----------------------
const num = (n) => n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const pct = (n) => n == null ? "—" : num(n) + "%";
const secs = (n) => n == null ? "—" : num(n) + "s";
const dur = (ms) => {
  if (ms == null) return "—";
  const s = Math.round(ms/1000);
  if (s < 90) return s + "s ago";
  const m = Math.round(s/60);
  if (m < 90) return m + "m ago";
  return Math.round(m/60) + "h ago";
};
const TILES = [
  { k: "sockets_live", label: "Live sockets", fmt: num },
  { k: "rooms_live", label: "Live rooms", fmt: num },
  { k: "upgrades", label: "Upgrades", fmt: num, note: () => "in range" },
  { k: "requests", label: "HTTP requests", fmt: num, note: () => "in range" },
  { k: "error_pct", label: "Error rate", fmt: pct,
    status: (t) => t.error_pct >= 10 ? "critical" : t.error_pct >= 5 ? "warn" : "good",
    note: (t) => t.errors + " / " + t.requests },
  { k: "exceptions", label: "Exceptions", fmt: num,
    status: (t) => t.exceptions > 0 ? "warn" : "good", note: () => "in range" },
  { k: "short_lived_pct", label: "Flap (<1s)", fmt: pct,
    status: (t) => t.short_lived_pct >= 60 ? "warn" : "good",
    note: (t) => t.closed + " closed" },
  { k: "avg_lifetime_s", label: "Avg lifetime", fmt: secs },
  { k: "push_errors", label: "Push errors", fmt: num,
    status: (t) => t.push_errors > 0 ? "warn" : "good", note: () => "in range" },
];

// --- charts: [key, title, color-var, value formatter, y-unit] ------------------
const CHARTS = [
  { k: "sockets_live", title: "Live sockets", color: "--blue", fmt: num },
  { k: "rooms_live", title: "Live rooms", color: "--aqua", fmt: num },
  { k: "request_rate", title: "HTTP requests /min", color: "--yellow", fmt: num },
  { k: "upgrade_rate", title: "WS upgrades /min", color: "--violet", fmt: num },
  { k: "error_rate", title: "HTTP errors /min", color: "--red", fmt: num },
  { k: "rejected_rate", title: "Rejected upgrades /min", color: "--orange", fmt: num },
  { k: "short_lived_frac", title: "Short-lived fraction (<1s)", color: "--magenta", fmt: (v) => v==null?"—":(v*100).toFixed(0)+"%", pctAxis: true },
];

function cssVar(name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); }

function renderRanges() {
  const el = document.getElementById("ranges");
  el.innerHTML = "";
  for (const r of RANGES) {
    const b = document.createElement("button");
    b.textContent = r.label;
    b.setAttribute("aria-pressed", String(r.key === curRange));
    b.onclick = () => { curRange = r.key; localStorage.setItem("range", r.key); renderRanges(); load(); };
    el.appendChild(b);
  }
}

function renderHealth(alerts) {
  const el = document.getElementById("health");
  el.hidden = false;
  el.innerHTML = "";
  const dot = document.createElement("span");
  dot.className = "dot";
  const worst = alerts.some(a => a.severity === "critical") ? "critical"
    : alerts.length ? "warn" : "good";
  dot.style.background = "var(--" + (worst === "good" ? "good" : worst === "warn" ? "warn" : "critical") + ")";
  el.appendChild(dot);
  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = alerts.length ? (alerts.length + " active alert" + (alerts.length>1?"s":"")) : "All clear";
  el.appendChild(msg);
  for (const a of alerts) {
    const s = document.createElement("span");
    s.className = "alert";
    s.textContent = (a.severity === "critical" ? "⚠ " : "") + a.title;
    el.appendChild(s);
  }
}

function renderTiles(t) {
  const el = document.getElementById("tiles");
  el.innerHTML = "";
  for (const spec of TILES) {
    const d = document.createElement("div");
    d.className = "tile" + (spec.status ? " status-" + spec.status(t) : "");
    const lbl = document.createElement("div"); lbl.className = "label"; lbl.textContent = spec.label;
    const val = document.createElement("div"); val.className = "value"; val.textContent = spec.fmt(t[spec.k]);
    d.appendChild(lbl); d.appendChild(val);
    if (spec.note) { const n = document.createElement("div"); n.className = "note"; n.textContent = spec.note(t); d.appendChild(n); }
    el.appendChild(d);
  }
}

// Build one small-multiple line chart as inline SVG with a crosshair + tooltip.
function renderChart(spec, points, windowObj) {
  const wrap = document.createElement("div");
  wrap.className = "chart";
  const h = document.createElement("h3"); h.textContent = spec.title; wrap.appendChild(h);
  const cur = document.createElement("div"); cur.className = "cur";
  const last = [...points].reverse().find(p => p.v != null);
  cur.textContent = last ? spec.fmt(last.v) : "no data";
  wrap.appendChild(cur);

  const real = points.filter(p => p.v != null);
  if (!real.length) {
    const e = document.createElement("div"); e.className = "empty"; e.textContent = "No data in range";
    wrap.appendChild(e); return wrap;
  }

  const W = 1000, H = 220, PADX = 8, PADT = 12, PADB = 20;
  const t0 = windowObj.fromMs, t1 = windowObj.toMs;
  let vmax = Math.max(...real.map(p => p.v), spec.pctAxis ? 1 : 0);
  if (spec.pctAxis) vmax = 1; else vmax = vmax <= 0 ? 1 : vmax * 1.15;
  const x = (t) => PADX + (t - t0) / Math.max(1, t1 - t0) * (W - 2*PADX);
  const y = (v) => PADT + (1 - v / vmax) * (H - PADT - PADB);
  const color = cssVar(spec.color);

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("preserveAspectRatio", "none");

  const ns = "http://www.w3.org/2000/svg";
  const mk = (n, attrs) => { const e = document.createElementNS(ns, n); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  // gridlines + y labels (0, mid, max)
  for (const frac of [0, 0.5, 1]) {
    const gv = vmax * frac, gy = y(gv);
    svg.appendChild(mk("line", { x1: PADX, x2: W-PADX, y1: gy, y2: gy, stroke: cssVar("--grid"), "stroke-width": 1 }));
    const lab = mk("text", { x: PADX, y: gy - 2, fill: cssVar("--muted"), "font-size": 10 });
    lab.textContent = spec.pctAxis ? Math.round(gv*100) + "%" : num(+gv.toPrecision(3));
    svg.appendChild(lab);
  }

  // Build path, breaking at nulls so gaps show as gaps.
  let dLine = "", dArea = "", open = false, firstX = null, lastX = null;
  for (const p of points) {
    if (p.v == null) { open = false; continue; }
    const px = x(p.t), py = y(p.v);
    if (!open) { dLine += "M" + px + " " + py; open = true; if (firstX == null) firstX = px; }
    else dLine += "L" + px + " " + py;
    lastX = px;
  }
  // Simple area under the whole visible line for subtle fill.
  const areaPath = mk("path", { d: dLine + (lastX!=null ? ("L" + lastX + " " + y(0) + "L" + (firstX||PADX) + " " + y(0) + "Z") : ""), fill: color, "fill-opacity": 0.10, stroke: "none" });
  svg.appendChild(areaPath);
  svg.appendChild(mk("path", { d: dLine, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "vector-effect": "non-scaling-stroke" }));

  // Hover layer: crosshair + dot + tooltip.
  const cross = mk("line", { x1: 0, x2: 0, y1: PADT, y2: H-PADB, stroke: cssVar("--axis"), "stroke-width": 1, opacity: 0, "vector-effect": "non-scaling-stroke" });
  const dot = mk("circle", { r: 3.5, fill: color, stroke: cssVar("--surface"), "stroke-width": 2, opacity: 0 });
  svg.appendChild(cross); svg.appendChild(dot);
  const tt = document.getElementById("tt");

  function onMove(ev) {
    const rect = svg.getBoundingClientRect();
    const relX = (ev.clientX - rect.left) / rect.width;
    const tt0 = t0 + relX * (t1 - t0);
    let best = null;
    for (const p of real) if (best == null || Math.abs(p.t - tt0) < Math.abs(best.t - tt0)) best = p;
    if (!best) return;
    cross.setAttribute("x1", x(best.t)); cross.setAttribute("x2", x(best.t)); cross.setAttribute("opacity", 1);
    dot.setAttribute("cx", x(best.t)); dot.setAttribute("cy", y(best.v)); dot.setAttribute("opacity", 1);
    tt.innerHTML = '<div class="t">' + new Date(best.t).toLocaleString() + '</div><div class="v">' + spec.fmt(best.v) + '</div>';
    tt.style.opacity = 1;
    tt.style.left = Math.min(window.innerWidth - 160, ev.clientX + 12) + "px";
    tt.style.top = (ev.clientY + 12) + "px";
  }
  function onLeave() { cross.setAttribute("opacity", 0); dot.setAttribute("opacity", 0); tt.style.opacity = 0; }
  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerleave", onLeave);

  wrap.appendChild(svg);
  return wrap;
}

function renderCharts(series, windowObj) {
  const el = document.getElementById("charts");
  el.innerHTML = "";
  for (const spec of CHARTS) el.appendChild(renderChart(spec, series[spec.k] || [], windowObj));
}

async function load() {
  try {
    const res = await fetch("api/data?range=" + encodeURIComponent(curRange), { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderHealth(data.alerts || []);
    renderTiles(data.tiles);
    renderCharts(data.series, data.window);
    const fresh = document.getElementById("freshness");
    fresh.textContent = data.tiles.last_sample_ts
      ? "updated " + dur(data.tiles.stale_ms)
      : "no samples yet";
    fresh.style.color = (data.tiles.stale_ms != null && data.tiles.stale_ms > 180000) ? "var(--critical)" : "var(--muted)";
    document.getElementById("foot").textContent =
      "Reset-aware rates from " + (data.window.buckets) + " buckets. Loopback scrape of /metrics; zero PII. Auto-refreshes every 30s.";
  } catch (e) {
    document.getElementById("freshness").textContent = "load error: " + e.message;
  }
}

renderRanges();
load();
timer = setInterval(load, 30000);
`;
