// Tests for scripts/r2-bucket-rules.mjs, run with node:test: `npm run test:scripts`. Each
// scenario file is a top-level test and each case a subtest, awaited, as node:test's promises ask.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lifecycleRules } from "./r2-bucket-rules.mjs";

const script = fileURLToPath(new URL("r2-bucket-rules.mjs", import.meta.url));
const stub = fileURLToPath(new URL("test/wrangler-stub.mjs", import.meta.url));
const root = dirname(dirname(script));

// None of the developer's Cloudflare credentials reach the script under test: the CLOUDFLARE_
// variables are dropped, and a token that is not one takes wrangler's place before any
// `wrangler login` on disk. A regression that drops the stub fails to authenticate instead of
// changing a real bucket.
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("CLOUDFLARE_")),
  ),
  CLOUDFLARE_API_TOKEN: "not-a-cloudflare-token",
};

// Runs the script with the stub as its wrangler (or with `wrangler` as the override, "" for none;
// `relative` passes the stub's path relative to the directory it runs in). The stub fails a call
// whose arguments start with `fail`. Returns the exit code, the output, and each call the stub
// saw, in order.
function run(args = [], { fail = "", wrangler = stub, relative: rel = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "r2-bucket-rules-test-"));
  const override = rel ? relative(dir, stub) : wrangler;
  const log = join(dir, "calls.jsonl");
  writeFileSync(log, "");
  try {
    // From outside the repo, as an operator in any directory would run it.
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...env, R2_BUCKET_RULES_WRANGLER: override, STUB_LOG: log, STUB_FAIL: fail },
    });
    const calls = readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The scenarios' THEN, as a rule: everything under uploads/ expires 604800 s (7 days) after it was
// written. R2 then deletes it, typically within 24 hours; the scenarios hold at the rule level.
const expireUploads = {
  id: "expire-uploads",
  enabled: true,
  conditions: { prefix: "uploads/" },
  deleteObjectsTransition: { condition: { type: "Age", maxAge: 604800 } },
};

// The rule R2 gives a new bucket, which a lifecycle set would otherwise delete: abort incomplete
// multipart uploads, on every prefix, 7 days after they start.
const defaultMultipartAbort = {
  id: "Default Multipart Abort Rule",
  enabled: true,
  conditions: { prefix: "" },
  abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } },
};

// The keys of a rule that only aborts incomplete multipart uploads: no delete or transition.
const abortOnly = ["abortMultipartUploadsTransition", "conditions", "enabled", "id"];

const appliedLifecycle = () => {
  const { code, calls } = run();
  assert.equal(code, 0);
  return fileFor(calls, "r2 bucket lifecycle set rarepair");
};

const fileFor = (calls, command) =>
  calls.find((call) => call.args.join(" ").startsWith(command))?.file;

await test("02-upload-handshake", async (t) => {
  await t.test("Confirm is never called", () => {
    const { rules } = appliedLifecycle();
    assert.deepEqual(
      rules.find((rule) => rule.id === "expire-uploads"),
      expireUploads,
    );
  });
});

// Every call names apps/content's config, the one that binds the bucket, so wrangler finds no
// other config (with an account_id that would beat CLOUDFLARE_ACCOUNT_ID) in a parent directory.
const config = ["--config", "apps/content/wrangler.jsonc"];
const lifecycle = ["r2", "bucket", "lifecycle"];

await test("Applying the bucket rules", async (t) => {
  await t.test("Replaces the lifecycle rules, then prints the bucket's current ones", () => {
    const { code, stdout, calls } = run();
    assert.equal(code, 0);
    assert.deepEqual(
      calls.map(({ args }) => args.map((arg, i) => (args[i - 1] === "--file" ? "<file>" : arg))),
      [
        [...lifecycle, "set", "rarepair", "--file", "<file>", "--force", ...config],
        [...lifecycle, "list", "rarepair", ...config],
      ],
    );
    assert.match(stdout, /stub ran: r2 bucket lifecycle list rarepair/);
    // From the repo root, so no app's wrangler config, wherever the operator stands, picks the
    // account or breaks the run.
    for (const call of calls) assert.equal(call.cwd, root);
  });
});

