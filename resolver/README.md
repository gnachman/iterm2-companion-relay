# iTerm2 shard-map resolver (Cloudflare static asset)

Serves the resolved-mode shard map at **`https://resolver.iterm2.com/shardmap.json`**
as a **static asset** at the Cloudflare edge: an assets-only Worker (no script)
whose only content is `public/shardmap.json`. No R2, no KV, no origin
dependency, so it stays up even if the web server is down.

## Why a static asset, not a Worker script

Until 2026-10-09 this was a Worker script that returned the map from inside its
own bundle. Every request ran the script and counted toward the free plan's
100k/day Workers request limit; client and relay polling exceeded it, and
Cloudflare answered `429` (`error code: 1027`) until the daily reset. Static
asset requests that run no script are free and unlimited, which is what the
design assumed all along (design §6.3: "a tiny static asset on a CDN is
effectively always-available and unlimited-throughput"). **Do not add a `main`
script back**: any script on this route puts every request back under the cap.

## Properties

- **Live in seconds.** `wrangler deploy` uploads a new asset version and
  switches to it atomically, so a redeploy is served at the edge in seconds.
- **No origin fallthrough.** The whole `resolver.iterm2.com/*` subdomain routes
  to the Worker. `/shardmap.json` is a 200; any other path is a 404 from the
  asset layer (`not_found_handling: "none"`). Nothing ever reaches the origin.
- **Free, unlimited, cannot bill.** No script, no KV, R2, Durable Objects,
  Queues, or observability.
- **Correct HTTP.** `Content-Type: application/json` (from the extension), an
  `ETag` with `304` on a matching `If-None-Match`, and `HEAD`, all provided by
  the asset layer. `Cache-Control` comes from `public/_headers`.

## One-time setup

1. **Auth** (uses your Cloudflare login):
   ```sh
   cd resolver
   npm install          # installs wrangler (the only dependency)
   npx wrangler login    # or set CLOUDFLARE_API_TOKEN
   ```

2. **DNS.** Worker routes only run on *proxied* traffic, so `resolver.iterm2.com`
   needs a proxied DNS record. It never actually serves from the origin (the
   asset Worker answers everything), so point it at a dummy address:

   > In the Cloudflare dashboard for `iterm2.com` -> DNS -> Add record:
   > **A** · name `resolver` · IPv4 `192.0.2.1` · **Proxied (orange cloud)**.

   (`192.0.2.1` is RFC 5737 documentation space, non-routable — it exists only so
   Cloudflare will proxy the hostname; the Worker route intercepts before any
   origin connection. An `AAAA resolver -> 100::` proxied record works equally.)

## Deploy

```sh
cd resolver
npm run deploy        # == wrangler deploy
```

Wrangler will confirm the route `resolver.iterm2.com/*` on zone `iterm2.com`.

## Update the shard map

Editing the document does **not** touch code:

1. Edit **`public/shardmap.json`** and **bump `"version"`** (it must strictly
   increase — relays and clients ignore a same-or-lower version, by design).
2. `npm run deploy`.

Live within seconds. Verify:

```sh
curl -i https://resolver.iterm2.com/shardmap.json
```

> The committed `public/shardmap.json` is a **template** (hosts `relay1.iterm2.com` /
> `relay2.iterm2.com`, 50/50). Replace the `host` values with your real relay
> authorities before pointing clients at it. Each `host` is a bare authority
> (lowercase `host` or `host:port`, no scheme/path), and must byte-match that
> relay's TLS-cert name, `RELAY_SELF_HOST`, and `RELAY_ORIGIN` (minus `https://`).

Clients set the pairing QR's `resolver=` to `https://resolver.iterm2.com/`, and
the relays set `RELAY_SHARDMAP_URL=https://resolver.iterm2.com/shardmap.json`.

## Caching (`max-age=5` is a design invariant, not a tuning knob)

- Each deploy is a new asset version, served immediately, so a redeploy is
  live at the edge in seconds.
- `Cache-Control: public, max-age=5` (set in `public/_headers`) is the value the design mandates (§6.3,
  Appendix C), and it is load-bearing for the **client** re-resolve path. On a
  reshard the losing relay evicts a room with WS 4421 (or rejects with HTTP 421)
  and the client "forces a map refresh", but the client fetches the map with an
  ordinary protocol-caching HTTP client, so that refresh only sees the new map
  once the cached copy has expired. A long `max-age` (or any
  `stale-while-revalidate`) would hand the evicted client its stale map, bounce
  it back to the old owner, and 421-ping-pong it until the cache expired. Five
  seconds bounds that window; the `ETag` makes each revalidation a cheap `304`.
- The **relays** fetch with a plain HTTP client (no cache), so they always see
  the deployed content on their next poll regardless of this header.

## Files

```
wrangler.jsonc         route (whole subdomain), assets dir, workers_dev off, no script
public/shardmap.json   the document (edit this; bump version; redeploy)
public/_headers        Cache-Control: public, max-age=5 for /shardmap.json
package.json           wrangler devDependency + deploy script
```
