import { defineConfig } from "vitest/config";

// Node-runtime tests for the self-hosted relay: the storage shim, the runtime /
// alarm shim, the http+ws host, and the ported integration tests. These run in
// plain Node (not workerd), so they exercise the code exactly as it runs in
// production on the VPS. The legacy workerd projects (vitest.config.js) are
// retired once the integration suite finishes porting.
export default defineConfig({
  test: {
    name: "node",
    include: ["test/**/*.test.js"],
  },
});