await test("A dry run", async (t) => {
  await t.test("Prints the rule set and the commands, and calls nothing", () => {
    const { code, stdout, calls } = run(["--dry-run"]);
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    const printed = JSON.parse(stdout);
    assert.deepEqual(printed.lifecycle, lifecycleRules());
    assert.deepEqual(printed.commands, [
      "wrangler r2 bucket lifecycle set rarepair --file <lifecycle.json> --force --config apps/content/wrangler.jsonc",
      "wrangler r2 bucket lifecycle list rarepair --config apps/content/wrangler.jsonc",
    ]);
  });
});

await test("The bucket's lifecycle rules", async (t) => {
  const { rules } = appliedLifecycle();

  await t.test("Keep R2's default multipart abort rule", () => {
    assert.deepEqual(rules, [expireUploads, defaultMultipartAbort]);
  });

  await t.test("Only expire-uploads deletes objects", () => {
    const deleting = rules.filter((rule) => Object.keys(rule).some((k) => !abortOnly.includes(k)));
    assert.deepEqual(
      deleting.map((rule) => rule.id),
      ["expire-uploads"],
    );
  });

  await t.test("Every other rule only aborts incomplete multipart uploads", () => {
    const others = rules.filter((rule) => rule.id !== "expire-uploads");
    for (const rule of others) assert.deepEqual(Object.keys(rule).toSorted(), abortOnly);
  });

  await t.test("expire-uploads expires exactly uploads/", () => {
    const rule = rules.find((r) => r.id === "expire-uploads");
    assert.equal(rule?.conditions.prefix, "uploads/");
  });
});

await test("A usage error", async (t) => {
  await t.test("Exits 2 on an unknown argument and calls nothing", () => {
    const { code, stderr, calls } = run(["--bucket", "other"]);
    assert.equal(code, 2);
    assert.match(stderr, /usage: node scripts\/r2-bucket-rules\.mjs \[--dry-run\]/);
    assert.equal(calls.length, 0);
  });
});

await test("When wrangler fails", async (t) => {
  await t.test("Exits 2 with wrangler's error and runs nothing after it", () => {
    const { code, stdout, stderr, calls } = run([], { fail: "r2 bucket lifecycle set" });
    assert.equal(code, 2);
    assert.match(stderr, /stub: r2 bucket lifecycle set failed/);
    assert.doesNotMatch(stdout, /set the lifecycle rules/);
    assert.equal(calls.length, 1);
  });

  await t.test("Leaves no rule file", () => {
    const { calls } = run([], { fail: "r2 bucket lifecycle set" });
    for (const { args } of calls) assert.equal(existsSync(args[args.indexOf("--file") + 1]), false);
  });
});

await test("The installed wrangler", async (t) => {
  await t.test("Is the one apps/content pins, when no override is set", () => {
    const { code, stdout } = run(["--dry-run"], { wrangler: "" });
    assert.equal(code, 0);
    const { wrangler } = JSON.parse(stdout);
    assert.ok(existsSync(wrangler), wrangler);
    const manifest = join(dirname(dirname(wrangler)), "package.json");
    const pinned = JSON.parse(readFileSync(join(root, "apps/content/package.json"), "utf8"))
      .devDependencies.wrangler;
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).version, pinned);
  });
});

await test("An overridden wrangler", async (t) => {
  await t.test("Is resolved from where the operator stands, and named on stderr", () => {
    const { code, stderr, calls } = run([], { relative: true });
    assert.equal(code, 0);
    assert.equal(calls.length, 2);
    assert.ok(stderr.includes(stub), stderr);
  });
});

await test("The bucket", async (t) => {
  await t.test("Is the one apps/content binds", () => {
    const config = readFileSync(join(root, "apps/content/wrangler.jsonc"), "utf8");
    assert.match(config, /"binding": "BUCKET", "bucket_name": "rarepair"/);
    assert.ok(fileFor(run().calls, "r2 bucket lifecycle set rarepair"));
  });
});

await test("19-surge-controls-and-quotas", async (t) => {
  await t.test("Abandoned uploads expire", () => {
    const { rules } = appliedLifecycle();
    assert.deepEqual(
      rules.find((rule) => rule.id === "expire-uploads"),
      expireUploads,
    );
  });
});
