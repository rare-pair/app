import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";
import type { Expected } from "./expected";

// Workers tests have no filesystem, so fixtures are read here in Node and handed
// over as base64. Two folders feed the same tests: the committed synthetic ones
// (scripts/synthetic-fixtures.ts writes them) and the local, git-ignored real ones.
// A missing or empty directory provides nothing.
const FIXTURE_DIRS = ["../../../fixtures/epubs/synthetic/", "../../../fixtures/epubs/"].map((dir) =>
  fileURLToPath(new URL(dir, import.meta.url)),
);

function readDir(
  dir: string,
  fixtures: Record<string, string>,
  expected: Record<string, Expected>,
): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".epub"));
  } catch {
    names = [];
  }
  for (const name of names.sort()) {
    if (name in fixtures) throw new Error(`fixture ${name} is in more than one folder`);
    fixtures[name] = readFileSync(join(dir, name)).toString("base64");
  }
  let text: string | null = null;
  try {
    text = readFileSync(join(dir, "expected.json"), "utf8");
  } catch (error) {
    // Only a missing file means "no expected values"; anything else fails the run.
    // SAFETY: readFileSync throws a Node system error, which carries a code.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text === null) return;
  // SAFETY: a file shaped like expected.example.json. A malformed file throws here
  // (JSON.parse) instead of silently skipping the checks.
  const entries = JSON.parse(text) as Record<string, Expected>;
  Object.assign(expected, entries);
}

export default function setup(project: TestProject): void {
  const fixtures: Record<string, string> = {};
  const expected: Record<string, Expected> = {};
  const [synthetic, ...real] = FIXTURE_DIRS;
  readDir(synthetic!, fixtures, expected);
  // Synthetic output holds no fanwork text, so those fixtures are snapshotted too.
  project.provide("epubSyntheticNames", Object.keys(fixtures));
  for (const dir of real) readDir(dir, fixtures, expected);
  project.provide("epubFixtures", fixtures);
  project.provide("epubExpected", expected);
}
