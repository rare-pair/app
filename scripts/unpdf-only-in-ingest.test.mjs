// Spec 12, "The web and content Workers stay small": unpdf is only in the ingest Worker. Reads
// package manifests and sources; the built bundles get the same check in /gate's build step when
// a `dist` folder is there.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..");
const WORKSPACES = [
  ...readdirSync(join(ROOT, "apps")).map((name) => join("apps", name)),
  ...readdirSync(join(ROOT, "packages")).map((name) => join("packages", name)),
];

/** Every TypeScript file under `dir`, skipping what's installed or built. */
function sources(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".wrangler") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sources(path));
    else if (path.endsWith(".ts")) found.push(path);
  }
  return found;
}

describe("12-pdf-upload", () => {
  it("The web and content Workers stay small: only the ingest Worker depends on unpdf", () => {
    for (const workspace of WORKSPACES) {
      const manifest = join(ROOT, workspace, "package.json");
      if (!existsSync(manifest)) continue;
      const { dependencies = {}, devDependencies = {} } = JSON.parse(readFileSync(manifest, "utf8"));
      const version = dependencies.unpdf ?? devDependencies.unpdf;
      if (workspace === join("apps", "ingest")) assert.equal(version, "0.12.1");
      else assert.equal(version, undefined, workspace);
    }
  });

  it("The web and content Workers stay small: one ingest module imports it, by import()", () => {
    const importers = [];
    for (const workspace of WORKSPACES) {
      const src = join(ROOT, workspace, "src");
      if (!existsSync(src)) continue;
      for (const path of sources(src)) {
        if (/from "unpdf|import\("unpdf/.test(readFileSync(path, "utf8"))) importers.push(path);
      }
    }
    assert.deepEqual(importers, [join(ROOT, "apps", "ingest", "src", "pdf", "parser.ts")]);
    const worker = readFileSync(join(ROOT, "apps", "ingest", "src", "worker.ts"), "utf8");
    assert.match(worker, /await import\("\.\/pdf\/parser"\)/);
    assert.doesNotMatch(worker, /from "\.\/pdf\/parser"/);
  });
});
