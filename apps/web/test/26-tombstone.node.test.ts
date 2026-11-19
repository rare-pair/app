import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// wrangler.jsonc without its comments and trailing commas: strings are kept whole, so a `//`
// inside one survives.
function readVars(app: "web" | "content"): { TOMBSTONE?: string } {
  const text = readFileSync(join(import.meta.dirname, "..", "..", app, "wrangler.jsonc"), "utf8");
  const json = text
    .replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? m : ""))
    .replace(/,(\s*[}\]])/g, "$1");
  // SAFETY: the test reads only `vars.TOMBSTONE`, from the file's own JSON.
  return (JSON.parse(json) as { vars?: { TOMBSTONE?: string } }).vars ?? {};
}

describe("26-tombstone", () => {
  it("Both public Workers deploy closed for good", () => {
    expect(readVars("web").TOMBSTONE).toBe("on");
    expect(readVars("content").TOMBSTONE).toBe("on");
  });
});
