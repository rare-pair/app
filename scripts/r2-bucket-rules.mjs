#!/usr/bin/env node
// Applies the R2 bucket's lifecycle rules: the rule that expires uploads/ after 7 days, so an
// upload whose /complete never comes deletes itself (ARCHITECTURE, Orphaned uploads); R2 removes an
// expired object typically within 24 hours. Then it prints the bucket's current rules, for the
// gate. The bucket has no CORS rule: no browser talks to it.
//
//   node scripts/r2-bucket-rules.mjs [--dry-run]
//
// The bucket is rarepair, the one apps/content/wrangler.jsonc binds. The operator runs this by
// hand, once, and again whenever a rule here changes; nothing deploys it. It needs wrangler's
// credentials: CLOUDFLARE_API_TOKEN (a token with Workers R2 Storage Write), or a
// `wrangler login`, and CLOUDFLARE_ACCOUNT_ID in the environment either way, since wrangler runs
// non-interactively and cannot ask which account. It never prints the token; a wrangler error it
// passes on may name the account id. Every call names apps/content/wrangler.jsonc as its config,
// which has no account_id, so no wrangler config in a parent directory picks another account.
//
// `lifecycle set` passes --force, which skips wrangler's prompt and R2 Data Catalog's check; the
// bucket has no Data Catalog, and enabling one means revisiting this.
//
// Every lifecycle rule this bucket has lives here. `lifecycle set` replaces the bucket's whole rule
// set, so a rule added any other way (the dashboard, `wrangler r2 bucket lifecycle add`) is deleted
// by the next run: add it to lifecycleRules instead.
//
// The only rule that deletes objects is expire-uploads, on exactly uploads/. Every other lifecycle
// rule only aborts incomplete multipart uploads. The second rule, "Default Multipart Abort Rule",
// mirrors the one Cloudflare gives every new bucket (abort after 7 days, every prefix). It must be
// kept: without it, `lifecycle set` removes the default, and an unfinished multipart upload keeps
// its parts, and their storage bill, for good.
//
// --dry-run prints the rule set, the wrangler commands and the wrangler it would run, and calls
// nothing.
// R2_BUCKET_RULES_WRANGLER, when set, is the wrangler script to run in place of the installed
// one, resolved from the current directory and named on stderr; the tests point it at a stub. It
// runs with the operator's environment, token included, so leave it unset for a real run.
// Exits 0 when the rules are applied and printed (or the dry run printed them), and 2 on a usage
// error or when wrangler fails: missing, unauthenticated, or refused. It is safe to repeat.
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const BUCKET = "rarepair";
const DAY = 86400;

export function lifecycleRules() {
  return {
    rules: [
      {
        id: "expire-uploads",
        enabled: true,
        conditions: { prefix: "uploads/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 7 * DAY } },
      },
      // Cloudflare's default for new buckets, kept: lifecycle set would delete it.
      {
        id: "Default Multipart Abort Rule",
        enabled: true,
        conditions: { prefix: "" },
        abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 7 * DAY } },
      },
    ],
  };
}

const root = fileURLToPath(new URL("..", import.meta.url));

// The wrangler apps/content declares, the workspace that binds the bucket, so the script runs the
// pinned version whether or not npm hoists it to the root. An empty override counts as none.
const wranglerBin = () => {
  const override = process.env.R2_BUCKET_RULES_WRANGLER;
  if (override) {
    const bin = resolve(override);
    console.error(
      `r2-bucket-rules: running R2_BUCKET_RULES_WRANGLER=${bin}, not the installed wrangler`,
    );
    return bin;
  }
  return join(
    dirname(
      createRequire(join(root, "apps/content/package.json")).resolve("wrangler/package.json"),
    ),
    "bin/wrangler.js",
  );
};
const execFileAsync = promisify(execFile);

// Relative to the repo root, where wrangler runs.
const CONFIG = ["--config", "apps/content/wrangler.jsonc"];
const setArgs = (file) => [
  "r2",
  "bucket",
  "lifecycle",
  "set",
  BUCKET,
  "--file",
  file,
  "--force",
  ...CONFIG,
];
const LIST_ARGS = ["r2", "bucket", "lifecycle", "list", BUCKET, ...CONFIG];

async function main(dryRun) {
  const lifecycle = lifecycleRules();
  const bin = wranglerBin();
  if (dryRun) {
    const commands = [setArgs("<lifecycle.json>"), LIST_ARGS].map((args) =>
      ["wrangler", ...args].join(" "),
    );
    console.log(JSON.stringify({ lifecycle, commands, wrangler: bin }, null, 2));
    return 0;
  }
  const wrangler = async (args) =>
    (await execFileAsync(process.execPath, [bin, ...args], { cwd: root, encoding: "utf8" })).stdout;
  const dir = mkdtempSync(join(tmpdir(), "r2-bucket-rules-"));
  try {
    const file = join(dir, "lifecycle.json");
    writeFileSync(file, JSON.stringify(lifecycle));
    await wrangler(setArgs(file));
    console.log(`r2-bucket-rules: set the lifecycle rules on ${BUCKET}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(await wrangler(LIST_ARGS));
  return 0;
}

// Run as a script, not imported by the tests. Both paths are resolved, so a symlinked checkout
// still runs.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
    console.error("usage: node scripts/r2-bucket-rules.mjs [--dry-run]");
    process.exit(2);
  }
  try {
    // exitCode, not exit(), so the printed rules reach a pipe in full.
    process.exitCode = await main(args[0] === "--dry-run");
  } catch (error) {
    console.error(`r2-bucket-rules: failed: ${error.message ?? error}`);
    process.exit(2);
  }
}
