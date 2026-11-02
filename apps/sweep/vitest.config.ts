import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Two projects (/tdd, Rules of the loop). Reference extraction and the cron config check are
// plain Node. The scheduled handler needs workerd: it lists and deletes R2 objects and reads
// Postgres through the Worker's bindings. The compatibility date (wrangler.jsonc) must not be
// newer than the installed workerd.
export default defineConfig({
  // The plugin resolves a module workerd asks it for through this root config's SSR
  // environment, not a project's: pg's require of pg-cloudflare needs the plugin's
  // conditions here too. The node project doesn't inherit them.
  ssr: { resolve: { conditions: ["workerd", "worker", "module", "browser"] } },
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/**/*.node.test.ts"],
          environment: "node",
          // PGlite starts and migrates in the paging test's hook.
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // The Worker as wrangler.jsonc deploys it, with a local R2 bucket and Postgres from
        // the global setup reached through a local Hyperdrive, as in production.
        plugins: [
          cloudflareTest(({ inject }) => ({
            wrangler: { configPath: "./wrangler.jsonc" },
            miniflare: {
              hyperdrives: { HYPERDRIVE: inject("databaseUrl") },
              // The sweep makes no outbound calls: any fetch gets this.
              outboundService: () =>
                new Response("outbound network blocked in tests", { status: 599 }),
            },
          })),
        ],
        test: {
          name: "workers",
          include: ["test/**/*.worker.test.ts"],
          globalSetup: ["./test/global-setup.ts"],
          // A project doesn't inherit the root's timeouts.
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
