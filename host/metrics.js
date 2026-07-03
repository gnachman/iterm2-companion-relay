// Aggregate, non-identifying metrics for the relay. The Cloudflare dashboard is
// gone, so this is how you see "is it healthy / is someone hammering me" — but
// the relay's zero-PII posture still holds: only counts and a socket-lifetime
// histogram, never a room name, opaque room tag, or IP.
//
// The socket-lifetime histogram is the flap-cadence signal the recent close-time
// logging was reaching for: a spike in the short buckets means clients are
// connecting and dropping in seconds (the behavior that ran up the Cloudflare
// per-connection bill), now free but still worth watching.
//
// Rendered in Prometheus text format and served on a localhost-only endpoint.

// Cumulative upper bounds in seconds; the last (+Inf) catches everything.
const LIFETIME_BUCKETS = [1, 5, 15, 60, 300, 1800];

const COUNTER_HELP = {
  ws_upgrades_total: "WebSocket upgrades accepted.",
  ws_upgrades_rejected_total: "WebSocket upgrades rejected before handshake, by reason.",
  http_requests_total: "HTTP (non-upgrade) requests received.",
  http_errors_total: "HTTP requests that threw and returned 500.",
  process_exceptions_total: "Process-level exceptions swallowed to keep serving.",
};
const GAUGE_HELP = {
  rooms_live: "Rooms currently resident in memory.",
  sockets_live: "WebSocket connections currently open.",
};

export class Metrics {
  constructor() {
    this.counters = new Map(); // "name" or "name\x00reason" -> value
    this.bucketCounts = LIFETIME_BUCKETS.map(() => 0);
    this.lifetimeInf = 0;
    this.lifetimeSum = 0;
  }

  inc(name, by = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + by);
  }

  incReason(name, reason) {
    const key = `${name}\x00${reason}`;
    this.counters.set(key, (this.counters.get(key) || 0) + 1);
  }

  observeSocketLifetime(seconds) {
    this.lifetimeInf += 1;
    this.lifetimeSum += seconds;
    for (let i = 0; i < LIFETIME_BUCKETS.length; i++) {
      if (seconds <= LIFETIME_BUCKETS[i]) this.bucketCounts[i] += 1;
    }
  }

  // `gauges` are point-in-time values supplied by the host at scrape time.
  render(gauges = {}) {
    const lines = [];
    const emittedHelp = new Set();
    const help = (name, type) => {
      if (emittedHelp.has(name)) return;
      emittedHelp.add(name);
      const h = COUNTER_HELP[name] || GAUGE_HELP[name];
      if (h) lines.push(`# HELP relay_${name} ${h}`);
      lines.push(`# TYPE relay_${name} ${type}`);
    };

    // Counters (plain and reason-labeled).
    const plain = new Map();
    const labeled = new Map(); // name -> [{reason, value}]
    for (const [key, value] of this.counters) {
      const sep = key.indexOf("\x00");
      if (sep === -1) {
        plain.set(key, value);
      } else {
        const name = key.slice(0, sep);
        const reason = key.slice(sep + 1);
        if (!labeled.has(name)) labeled.set(name, []);
        labeled.get(name).push({ reason, value });
      }
    }
    for (const [name, value] of plain) {
      help(name, "counter");
      lines.push(`relay_${name} ${value}`);
    }
    for (const [name, entries] of labeled) {
      help(name, "counter");
      for (const { reason, value } of entries.sort((a, b) => a.reason.localeCompare(b.reason))) {
        lines.push(`relay_${name}{reason="${reason}"} ${value}`);
      }
    }

    // Gauges.
    for (const [name, value] of Object.entries(gauges)) {
      help(name, "gauge");
      lines.push(`relay_${name} ${value}`);
    }

    // Socket-lifetime histogram. bucketCounts[i] is already cumulative (each
    // observation increments every bucket whose bound >= its lifetime), so emit
    // it directly.
    lines.push("# HELP relay_socket_lifetime_seconds How long WebSocket connections lived.");
    lines.push("# TYPE relay_socket_lifetime_seconds histogram");
    for (let i = 0; i < LIFETIME_BUCKETS.length; i++) {
      lines.push(`relay_socket_lifetime_seconds_bucket{le="${LIFETIME_BUCKETS[i]}"} ${this.bucketCounts[i]}`);
    }
    lines.push(`relay_socket_lifetime_seconds_bucket{le="+Inf"} ${this.lifetimeInf}`);
    lines.push(`relay_socket_lifetime_seconds_sum ${this.lifetimeSum}`);
    lines.push(`relay_socket_lifetime_seconds_count ${this.lifetimeInf}`);

    return lines.join("\n") + "\n";
  }
}
