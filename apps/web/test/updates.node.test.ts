import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { latestUpdates, newestFirst, UPDATES, type Update } from "../src/updates-data";

const update = (slug: string, created: string): Update => ({
  slug,
  title: slug,
  summary: slug,
  author: "admin",
  created,
  body: "<p>x</p>",
});

const decode = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

/** A post body's words and link addresses, in order. */
const htmlWords = (html: string) =>
  decode(html.replace(/<a href="([^"]*)">([^<]*)<\/a>/g, "$2 $1 ").replace(/<[^>]*>/g, " "))
    .split(/\s+/)
    .filter(Boolean);

/** The release notes below their title line, as words and link addresses, in order. */
const notesWords = (markdown: string) =>
  markdown
    .split(/\r?\n/)
    .slice(1)
    .join("\n")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1 $2 ")
    .replace(/\*\*/g, "")
    .replace(/^(#+|-)\s/gm, "")
    .split(/\s+/)
    .filter(Boolean);

describe("25-updates: the first update", () => {
  it("The first update's text is the operator's own", () => {
    const notes = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "docs", "release-notes", "v0.1.0.md"),
      "utf8",
    );
    const post = UPDATES.find((u) => u.slug === "release-0-1-0-chuhura");
    expect(post).toBeDefined();
    expect(htmlWords(post?.body ?? "")).toEqual(notesWords(notes));
    // Spot checks, so a reduction that dropped the typos too would still fail.
    expect(post?.body).toContain("It is open source I highly recommend plopping");
    expect(post?.body).toContain("🤝 Some promises,");
    expect(post?.body).not.toContain("Draft:");
  });

  it("The first update has the fields the spec gives", () => {
    expect(UPDATES.find((u) => u.slug === "release-0-1-0-chuhura")).toMatchObject({
      title: 'rarepair v0.1.0 "Chuhura"',
      summary:
        "rarepair is open. It is a temporary, community-run reading archive for fanworks while the original archive is offline.",
      author: "admin and 🤖",
      created: "2026-11-06",
    });
  });
});

describe("25-updates: the second update", () => {
  it("The second update's text matches the release notes", () => {
    const notes = readFileSync(
      join(import.meta.dirname, "..", "..", "..", "docs", "release-notes", "v0.2.0.md"),
      "utf8",
    );
    const post = UPDATES.find((u) => u.slug === "release-0-2-0-mothership");
    expect(post).toBeDefined();
    expect(htmlWords(post?.body ?? "")).toEqual(notesWords(notes));
    expect(post?.body).toContain("https://discord.gg/538ME6Jabu");
    expect(post?.body).toContain("Some quality of life updates");
  });

  it("The second update has the required fields", () => {
    expect(UPDATES.find((u) => u.slug === "release-0-2-0-mothership")).toMatchObject({
      title: 'rarepair v0.2.0 "Mothership"',
      summary:
        "Uploading many works is much easier now. You can drop a whole folder's worth of epubs, or a zip of them, onto the upload page.",
      author: "admin and 🤖",
      created: "2026-11-07",
    });
  });
});

describe("25-updates: the list", () => {
  it("Every update in the real list is complete", () => {
    expect(UPDATES.length).toBeGreaterThan(0);
    const slugs = new Set<string>();
    for (const u of UPDATES) {
      for (const field of ["slug", "title", "summary", "author", "created", "body"] as const) {
        expect(u[field].trim(), `${u.slug}: ${field}`).not.toBe("");
      }
      expect(u.slug, `${u.slug}: slug`).toMatch(/^[a-z0-9-]+$/);
      expect(slugs.has(u.slug), `${u.slug}: repeated`).toBe(false);
      slugs.add(u.slug);
      expect(u.created, `${u.slug}: created`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${u.created}T00:00:00Z`).toISOString().slice(0, 10), u.slug).toBe(u.created);
    }
  });

  it("The home page shows the latest updates, newest first", () => {
    const a = update("a", "2026-01-01");
    const b = update("b", "2026-01-02");
    const c = update("c", "2026-01-03");
    const d = update("d", "2026-01-04");
    expect(latestUpdates([a, b, c, d]).map((u) => u.slug)).toEqual(["d", "c", "b"]);
  });

  it("Two updates on one day", () => {
    const first = update("first", "2026-01-02");
    const later = update("later", "2026-01-02");
    const old = update("old", "2026-01-01");
    for (let i = 0; i < 3; i++) {
      expect(newestFirst([old, first, later]).map((u) => u.slug)).toEqual([
        "later",
        "first",
        "old",
      ]);
    }
  });
});
