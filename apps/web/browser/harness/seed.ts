import { insertUpload, normalizeTagName } from "@archive/db";
import { putFragments, seedWork, type SeedWorkOptions } from "@archive/db/seed";
import { tagHref } from "../../src/tag-links";
import type { Site } from "./site";

/**
 * Seeds one work through `@archive/db/seed`, as the workerd tests do, and writes its chapter
 * fragments to the Worker's bucket, so its pages render. Returns what `seedWork` returns.
 */
export async function seedReadableWork(site: Site, options: SeedWorkOptions) {
  const work = await seedWork(site.db, options);
  await putFragments(site.bucket, work.fragments);
  return work;
}

/** A chapter's sanitized HTML, synthetic, with headings of its own. */
const chapter = (n: number) =>
  `<h1>Part ${n}</h1><p>Synthetic paragraph one of chapter ${n}.</p>` +
  `<h1>Part ${n}, later</h1><p>Synthetic paragraph two of chapter ${n}.</p>`;

/** What `seedInventory` made: the ids its pages' URLs need. */
export type Inventory = {
  /** A General Audiences work in three chapters, each with two <h1> of its own. */
  work: number;
  /** A Mature work with archive warnings: the warnings screen comes before its text. */
  warned: number;
  /** A work with 20+ tags and long warnings. */
  manyTags: number;
  /** A work with a very long title, in two chapters with very long titles. */
  longTitle: number;
  hidden: number;
  removed: number;
  /** A work whose current version has a review reason: listed in Works to check. */
  toCheck: number;
  /** The fandom tag the works share, as its listing's URL names it. */
  fandomPath: string;
  /** Items in the moderation queues, by id. */
  report: string;
  takedown: string;
  request: string;
};

/**
 * Seeds the works and moderation items every page of the inventory needs, with AO3 work ids
 * `firstId` to `firstId + 6` and names starting "q1b-". `uploader` is the user id of the
 * account that sees the uploads (one in each of five statuses) on My uploads. Text is
 * synthetic.
 */
export async function seedInventory(
  site: Site,
  { firstId, uploader }: { firstId: number; uploader: string },
): Promise<Inventory> {
  const fandom = { type: "fandom" as const, name: "q1b-Fandom" };
  const work = await seedReadableWork(site, {
    ao3WorkId: firstId,
    title: "q1b-Work in three chapters",
    rating: "General Audiences",
    summary: "<p>A synthetic summary.</p>",
    tags: [fandom, { type: "character", name: "q1b-Character" }],
    chapters: [1, 2, 3].map((n) => ({ title: `Chapter ${n}`, html: chapter(n), words: 20 })),
    chapterTotal: 3,
  });
  await seedReadableWork(site, {
    ao3WorkId: firstId + 1,
    title: "q1b-Work behind warnings",
    rating: "Mature",
    tags: [
      { type: "warning", name: "Graphic Depictions Of Violence" },
      { type: "warning", name: "Major Character Death" },
      fandom,
    ],
  });
  const unbroken = "a-long-unbroken-title-that-goes-on-and-on-without-any-spaces-at-all";
  const long = "q1b-a-long-unbroken-tag-name-that-goes-on-and-on-without-spaces";
  await seedReadableWork(site, {
    ao3WorkId: firstId + 2,
    title: "q1b-Work with many tags",
    rating: "Teen And Up Audiences",
    tags: [
      { type: "warning", name: `${long}-as-a-warning` },
      { type: "warning", name: "Creator Chose Not To Use Archive Warnings" },
      fandom,
      ...Array.from({ length: 22 }, (_, i) => ({
        type: "freeform" as const,
        name: i === 0 ? long : `q1b-Freeform tag ${i}`,
      })),
    ],
  });
  await seedReadableWork(site, {
    ao3WorkId: firstId + 3,
    title: `q1b-${"A very long title that keeps on going ".repeat(6).trim()}-${unbroken}`,
    rating: "General Audiences",
    tags: [fandom],
    // Two chapters, so the chapter nav has each shape (Next only, Previous only), with titles
    // as long as a title can be: one of many words, one of a single 60+ character word.
    chapters: [
      {
        title: `q1b-${"A chapter title that keeps on going ".repeat(6).trim()}`,
        html: chapter(1),
        words: 20,
      },
      { title: `q1b-${unbroken}`, html: chapter(2), words: 20 },
    ],
    chapterTotal: 2,
  });
  await seedReadableWork(site, {
    ao3WorkId: firstId + 4,
    title: "q1b-Hidden work",
    status: "hidden",
    hiddenCause: "moderator",
  });
  await seedReadableWork(site, {
    ao3WorkId: firstId + 5,
    title: "q1b-Removed work",
    status: "removed",
  });
  await seedReadableWork(site, {
    ao3WorkId: firstId + 6,
    title: "q1b-Work to check",
    rating: "General Audiences",
    reviewReasons: ["q1b-reason"],
    tags: [fandom],
  });

  const report = await site.db
    .insertInto("reports")
    .values({
      work_id: work.workId,
      reporter_id: work.userId,
      kind: "q1b-reason",
      body: "q1b-report",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const takedown = await site.db
    .insertInto("takedowns")
    .values({ work_id: work.workId, requester: "q1b-takedown@example.test", basis: "q1b-basis" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const request = await site.db
    .insertInto("requests")
    .values({
      kind: "remove_work",
      work_id: work.workId,
      contact_email: "q1b-request@example.test",
      statement: "q1b-statement",
      ip_hash: "q1b-ip-hash",
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  for (const status of ["pending", "processing", "live", "held_for_review", "not_epub"] as const) {
    const { id } = await insertUpload(site.db, {
      userId: uploader,
      r2Key: `uploads/q1b-${status}.epub`,
      bytes: 1000,
    });
    await site.db
      .updateTable("uploads")
      .set({ status, work_id: status === "live" ? work.workId : null })
      .where("id", "=", id)
      .execute();
  }

  return {
    work: firstId,
    warned: firstId + 1,
    manyTags: firstId + 2,
    longTitle: firstId + 3,
    hidden: firstId + 4,
    removed: firstId + 5,
    toCheck: firstId + 6,
    fandomPath: tagHref("fandom", normalizeTagName("fandom", fandom.name)),
    report: report.id,
    takedown: takedown.id,
    request: request.id,
  };
}
