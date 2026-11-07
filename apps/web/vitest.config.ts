import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { outbound, SECRETS, sink } from "./test/stand-ins";

/**
 * The Worker in workerd, as wrangler.jsonc deploys it, with `bindings` over its
 * own. The entry, compatibility date and bindings come from wrangler.jsonc, so
 * the tests run the config that deploys. Postgres is the one the global setup
 * starts, reached through a local Hyperdrive as in production.
 */
const worker = (bindings: Record<string, string> = {}) =>
  cloudflareTest(({ inject }) => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      // Both connections reach the one test database; a local Hyperdrive has no cache.
      hyperdrives: {
        HYPERDRIVE: inject("databaseUrl"),
        HYPERDRIVE_CACHED: inject("databaseUrl"),
      },
      outboundService: outbound,
      bindings: { ...SECRETS, ...bindings },
      serviceBindings: { EMAIL_SINK: "email-sink", INGEST_SINK: "ingest-sink" },
      workers: [sink("email-sink", "email"), sink("ingest-sink", "ingest")],
    },
  }));

// What every workerd project shares. A project doesn't inherit the root's
// timeouts; the first request loads Better Auth.
const workerd = {
  globalSetup: ["./test/global-setup.ts"],
  testTimeout: 60_000,
  hookTimeout: 60_000,
};

// Three projects. Pure logic, such as the Turnstile verifier and the `next`
// reduction, runs in Node (/tdd, Rules of the loop). The Worker's HTTP surface
// runs in workerd, through exports.default.fetch: `open` with PRELAUNCH off (as
// wrangler.jsonc deploys), and `prelaunch` with it turned on.
export default defineConfig({
  // The plugin resolves a module workerd asks it for through this root config's
  // SSR environment, not a project's: pg's require of pg-cloudflare needs the
  // plugin's conditions here too. The node project doesn't inherit them.
  ssr: { resolve: { conditions: ["workerd", "worker", "module", "browser"] } },
  test: {
    // Each file's first request loads the Worker's module graph again (about 2 s a file), and
    // those loads queue behind one another, so N files started at once wait about N x 2 s.
    // The whole run takes no longer for fewer at once, but the wait stays well under the
    // timeout when two runs share the machine (#359).
    maxWorkers: 4,
    projects: [
      {
        test: {
          name: "node",
          include: ["test/**/*.node.test.ts"],
          environment: "node",
        },
      },
      {
        // The archive open: wrangler.jsonc as it deploys (PRELAUNCH off), set here too so
        // this project doesn't follow a change to the file. Other vars are kept.
        plugins: [worker({ PRELAUNCH: "off" })],
        test: {
          name: "open",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.node.test.ts", "test/**/*.prelaunch.test.ts"],
          ...workerd,
        },
      },
      {
        // Before launch: wrangler.jsonc with PRELAUNCH turned on, which it no longer is as
        // deployed. As in `open`, the database, secrets, outbound network and email sink are
        // the test stand-ins. The wait list's response-time floor is shortened, so each join
        // doesn't wait out the deployed one; the floor tests set their own, and a Node test
        // checks the deployed value.
        plugins: [worker({ PRELAUNCH: "on", WAITLIST_FLOOR_MS: "50" })],
        test: {
          name: "prelaunch",
          include: ["test/**/*.prelaunch.test.ts"],
          ...workerd,
        },
      },
    ],
  },
});
