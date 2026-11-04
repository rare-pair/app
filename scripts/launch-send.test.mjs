// Tests for scripts/launch-send.mjs's command line, run with node:test: `npm run test:scripts`.
// The send itself is tested in packages/db/test/launch-send.test.ts, against PGlite.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("launch-send.mjs", import.meta.url));
const NAMES = [
  "DATABASE_URL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "EMAIL_BULK_QUEUE_ID",
];

// None of the developer's real variables reach the script under test.
const clean = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith("CLOUDFLARE_") && !NAMES.includes(name),
  ),
);

// Runs the script from an empty directory, so a stray .env file would be found if it read one.
function run(env) {
  const dir = mkdtempSync(join(tmpdir(), "launch-send-test-"));
  try {
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      env: { ...clean, ...env },
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await test("Secrets only from the environment: with none set it names each variable and exits 2", () => {
  const { code, stdout, stderr } = run({});
  assert.equal(code, 2);
  assert.equal(stdout, "");
  for (const name of NAMES) assert.match(stderr, new RegExp(`${name} is not set`));
});

await test("Secrets only from the environment: one missing variable is the only one named, never a value", () => {
  const secrets = {
    DATABASE_URL: "postgresql://nobody:not-a-password@127.0.0.1:1/none",
    CLOUDFLARE_ACCOUNT_ID: "not-an-account",
    CLOUDFLARE_API_TOKEN: "not-a-token",
  };
  const { code, stdout, stderr } = run(secrets);
  assert.equal(code, 2);
  assert.match(stderr, /EMAIL_BULK_QUEUE_ID is not set/);
  assert.doesNotMatch(stderr, /(DATABASE_URL|CLOUDFLARE_\w+) is not set/);
  for (const value of Object.values(secrets)) {
    assert.ok(!stdout.includes(value) && !stderr.includes(value));
  }
});
