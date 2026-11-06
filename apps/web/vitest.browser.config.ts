import { defineConfig } from "vitest/config";

// The browser suites (browser/): headless Chromium against the web, ingest and content Workers
// in Miniflare, from Node. Not part of `npm test`: they need a browser `npm ci` doesn't fetch, and
// add most of a minute. `npm run test:browser` runs them. The Workers are bundled once for the run
// (the global setup); each file starts its own sites, on free ports, so files run side by side.
export default defineConfig({
  test: {
    include: ["browser/**/*.browser.test.ts"],
    environment: "node",
    globalSetup: ["./browser/harness/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // A poll here waits on a browser and several Workers, not the default one second.
    expect: { poll: { timeout: 15_000 } },
    // Each worker runs a browser and several Workers: about 1.2 GB each. Left to the default of
    // about one per core, one run took 17 GB and stalled the machine.
    maxWorkers: 4,
  },
});
