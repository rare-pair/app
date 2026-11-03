import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { unstable_getMiniflareWorkerOptions, unstable_readConfig } from "wrangler";
import { outbound, SECRETS, sink } from "../../test/stand-ins";

/** apps/web, where wrangler.jsonc is. */
const WEB = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Bundles the Worker as `wrangler deploy` does (a dry run into a new temporary folder), so
 * the browser is served what deploys, and returns the folder. The bundle doesn't depend on
 * PRELAUNCH or the database, so one serves every site in a run (global-setup.ts).
 */
export async function bundleWorker(): Promise<string> {
  const outdir = await mkdtemp(join(tmpdir(), "rarepair-web-"));
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
    { cwd: WEB, env },
  );
  return outdir;
}

/** The web Worker running in Miniflare, from `startWorker`. */
type RunningWorker = {
  mf: Miniflare;
  /** The port on 127.0.0.1 where it answers HTTPS. */
  port: number;
};

/**
 * The web Worker in Miniflare, from the bundle in `bundle` (`bundleWorker`), as wrangler.jsonc
 * deploys it, over HTTPS on a free port of 127.0.0.1 (Miniflare's self-signed certificate).
 * PRELAUNCH is wrangler.jsonc's ("on") when `prelaunch` is true, "off" otherwise. The
 * database, secrets, outbound network and queue consumers are the workerd tests' stand-ins
 * (test/stand-ins.ts); the database is the one at `databaseUrl`, reached through the
 * Hyperdrive binding. `mf.dispose()` stops it.
 */
export async function startWorker({
  bundle,
  databaseUrl,
  prelaunch,
}: {
  bundle: string;
  databaseUrl: string;
  prelaunch: boolean;
}): Promise<RunningWorker> {
  const configPath = join(WEB, "wrangler.jsonc");
  // The bundle is one module, so wrangler's rules for finding others are not needed (and
  // Miniflare refuses to convert them).
  const { modulesRules: _, ...config } =
    unstable_getMiniflareWorkerOptions(configPath).workerOptions;
  // The Worker's plain bindings are wrangler.jsonc's vars and the throwaway secrets, nothing
  // else: wrangler's own bindings would also bring a developer's .dev.vars, .env or exported
  // secrets.
  const { vars } = unstable_readConfig({ config: configPath }, { hideWarnings: true });
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
          ...config,
          name: "rarepair-web",
          modules: true,
          // The bundle's own folder: workerd fails to start, saying only "internal error",
          // when the module's name climbs out of its root with "..".
          modulesRoot: bundle,
          scriptPath: join(bundle, "index.js"),
          hyperdrives: { HYPERDRIVE: databaseUrl },
          outboundService: outbound,
          bindings: {
            ...vars,
            ...SECRETS,
            PRELAUNCH: prelaunch ? "on" : "off",
          },
        },
        sink("email-sink", "email"),
        sink("ingest-sink", "ingest"),
      ],
    }),
  );
  const url = await mf.ready;
  return { mf, port: Number(url.port) };
}
