import { defineConfig } from "vitest/config";

// Two projects run under one `npm test`: the default open-mode worker
// (vitest.open.config.js) and an attested-mode worker with a different
// ATTEST_REQUIRED + trust-root binding (vitest.attested.config.js).
export default defineConfig({
  test: {
    projects: ["./vitest.open.config.js", "./vitest.attested.config.js"],
  },
});
