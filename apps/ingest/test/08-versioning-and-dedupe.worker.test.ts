import { describe, expect, it } from "vitest";
import { ao3Epub } from "../../../packages/epub/test/helpers";
import {
  beforePut,
  bucketKeys,
  bucketText,
  deliver,
  freshAo3WorkId,
  hideWork,
  ingestParsed,
  liveWork,
  meetBeforeOriginal,
  parsedWork,
  pendingUpload,
  rendezvous,
  savedRows,
  searchedIds,
  token,
  uploadRow,
  versionsOf,
} from "./helpers";

/** A chapter of sixty words of its own, so another chapter or variant is nothing like it. */
const chapterHtml = (n: number, variant = "") =>
  `<p>${Array.from({ length: 60 }, (_, i) => `w${variant}${n}x${i}`).join(" ")}</p>`;

interface Fixture {
  count?: number;
  updated?: string;
  /** Chapters (numbers) whose text is wholly different. */
  rewritten?: number[];
  /** Chapters whose text has one word changed. */
  tweaked?: number[];
  freeforms?: string[];
  pseud?: string;
  title?: string;
  /** Changes the last chapter's text, so two files with the same facts still differ. */
  tail?: string;
}

/** A parsed version of work `workId`: v1 is three chapters and an Updated date of 2020-02-01. */
function fixture(workId: number, o: Fixture = {}) {
  const count = o.count ?? 3;
  const pseud = o.pseud ?? "someone";
  return parsedWork({
    ao3WorkId: String(workId),
    title: o.title ?? "Synthetic Work",
    authors: [{ pseud, user: pseud }],
    freeforms: o.freeforms ?? ["Synthetic Tag"],
    stats: {
      published: "2020-01-02",
      updated: o.updated ?? "2020-02-01",
      completed: null,
      words: count * 60,
      chapters: { posted: count, total: count },
    },
    chapters: Array.from({ length: count }, (_, i) => {
      const n = i + 1;
      const variant = o.rewritten?.includes(n) ? "r" : o.tweaked?.includes(n) ? "t" : "";
      const html =
        variant === "t"
          ? chapterHtml(n).replace(`w${n}x7 `, "changed ")
          : chapterHtml(n, variant) + (n === count ? (o.tail ?? "") : "");
      return { n, title: `Chapter ${n}`, html, words: 60 };
    }),
  });
}

/** Work W at v1: a fresh work, its first upload ingested. */
async function workAtV1() {
  const workId = freshAo3WorkId();
  const v1 = await ingestParsed(fixture(workId));
  expect(v1.row.status).toBe("live");
  return { workId, v1 };
}

