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
      },
    },
  },
});
