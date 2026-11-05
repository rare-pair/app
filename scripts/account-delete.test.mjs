// Tests for scripts/account-delete.mjs's command line and KV client, run with node:test:
// `npm run test:scripts`. The delete itself is tested in packages/db/test/account-delete.test.ts,
// against PGlite. No test calls Cloudflare: the KV client takes its fetch.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { KV_LAG_MS, positionsKv } from "./account-delete.mjs";

const script = fileURLToPath(new URL("account-delete.mjs", import.meta.url));

const FAKE_URL = "postgresql://nobody:not-a-password@127.0.0.1:1/none";
const FULL_ENV = {
  DATABASE_URL: FAKE_URL,
  CLOUDFLARE_ACCOUNT_ID: "test-account",
  CLOUDFLARE_API_TOKEN: "test-not-a-token",
  POSITIONS_NAMESPACE_ID: "test-namespace",
};
const NAMES = Object.keys(FULL_ENV);

// None of the developer's real variables reach the script under test.
const clean = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !NAMES.includes(name)),
);

// Runs the script from an empty directory, so a stray .env file would be found if it read one.
function run(env, args = []) {
  const dir = mkdtempSync(join(tmpdir(), "account-delete-test-"));
  try {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...clean, ...env },
      input: "",
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await test("Secrets only from the environment: with none set it names each variable and exits 2", () => {
  const { code, stdout, stderr } = run({}, ["a@example.test"]);
  assert.equal(code, 2);
  assert.equal(stdout, "");
  for (const name of NAMES) assert.match(stderr, new RegExp(`${name} is not set`));
});

await test("Secrets only from the environment: a database URL given as a flag is refused and never echoed", () => {
  const { code, stdout, stderr } = run(FULL_ENV, ["a@example.test", `--database-url=${FAKE_URL}`]);
  assert.equal(code, 2);
  assert.ok(!stdout.includes("not-a-password") && !stderr.includes("not-a-password"));
});

await test("The address comes from the arguments: none, two or one that isn't an address exit 2", () => {
  for (const args of [[], ["a@example.test", "b@example.test"], ["not-an-address"]]) {
    const { code, stdout } = run(FULL_ENV, args);
    assert.equal(code, 2, args.join(" "));
    assert.equal(stdout, "");
  }
});

await test("An unreachable database exits 1 and prints a code, never the URL", () => {
  const { code, stdout, stderr } = run(FULL_ENV, ["a@example.test"]);
  assert.equal(code, 1);
  assert.match(stderr, /database error \(\w+\)/);
  assert.ok(!stdout.includes("not-a-password") && !stderr.includes("not-a-password"));
});

await test("The wait outlasts KV's list lag, which Cloudflare gives as up to 60 seconds", () => {
  assert.ok(KV_LAG_MS > 60_000);
});

/** A fetch that answers from `replies` in order and keeps each call. */
function recording(replies) {
  const calls = [];
  const doFetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const { status = 200, body } = replies.shift();
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, doFetch };
}

const kvWith = (doFetch) =>
  positionsKv({
    accountId: "acct",
    apiToken: "test-not-a-token",
    namespaceId: "ns",
    fetch: doFetch,
  });

const BASE = "https://api.cloudflare.com/client/v4/accounts/acct/storage/kv/namespaces/ns";

await test("Listing keys follows the cursor until it runs out, with the prefix on every page", async () => {
  const { calls, doFetch } = recording([
    {
      body: {
        success: true,
        result: [{ name: "pos:u:1" }, { name: "pos:u:2" }],
        result_info: { count: 2, cursor: "next-page" },
      },
    },
    // An empty page with a cursor is not the end.
    { body: { success: true, result: [], result_info: { count: 0, cursor: "last-page" } } },
    {
      body: {
        success: true,
        result: [{ name: "pos:u:3" }],
        result_info: { count: 1, cursor: "" },
      },
    },
  ]);

  const keys = await kvWith(doFetch).listKeys("pos:u:");

  assert.deepEqual(keys, ["pos:u:1", "pos:u:2", "pos:u:3"]);
  assert.equal(calls.length, 3);
  assert.equal(`${calls[0].url.origin}${calls[0].url.pathname}`, `${BASE}/keys`);
  assert.equal(calls[0].url.searchParams.get("prefix"), "pos:u:");
  assert.equal(calls[0].url.searchParams.has("cursor"), false);
  assert.equal(calls[1].url.searchParams.get("cursor"), "next-page");
  assert.equal(calls[2].url.searchParams.get("cursor"), "last-page");
  assert.equal(calls[2].url.searchParams.get("prefix"), "pos:u:");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-not-a-token");
});

await test("Deleting keys posts at most 10,000 names a call", async () => {
  const ok = { body: { success: true, result: { successful_key_count: 1 } } };
  const { calls, doFetch } = recording([ok, ok]);
  const keys = Array.from({ length: 10_001 }, (_, i) => `pos:u:${i}`);

  await kvWith(doFetch).deleteKeys(keys);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.href, `${BASE}/bulk/delete`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(JSON.parse(calls[0].init.body).length, 10_000);
  assert.deepEqual(JSON.parse(calls[1].init.body), ["pos:u:10000"]);
});

await test("Deleting no keys makes no call", async () => {
  const { calls, doFetch } = recording([]);
  await kvWith(doFetch).deleteKeys([]);
  assert.equal(calls.length, 0);
});

await test("A key Cloudflare could not delete is a failure", async () => {
  const { doFetch } = recording([
    {
      body: {
        success: true,
        result: { successful_key_count: 0, unsuccessful_keys: ["pos:u:1"] },
      },
    },
  ]);
  await assert.rejects(kvWith(doFetch).deleteKeys(["pos:u:1"]), (error) => {
    assert.match(error.message, /KV/);
    assert.ok(!error.message.includes("pos:u:1"));
    return true;
  });
});

await test("A refused call reports its status and Cloudflare's code, not the token or the key", async () => {
  const { doFetch } = recording([
    {
      status: 403,
      body: { success: false, errors: [{ code: 10_000, message: "pos:u: test-not-a-token" }] },
    },
  ]);
  await assert.rejects(kvWith(doFetch).listKeys("pos:u:"), (error) => {
    assert.match(error.message, /403/);
    assert.match(error.message, /10000/);
    assert.ok(!error.message.includes("test-not-a-token"));
    assert.ok(!error.message.includes("pos:u:"));
    return true;
  });
});

await test("A network failure reports a code, not the raw error", async () => {
  const doFetch = async () => {
    throw Object.assign(new Error("https://token@example.invalid"), { code: "ECONNRESET" });
  };
  await assert.rejects(kvWith(doFetch).listKeys("pos:u:"), (error) => {
    assert.match(error.message, /ECONNRESET/);
    assert.ok(!error.message.includes("example.invalid"));
    return true;
  });
});
