// Tests for scripts/waitlist-purge.mjs's command line, run with node:test: `npm run test:scripts`.
// The purge itself is tested in packages/db/test/waitlist-purge.test.ts, against PGlite.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("waitlist-purge.mjs", import.meta.url));

// None of the developer's real variables reach the script under test.
const clean = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== "DATABASE_URL"),
);

// Runs the script from an empty directory, so a stray .env file would be found if it read one.
function run(env, args = []) {
  const dir = mkdtempSync(join(tmpdir(), "waitlist-purge-test-"));
  try {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...clean, ...env },
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await test("Secrets only from the environment: with none set it names DATABASE_URL and exits 2", () => {
  const { code, stdout, stderr } = run({});
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /DATABASE_URL is not set/);
});

await test("Secrets only from the environment: a database URL given as a flag is refused and never echoed", () => {
  const url = "postgresql://nobody:not-a-password@127.0.0.1:1/none";
  const { code, stdout, stderr } = run({}, [`--database-url=${url}`]);
  assert.equal(code, 2);
  assert.ok(!stdout.includes(url) && !stderr.includes(url));
  assert.ok(!stderr.includes("not-a-password"));
});

await test("An unreachable database exits 1 and prints a code, never the URL", () => {
  const url = "postgresql://nobody:not-a-password@127.0.0.1:1/none";
  const { code, stdout, stderr } = run({ DATABASE_URL: url }, ["--force"]);
  assert.equal(code, 1);
  assert.match(stderr, /database error \(\w+\)/);
  assert.ok(!stdout.includes("not-a-password") && !stderr.includes("not-a-password"));
});
