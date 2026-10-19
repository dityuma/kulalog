import { defineConfig } from "vitest/config";

// Run date logic in the keepers' timezone (WIB), like the browser tests.
process.env.TZ = "Asia/Jakarta";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.js"],
    environment: "node"
  }
});
