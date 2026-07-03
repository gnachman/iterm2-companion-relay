// iTerm2 relay monitor — the I/O shell.
//
// The relay is self-hosted (a Node process behind Cloudflare), so there is no
// Workers Analytics to query. Instead the relay PUSHES an aggregate, PII-free
// snapshot of its own counters/gauges to this Worker's /ingest endpoint; the
// Worker stores the latest in KV, and a cron run analyzes it and emails on
// liveness (dead-man's-switch), capacity, error rate, exceptions, or a traffic
// anomaly. The analysis is pure (src/monitor.js, unit-tested); this file is the
// I/O: ingest, KV, the cron trigger, and Resend email.
//
// Endpoints:
//   POST /ingest        (Authorization: Bearer INGEST_TOKEN)  <- the relay pushes here
//   GET  /?             (x-monitor-key: MANUAL_TRIGGER_SECRET) -> dry-run analysis JSON
//   GET  /?test=1       (x-monitor-key: MANUAL_TRIGGER_SECRET) -> send a REAL test email
//
// Secrets (wrangler secret put): INGEST_TOKEN, RESEND_API_KEY, MANUAL_TRIGGER_SECRET.
// KV binding: MONITOR_KV.

import {
  parseConfig, normalizeSnapshot, deltas, rollHour, hourKey, analyze, dueAlerts, livenessAlert,
  probeHandshake, probeAlert,
} from "./monitor.js";

const LATEST_KEY = "latest";
const STATE_KEY = "state";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      run(env, Date.now(), { dry: false })
        .catch((e) => console.error("relay-monitor: run failed:", (e && e.message) || e)),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // The relay pushes its snapshot here. Bearer-authenticated; the body is the
    // flat counter/gauge object from Metrics.snapshot().
    if (request.method === "POST" && url.pathname === "/ingest") {
      if (!bearerOk(request, env.INGEST_TOKEN)) return new Response("unauthorized", { status: 401 });
      let snapshot;
      try {
        snapshot = await request.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }
      await env.MONITOR_KV.put(LATEST_KEY, JSON.stringify({ receivedAt: Date.now(), snapshot }));
      return new Response(null, { status: 204 });
    }

    // Everything else is an operator tool, gated by the manual-trigger secret.
    if (!env.MANUAL_TRIGGER_SECRET || request.headers.get("x-monitor-key") !== env.MANUAL_TRIGGER_SECRET) {
      return new Response("not found", { status: 404 });
    }
    if (url.searchParams.get("test") === "1") {
      try {
        await sendDigest(env, [{
          key: "test", severity: "warn", title: "Relay monitor test",
          body: "If you received this, the monitor's email path works.",
        }]);
        return json({ emailed: true });
      } catch (e) {
        return json({ emailed: false, error: String(e.message || e) }, 500);
      }
    }
    // Dry run: analyze the latest snapshot without sending mail or writing state.
    return json(await run(env, Date.now(), { dry: true }));
  },
};

// Constant-time-ish bearer compare (Workers has no timingSafeEqual). Length-guard
// then XOR-accumulate so a wrong token leaks nothing exploitable through timing.
function bearerOk(request, expected) {
  if (!expected) return false;
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  if (!m) return false;
  const a = m[1];
  if (a.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { "content-type": "application/json" },
  });
}

