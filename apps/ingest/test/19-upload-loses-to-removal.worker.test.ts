import { putFragments } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ao3Epub } from "../../../packages/epub/test/helpers";
import { ingestWorker, type Steps } from "../src/worker";
import {
  afterPut,
  bucketKeys,
  deliver,
  epubWithImages,
  imageBytes,
  ingestParsed,
  ingestReal,
  parsedWork,
  pendingUpload,
  seededWork,
  setWorkStatus,
  sha256Hex,
  uploadRow,
  versionsOf,
  watchedWorker,
} from "./helpers";

// RACE (#508): an upload whose work is removed while the job runs is refused as `work_removed`
// and deletes the R2 files it wrote. AO3 work ids 41200-41299 are this file's.

afterEach(() => vi.restoreAllMocks());

/** The bucket step: the work is removed right after the job's `originals/` write lands. */
const removedAfterOriginal = (ao3WorkId: number) =>
  afterPut(async (key) => {
    if (key.startsWith("originals/")) await setWorkStatus(ao3WorkId, "removed");
  });

/** Expects the upload refused as `work_removed`, acked, with none of its files left. */
async function expectLostCleanly(
  ao3WorkId: number,
  { id, row, result }: Awaited<ReturnType<typeof ingestReal>>,
) {
  expect(row.status).toBe("work_removed");
  expect(row.error_stage).toBe("save");
  expect(row.error).toBe("work_removed");
  expect(row.work_id).toBeNull();
  expect(result.explicitAcks).toEqual(["msg-0"]);
  expect(result.retryMessages).toEqual([]);
  expect(await bucketKeys(`works/${ao3WorkId}/${id}/`)).toEqual([]);
  expect(await bucketKeys(`originals/${id}`)).toEqual([]);
}

