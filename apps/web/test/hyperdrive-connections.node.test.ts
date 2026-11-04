import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Two Hyperdrive connections (ARCHITECTURE, Connections): HYPERDRIVE is the one with caching off,
// the default for every read; HYPERDRIVE_CACHED is for public pages only. Hyperdrive's cache
// (one minute, from its docs) can't be seen locally: a local Hyperdrive has no cache, so these
// tests read the source and the config. They catch a read that moves to the cached connection
// and a config that drops a binding or gives both the same id. They cannot catch a stale read, a
// binding reached through a helper that is handed `env`, or the real ids: whether the two
// deployed configs differ, and which has caching on.

/** The public pages that read through the cached connection, and nothing else does. */
const CACHED_READERS = [
  "full.ts",
  "home.ts",
  "listing.ts",
  "reader.ts",
  "search.ts",
  "warnings.ts",
  "work-page.ts",
];

const dir = (rel: string) => join(import.meta.dirname, rel);

/** Files under `srcDir` with an identifier `binding`: comments and strings don't count. */
function filesUsing(srcDir: string, binding: string): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => {
      const file = ts.createSourceFile(
        f,
        readFileSync(join(srcDir, f), "utf8"),
        ts.ScriptTarget.Latest,
      );
      const names = (node: ts.Node): boolean =>
        (ts.isIdentifier(node) && node.text === binding) || ts.forEachChild(node, names) === true;
      return names(file);
    })
    .sort();
}

/** wrangler.jsonc, read with its line comments and trailing commas removed. */
function hyperdrives(rel: string): { binding: string; id: string }[] {
  const text = readFileSync(dir(rel), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  // SAFETY: only the `hyperdrive` entries' `binding` fields are read, checked by the assertions.
  const c = JSON.parse(text) as { hyperdrive: { binding: string; id: string }[] };
  return c.hyperdrive;
}

describe("Hyperdrive connections", () => {
  it("Only public pages read through the cached connection", () => {
    expect(filesUsing(dir("../src"), "HYPERDRIVE_CACHED").filter((f) => f !== "env.ts")).toEqual(
      CACHED_READERS,
    );
  });

  it("A public page does not read through the uncached connection", () => {
    // Each of these reads once, on the cached binding: a second read on the other one would
    // be a page that mixes the two views of the database.
    const uncached = filesUsing(dir("../src"), "HYPERDRIVE");
    expect(uncached.filter((f) => CACHED_READERS.includes(f))).toEqual([]);
  });

  it("The web Worker has both bindings, under different names", () => {
    const configs = hyperdrives("../wrangler.jsonc");
    expect(configs.map((h) => h.binding)).toEqual(["HYPERDRIVE", "HYPERDRIVE_CACHED"]);
    // Once real, the ids are the operator's to keep apart (ARCHITECTURE, Connections); the
    // placeholders at least start different.
    expect(new Set(configs.map((h) => h.id)).size).toBe(2);
  });

  it("Ingest, the sweep and the content Worker read through the uncached connection alone", () => {
    expect(hyperdrives("../../ingest/wrangler.jsonc").map((h) => h.binding)).toEqual([
      "HYPERDRIVE",
    ]);
    expect(hyperdrives("../../sweep/wrangler.jsonc").map((h) => h.binding)).toEqual(["HYPERDRIVE"]);
    expect(filesUsing(dir("../../ingest/src"), "HYPERDRIVE_CACHED")).toEqual([]);
    expect(filesUsing(dir("../../sweep/src"), "HYPERDRIVE_CACHED")).toEqual([]);
    expect(hyperdrives("../../content/wrangler.jsonc").map((h) => h.binding)).toEqual([
      "HYPERDRIVE",
    ]);
    expect(filesUsing(dir("../../content/src"), "HYPERDRIVE_CACHED")).toEqual([]);
  });
});
