import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, fetchW, signIn } from "./helpers";

// This file keeps to AO3 work IDs 8813500 to 8813599, and tags named adultmark-.... Text is
// synthetic.
const G = 8813501; // General, no warnings: only a mark gives it the screen
const R = 8813502; // General, for the report cases
const K = 8813503; // General, marked and unmarked by the moderator
const LINE = "A moderator marked this work as adult.";
const TAGS = [
  { type: "rating", name: "General Audiences" },
  { type: "warning", name: "No Archive Warnings Apply" },
  { type: "fandom", name: "adultmark-Fandom" },
] as const;

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

beforeAll(async () => {
  for (const ao3WorkId of [G, R, K]) {
    const w = await seedWork(db, {
      ao3WorkId,
      title: `adultmark work ${ao3WorkId}`,
      rating: "General Audiences",
      tags: [...TAGS],
      chapters: [{ html: `<p>adultmark-${ao3WorkId}-1</p>` }],
    });
    await putFragments(env.BUCKET, w.fragments);
  }
});
afterAll(() => db.destroy());

const FORM = {
  origin: BASE,
  "sec-fetch-site": "same-origin",
  "content-type": "application/x-www-form-urlencoded",
};

const post = (path: string, cookie: string | undefined, fields: Record<string, string> = {}) =>
  fetchW(path, {
    method: "POST",
    headers: cookie === undefined ? FORM : { ...FORM, cookie },
    body: new URLSearchParams(fields).toString(),
  });

const moderatorCookie = async (email: string) => {
  const cookie = await signIn(email, { acceptTerms: true });
  await db.updateTable("user").set({ role: "moderator" }).where("email", "=", email).execute();
  return cookie;
};

const stateOf = (ao3WorkId: number) =>
  db
    .selectFrom("works")
    .select(["status", "rating", "adult_marked"])
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirstOrThrow();

const reportsOf = (ao3WorkId: number) =>
  db
    .selectFrom("reports")
    .innerJoin("works", "works.id", "reports.work_id")
    .select(["reports.kind", "reports.status"])
    .where("works.ao3_work_id", "=", ao3WorkId)
    .execute();

const cardOf = (html: string, ao3WorkId: number) =>
  html.split("<article").find((part) => part.includes(`href="/works/${ao3WorkId}"`)) ?? "";

describe("17-reports-and-dmca", () => {
  it("A reader reports that a work needs a higher rating", async () => {
    const reader = await signIn("adultmark-reader@example.test", { acceptTerms: true });
    const form = await (await fetchW(`/works/${R}/report`, { headers: { cookie: reader } })).text();
    expect(form).toContain(
      '<label><input type="radio" name="reason" value="higher_rating"> This needs a higher rating</label>',
    );

    const res = await post(`/works/${R}/report`, reader, { reason: "higher_rating" });
    expect(res.status).toBe(200);

    expect(await reportsOf(R)).toEqual([{ kind: "higher_rating", status: "open" }]);
    // Nothing about the work changes by itself.
    expect(await stateOf(R)).toEqual({
      status: "live",
      rating: "General Audiences",
      adult_marked: false,
    });
  });

  it("A needs-a-higher-rating report is listed in the Reports queue", async () => {
    const moderator = await moderatorCookie("adultmark-mod-queue@example.test");
    const queue = await (await fetchW("/admin/reports", { headers: { cookie: moderator } })).text();
    expect(queue).toContain(`(${R})`);
    expect(queue).toContain("higher_rating");
  });

  it("Needs-a-higher-rating reports never count toward hiding", async () => {
    for (const n of [1, 2, 3]) {
      const cookie = await signIn(`adultmark-three-${n}@example.test`, { acceptTerms: true });
      expect((await post(`/works/${R}/report`, cookie, { reason: "higher_rating" })).status).toBe(
        200,
      );
    }
    expect((await stateOf(R)).status).toBe("live");
  });
});

