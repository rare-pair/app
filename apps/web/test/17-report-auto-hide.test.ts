import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, fetchW, signIn as signInAs } from "./helpers";

// One database serves every test file in the run, so this file keeps to AO3 work
// IDs 17900 to 17999, names every tag it seeds with an "x7-" prefix, and signs in
// its own accounts. Text is synthetic.
const TAGS = [
  { type: "rating", name: "x7-General Audiences" },
  { type: "fandom", name: "x7-Fandom" },
] as const;

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

/** One work per case, so no case sees another's reports. */
const works = { three: 17900, two: 17901, repeat: 17902, wrong: 17903, converse: 17904 } as const;
const MODERATOR_HIDDEN = 17905;

beforeAll(async () => {
  for (const [name, ao3WorkId] of Object.entries(works)) {
    await seedWork(db, { ao3WorkId, title: `x7 ${name}`, tags: [...TAGS] });
  }
  await seedWork(db, {
    ao3WorkId: MODERATOR_HIDDEN,
    status: "hidden",
    hiddenCause: "moderator",
    tags: [...TAGS],
  });
});
afterAll(() => db.destroy());

const signIn = (email: string) => signInAs(email, { acceptTerms: true });

const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  origin: BASE,
  "sec-fetch-site": "same-origin",
};

/** Reports work `id` as the account behind `cookie`, with a `reason` (default "other"). */
const report = (cookie: string, id: number, reason = "other") =>
  fetchW(`/works/${id}/report`, {
    method: "POST",
    headers: { ...FORM_HEADERS, cookie },
    body: new URLSearchParams({ reason }).toString(),
  });

/** The stored state of the work, from the database. */
const stored = (id: number) =>
  db
    .selectFrom("works")
    .select(["status", "hidden_cause"])
    .where("ao3_work_id", "=", id)
    .executeTakeFirstOrThrow();

const reportRows = async (id: number, email: string) =>
  (
    await db
      .selectFrom("reports")
      .innerJoin("works", "works.id", "reports.work_id")
      .innerJoin("user", "user.id", "reports.reporter_id")
      .select("reports.kind")
      .where("works.ao3_work_id", "=", id)
      .where("user.email", "=", email)
      .execute()
  ).length;

/** Three accounts, signed in, as session cookies. */
const accounts = (prefix: string) =>
  Promise.all([
    signIn(`${prefix}-1@example.test`),
    signIn(`${prefix}-2@example.test`),
    signIn(`${prefix}-3@example.test`),
  ]);

describe("17-reports-and-dmca", () => {
  it("Report from a third account hides the work automatically", async () => {
    const id = works.three;
    const [u, u2, u3] = await accounts("x7-three");
    await report(u, id);
    await report(u2, id);
    expect((await fetchW(`/works/${id}`)).status).toBe(200);
    expect((await report(u3, id)).status).toBe(200);
    expect(await stored(id)).toEqual({ status: "hidden", hidden_cause: "reports" });
    const page = await fetchW(`/works/${id}`);
    expect(page.status).toBe(451);
    expect(await page.text()).toContain("Temporarily hidden after reader reports");
  });

  it("Reports from two accounts keep the work live", async () => {
    const id = works.two;
    const [u, u2] = await accounts("x7-two");
    await report(u, id);
    await report(u2, id);
    expect(await stored(id)).toEqual({ status: "live", hidden_cause: null });
    expect((await fetchW(`/works/${id}`)).status).toBe(200);
  });

  it("Repeat reports from one account count once", async () => {
    const id = works.repeat;
    const [u, u2] = await accounts("x7-repeat");
    await report(u, id);
    await report(u2, id);
    expect((await report(u, id)).status).toBe(200);
    expect((await report(u, id)).status).toBe(200);
    // All three of U's reports are stored, and the work stays live.
    expect(await reportRows(id, "x7-repeat-1@example.test")).toBe(3);
    expect(await stored(id)).toEqual({ status: "live", hidden_cause: null });
    expect((await fetchW(`/works/${id}`)).status).toBe(200);
  });

  it("This version is wrong reports never count toward hiding", async () => {
    const id = works.wrong;
    const [u, u2, u3] = await accounts("x7-wrong");
    await report(u, id);
    await report(u2, id);
    expect((await report(u3, id, "wrong_version")).status).toBe(200);
    expect(await reportRows(id, "x7-wrong-3@example.test")).toBe(1);
    expect(await stored(id)).toEqual({ status: "live", hidden_cause: null });
    expect((await fetchW(`/works/${id}`)).status).toBe(200);
  });

  it("Two wrong_version reports and a third account's other report keep the work live", async () => {
    const id = works.converse;
    const [u, u2, u3] = await accounts("x7-converse");
    await report(u, id, "wrong_version");
    await report(u2, id, "wrong_version");
    await report(u3, id);
    expect(await stored(id)).toEqual({ status: "live", hidden_cause: null });
  });

  it("A work hidden by a moderator keeps its cause", async () => {
    // A report on a hidden work is refused (404), so the cause can't change through it.
    const [u] = await accounts("x7-mod");
    expect((await report(u, MODERATOR_HIDDEN)).status).toBe(404);
    expect(await stored(MODERATOR_HIDDEN)).toEqual({
      status: "hidden",
      hidden_cause: "moderator",
    });
  });
});
