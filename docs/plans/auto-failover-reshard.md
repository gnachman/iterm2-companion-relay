# Plan: automatic failover reshard when a relay goes dark

Status: approved 2026-10-23 (decisions in "Decisions" at the end). Nothing here
is built yet.

## Why

On 2026-10-22 each relay box dropped off the network while its relay process
kept running:

| Box | Down (PDT) | Duration | Process restarted? |
|---|---|---|---|
| relay2.iterm2.com (interserver2) | ~06:51 to 07:15 | ~24 min | No (active since 10:15Z) |
| relay1.iterm2.com (interserver1) | ~09:33 to 09:50 | ~17 min | No (active since 12:49Z) |

Each time, the 50% of rooms in that box's buckets could not connect until the
network came back by itself. Detection was fast (the Mac watcher paged within
~5 min, both monitors agreed), but the fix is a manual reshard (ops/SHARDING.md),
and nobody did one. Incident reports: `ops/watch/incidents/20261022T*`.

The design already supports moving a dead host's buckets: the relay holds no
durable per-pairing state (design §6.7, Appendix A invariant 5), and a client
whose connect fails re-fetches the map and goes to the new owner if it changed
(§6.4). So the only missing piece is something that publishes the new map
automatically.

## Goal

When a relay is dark from every vantage for ~5 min, move its buckets to the
healthy relay(s); when it has been healthy again for a while, move them back.
Page on every move. Never make things worse than doing nothing.

## The two ways this goes wrong (and the guards)

### 1. Moving a box that clients can still reach (split pairings)

If a box is reachable by clients but cannot fetch the map (relay1 has a known,
recurring lossy path to Cloudflare behind its daily shard-map fetch
alerts), it keeps serving its old buckets on last-known-good while the new
owner serves the same buckets. Pairings split: Mac on one box, phone on the
other. SHARDING.md calls this "the one way to get a long-lived split pairing".
A failover that fires on a false positive creates exactly this.

Guard: only fail over a box that is **dark**, meaning unreachable at the
transport level from multiple independent vantages, not just failing the
handshake or the map fetch:

- The primary monitor (mcnachman.cloud) probe fails, AND
- the mirror monitor on the surviving relay agrees (its own probe fails), AND
- the dark box's metrics push to the primary has stopped (liveness stale), AND
- the failure is connect-level (TCP connect timeout / refused / network
  unreachable) on 443, not an HTTP error, a 421, or an admission rejection.

All four held in both 2026-10-22 incidents. A box that answers on 443 at all
(even with 5xx) is not dark and is never failed over automatically; that is a
page for a human.

Residual risk: a box dark to both vantages but reachable by some clients (a
partial upstream partition). Both vantages are on different networks (a
non-Interserver VPS and the other Interserver box), which makes this unlikely
but not impossible. The return check below bounds how long a split from this
case can last.

### 2. Not moving back (the second outage takes everything)

Without failback, 2026-10-22 would have gone worse: relay2's half moves to
relay1 at ~06:56, relay1 owns 100%, and relay1's drop at 09:33 takes down
every room instead of half.

Guard: automatic failback. When the original box has been healthy (probe ok
from both vantages, liveness fresh) for `FAILBACK_STABLE_MIN` (default 10,
and never less than 10: lower values are clamped up),
restore the pre-failover ranges as a new, higher version. It drains at the
normal eviction rate (§7.4), so the moved rooms trickle back rather than
storming the returning box.

## Behavior when the dark box comes back

When network returns, the box is still holding the old map version (it could
not poll while dark). Until its next successful poll (10 s default) it can
accept new joins for buckets it no longer owns (a short split, §6.6). Normally
it polls and drains within seconds.

If it cannot fetch the map (relay1's known path problem), the split persists.
The controller checks: within 2 min of the box becoming reachable again, its
`relay_shard_map_version` (it already exports this metric) must equal the
published version. If not, page as urgent: "relay1 back but blind to the
failover map; hard-stop it" (the SHARDING.md remedy). The controller cannot do
the hard-stop itself (no ssh, by design).

## Where it runs

In the primary monitor on mcnachman.cloud, as a new optional module (off unless
configured). Reasons:

- It is always on, unlike George's Mac (sleeps, travels, single vantage, and
  the watcher is read-only on purpose).
- It already has the per-host probe streaks, liveness, and the fleet map; it
  only needs to also read the surviving relay's mirror (`https://relay{1,2}.iterm2.com/fleet`,
  or a small JSON endpoint added to the mirror for this).

Known weakness: if mcnachman.cloud itself is down (as on 2026-10-16), there is
no failover. That fails safe (no action), which is the right direction.