describe("RACE: an upload that loses to a removal", () => {
  it("deletes every file it wrote when a duplicate loses to the removal", async () => {
    const live = await seededWork({ ao3WorkId: 41200 });
    await putFragments(env.BUCKET, live.fragments);
    const before = await versionsOf(41200);

    const upload = await ingestReal(ao3Epub({ workId: 41200 }), {
      bucket: removedAfterOriginal(41200),
    });

    await expectLostCleanly(41200, upload);
    expect(await versionsOf(41200)).toEqual({ ...before, status: "removed" });
  });

  it("deletes every file it wrote when a replace loses to the removal", async () => {
    const live = await seededWork({ ao3WorkId: 41201 });
    await putFragments(env.BUCKET, live.fragments);
    const newer = parsedWork({
      ao3WorkId: "41201",
      stats: {
        published: "2020-01-02",
        updated: "2030-01-01",
        completed: null,
        words: 3,
        chapters: { posted: 1, total: 1 },
      },
      chapters: [{ n: 1, title: "One", html: "<p>a newer text.</p>", words: 3 }],
    });

    const upload = await ingestParsed(newer, { bucket: removedAfterOriginal(41201) });

    await expectLostCleanly(41201, upload);
  });

  it("deletes the images it wrote", async () => {
    const live = await seededWork({ ao3WorkId: 41202 });
    await putFragments(env.BUCKET, live.fragments);
    const epub = epubWithImages(41202, {
      "a.png": { mediaType: "image/png", data: imageBytes("png", "race-a") },
    });
    // Seen at the removal: the image is already written (images go before `originals/`).
    // SAFETY: the hook below assigns it.
    let seen = [] as string[];
    const bucket = afterPut(async (key) => {
      if (!key.startsWith("originals/")) return;
      seen = await bucketKeys("works/41202/");
      await setWorkStatus(41202, "removed");
    });

    // `ingestReal` hands the processor no image sink, so the real worker runs the job.
    const id = await pendingUpload(epub);
    const result = await deliver([{ upload_id: id }], { handler: ingestWorker({ bucket }) });
    const upload = { id, row: await uploadRow(id), result };

    expect(seen).toContain(`works/41202/img/${await sha256Hex(imageBytes("png", "race-a"))}`);
    await expectLostCleanly(41202, upload);
    expect(await bucketKeys("works/41202/img/")).toEqual([]);
  });

  it("leaves a neighbouring work's files alone", async () => {
    const lost = await seededWork({ ao3WorkId: 41210 });
    const neighbour = await seededWork({ ao3WorkId: 41211 });
    await putFragments(env.BUCKET, lost.fragments);
    await putFragments(env.BUCKET, neighbour.fragments);
    const neighbourBefore = await bucketKeys("works/41211/");

    await ingestReal(ao3Epub({ workId: 41210 }), { bucket: removedAfterOriginal(41210) });

    expect(neighbourBefore.length).toBeGreaterThan(0);
    expect(await bucketKeys("works/41211/")).toEqual(neighbourBefore);
    expect(await bucketKeys("works/41210/")).toEqual([]);
  });

  it("keeps the work's folder when it is restored before the clear, but deletes its original", async () => {
    const live = await seededWork({ ao3WorkId: 41220 });
    await putFragments(env.BUCKET, live.fragments);
    const folderBefore = await bucketKeys("works/41220/");
    const id = await pendingUpload(ao3Epub({ workId: 41220 }));
    const { handler } = watchedWorker({
      bucket: (real) => ({
        ...removedAfterOriginal(41220)(real),
        // The original is deleted first: a moderator restores the work just then.
        delete: async (keys) => {
          await real.delete(keys);
          if (keys.some((k) => k.startsWith("originals/"))) await setWorkStatus(41220, "live");
        },
      }),
    });

    await deliver([{ upload_id: id }], { handler });

    expect((await uploadRow(id)).status).toBe("work_removed");
    expect(await bucketKeys(`originals/${id}`)).toEqual([]);
    // The upload's own fragments go; the seeded work's own files survive.
    expect(await bucketKeys(`works/41220/${id}/`)).toEqual([]);
    expect(folderBefore.length).toBeGreaterThan(0);
    for (const key of folderBefore) expect(await env.BUCKET.head(key)).not.toBeNull();
  });

  it("deletes again on redelivery when the first clean-up failed", async () => {
    const live = await seededWork({ ao3WorkId: 41230 });
    await putFragments(env.BUCKET, live.fragments);
    const id = await pendingUpload(ao3Epub({ workId: 41230 }));
    let failures = 1;
    const failing = watchedWorker({
      bucket: (real) => ({
        ...removedAfterOriginal(41230)(real),
        delete: async (keys) => {
          if (failures-- > 0) throw new Error("injected R2 failure");
          await real.delete(keys);
        },
      }),
    });

    const first = await deliver([{ upload_id: id }], { handler: failing.handler });

    expect(first.retryMessages).toEqual([{ msgId: "msg-0" }]);
    expect(await bucketKeys(`originals/${id}`)).toHaveLength(1);

    const second = await deliver([{ upload_id: id }], { handler: watchedWorker().handler });

    expect(second.explicitAcks).toEqual(["msg-0"]);
    expect((await uploadRow(id)).status).toBe("work_removed");
    expect(await bucketKeys(`originals/${id}`)).toEqual([]);
    expect(await bucketKeys(`works/41230/${id}/`)).toEqual([]);

    // A third delivery of the finished upload does nothing, and fails nothing.
    const third = await deliver([{ upload_id: id }], { handler: watchedWorker().handler });
    expect(third.explicitAcks).toEqual(["msg-0"]);
  });

  it("ends as work_removed, not parse_failed, when the removal purges a fragment mid-read", async () => {
    const live = await seededWork({ ao3WorkId: 41240 });
    await putFragments(env.BUCKET, live.fragments);
    // As removal does: status first, then the purge, in between the save's reads.
    const bucket: NonNullable<Steps["bucket"]> = (real) => ({
      ...afterPut(async () => {})(real),
      get: async (key) => {
        if (key.startsWith("works/")) {
          await setWorkStatus(41240, "removed");
          await real.delete([key]);
        }
        return real.get(key);
      },
    });
    const id = await pendingUpload(ao3Epub({ workId: 41240 }));
    const { handler } = watchedWorker({ bucket });

    const result = await deliver([{ upload_id: id }], { attempts: 4, handler });

    const row = await uploadRow(id);
    expect(row.status).toBe("work_removed");
    expect(row.error).toBe("work_removed");
    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("logs the loss with the upload id and a count, never the AO3 work id", async () => {
    const live = await seededWork({ ao3WorkId: 41250 });
    await putFragments(env.BUCKET, live.fragments);
    const log = vi.spyOn(console, "log");

    const { id } = await ingestReal(ao3Epub({ workId: 41250 }), {
      bucket: removedAfterOriginal(41250),
    });

    type Line = { event?: string; uploadId?: string; deleted?: number };
    const logged = log.mock.calls.map(([line]): Line => {
      // SAFETY: the job logs objects; the filter below checks the event.
      return line as Line;
    });
    const lines = logged.filter((l) => l.event === "ingest.lost_to_removal");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ uploadId: id });
    expect(lines[0]?.deleted).toBeGreaterThanOrEqual(2);
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(["deleted", "event", "uploadId"]);
  });
});
