import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ao3Epub, zipEntries, type SpineFile } from "../../../packages/epub/test/helpers";
import { ingestReal, liveWork, versionsOf } from "./helpers";

// AO3 work ids 40600-40649 are this file's. Synthetic text only.

/** Rebuilds an epub with `edit` applied to one entry's text. */
function patchEntry(epub: Uint8Array, name: string, edit: (text: string) => string): Uint8Array {
  const entries = unzipSync(epub);
  if (!(name in entries)) throw new Error(`patchEntry: no entry ${name}`);
  const patched: Record<string, string | Uint8Array> = {};
  for (const [path, data] of Object.entries(entries)) {
    if (path === "mimetype") continue; // zipEntries writes it again, first
    if (path !== name) {
      patched[path] = data;
      continue;
    }
    const before = strFromU8(data);
    const after = edit(before);
    if (after === before) throw new Error(`patchEntry: edit changed nothing in ${name}`);
    patched[path] = after;
  }
  return zipEntries(patched);
}

/** Three chapters, one file each, each with its own heading for the table of contents to anchor on. */
const chapterFiles = (plainHeadings = false): SpineFile[] =>
  [1, 2, 3].map((n) => ({
    name: `Review_${n}.xhtml`,
    body: `<div id="chapters"><h2${plainHeadings ? "" : ` class="toc-heading"`} id="t${n}">Chapter ${n}</h2><div class="userstuff2"><p>marker-r${n} some synthetic words</p></div></div>`,
  }));
const navPoints = [1, 2, 3].map((n) => ({ label: `${n}. Chapter`, src: `Review_${n}.xhtml` }));

/** A three-chapter epub of `workId` whose Stats line says `stats`. */
const threeChapters = (workId: number, stats: string) =>
  ao3Epub({ workId, stats, files: chapterFiles(), navPoints });

/** Ingests `epub`, expecting the upload live, and returns the work's one version row. */
async function ingestedLive(epub: Uint8Array, workId: number) {
  const { row } = await ingestReal(epub);
  expect(row.status).toBe("live");
  const rows = await versionsOf(workId);
  expect(rows.versions).toHaveLength(1);
  expect(rows.current).toBe(rows.versions[0]?.id);
  return rows.versions[0]!;
}

describe("06-ao3-preface-and-chapters: review reasons", () => {
  it("OPF work URL disagreeing with the preface is a review reason", async () => {
    const workId = 40600;
    const epub = patchEntry(ao3Epub({ workId }), "content.opf", (opf) =>
      opf.replace(
        "</metadata>",
        `<dc:identifier>http://archiveofourown.org/works/40601</dc:identifier></metadata>`,
      ),
    );

    const version = await ingestedLive(epub, workId);

    const live = await liveWork(workId);
    expect(live?.work.ao3_work_id).toBe(workId);
    expect(await liveWork(40601)).toBeNull();
    expect(version.review_reasons).toEqual([`work_id_mismatch: preface ${workId}, OPF 40601`]);
    expect(version.checked_at).toBeNull();
    expect(live?.version.review_reasons).toEqual(version.review_reasons);
  });

  it("Native file with no rating goes live with missing_rating", async () => {
    const workId = 40602;
    const epub = patchEntry(ao3Epub({ workId }), "Synthetic_preface.xhtml", (html) =>
      html.replace(/<dt class="calibre3">Rating:<\/dt><dd class="calibre4">.*?<\/dd>/s, ""),
    );

    const version = await ingestedLive(epub, workId);

    expect(version.review_reasons).toEqual(["missing_rating"]);
    expect(version.rating).toBeNull();
    expect(version.checked_at).toBeNull();
  });

  it("One chapter per file as a last resort goes live with the notice", async () => {
    const workId = 40603;
    const epub = ao3Epub({
      workId,
      stats: "Chapters: 3/3",
      files: chapterFiles(true),
      navPoints: [],
    });

    const version = await ingestedLive(epub, workId);

    expect(version.review_reasons).toEqual([expect.stringMatching(/^chapters_one_per_file/)]);
    expect(version.chapterNumbers).toEqual([1, 2, 3]);
    expect(version.checked_at).toBeNull();
  });

  it("Chapter count matching Stats goes live without the notice", async () => {
    const workId = 40604;

    const version = await ingestedLive(threeChapters(workId, "Chapters: 3/3"), workId);

    expect(version.chapterNumbers).toEqual([1, 2, 3]);
    expect(version.review_reasons).toEqual([]);
    expect(version.checked_at).toBeNull();
    expect((await liveWork(workId))?.version.review_reasons).toEqual([]);
  });

  it("Chapter count not matching Stats goes live with the notice", async () => {
    const workId = 40605;

    const version = await ingestedLive(threeChapters(workId, "Chapters: 2/3"), workId);

    expect(version.chapterNumbers).toEqual([1, 2, 3]);
    expect(version.review_reasons).toEqual(["chapter_count_mismatch: parsed 3, Stats says 2"]);
    expect(version.hold_reason).toBeNull();
    expect(version.checked_at).toBeNull();
  });

  const orphan: SpineFile = {
    name: "Review_2b.xhtml",
    body: `<div class="userstuff2"><p>marker-orphan</p></div>`,
  };
  // SAFETY: chapterFiles builds three.
  const [one, two, three] = chapterFiles() as [SpineFile, SpineFile, SpineFile];

  it.each([
    {
      reason: "content_outside_chapters",
      workId: 40606,
      epub: (workId: number) =>
        ao3Epub({
          workId,
          stats: "Chapters: 3/3",
          files: [one, two, orphan, three],
          navPoints,
        }),
    },
    {
      reason: "unread_manifest_item",
      workId: 40607,
      epub: (workId: number) =>
        ao3Epub({
          workId,
          stats: "Chapters: 3/3",
          files: chapterFiles(),
          navPoints,
          extraManifest: [{ href: "images/p.bmp", mediaType: "image/bmp", data: "BM" }],
        }),
    },
    {
      reason: "missing_title",
      workId: 40608,
      epub: (workId: number) =>
        ao3Epub({ workId, title: "", stats: "Chapters: 3/3", files: chapterFiles(), navPoints }),
    },
    {
      reason: "title_mismatch",
      workId: 40609,
      epub: (workId: number) =>
        patchEntry(threeChapters(workId, "Chapters: 3/3"), "content.opf", (opf) =>
          opf.replace("<dc:title>Synthetic Work</dc:title>", "<dc:title>Another Title</dc:title>"),
        ),
    },
  ])("Other review reasons also go live with the notice: $reason", async (c) => {
    const version = await ingestedLive(c.epub(c.workId), c.workId);

    expect(version.review_reasons).toEqual([expect.stringMatching(new RegExp(`^${c.reason}`))]);
    expect(version.chapterNumbers).toEqual([1, 2, 3]);
    expect(version.hold_reason).toBeNull();
    expect(version.checked_at).toBeNull();
  });
});