export async function run(env, now, { dry }) {
  const cfg = parseConfig(env);
  const latest = await env.MONITOR_KV.get(LATEST_KEY, "json");
  const state = dry ? {} : ((await env.MONITOR_KV.get(STATE_KEY, "json")) || {});
  const ageMs = latest ? now - latest.receivedAt : null;

  let alerts;
  const nextState = { ...state };
  if (!latest || ageMs > cfg.staleMs) {
    // Dead-man's-switch: no fresh push means the relay or its host is down.
    // Preserve the metric-derived state (prev/anchor/history) so it resumes
    // cleanly once pushes return.
    const detail = latest ? `no snapshot for ${Math.round(ageMs / 60000)} min` : "no snapshot received yet";
    alerts = [livenessAlert(detail)];
  } else {
    const snap = normalizeSnapshot(latest.snapshot);
    const interval = deltas(state.prev, snap.counters);
    const roll = rollHour(state.hourAnchor, snap.counters, hourKey(now));
    const analyzed = analyze({ gauges: snap.gauges, interval, lastHour: roll.lastHour }, state, cfg);
    alerts = analyzed.alerts;
    nextState.history = analyzed.history;
    nextState.lastRecordedHour = analyzed.lastRecordedHour;
    nextState.prev = snap.counters;
    nextState.hourAnchor = roll.anchor;
  }

  // Independent outside-in synthetic probe (when RELAY_PROBE_URL is set): a real
  // pairing handshake through the full inbound path. Catches the failure class
  // the push cannot see — process up and pushing, but users can't connect.
  let probe = null;
  if (env.RELAY_PROBE_URL) {
    probe = await runProbe(env, cfg.probeTimeoutMs);
    if (!probe.ok) alerts.push(probeAlert(probe.detail));
  }

  const { due, sentAt } = dueAlerts(alerts, state.sentAt || {}, now, cfg.cooldownMs);

  if (!dry) {
    let delivered = true;
    if (due.length) {
      try {
        await sendDigest(env, due);
      } catch (e) {
        // A transient Resend failure (429/5xx, network, bad key, unset ALERT_*)
        // must not lose state. Fall through and persist anyway.
        delivered = false;
        console.error("relay-monitor: alert send failed:", (e && e.message) || e);
      }
    }
    // Always advance the metric-derived state (prev/hourAnchor/history) so a send
    // failure can't freeze the baselines. Advance the cooldown (sentAt) only when
    // the send actually went out; otherwise keep the prior sentAt so the due
    // alerts are due again next tick and retry, rather than being recorded as
    // sent-but-undelivered (which would silently drop a real outage alert).
    nextState.sentAt = delivered ? sentAt : (state.sentAt || {});
    await env.MONITOR_KV.put(STATE_KEY, JSON.stringify(nextState));
  }
  return { ageMs, probe, alerts, due: due.map((a) => a.key) };
}

// --- Outside-in synthetic probe (real WebSocket handshake) ---

// A fresh 64-hex room per probe, so it never touches a real pairing (and the
// throwaway room is evicted once idle).
function randomRoom() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// Open an outbound WebSocket to the relay through its public hostname and drive
// the mac-park handshake, bounded by a SINGLE deadline that covers BOTH the
// connection (the fetch/upgrade) and the handshake. The headline failure this
// probe exists to catch — a stale origin firewall blackholing inbound — stalls
// during connect, so the deadline must abort the fetch, not just the handshake.
// Returns { ok, detail }; never throws. RELAY_PROBE_URL is the public origin,
// e.g. https://relay.iterm2.com/.
async function runProbe(env, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const timedOut = () => ({ ok: false, detail: `timeout after ${timeoutMs}ms` });
  let ws = null;
  try {
    const resp = await fetch(env.RELAY_PROBE_URL, {
      headers: { Upgrade: "websocket", "x-relay-room": randomRoom() },
      signal: ac.signal,
    });
    ws = resp.webSocket;
    if (!ws) return { ok: false, detail: `no websocket upgrade (HTTP ${resp.status})` };
    ws.accept();
    // Race the handshake against the same deadline: an abort here resolves to a
    // timeout while the finally closes the socket.
    return await Promise.race([
      probeHandshake(wsAdapter(ws)),
      new Promise((resolve) => ac.signal.addEventListener("abort", () => resolve(timedOut()), { once: true })),
    ]);
  } catch (e) {
    return ac.signal.aborted ? timedOut() : { ok: false, detail: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
    try { ws?.close(); } catch { /* ignore */ }
  }
}

// Adapt the event-based Workers WebSocket to the { send, next, close } interface
// probeHandshake expects: buffer messages and hand them out one await at a time;
// a close/error before the next message rejects the pending read.
function wsAdapter(ws) {
  const queue = [];
  const waiters = [];
  const fail = (msg) => {
    const err = new Error(msg);
    while (waiters.length) waiters.shift().reject(err);
  };
  ws.addEventListener("message", (ev) => {
    const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
    if (waiters.length) waiters.shift().resolve(data);
    else queue.push(data);
  });
  ws.addEventListener("close", () => fail("socket closed before reply"));
  ws.addEventListener("error", () => fail("socket error"));
  return {
    send: (s) => ws.send(s),
    next: () => new Promise((resolve, reject) => {
      if (queue.length) resolve(queue.shift());
      else waiters.push({ resolve, reject });
    }),
    close: () => { try { ws.close(); } catch { /* ignore */ } },
  };
}

// --- Email (Resend) ---

async function sendDigest(env, alerts) {
  const worst = alerts.some((a) => a.severity === "critical") ? "CRITICAL" : "warning";
  const subject = `[iTerm2 relay] ${alerts.length} alert(s) (${worst})`;
  const text = alerts.map((a) => `[${a.severity.toUpperCase()}] ${a.title}\n${a.body}`).join("\n\n");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.ALERT_FROM, to: [env.ALERT_TO], subject, text }),
  });
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
}