describe("08-versioning-and-dedupe", () => {
  it("First upload creates the work", async () => {
    // The scenario's 67890 stands for an ID no work has: here, a fresh random one, since a
    // rerun on the same database (vitest watch) would find a fixed ID's work from the first run.
    const workId = freshAo3WorkId();
    const id = await pendingUpload(
      ao3Epub({ workId, stats: "Published: 2020-01-02 Words: 3 Chapters: 1/1" }),
    );
    expect((await savedRows(workId, id)).works).toEqual([]);

    const result = await deliver([{ upload_id: id }]);
    // The same message again, as the queue may deliver it: the upload is live, so it is done.
    const again = await deliver([{ upload_id: id }]);

    const { works, versions } = await savedRows(workId, id);
    expect(works).toHaveLength(1);
    expect(versions).toHaveLength(1);
    expect(works[0]?.current_version_id).toBe(versions[0]?.id);
    const row = await uploadRow(id);
    expect(row.status).toBe("live");
    expect(row.work_id).toBe(works[0]?.id);
    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect(again.explicitAcks).toEqual(["msg-0"]);

    // What the reader gets.
    const live = await liveWork(workId);
    expect(live?.work).toMatchObject({
      ao3_work_id: workId,
      title: "Synthetic Work",
      language: "English",
      words: 3,
      chapters_count: 1,
      chapters_total: 1,
      complete: true,
      status: "live",
    });
    expect(live?.work.published_at).toEqual(new Date("2020-01-02T00:00:00Z"));
    expect(live?.authors).toEqual([{ pseud: "someone", ao3_user: "someone" }]);
    expect(live?.chapters).toEqual([
      // Two words in the chapter, as the processor counts them; the work's total is the Stats line's.
      { n: 1, title: "Synthetic Work", words: 2, r2_key: `works/${workId}/${id}/1.html` },
    ]);
    expect(await bucketText(`works/${workId}/${id}/1.html`)).toContain("marker-only-chapter text.");
  });

  it("Newer upload with more chapters replaces the current version", async () => {
    const { workId, v1 } = await workAtV1();
    const word = `Quill${token()}`;

    const v2 = await ingestParsed(fixture(workId, { count: 4, title: `The ${word} Edition` }));

    expect(v2.row.status).toBe("live");
    const rows = await versionsOf(workId);
    expect(rows.current).toBe(rows.versions.find((v) => v.upload_id === v2.id)?.id);
    expect(rows.versions).toHaveLength(2);
    expect(v2.row.work_id).toBe(rows.workId);
    // The work follows its new version; the reader gets four chapters.
    const live = await liveWork(workId);
    expect(live?.work.title).toBe(`The ${word} Edition`);
    expect(live?.work.chapters_count).toBe(4);
    expect(live?.chapters.map((c) => c.r2_key)).toEqual(
      [1, 2, 3, 4].map((n) => `works/${workId}/${v2.id}/${n}.html`),
    );
    // The replaced version's title is searched no more; the new one is.
    expect(await searchedIds(word)).toEqual([workId]);
    expect(v1.row.work_id).toBe(rows.workId);
  });

  it("Newer upload with a later date replaces the current version", async () => {
    const { workId } = await workAtV1();

    const v2 = await ingestParsed(fixture(workId, { updated: "2020-03-01" }));

    expect(v2.row.status).toBe("live");
    const rows = await versionsOf(workId);
    expect(rows.current).toBe(rows.versions.find((v) => v.upload_id === v2.id)?.id);
  });

  it("Small edits in shared chapters are allowed", async () => {
    const { workId } = await workAtV1();

    const v2 = await ingestParsed(fixture(workId, { count: 4, tweaked: [2] }));

    expect(v2.row.status).toBe("live");
    const rows = await versionsOf(workId);
    expect(rows.current).toBe(rows.versions.find((v) => v.upload_id === v2.id)?.id);
  });

  it("Every version is kept", async () => {
    const { workId, v1 } = await workAtV1();
    const v1Keys = await bucketKeys(`works/${workId}/${v1.id}/`);

    const v2 = await ingestParsed(fixture(workId, { count: 4 }));
    // The queue may deliver the message again: still one version.
    await deliver([{ upload_id: v2.id }]);

    const rows = await versionsOf(workId);
    expect(rows.versions.map((v) => v.r2_prefix).sort()).toEqual(
      [`works/${workId}/${v1.id}/`, `works/${workId}/${v2.id}/`].sort(),
    );
    for (const v of rows.versions) {
      expect(v.r2_prefix).toBe(`works/${workId}/${v.upload_id}/`);
      expect(v.chapterKeys.every((k) => k.startsWith(v.r2_prefix))).toBe(true);
    }
    expect(rows.versions.find((v) => v.upload_id === v1.id)?.chapterNumbers).toEqual([1, 2, 3]);
    expect(rows.versions.find((v) => v.upload_id === v2.id)?.chapterNumbers).toEqual([1, 2, 3, 4]);
    // v1's fragments are untouched, and no key carries a version number: under the work, a key
    // is an image or a chapter of an upload.
    expect(await bucketKeys(`works/${workId}/${v1.id}/`)).toEqual(v1Keys);
    expect(await bucketKeys(`works/${workId}/${v2.id}/`)).toHaveLength(4);
    const under = await bucketKeys(`works/${workId}/`);
    expect(
      under.every((k) =>
        new RegExp(`^works/${workId}/(img/.+|[0-9a-f-]{36}/\\d+\\.html)$`).test(k),
      ),
    ).toBe(true);
  });

  it("Newer upload with changed shared chapters is held", async () => {
    const { workId, v1 } = await workAtV1();
    const v1Live = await liveWork(workId);

    const v2 = await ingestParsed(fixture(workId, { count: 4, rewritten: [2] }));

    expect(v2.row.status).toBe("held_for_review");
    const rows = await versionsOf(workId);
    expect(rows.versions).toHaveLength(2);
    expect(rows.current).toBe(rows.versions.find((v) => v.upload_id === v1.id)?.id);
    expect(v2.row.work_id).toBe(rows.workId);
    // Stored, with its own files, but the reader still gets v1 whole.
    expect(rows.versions.find((v) => v.upload_id === v2.id)?.chapterNumbers).toEqual([1, 2, 3, 4]);
    expect(await bucketKeys(`works/${workId}/${v2.id}/`)).toHaveLength(4);
    expect(await bucketKeys(`originals/${v2.id}`)).toHaveLength(1);
    expect(await liveWork(workId)).toEqual(v1Live);
  });

  it("Newer upload with changed tags is held", async () => {
    const { workId, v1 } = await workAtV1();
    const v1Live = await liveWork(workId);

    const v2 = await ingestParsed(fixture(workId, { count: 4, freeforms: ["Another Tag"] }));

    expect(v2.row.status).toBe("held_for_review");
    const rows = await versionsOf(workId);
    expect(rows.current).toBe(rows.versions.find((v) => v.upload_id === v1.id)?.id);
    // The work's own tags are untouched, and the held version keeps its own for its approval.
    expect(await liveWork(workId)).toEqual(v1Live);
    expect(rows.versions.find((v) => v.upload_id === v2.id)?.tags).toContainEqual({
      type: "freeform",
      name: "Another Tag",
    });
  });

  it("Newer upload with changed authors is held", async () => {
    const { workId, v1 } = await workAtV1();
    const v1Live = await liveWork(workId);

    const v2 = await ingestParsed(fixture(workId, { count: 4, pseud: "someoneelse" }));

    expect(v2.row.status).toBe("held_for_review");
    const rows = await versionsOf(workId);
    expect(rows.current).toBe(rows.versions.find((v) => v.upload_id === v1.id)?.id);
    expect(await liveWork(workId)).toEqual(v1Live);
    expect(rows.versions.find((v) => v.upload_id === v2.id)?.authors).toEqual([
      { pseud: "someoneelse", user: "someoneelse" },
    ]);
  });

  it("Older upload is marked duplicate", async () => {
    const { workId, v1 } = await workAtV1();
    const v1Live = await liveWork(workId);

    const old = await ingestParsed(fixture(workId, { count: 2, updated: "2020-01-15" }));

    expect(old.row.status).toBe("duplicate");
    const rows = await versionsOf(workId);
    expect(old.row.work_id).toBe(rows.workId);
    // Stored but not used: the files are kept, and no version row is written for it.
    expect(rows.versions.map((v) => v.upload_id)).toEqual([v1.id]);
    expect(rows.current).toBe(rows.versions[0]?.id);
    expect(await bucketKeys(`works/${workId}/${old.id}/`)).toHaveLength(2);
    expect(await bucketKeys(`originals/${old.id}`)).toHaveLength(1);
    expect(await liveWork(workId)).toEqual(v1Live);
    expect(old.result.explicitAcks).toEqual(["msg-0"]);
  });

  it("Same-version upload is marked duplicate", async () => {
    const { workId } = await workAtV1();

    const same = await ingestParsed(fixture(workId, { tail: " one more word" }));

    expect(same.row.status).toBe("duplicate");
    expect((await versionsOf(workId)).versions).toHaveLength(1);
  });

  it("A replace of a hidden work leaves it hidden", async () => {
    const { workId } = await workAtV1();
    await hideWork(workId);

    const v2 = await ingestParsed(fixture(workId, { count: 4 }));

    expect(v2.row.status).toBe("live");
    const rows = await versionsOf(workId);
    expect(rows.status).toBe("hidden");
    expect(rows.current).toBe(rows.versions.find((v) => v.upload_id === v2.id)?.id);
  });

  it("Two uploads of the same work processed at once", async () => {
    const { workId } = await workAtV1();
    // Both are read against v1 before either writes. Whichever commits second is decided again
    // against the first: more chapters beats a later date, and a later date beats the first's
    // date, so both replace, in either order.
    const meet = rendezvous(2);
    const bucket = meetBeforeOriginal(meet);
    const [newer, later] = await Promise.all([
      ingestParsed(fixture(workId, { count: 4 }), { bucket }),
      ingestParsed(fixture(workId, { updated: "2020-03-01" }), { bucket }),
    ]);

    expect([newer.row.status, later.row.status]).toEqual(["live", "live"]);
    const rows = await versionsOf(workId);
    expect(rows.versions).toHaveLength(3);
    const current = rows.versions.find((v) => v.id === rows.current);
    expect([newer.id, later.id]).toContain(current?.upload_id);
    // Complete, and everything the reader gets belongs to it.
    expect(current?.chapterNumbers).toHaveLength(current?.chapter_count ?? -1);
    const live = await liveWork(workId);
    expect(live?.chapters).toHaveLength(current?.chapter_count ?? -1);
    expect(live?.chapters.every((c) => c.r2_key.startsWith(current?.r2_prefix ?? "?"))).toBe(true);
    // The other one is kept.
    expect(rows.versions.map((v) => v.upload_id)).toEqual(
      expect.arrayContaining([newer.id, later.id]),
    );
  });

  it("Two different files of one newer version at once leave one live and one duplicate", async () => {
    const { workId } = await workAtV1();
    // The same facts (four chapters, one date) in two files that differ in their text. Both
    // read v1 and decide it a replace. A save that wrote the replace unconditionally would
    // leave both live; the loser must match no row, read the winner and find itself a duplicate.
    const meet = rendezvous(2);
    const bucket = meetBeforeOriginal(meet);
    const [a, b] = await Promise.all([
      ingestParsed(fixture(workId, { count: 4, tail: " first file" }), { bucket }),
      ingestParsed(fixture(workId, { count: 4, tail: " second file" }), { bucket }),
    ]);

    expect([a.row.status, b.row.status].sort()).toEqual(["duplicate", "live"]);
    const winner = a.row.status === "live" ? a : b;
    const loser = winner === a ? b : a;
    const rows = await versionsOf(workId);
    // v1, and the winner's version: the duplicate has none.
    const uploads = rows.versions.map((v) => v.upload_id);
    expect(uploads).toHaveLength(2);
    expect(uploads).toContain(winner.id);
    expect(uploads).not.toContain(loser.id);
    expect(rows.current).toBe(rows.versions.find((v) => v.upload_id === winner.id)?.id);
    expect(loser.row.work_id).toBe(rows.workId);
    const live = await liveWork(workId);
    expect(live?.chapters).toHaveLength(4);
    expect(live?.chapters.every((c) => c.r2_key.startsWith(`works/${workId}/${winner.id}/`))).toBe(
      true,
    );
    expect(winner.result.explicitAcks).toEqual(["msg-0"]);
    expect(loser.result.explicitAcks).toEqual(["msg-0"]);
  });

  it("A hold decided against a version that was replaced meanwhile is decided again", async () => {
    const { workId } = await workAtV1();
    // B read v1 and decided to hold (chapter 2 rewritten); then A replaces v1 with the same
    // four chapters but for chapter 2. Against A, B is not newer: a duplicate with no version
    // of its own. A hold that committed against the moved pointer would leave a third version.
    let replaced = () => {};
    const aDone = new Promise<void>((resolve) => (replaced = resolve));
    let read = () => {};
    const bRead = new Promise<void>((resolve) => (read = resolve));
    const heldCandidate = ingestParsed(fixture(workId, { count: 4, rewritten: [2] }), {
      // The first write is after the job's read of the work; the last waits for A to commit.
      bucket: beforePut(async (key) => {
        read();
        if (key.startsWith("originals/")) await aDone;
      }),
    });
    await bRead;
    const a = await ingestParsed(fixture(workId, { count: 4 }));
    replaced();
    const b = await heldCandidate;

    expect(a.row.status).toBe("live");
    expect(b.row.status).toBe("duplicate");
    const rows = await versionsOf(workId);
    expect(rows.versions.map((v) => v.upload_id)).not.toContain(b.id);
    expect(rows.versions).toHaveLength(2);
    expect(rows.current).toBe(rows.versions.find((v) => v.upload_id === a.id)?.id);
  });

  it("Two first uploads of a work at once leave one version and one duplicate or replace", async () => {
    const workId = freshAo3WorkId();
    // Neither finds the work, so both try to create it: the loser's insert waits for the winner,
    // conflicts, and is decided as a later upload (not newer: a duplicate).
    const meet = rendezvous(2);
    const bucket = meetBeforeOriginal(meet);
    const [a, b] = await Promise.all([
      ingestParsed(fixture(workId, { tail: " first file" }), { bucket }),
      ingestParsed(fixture(workId, { tail: " second file" }), { bucket }),
    ]);

    expect([a.row.status, b.row.status].sort()).toEqual(["duplicate", "live"]);
    const rows = await versionsOf(workId);
    expect(rows.versions).toHaveLength(1);
    expect(rows.current).toBe(rows.versions[0]?.id);
    expect(await liveWork(workId).then((w) => w?.chapters)).toHaveLength(3);
  });
});
