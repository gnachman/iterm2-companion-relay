// Parse the relay's Prometheus text exposition (`/metrics`) into the flat,
// numeric snapshot the dashboard stores. Pure and tolerant: it reads only the
// series the dashboard charts and ignores everything else, so adding a metric to
// the relay never breaks the collector. Unknown / missing series default to 0.
//
// The relay is the only producer and its output is well-formed, so this is a
// deliberately small parser (line-oriented, no full Prometheus grammar): a
// `name{labels} value` shape, with reason-labeled rejections summed to a single
// total (the same folding the relay's own snapshot() does) and the socket
// -lifetime histogram flattened to its cumulative buckets.

const PLAIN = {
  relay_ws_upgrades_total: "ws_upgrades",
  relay_http_requests_total: "http_requests",
  relay_http_errors_total: "http_errors",
  relay_process_exceptions_total: "exceptions",
  relay_metrics_push_errors_total: "push_errors",
  relay_quota_exceeded_total: "quota_exceeded",
  relay_rooms_live: "rooms_live",
  relay_sockets_live: "sockets_live",
  // Room occupancy (mac/phone splice state). rooms_both is the "pairings
  // currently spliced" gauge; mac_only is a parked mac awaiting a phone;
  // phone_only should stay 0 (a phone can't admit without a mac -- tripwire).
  relay_rooms_both: "rooms_both",
  relay_rooms_mac_only: "rooms_mac_only",
  relay_rooms_phone_only: "rooms_phone_only",
  relay_socket_lifetime_seconds_sum: "life_sum",
  relay_socket_lifetime_seconds_count: "life_count",
  // Distributed-mode shard signals. A direct-mode relay renders none of these,
  // so they fall back to the defaults below (version -1 = no map, counts 0).
  relay_shard_reject_total: "shard_reject",
  relay_shard_map_reloads_total: "shard_map_reloads",
  relay_shard_map_fetch_errors_total: "shard_map_fetch_errors",
  relay_shard_map_version: "shard_map_version",
  relay_shard_owned_buckets: "shard_owned_buckets",
  relay_shard_draining_buckets: "shard_draining_buckets",
};

// Histogram bucket bounds we persist, matching the relay's LIFETIME_BUCKETS. The
// "+Inf" bucket equals life_count, so it is not stored separately.
const LIFE_BUCKETS = [1, 5, 15, 60, 300, 1800];

// A single `name{labels} value` line -> { name, labels, value } or null. Skips
// HELP/TYPE comments and blanks. `labels` is the raw inside-the-braces string.
function parseLine(line) {
  const s = line.trim();
  if (!s || s[0] === "#") return null;
  const brace = s.indexOf("{");
  let name, rest;
  if (brace === -1) {
    const sp = s.indexOf(" ");
    if (sp === -1) return null;
    name = s.slice(0, sp);
    rest = s.slice(sp + 1);
    return { name, labels: "", value: Number(rest.trim()) };
  }
  name = s.slice(0, brace);
  const close = s.indexOf("}", brace);
  if (close === -1) return null;
  const labels = s.slice(brace + 1, close);
  const value = Number(s.slice(close + 1).trim());
  return { name, labels, value };
}

// Pull a label value out of a raw label string, e.g. le from `le="5"`.
function label(labels, key) {
  const m = labels.match(new RegExp(`${key}="([^"]*)"`));
  return m ? m[1] : null;
}

export function parseMetrics(text) {
  const out = {
    ws_upgrades: 0,
    ws_rejected: 0,
    http_requests: 0,
    http_errors: 0,
    exceptions: 0,
    push_errors: 0,
    quota_exceeded: 0,
    rooms_live: 0,
    sockets_live: 0,
    rooms_both: 0,
    rooms_mac_only: 0,
    rooms_phone_only: 0,
    life_sum: 0,
    life_count: 0,
    shard_reject: 0,
    shard_map_reloads: 0,
    shard_map_fetch_errors: 0,
    shard_map_version: -1, // "no map adopted" sentinel, matching the relay gauge
    shard_owned_buckets: 0,
    shard_draining_buckets: 0,
  };
  for (const b of LIFE_BUCKETS) out[`life_le${b}`] = 0;

  for (const raw of String(text).split("\n")) {
    const p = parseLine(raw);
    if (!p || !Number.isFinite(p.value)) continue;

    const flat = PLAIN[p.name];
    if (flat) {
      out[flat] = p.value;
      continue;
    }
    // Rejections are reason-labeled; sum every reason to a single total.
    if (p.name === "relay_ws_upgrades_rejected_total") {
      out.ws_rejected += p.value;
      continue;
    }
    // Cumulative socket-lifetime buckets. le="+Inf" duplicates life_count.
    if (p.name === "relay_socket_lifetime_seconds_bucket") {
      const le = label(p.labels, "le");
      if (le && le !== "+Inf" && Object.prototype.hasOwnProperty.call(out, `life_le${le}`)) {
        out[`life_le${le}`] = p.value;
      }
    }
  }
  return out;
}

