import { createDb } from "@archive/db";
import { seedVersion, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, emailsTo, fetchW, LOGIN_TOKEN, postLogin, signIn as signInAs } from "./helpers";

// One database serves every test file in the run, and the queue lists every work
// that needs a check. So this file keeps to AO3 work IDs 18400 to 18499, names every
// title with a "mod3a-" prefix, dates its triggers in 2001 so they sort ahead of
// anyone else's, and asserts only the relative order of its own works. Text is synthetic.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/** Signs `email` in through the Worker and gives the account the moderator role. */
async function signInModerator(email: string): Promise<string> {
  expect((await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN })).status).toBe(200);
  const [sent] = await emailsTo(email);
  const token = new URL(sent!.url).searchParams.get("token")!;
  const res = await postLogin({ token, next: "/" }, { url: "/login/confirm" });
  expect(res.status).toBe(303);
  await db
    .updateTable("user")
    .set({ role: "moderator", terms_accepted_at: new Date() })
    .where("email", "=", email)
    .execute();
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
}

let moderator: string;

beforeAll(async () => {
  moderator = await signInModerator("mod3a-moderator@example.test");
});

const queue = async () => {
  const res = await fetchW("/admin/works", { headers: { cookie: moderator } });
  expect(res.status).toBe(200);
  return res.text();
};

/** The cells of the one row that mentions `marker`, a link's text standing for the link. */
function rowWith(html: string, marker: string): string[] {
  const rows = html.match(/<tr><td>.*?<\/tr>/g) ?? [];
  const [row, ...others] = rows.filter((r) => r.includes(marker));
  expect(others, marker).toEqual([]);
  expect(row, marker).toBeDefined();
  return [...(row ?? "").matchAll(/<td>(.*?)<\/td>/g)].map((m) =>
    (m[1] ?? "").replace(/^<a href="[^"]*">(.*)<\/a>$/, "$1"),
  );
}

const seed = (id: number, extra: Parameters<typeof seedWork>[1] = {}) =>
  seedWork(db, { ao3WorkId: id, title: `mod3a-${id}`, ...extra });

const reportOn = (
  work: { workId: string; userId: string },
  kind: string,
  createdAt: string,
  status = "open",
) =>
  db
    .insertInto("reports")
    .values({
      work_id: work.workId,
      reporter_id: work.userId,
      kind,
      status,
      created_at: createdAt,
    })
    .execute();

