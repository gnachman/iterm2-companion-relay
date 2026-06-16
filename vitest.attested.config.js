import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { TEST_ROOT_PEM } from "./test/fixtures/testRoot.js";

// Attested-mode tests: ATTEST_REQUIRED is left unset (so attestationRequired()
// is true, the production posture), and the trust anchor is the throwaway test
// root so synthetic attestations can be accepted. Only test/attested.test.js
// runs here.
export default defineWorkersConfig({
  test: {
    name: "attested",
    include: ["test/attested.test.js"],
    poolOptions: {
      workers: {
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            // Override the wrangler.jsonc var so this project runs attested.
            ATTEST_REQUIRED: "true",
            RELAY_ORIGIN: "https://relay.example",
            APP_ID: "TEAMID12.com.example.app",
            APPATTEST_ENV: "production",
            APPATTEST_ROOT_PEM: TEST_ROOT_PEM,
            RELAY_LOG: "true",
          },
        },
      },
    },
  },
});
