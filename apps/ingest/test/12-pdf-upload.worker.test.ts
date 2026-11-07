import { env } from "cloudflare:workers";
import { makeVersionCurrent } from "@archive/db";
import { inject, describe, expect, it } from "vitest";
import {
  addOptOut,
  bucketKeys,
  bucketText,
  deactivateOptOut,
  deliver,
  hideWork,
  liveWork,
  pendingUpload,
  uploadRow,
  versionsOf,
  withDb,
} from "./helpers";
import { ao3Epub } from "../../../packages/epub/test/helpers";
import { PDF_MAX_BYTES } from "../src/pdf";
import { PDF_LIMITS } from "../src/pdf/preflight";
import { ingestWorker } from "../src/worker";
import { ao3Pdf, flate, layoutPdf, onePage, pagesPdf, type PdfLine } from "./pdf-builder";

const base64Bytes = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Ingests a synthetic PDF with the real processor and save, and returns the upload's row. */
async function ingestPdf(bytes: Uint8Array) {
  const id = await pendingUpload(bytes);
  const result = await deliver([{ upload_id: id }]);
  return { id, row: await uploadRow(id), result };
}

describe("12-pdf-upload", () => {
  describe("Which files are accepted", () => {
    it("A PDF of an AO3 work is accepted", async () => {
      const workId = 8813710;
      const { id, row, result } = await ingestPdf(
        ao3Pdf({
          workId,
          title: "A synthetic title",
          summary: ["The summary words."],
          notes: ["The notes words."],
          endNotes: ["The end notes words."],
          chapters: [
            { heading: "Chapter 1: The first", paragraphs: ["First para.", "Second para."] },
            { heading: "Chapter 2", paragraphs: ["Third para."] },
          ],
        }),
      );

      expect(row.status).toBe("live");
      expect(result.explicitAcks).toEqual(["msg-0"]);
      const live = await liveWork(workId);
      expect(live?.work.title).toBe("A synthetic title");
      expect(live?.work.rating).toBe("Teen And Up Audiences");
      expect(live?.work.language).toBe("English");
      expect(live?.work.chapters_count).toBe(2);
      expect(live?.work.summary_html).toContain("The summary words.");
      expect(live?.authors).toEqual([{ pseud: "Synthetic Author", ao3_user: "synthetic_author" }]);
      const names = (type: string) => live?.tags.filter((t) => t.type === type).map((t) => t.name);
      expect(names("fandom")).toEqual(["Synthetic Fandom"]);
      expect(names("character")).toEqual(["Person A", "Person B"]);
      expect(names("freeform")).toEqual(["Filler Tag, With A Comma", "Plain Tag"]);
      expect(live?.version.review_reasons).toEqual(["from_pdf"]);
      expect(live?.version.original_format).toBe("pdf");
      expect(live?.chapters.map((c) => c.title)).toEqual(["Chapter 1: The first", "Chapter 2"]);
      const first = await bucketText(live!.chapters[0]!.r2_key);
      expect(first).toBe("<p>First para.</p>\n<p>Second para.</p>");
      expect(await bucketKeys(`originals/${id}`)).toEqual([`originals/${id}.pdf`]);
      const original = await env.BUCKET.get(`originals/${id}.pdf`);
      expect(original?.httpMetadata?.contentType).toBe("application/pdf");
      expect(await bucketText(live!.chapters[1]!.r2_key)).toBe("<p>Third para.</p>");
    });
  });

  describe("Which files are accepted, continued", () => {
    it("A PDF with no such line is refused", async () => {
      const { id, row, result } = await ingestPdf(
        ao3Pdf({ workId: 8813711, noPostedLine: true, linkWorkId: 8813711 }),
      );

      expect(row.status).toBe("not_ao3");
      expect(result.explicitAcks).toEqual(["msg-0"]);
      expect(await bucketKeys(`originals/${id}`)).toEqual([]);
    });

    it("A printed URL and a link that disagree are looked at", async () => {
      const printed = 8813712;
      const { row } = await ingestPdf(
        ao3Pdf({ workId: printed, printedWorkId: printed, linkWorkId: 8813713 }),
      );

      expect(row.status).toBe("live");
      const live = await liveWork(printed);
      expect(live?.version.review_reasons.some((r) => r.startsWith("work_id_mismatch"))).toBe(true);
    });

    it("Tags come from links, then from print", async () => {
      const workId = 8813714;
      await ingestPdf(ao3Pdf({ workId, tagLinks: false }));

      const live = await liveWork(workId);
      expect(live?.version.review_reasons).toContain("tags_from_print");
      const names = (type: string) => live?.tags.filter((t) => t.type === type).map((t) => t.name);
      expect(names("rating")).toEqual(["Teen And Up Audiences"]);
      expect(names("character")).toEqual(["Person A", "Person B"]);
      // The tag holding ", " can't be told apart from two tags: that's why it's flagged.
      expect(names("freeform")).toEqual(["Filler Tag", "With A Comma", "Plain Tag"]);
    });

    it("Tags come from links, then from print: each link is one tag, deduped by URL", async () => {
      const workId = 8813715;
      const name = "Doubled Tag";
      await ingestPdf(ao3Pdf({ workId, tags: { "Additional Tags": [name, name] } }));

      const live = await liveWork(workId);
      expect(live?.tags.filter((t) => t.type === "freeform").map((t) => t.name)).toEqual([name]);
      expect(live?.version.review_reasons).not.toContain("tags_from_print");
    });

    it("Tags come from links, then from print: the byline may come before the fields", async () => {
      const workId = 8813730;
      const tagUrl = (name: string) => `https://archiveofourown.org/tags/${name}`;
      const lines: PdfLine[] = [
        {
          text: `Posted originally on the Archive of Our Own at https://archiveofourown.org/works/${workId}.`,
        },
        { text: "The title first", size: 18, gap: 10 },
        { text: "by Someone", url: "https://archiveofourown.org/users/someone" },
        { text: "Rating:", gap: 10 },
        { text: "Mature", url: tagUrl("Mature") },
        { text: "Fandom:" },
        { text: "Synthetic", url: tagUrl("Synthetic") },
        { text: "Language: Klingon" },
        { text: "Stats: Published: 2020-01-01 Chapters: 1/1" },
        { text: "Summary", gap: 8 },
        { text: "The summary.", x: 90 },
        { text: "The text.", newPage: true },
      ];
      await ingestPdf(layoutPdf(lines));

      const live = await liveWork(workId);
      expect(live?.work.title).toBe("The title first");
      expect(live?.work.rating).toBe("Mature");
      expect(live?.work.language).toBe("Klingon");
      expect(live?.tags.filter((t) => t.type === "fandom").map((t) => t.name)).toEqual([
        "Synthetic",
      ]);
      expect(live?.work.published_at).not.toBeNull();
    });

    it("Tags come from links, then from print: several labels may share a line", async () => {
      const workId = 8813731;
      const tagUrl = (name: string) => `https://archiveofourown.org/tags/${name}`;
      const fields = "Rating: Mature Archive Warning: Creator Chose Not To Use";
      const lines: PdfLine[] = [
        {
          text: `Posted originally on the Archive of Our Own at https://archiveofourown.org/works/${workId}.`,
        },
        {
          text: fields,
          links: [
            { url: tagUrl("Mature"), at: fields.indexOf("Mature"), length: 6 },
            { url: tagUrl("Unused"), at: fields.indexOf("Creator"), length: 24 },
          ],
        },
        { text: "Stats: Published: 2020-01-01 Chapters: 1/1" },
        { text: "A title", size: 18, gap: 10 },
        { text: "by Someone", url: "https://archiveofourown.org/users/someone" },
        { text: "The text.", gap: 10 },
      ];
      await ingestPdf(layoutPdf(lines));

      const live = await liveWork(workId);
      expect(live?.work.rating).toBe("Mature");
      expect(live?.tags.filter((t) => t.type === "warning").map((t) => t.name)).toEqual(["Unused"]);
    });

    it("An anonymous work has no author link", async () => {
      const workId = 8813716;
      await ingestPdf(ao3Pdf({ workId, anonymous: true, strayUserLink: true }));

      const live = await liveWork(workId);
      expect(live?.authors).toEqual([{ pseud: "Anonymous", ao3_user: null }]);
    });

    it("A /users/ link outside the byline isn't taken for an author", async () => {
      const workId = 8813717;
      await ingestPdf(ao3Pdf({ workId, strayUserLink: true }));

      const live = await liveWork(workId);
      expect(live?.authors).toEqual([{ pseud: "Synthetic Author", ao3_user: "synthetic_author" }]);
    });

    it("The chapter count must match", async () => {
      const { id, row, result } = await ingestPdf(
        ao3Pdf({
          workId: 8813718,
          stats: "Published: 2020-01-01 Chapters: 3/3",
          chapters: [
            { heading: "Chapter 1", paragraphs: ["One."] },
            { heading: "Chapter 2", paragraphs: ["Two."] },
          ],
        }),
      );

      expect(row.status).toBe("pdf_unreadable");
      expect(row.error_stage).toBe("process");
      expect(result.explicitAcks).toEqual(["msg-0"]);
      expect(result.retryMessages).toEqual([]);
      expect(await bucketKeys(`originals/${id}`)).toEqual([]);
    });

    it("The chapter count must match: an outline can tell them apart", async () => {
      const workId = 8813719;
      await ingestPdf(
        ao3Pdf({
          workId,
          outlineChapters: true,
          chapters: [
            { heading: "Part one", paragraphs: ["One."] },
            { heading: "Part two", paragraphs: ["Two."] },
          ],
        }),
      );

      const live = await liveWork(workId);
      expect(live?.chapters.map((c) => c.title)).toEqual(["Part one", "Part two"]);
      expect(await bucketText(live!.chapters[1]!.r2_key)).toBe("<p>Two.</p>");
    });

    it("A work with one chapter has nothing to split", async () => {
      const workId = 8813720;
      const title = "The one chapter";
      await ingestPdf(
        ao3Pdf({
          workId,
          title,
          stats: null,
          summary: ["Summary words."],
          endNotes: ["End words."],
          chapters: [{ paragraphs: ["First para.", "Second para."] }],
        }),
      );

      const live = await liveWork(workId);
      expect(live?.work.chapters_count).toBe(1);
      expect(live?.work.summary_html).toBe("<p>Summary words.</p>");
      expect(live?.chapters[0]?.title).toBe(title);
      expect(await bucketText(live!.chapters[0]!.r2_key)).toBe(
        "<p>First para.</p>\n<p>Second para.</p>",
      );
    });

    it("A work with one chapter has nothing to split: no summary and no break", async () => {
      const workId = 8813721;
      const lines: PdfLine[] = [
        {
          text: `Posted originally on the Archive of Our Own at https://archiveofourown.org/works/${workId}.`,
        },
        { text: "Rating: General Audiences" },
        { text: "Stats: Published: 2020-01-01 Chapters: 1/1" },
        { text: "No summary here", size: 18, gap: 10 },
        { text: "by Someone", url: "https://archiveofourown.org/users/someone" },
        { text: "Just the text.", gap: 10 },
      ];
      await ingestPdf(layoutPdf(lines));

      const live = await liveWork(workId);
      expect(await bucketText(live!.chapters[0]!.r2_key)).toBe("<p>Just the text.</p>");
    });
  });

  describe("An epub wins", () => {
    const pdfOf = (workId: number, updated: string, count = 1, words = "Words of the PDF.") =>
      ao3Pdf({
        workId,
        stats: `Published: 2019-01-01 Updated: ${updated} Words: 10 Chapters: ${count}/${count}`,
        chapters: Array.from({ length: count }, (_, i) => ({
          heading: `Chapter ${i + 1}`,
          paragraphs: [`${words} ${i}`],
        })),
      });
    const epubOf = (workId: number, updated: string, count = 1) =>
      ao3Epub({
        workId,
        pseud: "epubauthor",
        stats: `Published: 2019-01-01 Updated: ${updated} Words: 10 Chapters: ${count}/${count}`,
        files: Array.from({ length: count }, (_, i) => ({
          name: `c${i + 1}.xhtml`,
          body: `<div id="chapters" class="userstuff1"><h2 class="toc-heading" id="toc_${i}">Chapter ${i + 1}</h2><div class="userstuff2"><p>Different words of the epub, chapter ${i}.</p></div></div>`,
        })),
      });

    it("An epub replaces a PDF", async () => {
      const workId = 8813740;
      const first = await ingestPdf(pdfOf(workId, "2020-02-01"));
      expect(first.row.status).toBe("live");

      const second = await ingestPdf(epubOf(workId, "2020-02-01"));

      expect(second.row.status).toBe("live");
      const live = await liveWork(workId);
      expect(live?.version.original_format).toBe("epub");
      expect(live?.version.original_upload_id).toBe(second.id);
      expect(live?.version.review_reasons).not.toContain("from_pdf");
    });

    it("An epub replaces a PDF: more chapters, whatever the date", async () => {
      const workId = 8813741;
      await ingestPdf(pdfOf(workId, "2020-02-01"));

      const second = await ingestPdf(epubOf(workId, "2019-06-01", 2));

      expect(second.row.status).toBe("live");
      expect((await liveWork(workId))?.work.chapters_count).toBe(2);
    });

    it("An epub replaces a PDF: a moderator's hide still applies", async () => {
      const workId = 8813742;
      await ingestPdf(pdfOf(workId, "2020-02-01"));
      await hideWork(workId);

      const second = await ingestPdf(epubOf(workId, "2020-03-01"));

      expect(second.row.status).toBe("live");
      expect(await liveWork(workId)).toBeNull();
    });

    it("An older epub doesn't replace a newer PDF", async () => {
      const workId = 8813743;
      const first = await ingestPdf(pdfOf(workId, "2020-02-01"));

      const second = await ingestPdf(epubOf(workId, "2020-01-15"));

      expect(second.row.status).toBe("duplicate");
      expect((await liveWork(workId))?.version.original_upload_id).toBe(first.id);
    });

    it("A PDF never replaces an epub", async () => {
      const workId = 8813744;
      const first = await ingestPdf(epubOf(workId, "2020-02-01"));

      const later = await ingestPdf(pdfOf(workId, "2021-01-01"));
      const same = await ingestPdf(pdfOf(workId, "2020-02-01"));

      expect(later.row.status).toBe("duplicate");
      expect(same.row.status).toBe("duplicate");
      expect(later.row.work_id).not.toBeNull();
      expect((await liveWork(workId))?.version.original_upload_id).toBe(first.id);
    });

    it("A PDF with more chapters than the current epub is held for a moderator", async () => {
      const workId = 8813745;
      const first = await ingestPdf(epubOf(workId, "2020-02-01"));

      const longer = await ingestPdf(pdfOf(workId, "2019-01-01", 2));

      expect(longer.row.status).toBe("held_for_review");
      const live = await liveWork(workId);
      expect(live?.version.original_upload_id).toBe(first.id);
      const { versions } = await versionsOf(workId);
      const held = versions.find((v) => v.upload_id === longer.id);
      expect(held?.hold_reason).toBe("pdf_more_chapters");

      // A moderator can make it current, as any version.
      await withDb((db) => makeVersionCurrent(db, live!.work.id, held!.id));
      const after = await liveWork(workId);
      expect(after?.version.original_upload_id).toBe(longer.id);
      expect(after?.version.original_format).toBe("pdf");
    });

    it("A PDF follows the rules against a PDF", async () => {
      const workId = 8813746;
      await ingestPdf(pdfOf(workId, "2020-02-01", 1, "Words."));

      const notNewer = await ingestPdf(pdfOf(workId, "2020-02-01", 1, "Words."));
      expect(notNewer.row.status).toBe("duplicate");

      const newer = await ingestPdf(pdfOf(workId, "2020-03-01", 1, "Words."));
      expect(newer.row.status).toBe("live");

      const rewritten = await ingestPdf(
        pdfOf(workId, "2020-04-01", 1, "Wholly other text with nothing the same in it at all now."),
      );
      expect(rewritten.row.status).toBe("held_for_review");
      const held = (await versionsOf(workId)).versions.find((v) => v.upload_id === rewritten.id);
      expect(held?.hold_reason).toBe("chapters_changed");
    });
  });

  describe("Everything that handles an original handles a PDF", () => {
    it("The re-sanitize backfill knows a PDF", async () => {
      const workId = 8813750;
      const { id } = await ingestPdf(ao3Pdf({ workId }));
      const before = await versionsOf(workId);
      let opened = 0;
      const handler = ingestWorker({
        loadPdfParser: async () => {
          opened++;
          const { pdfParser } = await import("../src/pdf/parser");
          return pdfParser();
        },
      });

      const result = await deliver([{ work_id: before.workId, version_id: before.current }], {
        queue: "ingest-backfill",
        handler,
      });

      expect(result.explicitAcks).toEqual(["msg-0"]);
      expect(opened).toBe(1);
      const after = await versionsOf(workId);
      expect(after.current).not.toBe(before.current);
      const live = await liveWork(workId);
      expect(live?.version.original_upload_id).toBe(id);
      expect(live?.version.original_format).toBe("pdf");
      expect(live?.version.review_reasons).toEqual(["from_pdf"]);
    });

    it("A refused PDF's original doesn't stay behind, whichever key it reached", async () => {
      const pseud = "Opted Out 8813751";
      const id = await pendingUpload(
        ao3Pdf({ workId: 8813751, authors: [{ pseud, user: "optedout8813751" }] }),
      );
      await env.BUCKET.put(`originals/${id}.pdf`, "left by an earlier attempt");
      const optOut = await addOptOut(pseud.toLowerCase());

      await deliver([{ upload_id: id }]);

      expect((await uploadRow(id)).status).toBe("opted_out");
      expect(await bucketKeys(`originals/${id}`)).toEqual([]);
      await deactivateOptOut(optOut);
    });
  });

  describe("Nothing else changes", () => {
    it("Epubs behave as they did: unpdf isn't loaded for one", async () => {
      const workId = 8813752;
      const id = await pendingUpload(ao3Epub({ workId }));
      let loaded = 0;
      const handler = ingestWorker({
        loadPdfParser: async () => {
          loaded++;
          throw new Error("an epub must not load the PDF parser");
        },
      });

      await deliver([{ upload_id: id }], { handler });

      expect(loaded).toBe(0);
      expect((await uploadRow(id)).status).toBe("live");
      expect(await bucketKeys(`originals/${id}`)).toEqual([`originals/${id}.epub`]);
    });
  });

  describe("Uploading", () => {
    it("A file's bytes decide what it is", async () => {
      // A PDF at an epub's key and type: it goes to the PDF processor.
      const workId = 8813722;
      const { row } = await ingestPdf(ao3Pdf({ workId }));
      expect(row.status).toBe("live");
      expect((await liveWork(workId))?.version.original_format).toBe("pdf");
      // An epub goes to the epub processor, and random bytes end `not_epub`.
      const epub = await ingestPdf(ao3Epub({ workId: 8813723 }));
      expect(epub.row.status).toBe("live");
      expect((await liveWork(8813723))?.version.original_format).toBe("epub");
      const random = await ingestPdf(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
      expect(random.row.status).toBe("not_epub");
    });
  });

  describe("What a reader gets", () => {
    it("The text is built, not copied", async () => {
      const workId = 8813724;
      await ingestPdf(
        ao3Pdf({
          workId,
          chapters: [
            { paragraphs: ["<script>alert(1)</script> & <b>bold</b>", "* * *", "After."] },
          ],
        }),
      );

      const live = await liveWork(workId);
      expect(await bucketText(live!.chapters[0]!.r2_key)).toBe(
        "<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;bold&lt;/b&gt;</p>\n<p>* * *</p>\n<p>After.</p>",
      );
    });

    it("The text is built, not copied: lines wrap into paragraphs by their layout", async () => {
      const workId = 8813732;
      const full = "A full line of synthetic words that runs out to the right margin here";
      const lines: PdfLine[] = [
        {
          text: `Posted originally on the Archive of Our Own at https://archiveofourown.org/works/${workId}.`,
        },
        { text: "Stats: Published: 2020-01-01 Chapters: 1/1" },
        { text: "A title", size: 18, gap: 10 },
        { text: "by Someone", url: "https://archiveofourown.org/users/someone" },
        { text: full, gap: 10 },
        { text: full },
        { text: "A short end." },
        // No gap: only the short line above says this is a new paragraph.
        { text: full },
        { text: full },
        { text: full },
        { text: full },
        { text: "Another end." },
      ];
      await ingestPdf(layoutPdf(lines));

      const live = await liveWork(workId);
      expect(await bucketText(live!.chapters[0]!.r2_key)).toBe(
        `<p>${full} ${full} A short end.</p>\n<p>${full} ${full} ${full} ${full} Another end.</p>`,
      );
    });

    it("Chapters read as ordinary chapters: chapter notes stay in the chapter", async () => {
      const workId = 8813725;
      await ingestPdf(
        ao3Pdf({
          workId,
          summary: ["Work summary."],
          chapters: [
            { heading: "Chapter 1", paragraphs: ["Chapter Summary", "A summary.", "The text."] },
            { heading: "Chapter 2", paragraphs: ["Chapter Notes", "A note.", "More text."] },
          ],
        }),
      );

      const live = await liveWork(workId);
      expect(live?.work.summary_html).toBe("<p>Work summary.</p>");
      expect(await bucketText(live!.chapters[1]!.r2_key)).toBe(
        "<p>Chapter Notes</p>\n<p>A note.</p>\n<p>More text.</p>",
      );
    });

    it("Chapters read as ordinary chapters: the pointer to the end notes is dropped", async () => {
      const workId = 8813726;
      await ingestPdf(
        ao3Pdf({
          workId,
          chapters: [{ paragraphs: ["(See the end of the work for more notes.)", "The text."] }],
        }),
      );

      const live = await liveWork(workId);
      expect(await bucketText(live!.chapters[0]!.r2_key)).toBe("<p>The text.</p>");
    });

    it("Italics and images are left out", async () => {
      const workId = 8813727;
      const { row } = await ingestPdf(ao3Pdf({ workId }));
      expect(row.status).toBe("live");
      const live = await liveWork(workId);
      expect(await bucketKeys(`works/${workId}/img/`)).toEqual([]);
      expect(await bucketText(live!.chapters[0]!.r2_key)).not.toContain("<img");
    });
  });

  describe("Hostile files, end to end", () => {
    it("Encrypted and corrupt files are refused", async () => {
      let opened = 0;
      const handler = ingestWorker({
        loadPdfParser: async () => {
          opened++;
          throw new Error("the parser must not open this file");
        },
      });
      const file = onePage(flate("x"), { trailerExtra: "/Encrypt 4 0 R" });
      const id = await pendingUpload(file);

      const result = await deliver([{ upload_id: id }], { handler });

      expect(opened).toBe(0);
      expect((await uploadRow(id)).status).toBe("pdf_unreadable");
      expect(result.explicitAcks).toEqual(["msg-0"]);
      expect(result.retryMessages).toEqual([]);
    });

    it("Encrypted and corrupt files are refused: what the parser throws on is final", async () => {
      const { row, result } = await ingestPdf(
        onePage(flate("x"), { trailerExtra: "/Root 99 0 R" }),
      );

      expect(row.status).toBe("pdf_unreadable");
      expect(result.retryMessages).toEqual([]);
    });

    it("Too many objects or pages are refused", async () => {
      const { row, result } = await ingestPdf(pagesPdf(PDF_LIMITS.maxPages + 1));

      expect(row.status).toBe("pdf_unreadable");
      expect(result.explicitAcks).toEqual(["msg-0"]);
    });

    it("A larger PDF is too large, by its bytes, whatever it was sent as", async () => {
      const padded = new Uint8Array(PDF_MAX_BYTES + 1);
      padded.set(onePage(flate("x")));
      const { row, result } = await ingestPdf(padded);

      expect(row.status).toBe("too_large");
      expect(row.error_stage).toBe("read");
      expect(result.explicitAcks).toEqual(["msg-0"]);
    });

    it("A long parse keeps its lease", async () => {
      const workId = 8813728;
      const pages = Array.from({ length: 200 }, (_, i) => `Page ${i} of filler.`);
      const id = await pendingUpload(
        ao3Pdf({
          workId,
          chapters: [{ paragraphs: pages.flatMap((p) => Array<string>(30).fill(p)) }],
        }),
      );
      const claimed: (Date | null)[] = [];
      const handler = ingestWorker({
        timing: { seconds: 60, renewSeconds: 0.01 },
        loadPdfParser: async () => {
          const { pdfParser } = await import("../src/pdf/parser");
          const parser = pdfParser();
          return {
            read: async (bytes) => {
              claimed.push((await uploadRow(id)).lease_until);
              const text = await parser.read(bytes);
              claimed.push((await uploadRow(id)).lease_until);
              return text;
            },
          };
        },
      });

      await deliver([{ upload_id: id }], { handler });

      expect(claimed[1]!.getTime()).toBeGreaterThan(claimed[0]!.getTime());
      expect((await uploadRow(id)).status).toBe("live");
    });

    it("A long parse keeps its lease: a Worker that dies mid-parse is retried", async () => {
      const id = await pendingUpload(ao3Pdf({ workId: 8813729 }));
      const handler = ingestWorker({
        process: async () => {
          throw new Error("the isolate went away");
        },
      });

      const result = await deliver([{ upload_id: id }], { handler });

      expect(result.retryMessages.map((m) => m.msgId)).toEqual(["msg-0"]);
      expect((await uploadRow(id)).status).toBe("pending");
    });
  });

  describe("Hostile files", () => {
    it("A stream that inflates too far is refused", async () => {
      // The 261 KB file that inflates to 256 MB, from "What the tests showed".
      const bomb = base64Bytes(inject("inflateBombBase64"));
      expect(bomb.length).toBeLessThan(300_000);
      const id = await pendingUpload(bomb);
      let opened = 0;
      const handler = ingestWorker({
        loadPdfParser: async () => {
          opened++;
          throw new Error("the parser must not open this file");
        },
      });

      const result = await deliver([{ upload_id: id }], { handler });

      expect(opened).toBe(0);
      const row = await uploadRow(id);
      expect(row.status).toBe("zip_bomb");
      expect(row.error_stage).toBe("process");
      expect(result.explicitAcks).toEqual(["msg-0"]);
      expect(result.retryMessages).toEqual([]);
      expect(await bucketKeys(`originals/${id}`)).toEqual([]);
    });
  });
});
