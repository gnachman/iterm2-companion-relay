# Sharding operations runbook (distributed mode)

How to run, observe, and reshape a sharded relay fleet: add a box, drain a box
to empty, rebalance, and what to do when a host cannot see the map. The design
and its correctness arguments live in `docs/companion-relay-design.md` (§6
architecture, §7 resharding and operations); this file is the operator's
command-level companion. A single self-hosted relay (direct mode) needs none of
this.

---

## The moving parts, in one picture

```
             resolver.iterm2.com/shardmap.json  (Cloudflare Worker, resolver/)
             Cache-Control: max-age=5  <- LOAD-BEARING, see below
               ▲                    ▲
     clients   │ fetch on connect   │ poll every RELAY_SHARDMAP_POLL_MS (10 s)
     (Mac +    │ + forced refresh   │
      phone)   │ on 421 / WS 4421   │
               │              ┌─────┴─────┐   each host serves ONLY the buckets
               └──────────────│ relay1..N │   the map assigns it (reject-on-
                              └───────────┘   doubt: anything else gets 421)
```

- The map partitions buckets `0..65535` into `{low, high, host}` ranges. A
  room's bucket is derived from its name; same room, same bucket, same host,
  on every device, as long as everyone reads the same map.
- `version` must strictly increase on every publish. Rollback is roll-forward:
  publish a higher version, never a lower one (every actor ignores lower).
- Relays poll the map; on a version bump they diff ownership. Gained buckets
  serve immediately. Lost buckets stop admitting new joins at once, then after
  `RELAY_DRAIN_DELAY_MS` (default 20 s, must stay >= 2x the poll interval)
  existing rooms are evicted at `RELAY_EVICTION_RATE` rooms/second with WS
  close 4421, which tells clients to re-fetch the map and land on the new
  owner.
- The Worker serves the map with `Cache-Control: max-age=5`. That number is a
  design invariant, not a tuning knob: evicted clients re-resolve through
  their HTTP cache, and a longer TTL would bounce them off their stale copy
  (421 ping-pong) for its whole lifetime. Do not "optimize" it upward.

## Deploy a distributed-mode box

1. Publish (or update) the map first so it names the new box; see
   `resolver/README.md` for the one-time Worker setup and the publish flow.
   A box whose `RELAY_SELF_HOST` matches no `host` in the map boots fine but
   owns zero buckets and 421s everything, so the map entry comes first.
2. In `ops/deploy.env`, set `RELAY_SHARDMAP_URL` (and optionally the poll /
   drain / eviction tunables). The box's map identity is derived from
   `RELAY_ORIGIN_HOST`; the map's `host` entries for this box must byte-match
   it (same string as the TLS cert name; design §6.10).
3. `ops/deploy-remote.sh <host>` as usual. The deploy validates the sharding
   config before touching the box (both-or-neither, drain >= 2x poll, identity
   match) so misconfigurations fail in your terminal, not as a crash loop.
4. Verify on the box:

   ```bash
   curl -s localhost:8787/metrics | grep -E '^relay_shard'
   # shard_map_version >= 0, shard_owned_buckets > 0, fetch_errors flat
   journalctl -u iterm2-companion-relay | grep "mode=distributed"
   ```

5. **Onboard it to the monitor** (`monitor/README.md`). The monitor's probe
   auto-discovers the new host from the shard map (zero config), but per-host
   liveness/capacity needs the box to push its metrics. In `ops/deploy.env` set:

   ```sh
   RELAY_METRICS_PUSH_URL=https://<monitor-host>/ingest/<this-box-host>
   RELAY_METRICS_PUSH_TOKEN=<shared secret; matches the monitor's INGEST_TOKEN>
   ```

   Use the box's own map `host` string in the path, so the monitor keys its
   snapshot under that host. Without this the box probes green but never reports,
   and the monitor pages `<host>|liveness`.

Boot is fetch-before-accept: the relay refuses to serve until it has a map,
retrying for about a minute and then exiting (systemd restarts it). So a
deploy performed while the resolver is unreachable crash-loops rather than
failing open; do not roll the fleet during a resolver outage.

## Reshard: add / remove / rebalance

Every reshard is the same operator motion; only the range edit differs.

1. Edit `resolver/public/shardmap.json`: move ranges, **bump `version`**.
   Prefer minimal-churn edits (split or merge with a neighbor, design §7.5)
   over re-dealing the whole ring.
2. `cd resolver && npm run deploy`, then verify:
   `curl -s https://<resolver-host>/shardmap.json` shows the new version.
3. Within one poll interval (~10 s) every reachable relay adopts it. Watch
   either the dashboard's Shard tile or, on a box:

   ```bash
   curl -s localhost:8787/metrics | grep -E '^relay_shard'
   # losing host: shard_owned_buckets drops, shard_draining_buckets rises,
   #   then draining returns to 0 as the evictions complete
   # gaining host: shard_owned_buckets rises immediately
   ```

   With `RELAY_LOG=true` (toggle live with `systemctl kill -s USR2 <unit>`)
   the journal also shows `shardmap v<N> adopted: ...` and per-room
   `shardmap drain: evicted ...` lines.
