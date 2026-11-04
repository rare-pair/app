import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { unstable_getMiniflareWorkerOptions, unstable_readConfig } from "wrangler";
import { CONTENT_HOST } from "../../src/content-host";
import { outbound, SECRETS, sink } from "../../test/stand-ins";
import { r2PutWorker } from "./r2-put";

/** apps/, where each Worker's folder is. */
const APPS = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const BUNDLE_TIMEOUT_MS = 120_000;

/** The Workers a site runs, by their folders under apps/. */
type App = "web" | "ingest" | "content";
/** The folder holding each Worker's bundle. */
export type WorkerBundles = Record<App, string>;

const configOf = (app: App) => join(APPS, app, "wrangler.jsonc");

/**
 * Bundles `app` as `wrangler deploy` does (a dry run into a new temporary folder), so the
 * browser is served what deploys, and returns the folder. A bundle doesn't depend on PRELAUNCH
 * or the database, so one serves every site in a run (global-setup.ts).
 */
async function bundleWorker(app: App): Promise<string> {
  const outdir = await mkdtemp(join(tmpdir(), `rarepair-${app}-`));
  const wrangler = createRequire(import.meta.url).resolve("wrangler/package.json");
  // No Cloudflare credentials reach the child, so it can never deploy, and no telemetry.
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("CLOUDFLARE_")),
    ),
    WRANGLER_SEND_METRICS: "false",
  };
  await promisify(execFile)(
    process.execPath,
    [join(dirname(wrangler), "bin/wrangler.js"), "deploy", "--dry-run", "--outdir", outdir],
    { cwd: join(APPS, app), env, timeout: BUNDLE_TIMEOUT_MS },
  ).catch(async (error: Error) => {
    await rm(outdir, { recursive: true });
    throw error;
  });
  return outdir;
}

/** Bundles the three Workers, side by side. If one fails, leaves no folder behind. */
export async function bundleWorkers(): Promise<WorkerBundles> {
  const results = await Promise.allSettled([
    bundleWorker("web"),
    bundleWorker("ingest"),
    bundleWorker("content"),
  ]);
  const [web, ingest, content] = results;
  if (
    web.status === "fulfilled" &&
    ingest.status === "fulfilled" &&
    content.status === "fulfilled"
  ) {
    return { web: web.value, ingest: ingest.value, content: content.value };
  }
  await Promise.all(
    results.flatMap((r) => (r.status === "fulfilled" ? [rm(r.value, { recursive: true })] : [])),
  );
  throw new Error("Bundling a Worker failed", {
    cause: results.flatMap((r) => (r.status === "rejected" ? [r.reason] : [])),
  });
}

/**
 * `app`'s options as its wrangler.jsonc deploys it, running its bundle under the name it
 * deploys with. Plain bindings are empty: wrangler's own would also bring a developer's
 * .dev.vars, .env or exported secrets.
 */
function deployed(app: App, bundle: string) {
  const configPath = configOf(app);
  // The bundle is one module, so wrangler's rules for finding others are not needed (and
  // Miniflare refuses to convert them).
  const { modulesRules: _, ...config } =
    unstable_getMiniflareWorkerOptions(configPath).workerOptions;
  const { main = "index.ts" } = unstable_readConfig({ config: configPath }, { hideWarnings: true });
  return {
    ...config,
    name: `rarepair-${app}`,
    modules: true,
    // The bundle's own folder: workerd fails to start, saying only "internal error", when
    // the module's name climbs out of its root with "..".
    modulesRoot: bundle,
    scriptPath: join(bundle, `${basename(main, ".ts")}.js`),
    bindings: {},
  };
}

/** The ingest and content Workers' outbound network: neither makes a call, so none is let out. */
const noOutbound = () => new Response("outbound network blocked in tests", { status: 599 });

/** The Workers running in Miniflare, from `startWorker`. */
type RunningWorker = {
  mf: Miniflare;
  /** The port on 127.0.0.1 where they answer HTTPS. */
  port: number;
};

/**
 * The web, ingest and content Workers in one Miniflare, from `bundles` (`bundleWorkers`), as
 * their wrangler.jsonc files deploy them, over HTTPS on a free port of 127.0.0.1 (Miniflare's
 * self-signed certificate). All three say bucket `rarepair`, so they share it, and web's
 * `ingest` queue is delivered to the real ingest Worker, sooner than deployed: no wait to fill
 * a batch, and a retry after a second rather than two minutes, with the deployed retry count.
 * (That is under the job's 60 s lease, so a job that dies holding its lease isn't retried: the
 * retry finds the lease taken and acks, and `site.waitForUpload` times out on `processing`.)
 * PRELAUNCH is wrangler.jsonc's ("on") when `prelaunch` is true, "off" otherwise. The database,
 * secrets, web's outbound network and email's consumer are the workerd tests' stand-ins
 * (test/stand-ins.ts); the database is the one at `databaseUrl`, reached through each
 * Hyperdrive binding. `mf.dispose()` stops it.
 */
export async function startWorker({
  bundles,
  databaseUrl,
  prelaunch,
}: {
  bundles: WorkerBundles;
  databaseUrl: string;
  prelaunch: boolean;
}): Promise<RunningWorker> {
  // Web's plain bindings are wrangler.jsonc's vars and the throwaway secrets, nothing else.
  const { vars } = unstable_readConfig({ config: configOf("web") }, { hideWarnings: true });
  const ingest = deployed("ingest", bundles.ingest);
  // SAFETY: wrangler's type leaves out the consumers it returns; ingest's wrangler.jsonc has them.
  const { queueConsumers } = ingest as typeof ingest & {
    queueConsumers: Record<string, { maxBatchTimeout: number; retryDelay: number }>;
  };
  // wrangler gives the options in Miniflare 4's shape, as the vitest plugin takes them.
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      https: true,
      // No request for Cloudflare's request metadata.
      cf: {},
      workers: [
        {
          ...deployed("web", bundles.web),
          hyperdrives: { HYPERDRIVE: databaseUrl, HYPERDRIVE_CACHED: databaseUrl },
          outboundService: outbound,
          bindings: {
            ...vars,
            ...SECRETS,
            PRELAUNCH: prelaunch ? "on" : "off",
          },
        },
        {
          ...ingest,
          hyperdrives: { HYPERDRIVE: databaseUrl },
          outboundService: noOutbound,
          queueConsumers: {
            ...queueConsumers,
            ingest: { ...queueConsumers.ingest, maxBatchTimeout: 0, retryDelay: 1 },
          },
        },
        {
          ...deployed("content", bundles.content),
          // wrangler's custom domain gives no route: Miniflare routes by these.
          routes: [`${CONTENT_HOST}/*`],
          outboundService: noOutbound,
        },
        r2PutWorker,
        sink("email-sink", "email"),
      ],
    }),
  );
  try {
    const url = await mf.ready;
    return { mf, port: Number(url.port) };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
