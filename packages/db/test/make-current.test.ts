import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getLiveWork, makeVersionCurrent, searchLiveWorks } from "../src/index";
import { seedVersion, seedWork } from "../src/seed";
import { createTestDb, type TestDb } from "../src/testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

let users = 0;
async function addModerator() {
  const id = `make-current-mod-${++users}`;
  await t.db
    .insertInto("user")
    .values({ id, name: id, email: `${id}@example.test`, email_verified: true, role: "moderator" })
    .execute();
  return id;
}

/** A work at v1, replaced by a v2 that differs in every column, its byline and its tags. */
async function replacedWork(marker: string) {
  const first = await seedWork(t.db, {
    title: `${marker}first title`,
    summary: "<p>First summary.</p>",
    rating: "General Audiences",
    complete: true,
    updatedAt: "2020-02-01T00:00:00Z",
    authors: [{ pseud: "First Pseud", ao3_user: "first_user" }],
    tags: [{ type: "freeform", name: `${marker}First Tag` }],
    chapters: [{ words: 100 }],
    chapterTotal: 1,
  });
  const second = await seedVersion(t.db, first, {
    title: `${marker}second title`,
    summary: "<p>Second summary.</p>",
    rating: "Mature",
    complete: false,
    updatedAt: "2020-03-01T00:00:00Z",
    authors: [{ pseud: "Second Pseud", ao3_user: null }],
    tags: [{ type: "freeform", name: `${marker}Second Tag` }],
    chapters: [{ words: 200 }, { words: 300 }],
    chapterTotal: 5,
  });
  return { ...first, v1: first.versionId, v2: second.versionId };
}

const logOf = (versionId: string) =>
  t.db
    .selectFrom("moderation_actions")
    .select(["moderator_id", "action", "target_kind", "target_id"])
    .where("target_id", "=", versionId)
    .execute();

describe("makeVersionCurrent", () => {
  it("A rollback makes the work describe the version made current", async () => {
    const w = await replacedWork("mcroll");
    expect((await getLiveWork(t.db, w.ao3WorkId))?.work.title).toBe("mcrollsecond title");

    expect(await makeVersionCurrent(t.db, w.workId, w.v1)).toBe(true);

    const live = await getLiveWork(t.db, w.ao3WorkId);
    expect(live?.version.id).toBe(w.v1);
    expect(live?.work).toMatchObject({
      title: "mcrollfirst title",
      summary_html: "<p>First summary.</p>",
      rating: "General Audiences",
      language: "English",
      words: 100,
      chapters_count: 1,
      chapters_total: 1,
      complete: true,
    });
    expect(live?.work.updated_at).toEqual(new Date("2020-02-01T00:00:00Z"));
    expect(live?.authors).toEqual([{ pseud: "First Pseud", ao3_user: "first_user" }]);
    expect(live?.tags.map((x) => [x.type, x.name])).toEqual([["freeform", "mcrollFirst Tag"]]);
    // The search follows: the replaced version's title is found no more.
    expect(
      (await searchLiveWorks(t.db, "mcrollfirst")).works.map((x) => x.work.ao3_work_id),
    ).toEqual([w.ao3WorkId]);
    expect((await searchLiveWorks(t.db, "mcrollsecond")).works).toEqual([]);
  });

  it("A field the version lacks keeps the work's value", async () => {
    const w = await replacedWork("mcnull");
    // As a version saved before migrations 0010 and 0012 has: nothing but its title kept.
    await t.db
      .updateTable("work_versions")
      .set({
        summary_html: null,
        rating: null,
        language: null,
        words: null,
        complete: null,
        published_at: null,
        updated_at: null,
        raw_meta: null,
        chapter_total: null,
        tags: null,
        authors: null,
      })
      .where("id", "=", w.v1)
      .execute();

    expect(await makeVersionCurrent(t.db, w.workId, w.v1)).toBe(true);

    const live = await getLiveWork(t.db, w.ao3WorkId);
    expect(live?.work).toMatchObject({
      title: "mcnullfirst title",
      summary_html: "<p>Second summary.</p>",
      rating: "Mature",
      language: "English",
      words: 500,
      chapters_count: 1,
      chapters_total: 5,
      complete: false,
    });
    expect(live?.work.updated_at).toEqual(new Date("2020-03-01T00:00:00Z"));
    expect(live?.authors).toEqual([{ pseud: "Second Pseud", ao3_user: null }]);
    expect(live?.tags.map((x) => x.name)).toEqual(["mcnullSecond Tag"]);
  });

  it("A hidden work's version can be made current; a removed work's cannot", async () => {
    const hidden = await replacedWork("mchidden");
    await t.db
      .updateTable("works")
      .set({ status: "hidden", hidden_cause: "moderator" })
      .where("id", "=", hidden.workId)
      .execute();
    expect(await makeVersionCurrent(t.db, hidden.workId, hidden.v1)).toBe(true);

    const removed = await replacedWork("mcremoved");
    await t.db
      .updateTable("works")
      .set({ status: "removed" })
      .where("id", "=", removed.workId)
      .execute();
    expect(await makeVersionCurrent(t.db, removed.workId, removed.v1)).toBe(false);
    const row = await t.db
      .selectFrom("works")
      .select(["current_version_id", "title"])
      .where("id", "=", removed.workId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ current_version_id: removed.v2, title: "mcremovedsecond title" });
  });

  it("Making a version current is logged with the moderator, once", async () => {
    const moderator = await addModerator();
    const w = await replacedWork("mclog");

    expect(await makeVersionCurrent(t.db, w.workId, w.v1, { actor: moderator })).toBe(true);
    // Already current: nothing changed, so nothing more is logged.
    expect(await makeVersionCurrent(t.db, w.workId, w.v1, { actor: moderator })).toBe(true);

    expect(await logOf(w.v1)).toEqual([
      { moderator_id: moderator, action: "make_current", target_kind: "version", target_id: w.v1 },
    ]);
  });

  it("A refused make-current logs nothing", async () => {
    const moderator = await addModerator();
    const w = await replacedWork("mcnolog");
    await t.db.updateTable("works").set({ status: "removed" }).where("id", "=", w.workId).execute();

    expect(await makeVersionCurrent(t.db, w.workId, w.v1, { actor: moderator })).toBe(false);

    expect(await logOf(w.v1)).toEqual([]);
  });
});