describe("18 moderation: Works to check", () => {
  it("Works to check lists held, flagged and wrong-version works", async () => {
    // Inserted newest first, so neither insertion order nor id order is the answer.
    const bv = await seed(18401);
    await reportOn(bv, "wrong_version", "2001-03-01T00:00:00Z");
    await seed(18402, { reviewReasons: ["mod3a-reason"], addedAt: "2001-02-01T00:00:00Z" });
    const hv = await seed(18403, { addedAt: "2000-12-01T00:00:00Z" });
    await seedVersion(db, hv, { current: false, addedAt: "2001-01-01T00:00:00Z" });
    const html = await queue();
    const cells = [18403, 18402, 18401].map((id) => rowWith(html, `mod3a-${id} (`));
    expect(cells.map((c) => c[0])).toEqual([
      "2001-01-01T00:00:00.000Z",
      "2001-02-01T00:00:00.000Z",
      "2001-03-01T00:00:00.000Z",
    ]);
    expect(cells.map((c) => c[1])).toEqual([
      "mod3a-18403 (18403)",
      "mod3a-18402 (18402)",
      "mod3a-18401 (18401)",
    ]);
    for (const id of [18401, 18402, 18403]) {
      expect(html, String(id)).toContain(`<a href="/admin/works/${id}">`);
    }
    const at = (id: number) => html.indexOf(`mod3a-${id} (`);
    expect(at(18403)).toBeLessThan(at(18402));
    expect(at(18402)).toBeLessThan(at(18401));
  });

  it("Works that need no check are not listed", async () => {
    const checked = await seed(18410, { reviewReasons: ["mod3a-reason"] });
    await db
      .updateTable("work_versions")
      .set({ checked_at: new Date() })
      .where("id", "=", checked.versionId)
      .execute();
    const other = await seed(18411);
    await reportOn(other, "mod3a-other-kind", "2001-01-01T00:00:00Z");
    const closed = await seed(18412);
    await reportOn(closed, "wrong_version", "2001-01-01T00:00:00Z", "dismissed");
    // An earlier version's reasons don't flag the work: only its current version counts.
    const older = await seed(18413, { reviewReasons: ["mod3a-reason"] });
    await seedVersion(db, older, { current: true });
    await seed(18414);
    const html = await queue();
    for (const id of [18410, 18411, 18412, 18413, 18414]) {
      expect(html, String(id)).not.toContain(`mod3a-${id}`);
    }
  });

  it("A hidden work is listed and a removed work is not", async () => {
    const hidden = await seed(18420, { status: "hidden", hiddenCause: "moderator" });
    await reportOn(hidden, "wrong_version", "2001-01-01T00:00:00Z");
    const removed = await seed(18421, { status: "removed" });
    await reportOn(removed, "wrong_version", "2001-01-01T00:00:00Z");
    const html = await queue();
    expect(html).toContain("mod3a-18420 (18420)");
    expect(html).not.toContain("mod3a-18421");
    // Flagged by review reasons alone, a hidden work is listed too.
    await seed(18422, { status: "hidden", hiddenCause: "moderator", reviewReasons: ["mod3a-r"] });
    expect(await queue()).toContain("mod3a-18422 (18422)");
  });

  it("A work with several held versions is listed once, from the oldest", async () => {
    const w = await seed(18460);
    await seedVersion(db, w, { current: false, addedAt: "2001-08-01T00:00:00Z" });
    await seedVersion(db, w, { current: false, addedAt: "2001-07-01T00:00:00Z" });
    const cells = rowWith(await queue(), "mod3a-18460 (");
    expect(cells[0]).toBe("2001-07-01T00:00:00.000Z");
  });

  it("A work with two triggers is listed once, from the earliest, with both reasons", async () => {
    const w = await seed(18430, { reviewReasons: ["mod3a-why"], addedAt: "2001-05-01T00:00:00Z" });
    await reportOn(w, "wrong_version", "2001-04-01T00:00:00Z");
    await reportOn(w, "wrong_version", "2001-06-01T00:00:00Z");
    const cells = rowWith(await queue(), "mod3a-18430 (");
    expect(cells[0]).toBe("2001-04-01T00:00:00.000Z");
    expect(cells[2]).toContain("mod3a-why");
    expect(cells[2]).toMatch(/wrong/i);
  });

  it("A title is escaped", async () => {
    const w = await seedWork(db, { ao3WorkId: 18440, title: "mod3a-<b>bold</b>" });
    await reportOn(w, "wrong_version", "2001-01-01T00:00:00Z");
    const html = await queue();
    expect(html).toContain("mod3a-&lt;b&gt;bold&lt;/b&gt; (18440)");
    expect(html).not.toContain("mod3a-<b>");
  });

  it("This version is wrong queues the work in Works to check", async () => {
    const w = await seed(18450);
    const reader = await signInAs("mod3a-reader@example.test", { acceptTerms: true });
    const res = await fetchW("/works/18450/report", {
      method: "POST",
      headers: {
        cookie: reader,
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE,
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ reason: "wrong_version" }).toString(),
    });
    expect(res.status).toBe(200);
    const stored = await db
      .selectFrom("reports")
      .select("kind")
      .where("work_id", "=", w.workId)
      .execute();
    expect(stored).toEqual([{ kind: "wrong_version" }]);
    expect(await queue()).toContain("mod3a-18450 (18450)");
  });

  it("A work the reports hid is listed once its reports are closed", async () => {
    const w = await seed(18470, { status: "hidden", hiddenCause: "reports" });
    await reportOn(w, "mod3a-other-kind", "2001-09-01T00:00:00Z", "closed");
    await reportOn(w, "mod3a-other-kind", "2001-10-01T00:00:00Z", "dismissed");
    const cells = rowWith(await queue(), "mod3a-18470 (");
    expect(cells[0]).toBe("2001-09-01T00:00:00.000Z");
    expect(cells[2]).toBe("Hidden by reports, none open: restore or remove");
  });

  it("A work the reports hid is not listed while a report is open", async () => {
    const w = await seed(18471, { status: "hidden", hiddenCause: "reports" });
    await reportOn(w, "mod3a-other-kind", "2001-09-01T00:00:00Z");
    expect(await queue()).not.toContain("mod3a-18471");
  });

  it("Only a hide by reports is listed for having none open", async () => {
    await seed(18472, { status: "hidden", hiddenCause: "moderator" });
    await seed(18473, { status: "hidden", hiddenCause: "removal_request" });
    await seed(18474, { status: "live" });
    await seed(18475, { status: "removed" });
    const html = await queue();
    for (const id of [18472, 18473, 18474, 18475]) {
      expect(html, String(id)).not.toContain(`mod3a-${id}`);
    }
  });

  it("A work the reports hid with a wrong-version report is listed once, with both reasons", async () => {
    const w = await seed(18476, { status: "hidden", hiddenCause: "reports" });
    await reportOn(w, "wrong_version", "2001-09-01T00:00:00Z");
    const cells = rowWith(await queue(), "mod3a-18476 (");
    expect(cells[2]).toBe(
      "Reported: this version is wrong; Hidden by reports, none open: restore or remove",
    );
  });

  describe("its exits", () => {
    const post = (path: string, fields: Record<string, string> = {}) =>
      fetchW(path, {
        method: "POST",
        headers: {
          cookie: moderator,
          "content-type": "application/x-www-form-urlencoded",
          origin: BASE,
          "sec-fetch-site": "same-origin",
        },
        body: new URLSearchParams(fields).toString(),
      });
    const state = (id: number) =>
      db
        .selectFrom("works")
        .select(["status", "hidden_cause"])
        .where("ao3_work_id", "=", id)
        .executeTakeFirstOrThrow();

    it("Dismissing the last report lists the work, still hidden", async () => {
      const w = await seed(18480, { status: "hidden", hiddenCause: "reports" });
      await db
        .insertInto("reports")
        .values({
          id: "mod3a-18480",
          work_id: w.workId,
          reporter_id: w.userId,
          kind: "mod3a-other-kind",
          status: "open",
          created_at: "2001-09-01T00:00:00Z",
        })
        .execute();
      expect(await queue()).not.toContain("mod3a-18480 (");
      expect((await post("/admin/reports/mod3a-18480/dismiss")).status).toBe(200);
      expect(await queue()).toContain("mod3a-18480 (18480)");
      expect(await state(18480)).toEqual({ status: "hidden", hidden_cause: "reports" });
      expect((await fetchW("/works/18480")).status).toBe(451);
    });

    it("Its admin page offers Restore and Remove", async () => {
      await seed(18481, { status: "hidden", hiddenCause: "reports" });
      const res = await fetchW("/admin/works/18481", { headers: { cookie: moderator } });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('action="/admin/works/18481/restore"');
      expect(html).toContain('action="/admin/works/18481/remove"');
    });

    it("Restoring it takes it off Works to check", async () => {
      await seed(18482, { status: "hidden", hiddenCause: "reports" });
      expect(await queue()).toContain("mod3a-18482 (");
      expect((await post("/admin/works/18482/restore")).status).toBe(200);
      expect(await state(18482)).toEqual({ status: "live", hidden_cause: null });
      expect(await queue()).not.toContain("mod3a-18482");
    });

    it("Removing it takes it off Works to check", async () => {
      await seed(18483, { status: "hidden", hiddenCause: "reports" });
      expect(await queue()).toContain("mod3a-18483 (");
      expect((await post("/admin/works/18483/remove", { confirm: "yes" })).status).toBe(200);
      expect((await state(18483)).status).toBe("removed");
      expect(await queue()).not.toContain("mod3a-18483");
    });
  });
});
