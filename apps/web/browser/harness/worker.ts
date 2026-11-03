import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { outbound, SECRETS, sink } from "../../test/stand-ins";

/** apps/web, where wrangler.jsonc is. */
const WEB = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Bundles the Worker as `wrangler deploy` does (a dry run into a temporary folder), so the
 * browser is served what deploys. Returns the folder and a function that removes it.
 */
async function bundle(): Promise<{ outdir: string; remove: () => Promise<void> }> {
  const outdir = await mkdtemp(join(tmpdir(), "rarepair-web-"));
  const wrangler = createRequire(import.meta.url).resolve("wrangler/package.json");
  await promisify(execFile)(
    process.execPath,
    [join(dirname(wrangler), "bin/wrangler.js"), "deploy", "--dry-run", "--outdir", outdir],
    { cwd: WEB },
  );
  return { outdir, remove: () => rm(outdir, { recursive: true }) };
}

/** The web Worker running in Miniflare, from `startWorker`. */
export type RunningWorker = {
  mf: Miniflare;
  /** The port on 127.0.0.1 where it answers HTTPS. */
  port: number;
  dispose: () => Promise<void>;
};

/**
 * The web Worker in Miniflare, as wrangler.jsonc deploys it, over HTTPS on a free port of
 * 127.0.0.1 (Miniflare's self-signed certificate). PRELAUNCH is wrangler.jsonc's ("on") when
 * `prelaunch` is true, "off" otherwise. The database, secrets, outbound network and queue
 * consumers are the workerd tests' stand-ins (test/stand-ins.ts); the database is the one at
 * `databaseUrl`, reached through the Hyperdrive binding.
 */
export async function startWorker({
  databaseUrl,
  prelaunch,
}: {
  databaseUrl: string;
  prelaunch: boolean;
}): Promise<RunningWorker> {
  const built = await bundle();
  // The bundle is one module, so wrangler's rules for finding others are not needed (and
  // Miniflare refuses to convert them).
  const { modulesRules: _, ...config } = unstable_getMiniflareWorkerOptions(
    join(WEB, "wrangler.jsonc"),
  ).workerOptions;
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
          modulesRoot: built.outdir,
          scriptPath: join(built.outdir, "index.js"),
          hyperdrives: { HYPERDRIVE: databaseUrl },
          outboundService: outbound,
          bindings: {
            // SAFETY: wrangler.jsonc's vars, which wrangler gives as a plain object.
            ...(config.bindings as Record<string, string>),
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
  return {
    mf,
    port: Number(url.port),
    async dispose() {
      await mf.dispose();
      await built.remove();
    },
  };
}