The Mac watcher does not participate in the decision. It keeps paging and
corroborating, and its triage reports note when an automatic move happened.

## How it publishes

The live map and the repo must not drift. If the controller deployed only to
Cloudflare, the next human `npm run deploy` from the repo would publish an older
version number, which every actor ignores (monotonic versioning, §6.6), so the
human edit would silently do nothing.

So make the repo file the single source of truth and publish from it:

1. The controller commits the new `resolver/public/shardmap.json` (version
   bumped, commit message names the trigger and links the evidence) to `main`
   via the GitHub contents API, using a fine-grained token scoped to this repo
   with contents:write only.
2. A GitHub Actions workflow on that path (extend `.github/workflows/pages.yml`
   or add a sibling) runs `wrangler deploy` for the resolver with a Cloudflare
   API token in repo secrets, and the existing Pages mirror job publishes the
   fallback copy.
3. The controller verifies by fetching `https://resolver.iterm2.com/shardmap.json`
   and the Pages mirror until both show the new version; it pages if either
   has not updated within 3 min.

Credentials: the GitHub token (fine-grained, this repo only, Contents read and
write, no Workflows permission) lives in the monitor's env as `GITHUB_TOKEN`.
The Cloudflare API token lives only in the repo's Actions secrets as
`CLOUDFLARE_API_TOKEN`. Fine-grained GitHub tokens expire, and an expired token
would break failover exactly when it is needed, so the monitor checks the token
daily (an authenticated read of the repo plus its expiry header) and pages 14
days before expiry and on any auth failure. Dry-run mode runs the same check.

This also changes the manual flow: humans would publish by pushing to `main`
instead of running `npm run deploy` locally. Expected Actions latency is
~30 to 90 s, small next to the ~5 min detection window.

Alternative considered: the controller runs `wrangler deploy` itself and
commits after. Faster by a minute, but it puts a Cloudflare token on
mcnachman.cloud and has a window where repo and live map differ. Not
recommended.

## The map edit

Failover: reassign every range whose `host` is the dark box to the surviving
host(s), bump `version`. With two hosts this is "everything to the survivor".
With more hosts, split the dark box's arcs among survivors by current load
(rooms_live), still minimal-churn (§7.5).

Record the pre-failover map (version and ranges) in the monitor's state so
failback restores it exactly. Failback publishes those ranges with a new,
higher version (never the old number).

If a human edits the map while a failover is active (the published version no
longer matches what the controller wrote), the controller drops its failback
state and pages; a human owns the map from then on.

## Limits and kill switch

- Never move buckets away from the last healthy host, and never move buckets
  to a host that is itself failing any check.
- At most one automatic failover per `FAILOVER_MIN_INTERVAL` (default 60 min);
  a second dark box inside that window pages instead of acting.
- Kill switch: `AUTO_FAILOVER=off` in the monitor env (default off until the
  drill passes), plus a dry-run mode that logs and pages "would fail over"
  without publishing. Run dry-run in production for a couple of weeks first.
- Every action pages (email via the monitor; the Mac watcher picks it up on its
  next triage) with: what moved, why (the four checks), the new version, and
  how to undo.

## Timing estimate

Dark at T. Monitor tick is 5 min with `ALERT_FAIL_STREAK=2`, which is too slow
for this; the failover check needs its own faster probe of the suspect host
(e.g. every 30 s once one tick fails), requiring ~3 min of consecutive
connect-level failure from both vantages. Then ~1 min to publish. So clients
recover around T+4 to T+5 min, versus T+17 and T+24 min on 2026-10-22.

## Drill

Do this before turning it on:

1. Unit tests for the decision function: each of the four checks missing ->
   no action; HTTP 5xx -> no action; last-host and rate-limit guards; human
   edit during failover -> drop state.
2. Dry-run in production, compare its "would fail over" pages against real
   incidents.
3. Live drill in a quiet hour: firewall 443 and 22 on one box (from the
   provider console, or a host firewall rule with a timed auto-revert),
   watch failover, confirm clients reconnect to the survivor, lift the block,
   confirm the box adopts the new map and failback drains rooms back.

## Decisions (George, 2026-10-23)

- Trigger: 3 min of dark from both vantages. Confirmed.
- Capacity: one box easily carries 100% of the load, so the two-host case
  ("everything to the survivor") needs no load check.
- Publishing: push to `main`, with GitHub Actions deploying the resolver and
  the Pages mirror. Confirmed.
- Failback: automatic, after the original box has been stable for at least
  10 min (`FAILBACK_STABLE_MIN`, floor 10).
