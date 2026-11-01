import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// A throwaway secret, none of Cloudflare's published test secrets: under those the Worker
// skips the action check (src/turnstile.ts), and the tests need it on.
const TURNSTILE_SECRET_KEY = "test-only-turnstile-secret";
// Cloudflare's published dummy token.
const DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

/**
 * The Worker's outbound network in tests: siteverify passes the dummy token under
 * the test secret, and everything else is blocked. Cloudflare reports such a token as
 * solved on "localhost"; this stand-in reports the host and the action the test chooses,
 * so the host and action checks can be tested. The token is the dummy token, then
 * "#" and the action it was solved under, then optionally "@" and the host:
 * "XXXX.DUMMY.TOKEN.XXXX#login@other.example". The host is rarepair.fans when left out.
 * A token with no "#" is reported with no action. "siteverify-down" gets a 503;
 * any other token fails.
 */
async function outbound(request: Request): Promise<Response> {
  if (request.url !== SITEVERIFY) {
    return new Response("outbound network blocked in tests", { status: 599 });
  }
  const form = new URLSearchParams(await request.text());
  const [solved = "", hostname = "rarepair.fans"] = (form.get("response") ?? "").split("@");
  const [token, action] = solved.split("#");
  if (token === "siteverify-down") return new Response("unavailable", { status: 503 });
  if (form.get("secret") === TURNSTILE_SECRET_KEY && token === DUMMY_TOKEN) {
    return Response.json({ success: true, hostname, action, "error-codes": [] });
  }
  return Response.json({ success: false, "error-codes": ["invalid-input-response"] });
}

// Stands in for a queue's consumer (apps/mailer for `email`, apps/ingest for `ingest`), and answers a fetch
// with every message body it has been delivered. One message a batch, delivered at once.
const QUEUE_SINK = /* js */ `
const delivered = [];
export default {
  async queue(batch) {
    for (const message of batch.messages) {
      delivered.push(message.body);
      message.ack();
    }
  },
  async fetch() {
    return Response.json(delivered);
  },
};
`;

// The stand-in consumer `name` for `queue`: `email` (apps/mailer) and `ingest` (apps/ingest).
const sink = (name: string, queue: string) => ({
  name,
  modules: true,
  script: QUEUE_SINK,
  compatibilityDate: "2026-08-01",
  queueConsumers: { [queue]: { maxBatchSize: 1, maxBatchTimeout: 0 } },
});

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
      hyperdrives: { HYPERDRIVE: inject("databaseUrl") },
      outboundService: outbound,
      bindings: {
        // Throwaway test values, not credentials.
        BETTER_AUTH_SECRET: "test-only-auth-value-not-used-anywhere-else",
        TURNSTILE_SECRET_KEY,
        IP_HASH_KEY: "test-only-ip-hash-key-not-used-anywhere-else",
        // Presigning makes no request, so these are never sent anywhere.
        R2_ACCOUNT_ID: "test0000000000000000000000000acct",
        R2_ACCESS_KEY_ID: "test-only-access-key-id",
        R2_SECRET_ACCESS_KEY: "test-only-secret-access-key",
        ...bindings,
      },
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
// runs in workerd, through exports.default.fetch: `open` with PRELAUNCH off, and
// `prelaunch` exactly as wrangler.jsonc deploys it.
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
        // The archive open: wrangler.jsonc with PRELAUNCH turned off. Other vars are kept.
        plugins: [worker({ PRELAUNCH: "off" })],
        test: {
          name: "open",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.node.test.ts", "test/**/*.prelaunch.test.ts"],
          ...workerd,
        },
      },
      {
        // Before launch: wrangler.jsonc as it deploys, PRELAUNCH on. As in `open`, the
        // database, secrets, outbound network and email sink are the test stand-ins.
        // The wait list's response-time floor is shortened, so each join doesn't wait out the
        // deployed one; the floor tests set their own, and a Node test checks the deployed value.
        plugins: [worker({ WAITLIST_FLOOR_MS: "50" })],
        test: {
          name: "prelaunch",
          include: ["test/**/*.prelaunch.test.ts"],
          ...workerd,
        },
      },
    ],
  },
});