export const LIFETIME_BUCKETS = LIFE_BUCKETS;

// --- Push relay (`pushrelay_*`, served by Companion/PushRelay/host) -----------
// A separate producer on its own loopback /metrics; same tolerant, line-oriented
// approach. Counters map to the register write-vs-skip and push delivery signals;
// `devices` is a gauge. Unknown/missing series default to 0.
const PUSH_PLAIN = {
  pushrelay_http_requests_total: "http_requests",
  pushrelay_http_errors_total: "http_errors",
  pushrelay_process_exceptions_total: "exceptions",
  pushrelay_register_total: "register",
  pushrelay_register_written_total: "register_written",
  pushrelay_register_skipped_total: "register_skipped",
  pushrelay_register_rejected_total: "register_rejected",
  pushrelay_push_total: "push",
  pushrelay_push_delivered_total: "push_delivered",
  pushrelay_push_bad_secret_total: "push_bad_secret",
  pushrelay_push_unknown_token_total: "push_unknown_token",
  pushrelay_push_apns_error_total: "push_apns_error",
  pushrelay_rate_limited_total: "rate_limited",
  pushrelay_devices: "devices",
  // Delivery outcome + APNs connection health.
  pushrelay_push_failed_total: "push_failed",
  pushrelay_apns_connects_total: "apns_connects",
  pushrelay_apns_connect_throttled_total: "apns_throttled",
  pushrelay_apns_session_errors_total: "apns_session_errors",
  pushrelay_apns_discarded_idle_total: "apns_discard_idle",
  pushrelay_apns_discarded_timeout_total: "apns_discard_timeout",
  pushrelay_apns_request_timeouts_total: "apns_timeouts",
  pushrelay_apns_sessions: "apns_sessions",                       // gauge
  pushrelay_apns_oldest_session_age_seconds: "apns_oldest_session_s", // gauge
  pushrelay_last_delivery_timestamp_seconds: "last_delivery_ts",  // gauge (unix s; 0 = none yet)
  pushrelay_apns_latency_seconds_sum: "lat_sum",
  pushrelay_apns_latency_seconds_count: "lat_count",
};

// APNs latency histogram: bounds (seconds, as the push relay emits them) -> the
// stored column. Milliseconds in the name keep the column identifiers plain.
const LAT_BUCKETS = [
  ["0.05", "lat_le50"], ["0.1", "lat_le100"], ["0.25", "lat_le250"], ["0.5", "lat_le500"],
  ["1", "lat_le1000"], ["2.5", "lat_le2500"], ["5", "lat_le5000"], ["10", "lat_le10000"],
];
// Upper bounds in ms, in column order, for quantile estimation (series.js).
export const LAT_BOUNDS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
export const LAT_COLUMNS = LAT_BUCKETS.map(([, col]) => col);

// Apple's rejection reasons that matter operationally get their own column; the
// rest fold into rej_other. The push relay already bounds the label set.
const REJECT_COLUMNS = {
  BadDeviceToken: "rej_bad_token",
  Unregistered: "rej_unregistered",
  DeviceTokenNotForTopic: "rej_wrong_topic",
  TooManyRequests: "rej_too_many",
  ExpiredProviderToken: "rej_expired_jwt",
  InvalidProviderToken: "rej_invalid_jwt",
  InternalServerError: "rej_apple_500",
  ServiceUnavailable: "rej_unavailable",
};
export const REJECT_FIELDS = [...Object.values(REJECT_COLUMNS), "rej_other"];
// Human labels for the tile note, keyed by column.
export const REJECT_LABELS = {
  rej_bad_token: "BadDeviceToken", rej_unregistered: "Unregistered", rej_wrong_topic: "DeviceTokenNotForTopic",
  rej_too_many: "TooManyRequests", rej_expired_jwt: "ExpiredProviderToken", rej_invalid_jwt: "InvalidProviderToken",
  rej_apple_500: "InternalServerError", rej_unavailable: "ServiceUnavailable", rej_other: "other",
};

export const PUSH_FIELDS = [...Object.values(PUSH_PLAIN), ...LAT_COLUMNS, ...REJECT_FIELDS];

export function parsePushMetrics(text) {
  const out = {};
  for (const f of PUSH_FIELDS) out[f] = 0;
  for (const raw of String(text).split("\n")) {
    const p = parseLine(raw);
    if (!p || !Number.isFinite(p.value)) continue;
    const flat = PUSH_PLAIN[p.name];
    if (flat) { out[flat] = p.value; continue; }
    if (p.name === "pushrelay_apns_latency_seconds_bucket") {
      const le = label(p.labels, "le");
      const hit = LAT_BUCKETS.find(([bound]) => bound === le);
      if (hit) out[hit[1]] = p.value;     // +Inf == lat_count, not stored twice
      continue;
    }
    if (p.name === "pushrelay_apns_rejected_total") {
      // Several labels can fold into rej_other, so accumulate rather than assign.
      out[REJECT_COLUMNS[label(p.labels, "reason")] || "rej_other"] += p.value;
    }
  }
  return out;
}
