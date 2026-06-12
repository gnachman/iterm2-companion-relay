import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Runs tests inside workerd (real Durable Objects, real WebSocket pairs), so
// the relay's admission/splice logic is exercised the way it runs in prod.
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Isolated storage snapshots trip over SQLite WAL (-shm/-wal) files
        // for SQLite-backed Durable Objects; we get per-test isolation by
        // using a unique room name per test instead.
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        // Integration tests default to OPEN mode (the production wrangler var
        // is fail-closed "true"; the fail-closed logic is unit-tested
        // directly). Attested/established admission is exercised via the
        // verifier-registration path, which does not depend on this var.
        miniflare: {
          bindings: {
            ATTEST_REQUIRED: "false",
            RELAY_ORIGIN: "https://relay.example",
          },
        },
      },
    },
  },
});
