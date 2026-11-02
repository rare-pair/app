import { createDb } from "@archive/db";
import { seedVersion, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, emailsTo, fetchW, LOGIN_TOKEN, postLogin, signIn as signInAs } from "./helpers";

// One database serves every test file in the run, and the queue lists every work
// that needs a check. So this file keeps to AO3 work IDs 14300 to 14399, names every
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
    const bv = await seed(14301);
    await reportOn(bv, "wrong_version", "2001-03-01T00:00:00Z");
    await seed(14302, { reviewReasons: ["mod3a-reason"], addedAt: "2001-02-01T00:00:00Z" });
    const hv = await seed(14303, { addedAt: "2000-12-01T00:00:00Z" });
    await seedVersion(db, hv, { current: false, addedAt: "2001-01-01T00:00:00Z" });
    const html = await queue();
    const cells = [14303, 14302, 14301].map((id) => rowWith(html, `mod3a-${id} (`));
    expect(cells.map((c) => c[0])).toEqual([
      "2001-01-01T00:00:00.000Z",
      "2001-02-01T00:00:00.000Z",
      "2001-03-01T00:00:00.000Z",
    ]);
    expect(cells.map((c) => c[1])).toEqual([
      "mod3a-14303 (14303)",
      "mod3a-14302 (14302)",
      "mod3a-14301 (14301)",
    ]);
    for (const id of [14301, 14302, 14303]) {
      expect(html, String(id)).toContain(`<a href="/admin/works/${id}">`);
    }
    const at = (id: number) => html.indexOf(`mod3a-${id} (`);
    expect(at(14303)).toBeLessThan(at(14302));
    expect(at(14302)).toBeLessThan(at(14301));
  });

  it("Works that need no check are not listed", async () => {
    const checked = await seed(14310, { reviewReasons: ["mod3a-reason"] });
    await db
      .updateTable("work_versions")
      .set({ checked_at: new Date() })
      .where("id", "=", checked.versionId)
      .execute();
    const other = await seed(14311);
    await reportOn(other, "mod3a-other-kind", "2001-01-01T00:00:00Z");
    const closed = await seed(14312);
    await reportOn(closed, "wrong_version", "2001-01-01T00:00:00Z", "dismissed");
    // An earlier version's reasons don't flag the work: only its current version counts.
    const older = await seed(14313, { reviewReasons: ["mod3a-reason"] });
    await seedVersion(db, older, { current: true });
    await seed(14314);
    const html = await queue();
    for (const id of [14310, 14311, 14312, 14313, 14314]) {
      expect(html, String(id)).not.toContain(`mod3a-${id}`);
    }
  });

  it("A hidden work is listed and a removed work is not", async () => {
    const hidden = await seed(14320, { status: "hidden", hiddenCause: "moderator" });
    await reportOn(hidden, "wrong_version", "2001-01-01T00:00:00Z");
    const removed = await seed(14321, { status: "removed" });
    await reportOn(removed, "wrong_version", "2001-01-01T00:00:00Z");
    const html = await queue();
    expect(html).toContain("mod3a-14320 (14320)");
    expect(html).not.toContain("mod3a-14321");
    // Flagged by review reasons alone, a hidden work is listed too.
    await seed(14322, { status: "hidden", hiddenCause: "moderator", reviewReasons: ["mod3a-r"] });
    expect(await queue()).toContain("mod3a-14322 (14322)");
  });

  it("A work with several held versions is listed once, from the oldest", async () => {
    const w = await seed(14360);
    await seedVersion(db, w, { current: false, addedAt: "2001-08-01T00:00:00Z" });
    await seedVersion(db, w, { current: false, addedAt: "2001-07-01T00:00:00Z" });
    const cells = rowWith(await queue(), "mod3a-14360 (");
    expect(cells[0]).toBe("2001-07-01T00:00:00.000Z");
  });

  it("A work with two triggers is listed once, from the earliest, with both reasons", async () => {
    const w = await seed(14330, { reviewReasons: ["mod3a-why"], addedAt: "2001-05-01T00:00:00Z" });
    await reportOn(w, "wrong_version", "2001-04-01T00:00:00Z");
    await reportOn(w, "wrong_version", "2001-06-01T00:00:00Z");
    const cells = rowWith(await queue(), "mod3a-14330 (");
    expect(cells[0]).toBe("2001-04-01T00:00:00.000Z");
    expect(cells[2]).toContain("mod3a-why");
    expect(cells[2]).toMatch(/wrong/i);
  });

  it("A title is escaped", async () => {
    const w = await seedWork(db, { ao3WorkId: 14340, title: "mod3a-<b>bold</b>" });
    await reportOn(w, "wrong_version", "2001-01-01T00:00:00Z");
    const html = await queue();
    expect(html).toContain("mod3a-&lt;b&gt;bold&lt;/b&gt; (14340)");
    expect(html).not.toContain("mod3a-<b>");
  });

  it("This version is wrong queues the work in Works to check", async () => {
    const w = await seed(14350);
    const reader = await signInAs("mod3a-reader@example.test", { acceptTerms: true });
    const res = await fetchW("/works/14350/report", {
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
    expect(await queue()).toContain("mod3a-14350 (14350)");
  });
});