4. Expect a brief, self-healing wobble for moved buckets: evicted clients
   reconnect to the new owner within seconds (bounded by the 5 s map TTL plus
   their jittered backoff). `shard_reject_total` upticks during the window are
   normal; sustained growth afterward is not (see failure modes).

Reshard converges in roughly `drain delay + moved-rooms / eviction rate`
seconds. It is deliberately unhurried; the pacing is what protects the gaining
hosts from a handshake storm. Do not raise `RELAY_EVICTION_RATE` beyond what a
target host comfortably absorbs in TLS handshakes per second.

No monitor change is needed for a reshard: the probe re-reads the map each tick
(auto-covering any newly-added host), and every host keeps pushing under its own
key. Onboarding a brand-new box is the only time you touch the monitor, via the
push line in *Deploy a distributed-mode box* above.

## Take a box down gracefully (drain to empty, then retire)

"Down for a code update" needs none of this: just restart the unit (clients
treat 1001 as retry-here and reconnect to the same box). This section is for
removing a box from the fleet or a long maintenance window.

1. Publish a map (version bump) that assigns ALL of the box's ranges to other
   hosts. A host with zero buckets is a normal, supported state.
2. Wait for the box to adopt it and drain. Watch on the box:

   ```bash
   watch -n5 'curl -s localhost:8787/metrics | grep -E "shard_(owned|draining)|rooms_live|sockets_live"'
   # owned -> 0 immediately on adopt; draining -> 0 and rooms_live -> ~0
   # after drain delay + rooms/rate seconds
   ```

3. Once `rooms_live` is ~0 and `shard_draining_buckets` is 0, stop and disable
   the unit, then decommission at leisure. The box was already rejecting new
   joins for those buckets the moment it adopted the map, so there is no
   hurry between step 2 completing and step 3.

Important: draining depends on the box OBSERVING the new map. A box that
cannot fetch the map keeps serving under last-known-good and never starts its
drain; if `shard_map_fetch_errors_total` is climbing on the box you are trying
to drain, fix its egress or hard-stop it (see next section).

## Failure modes and what to actually do

- **`Shard-map fetch errors: N` alert (monitor) / warn on the dashboard Shard
  tile.** The box cannot refresh the map and is running on last-known-good.
  Nothing is broken yet, and this is the designed behavior (never
  fail-open/closed), but the box is blind to reshards. Fix its route to the
  resolver. If a reshard happens (or was in flight) while a box is blind,
  **hard-stop that box** (`systemctl stop`); its buckets' clients re-resolve
  via the map and land on the new owners. Leaving a blind box up across a
  reshard is the one way to get a long-lived split pairing.
- **Box owns zero buckets right after boot and that was not intended.**
  `RELAY_SELF_HOST` does not byte-match any `host` in the map (case, port,
  FQDN vs short name). Fix the map (or the origin host) and redeploy. The
  deploy script prevents the identity-typo variant, but a map that simply
  omits the host will still do this.
- **Crash loop at boot, journal says the shard map is unavailable.** Boot is
  fetch-before-accept by design. Restore the resolver (or the box's egress),
  and the next systemd restart comes up normally. Already-running boxes are
  unaffected (last-known-good).
- **`shard_reject_total` climbing steadily outside any reshard.** Some client
  population is resolving to the wrong host: check that the published map is
  what you think it is (`curl` it), that its version actually increased, and
  that the Worker still serves `max-age=5`.
- **Rooms did not drain after a reshard.** Check `shard_draining_buckets` on
  the losing box: if it never rose, the box never adopted the map (fetch
  errors above); if it rose and stuck, check the journal for eviction lines
  and confirm `RELAY_EVICTION_RATE` was not set absurdly low relative to the
  room count.

## What a reshard does NOT preserve

Per-room host-local state does not migrate: the daily byte quota counter
resets on the new host, and any in-flight attest/register state is discarded
(clients silently redo it; design §6.7). Confidentiality is unaffected; the
relay only ever sees ciphertext. Treat "reshard resets quotas" as a known,
operator-gated cost of moving buckets.

## Config reference

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_SHARDMAP_URL` | unset (direct mode) | Map URL this box polls. Set together with a map that names this box. |
| `RELAY_SELF_HOST` | derived from `RELAY_ORIGIN_HOST` | Map identity. Must byte-match the map's `host` and the TLS name. |
| `RELAY_SHARDMAP_POLL_MS` | 10000 | Poll cadence; also how fast a reshard lands. |
| `RELAY_DRAIN_DELAY_MS` | 20000 | Defer before evicting a lost bucket. Must be >= 2x poll (enforced at deploy and at boot). |
| `RELAY_EVICTION_RATE` | 10 | Rooms/second closed during a drain. Sub-1 values pace slower (one room per 1/rate seconds). |

The relay refuses to boot on: exactly one of URL/self-host set, origin vs
self-host mismatch, drain < 2x poll, or rate <= 0.