describe("18-moderation", () => {
  it("A moderator marks a work as adult", async () => {
    const moderator = await moderatorCookie("adultmark-mod@example.test");
    const reader = await signIn("adultmark-reporter-k@example.test", { acceptTerms: true });
    await post(`/works/${K}/report`, reader, { reason: "higher_rating" });
    const page = await (
      await fetchW(`/admin/works/${K}`, { headers: { cookie: moderator } })
    ).text();
    expect(page).toContain(`action="/admin/works/${K}/adult"`);
    expect(page).toContain(">Mark as adult<");
    expect(page).toContain(`action="/admin/works/${K}/adult/remove"`);
    expect(page).toContain(">Remove the adult mark<");
    // Before the mark, the work opens straight away. (A reader with a settings cookie skips the
    // 60 s edge cache, so this read leaves no page behind for the cases below.)
    const open = await fetchW(`/works/${K}/chapters/1`, {
      headers: { cookie: "__Host-reader=theme=dark" },
    });
    expect(open.status).toBe(200);

    const res = await post(`/admin/works/${K}/adult`, moderator);
    expect(res.status).toBe(200);

    expect((await stateOf(K)).adult_marked).toBe(true);
    expect(await reportsOf(K)).toEqual([{ kind: "higher_rating", status: "closed" }]);
    const log = await db
      .selectFrom("moderation_actions")
      .innerJoin("works", "works.id", "moderation_actions.target_id")
      .select("moderation_actions.action")
      .where("works.ao3_work_id", "=", K)
      .execute();
    expect(log).toEqual([{ action: "mark_adult" }]);

    // The screen comes first, with the rating as the file gave it and the plain line.
    const gate = await fetchW(`/works/${K}/chapters/1`);
    expect(gate.status).toBe(302);
    expect(gate.headers.get("location")).toBe(
      `/works/${K}/warnings?next=${encodeURIComponent(`/works/${K}/chapters/1`)}`,
    );
    const screen = await (await fetchW(gate.headers.get("location")!)).text();
    expect(screen).toContain("Rating: General Audiences");
    expect(screen).toContain(LINE);
    // The work page and a card say so too.
    expect(await (await fetchW(`/works/${K}`)).text()).toContain(LINE);
    const listing = await (await fetchW("/tags/fandom/adultmark-fandom")).text();
    expect(cardOf(listing, K)).toContain(LINE);
    expect(cardOf(listing, G)).not.toContain(LINE);
  });

  it("The adult mark takes effect with the usual cache windows", async () => {
    // K is marked (above). A reader who has continued past the screen gets the page, which the
    // edge keeps for a minute with its decision; a reader who hasn't is still sent to the screen.
    const next = `/works/${K}/chapters/1`;
    const cont = await post(`/works/${K}/warnings`, undefined, { next });
    const cookie = cont.headers.getSetCookie()[0]!.split(";")[0]!;
    expect((await fetchW(next, { headers: { cookie } })).status).toBe(200);
    expect((await fetchW(next, { headers: { cookie } })).status).toBe(200);
    const other = await fetchW(next);
    expect(other.status).toBe(302);
    expect(other.headers.get("location")).toContain(`/works/${K}/warnings`);
  });

  it("A moderator removes the adult mark", async () => {
    const moderator = await moderatorCookie("adultmark-mod-remove@example.test");
    const res = await post(`/admin/works/${K}/adult/remove`, moderator);
    expect(res.status).toBe(200);
    expect((await stateOf(K)).adult_marked).toBe(false);
    expect(await (await fetchW(`/works/${K}`)).text()).not.toContain(LINE);
    const log = await db
      .selectFrom("moderation_actions")
      .innerJoin("works", "works.id", "moderation_actions.target_id")
      .select("moderation_actions.action")
      .where("works.ao3_work_id", "=", K)
      .orderBy("moderation_actions.created_at")
      .execute();
    expect(log.map((row) => row.action)).toEqual(["mark_adult", "unmark_adult"]);
  });

  it("A cross-site post can't mark a work", async () => {
    const moderator = await moderatorCookie("adultmark-mod-xsite@example.test");
    const res = await fetchW(`/admin/works/${G}/adult`, {
      method: "POST",
      headers: {
        cookie: moderator,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(res.status).toBe(404);
    expect((await stateOf(G)).adult_marked).toBe(false);
  });

  it("Only a moderator can mark a work", async () => {
    const plain = await signIn("adultmark-plain@example.test", { acceptTerms: true });
    expect((await post(`/admin/works/${G}/adult`, plain)).status).toBe(404);
    expect((await post(`/admin/works/${G}/adult`, undefined)).status).toBe(404);
    expect((await stateOf(G)).adult_marked).toBe(false);
  });
});
