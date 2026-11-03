import { defineConfig } from "vitest/config";

// The browser suites (browser/): headless Chromium against the web Worker in Miniflare, from
// Node. Not part of `npm test`: they need a browser `npm ci` doesn't fetch, and minutes.
// `npm run test:browser` runs them one file at a time, since each file starts its own site
// on one port.
export default defineConfig({
  test: {
    include: ["browser/**/*.browser.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
