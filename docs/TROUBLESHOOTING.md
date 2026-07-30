# Troubleshooting the relay

Field guide for diagnosing a live pairing that "won't connect." Written from a
real incident: the Mac showed *connected* while the phone said *the mac hasn't
been found yet*, for hours. Everything below runs on the relay host.

## Topology (know this first)

A client's TLS socket terminates at **Caddy on `:443`**, which reverse-proxies to
the **node relay on `127.0.0.1:8787`**. So every client has **two legs**:

```
Mac/phone  ──TLS──▶  Caddy :443  ──ws proxy──▶  node relay 127.0.0.1:8787
```

Consequences that bite:

- "Connected" on a device only means its leg to **Caddy** is up. It says nothing
  about whether the node relay still has a socket, or whether the device is
  *parked* (admitted) in its room.
- If the node's leg dies (keepalive reap, or Caddy resetting an idle upstream)
  and Caddy doesn't propagate the close outward, the device leg **lingers** —
  the device shows "connected" with a healthy TCP while nothing is behind it.
- The relay's keepalive governs only the **Caddy↔node** leg. It cannot reach a
  device across Caddy, and it cannot touch a socket the node has already lost.

## Layers of "connected"

| Layer | How to check | What "up" proves |
|-------|--------------|------------------|
| Device TCP/TLS → Caddy | `lsof`/`ss` on the device; `ss` on `:443` on the box | only that Caddy is a reachable TCP peer |
| Caddy → node WS (loopback `:8787`) | `ss` on `:8787` | a proxied WS exists behind the device leg |
| Node **admitted / parked** in the room | `/metrics` occupancy + the log | the device actually holds its role slot |

A device is only usable when the **bottom** layer is true. The upper two can be
up while the bottom is false — that is the whole failure class.

## The room tag

Logs never contain the room name (it is a rendezvous secret). A room is
identified by an opaque tag = **first 4 bytes of `SHA-256(roomName)`**:

```bash
printf '%s' "$ROOM_NAME" | sha256sum | cut -c1-8
```

## Step 1 — is a mac actually parked?

`sqlite` will **not** tell you: a parked mac is live socket state (the in-memory
socket attachment), never written to storage. `lastActivity`/`quota` rows can be
fresh even with no mac parked (a signing *phone retry* bumps `lastActivity`
just before it is rejected). Ask the running process instead:

```bash
curl -s localhost:8787/metrics | grep -E 'rooms_(both|mac_only|phone_only|neither)|phone_no_mac_total'
```

- `relay_rooms_both` — pairings currently spliced (mac + phone).
- `relay_rooms_mac_only` — macs parked, waiting for a phone.
- `relay_phone_no_mac_total` — **cumulative** phones turned away with "mac
  offline". A climbing value is the direct signal that macs aren't reaching
  their rooms.
- `relay_rooms_phone_only` should stay `0` (a phone can't admit without a mac);
  nonzero is an invariant tripwire.

## Step 2 — read the room's log

Disconnect, connect, and park lines are always-on (no `RELAY_LOG` needed) and
carry no PII:

```bash
journalctl -u iterm2-companion-relay --since '-30 min' --no-pager | grep "$TAG"
```

Interpret:

- `disconnect initiator=relay role=phone … reason=mac offline` — phone reached
  the right room but no mac is parked. (Layer 3 false.)
- `admit role=mac via=signed peer=true` — a mac parked and spliced. Absence of
  any recent `admit role=mac` while phones retry ⇒ the mac isn't parking here.
- `disconnect initiator=relay role=mac … reason=peer gone` — normal: the phone
  dropped, so the relay closed the mac to force a fresh re-park.
- `disconnect initiator=remote role=mac … code=1006` — the mac's socket died
  abnormally (no close frame): a network/proxy drop, **or** the relay's own
  keepalive giving up. To disambiguate, look for the always-on
  `keepalive no-pong; terminating` line — if present, the relay reaped it; if
  absent, the transport died underneath.

## Step 3 — reconcile the legs with `ss`

```bash
# client legs at Caddy
ss -tn state established '( sport = :443 )' | tail -n +2 | wc -l
# Caddy↔node loopback pairs (each connection is two lines) — subtract 1 for your
# own curl /metrics scrape if you just ran one
echo $(( $(ss -tn state established '( sport = :8787 or dport = :8787 )' | grep -c 127.0.0.1) / 2 ))
```

`:443` count **greater than** `:8787` pairs ⇒ one or more client legs are
**orphaned at Caddy** (device connected, no node upstream). To find a specific
device (its LAN port is NAT-rewritten, so match by public IP, not port):

```bash
ss -tan dst <DEVICE_PUBLIC_IP>     # every leg between that device and the box
```

No line on `:443` for a device that claims "connected" ⇒ its socket is
**half-open**: dead on the box, phantom on the device (often the NAT mapping has
already expired). `ESTABLISHED` with `Recv-Q 0 / Send-Q 0` on the *device* does
**not** rule this out — with no app-level keepalive nothing flows, so TCP never
learns the peer is gone.

## Step 4 — fix

- **Half-open / orphaned device:** force it to reconnect (toggle the companion /
  restart iTerm2). The box cannot heal a socket it no longer holds.
- **Established room, `reason=bad signature` on the mac:** its join key ≠ the
  registered verifier → re-pair.
- **Room torn down** (`reason=room deleted/expired/pairing cycle cap`) → re-pair.

## Live tracing without a restart

Verbose per-event logging (`RELAY_LOG`) can be toggled at runtime with `SIGUSR2`
— no restart, so parked sockets are not dropped:

```bash
systemctl kill -s USR2 iterm2-companion-relay   # toggle on; repeat to toggle off
journalctl -fu iterm2-companion-relay | grep "$TAG"
```

This surfaces `hello`, reject reasons, displacement, and eviction detail on top
of the always-on lifecycle lines. Ping/pong itself is **not** logged; to observe
it, packet-capture the plaintext loopback: `tcpdump -i lo -X 'tcp port 8787'`
(WS ping opcode `0x89`, pong `0x8a`).

## Root-cause note

The recurring version of this — a device trusting a dead WebSocket indefinitely
and showing a stale "connected N hours" — is a **client-side** gap (no
application-level ping / reconnect-on-pong-timeout), not a relay defect. The
relay keepalive correctly reaps its own side; it just can't reach across Caddy to
the device. The signals above exist so that when it recurs, it's a two-minute
diagnosis instead of an evening of socket arithmetic.
