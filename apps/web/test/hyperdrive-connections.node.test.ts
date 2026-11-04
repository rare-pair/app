import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Two Hyperdrive connections (ARCHITECTURE, Connections): HYPERDRIVE is the one with caching off,
// the default for every read; HYPERDRIVE_CACHED is for public pages only. Hyperdrive's cache
// (one minute, from its docs) can't be seen locally: a local Hyperdrive has no cache, so these
// tests read the source and the config. They catch a read that moves to the cached connection
// and a config that drops a binding. They cannot catch a stale read or a binding reached through a helper
// handed `env`, and a trailing comment naming a binding counts as a use, the two ids in wrangler.jsonc
// being the same once they are real, or the caching setting of either deployed config.

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

/** Files in `src` whose code names `binding`, comments aside. */
function filesUsing(srcDir: string, binding: string): string[] {
  const word = new RegExp(`\\b${binding}\\b`);
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => {
      const code = readFileSync(join(srcDir, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      return word.test(code);
    })
    .sort();
}

/** wrangler.jsonc, read with its line comments and trailing commas removed. */
function bindings(rel: string): string[] {
  const text = readFileSync(dir(rel), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/,(\s*[}\]])/g, "$1");
  // SAFETY: only the `hyperdrive` entries' `binding` fields are read, checked by the assertions.
  const c = JSON.parse(text) as { hyperdrive: { binding: string }[] };
  return c.hyperdrive.map((h) => h.binding);
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
    expect(bindings("../wrangler.jsonc")).toEqual(["HYPERDRIVE", "HYPERDRIVE_CACHED"]);
  });

  it("Ingest and the sweep read through the uncached connection alone", () => {
    expect(bindings("../../ingest/wrangler.jsonc")).toEqual(["HYPERDRIVE"]);
    expect(bindings("../../sweep/wrangler.jsonc")).toEqual(["HYPERDRIVE"]);
    expect(filesUsing(dir("../../ingest/src"), "HYPERDRIVE_CACHED")).toEqual([]);
    expect(filesUsing(dir("../../sweep/src"), "HYPERDRIVE_CACHED")).toEqual([]);
  });
});
