import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../src/auth";
import { nonceOf } from "./helpers";
import { forms, links, NoJsBrowser } from "./no-js-browser";

// One database serves every test file in the run, so this file keeps to AO3 work IDs
// 40800 to 40899, names every tag it seeds with a "nojs-" prefix and every email with
// "nojs-". Text is synthetic.
const GENERAL = 40800; // live, General Audiences, three chapters
const WARNED = 40801; // live, Mature: the warnings screen comes first
const HIDDEN = 40802;
const REMOVED = 40803;
const IMPERFECT = 40804; // live, with a review reason: the "may be imperfect" notice

const NO_WARNINGS = { type: "warning" as const, name: "No Archive Warnings Apply" };
const rated = (name: string) => ({ type: "rating" as const, name });
const FANDOM = { type: "fandom" as const, name: "nojs-Fandom" };
const FREEFORM = { type: "freeform" as const, name: "nojs-Freeform" };

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

beforeAll(async () => {
  const works = [
    { ao3WorkId: GENERAL, rating: "General Audiences", chapters: 3 },
    { ao3WorkId: WARNED, rating: "Mature", chapters: 2 },
    { ao3WorkId: HIDDEN, rating: "General Audiences", chapters: 2, status: "hidden" as const },
    { ao3WorkId: REMOVED, rating: "General Audiences", chapters: 2, status: "removed" as const },
    {
      ao3WorkId: IMPERFECT,
      rating: "General Audiences",
      chapters: 2,
      reviewReasons: ["missing_summary"],
    },
  ];
  for (const { chapters, rating, status, ...rest } of works) {
    const w = await seedWork(db, {
      ...rest,
      rating,
      status,
      ...(status === "hidden" ? { hiddenCause: "moderator" as const } : {}),
      title: `nojs work ${rest.ao3WorkId}`,
      tags: [rated(rating), NO_WARNINGS, FANDOM, FREEFORM],
      authors: [{ pseud: "nojs-pseud", ao3_user: "nojs-user" }],
      summary: "<p>nojs-summary</p>",
      chapters: Array.from({ length: chapters }, (_, i) => ({
        title: `nojs chapter ${i + 1}`,
        html: `<p>nojs-${rest.ao3WorkId}-${i + 1}</p>`,
      })),
    });
    await putFragments(env.BUCKET, w.fragments);
  }
});

describe("01-auth-magic-link", () => {
  it("Reading needs no account", async () => {
    const visitor = new NoJsBrowser();

    const home = await visitor.go("/");
    expect(home.res.status).toBe(200);
    expect(forms(home.html).map((f) => f.action)).not.toContain("/login");
    expect(home.html).not.toContain('name="email"');

    const work = await visitor.go(`/works/${GENERAL}`);
    expect(work.res.status).toBe(200);
    expect(work.html).toContain(`nojs work ${GENERAL}`);

    const first = links(work.html).find((l) => l.href === `/works/${GENERAL}/chapters/1`);
    expect(first, "the work page links to its first chapter").toBeDefined();
    const chapter = await visitor.click(work, first!.href);
    expect(chapter.res.status).toBe(200);
    expect(chapter.path).toBe(`/works/${GENERAL}/chapters/1`);
    expect(chapter.html).toContain(`nojs-${GENERAL}-1`);

    // No page asked them to sign in, and none gave them a session.
    expect(visitor.visited.some((p) => p.startsWith("/login"))).toBe(false);
    expect(visitor.cookies.has(SESSION_COOKIE)).toBe(false);
    for (const page of [home, work, chapter]) {
      expect(page.res.headers.getSetCookie().join("\n")).not.toContain(SESSION_COOKIE);
      expect(nonceOf(page.res.headers.get("content-security-policy"))).not.toBeNull();
    }
  });

  it("A warned work's first page is its warnings screen, which needs no account either", async () => {
    const visitor = new NoJsBrowser();
    const screen = await visitor.go(`/works/${WARNED}/chapters/1`);
    expect(screen.path).toBe(`/works/${WARNED}/warnings?next=${encodeURIComponent(`/works/${WARNED}/chapters/1`)}`);
    expect(screen.res.status).toBe(200);

    const [form] = forms(screen.html);
    const chapter = await visitor.submit(screen, form!);
    expect(chapter.path).toBe(`/works/${WARNED}/chapters/1`);
    expect(chapter.res.status).toBe(200);
    expect(chapter.html).toContain(`nojs-${WARNED}-1`);
    expect(visitor.visited.some((p) => p.startsWith("/login"))).toBe(false);
    expect(visitor.cookies.has(SESSION_COOKIE)).toBe(false);
  });
});
