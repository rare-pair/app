import { EpubError, processEpub } from "@archive/epub";
import { describe, expect, it } from "vitest";
import { ao3Epub } from "../../../packages/epub/test/helpers";
import { TAKEDOWN_REMOVED } from "../src/lists";
import { ingestWorker, type Steps } from "../src/worker";
import {
  addOptOut,
  addTakedown,
  beforePut,
  bucketKeys,
  bucketObject,
  bucketText,
  checkVersion,
  deliver,
  epubWithImages,
  failingPut,
  freshAo3WorkId,
  hideWork,
  imageBytes,
  ingestReal,
  pendingUpload,
  seededWork,
  setWorkStatus,
  sha256Hex,
  token,
  uploadRow,
  versionsOf,
} from "./helpers";

const ORIGIN = "https://content.rarepair.fans";

const png = (fill: string) => ({ mediaType: "image/png", data: imageBytes("png", fill) });

const BACKFILL = "ingest-backfill";

/** What a sanitizer bug let through: markup the processor as it is now drops. */
const UNSAFE = `<script>unsafe()</script>`;

/**
 * Uploads `epub` and runs its job through the real save with a processor from before a
 * sanitizer fix: each chapter keeps `UNSAFE`. Returns the upload's id.
 */
async function ingestBeforeFix(epub: Uint8Array, steps: Partial<Steps> = {}) {
  const { id } = await ingestReal(epub, {
    process: async (bytes) => {
      const work = await processEpub(bytes);
      return { ...work, chapters: work.chapters.map((c) => ({ ...c, html: c.html + UNSAFE })) };
    },
    ...steps,
  });
  return { id };
}

/** The backfill message for the work's current version. */
const backfillOf = (work: { workId: string; current: string | null }) => ({
  work_id: work.workId,
  version_id: work.current,
});

describe("07-sanitizing-and-images", () => {
  it("Images inside the epub are rewritten to the content origin", async () => {
    const workId = freshAo3WorkId();
    const image = png("a");
    const id = await pendingUpload(epubWithImages(workId, { "one.png": image }));

    await deliver([{ upload_id: id }]);

    const key = await sha256Hex(image.data);
    const fragment = await bucketText(`works/${workId}/${id}/1.html`);
    expect(fragment).toContain(`<img src="${ORIGIN}/works/${workId}/img/${key}"`);
  });

  it("Image types are checked by file signature", async () => {
    const workId = freshAo3WorkId();
    const images = {
      "a.png": { mediaType: "image/png", data: imageBytes("png", "p") },
      "b.jpg": { mediaType: "image/jpeg", data: imageBytes("jpeg", "j") },
      "c.gif": { mediaType: "image/gif", data: imageBytes("gif", "g") },
      "d.webp": { mediaType: "image/webp", data: imageBytes("webp", "w") },
    };
    const id = await pendingUpload(epubWithImages(workId, images));

    await deliver([{ upload_id: id }]);

    const expected = await Promise.all(
      Object.values(images).map(async (i) => ({
        key: `works/${workId}/img/${await sha256Hex(i.data)}`,
        ...i,
      })),
    );
    expect(await bucketKeys(`works/${workId}/img/`)).toEqual(expected.map((e) => e.key).sort());
    for (const e of expected) {
      const stored = await bucketObject(e.key);
      expect(stored?.contentType).toBe(e.mediaType);
      expect(stored?.bytes).toEqual(e.data);
    }
  });

  it("Identical images in one work share one key", async () => {
    const workId = freshAo3WorkId();
    const image = png("same");
    const id = await pendingUpload(epubWithImages(workId, { "one.png": image, "two.png": image }));

    await deliver([{ upload_id: id }]);

    const key = await sha256Hex(image.data);
    expect(await bucketKeys(`works/${workId}/img/`)).toEqual([`works/${workId}/img/${key}`]);
    const fragment = await bucketText(`works/${workId}/${id}/1.html`);
    expect(fragment?.split(`src="${ORIGIN}/works/${workId}/img/${key}"`)).toHaveLength(3);
  });

  it("A retried job rewrites the same image keys", async () => {
    const workId = freshAo3WorkId();
    const image = png("retry");
    const id = await pendingUpload(epubWithImages(workId, { "one.png": image }));
    const key = `works/${workId}/img/${await sha256Hex(image.data)}`;
    // The first attempt writes the image, then fails before the transaction.
    const first = await deliver([{ upload_id: id }], {
      handler: ingestWorker({ bucket: failingPut(`originals/${id}.epub`) }),
    });
    expect(first.retryMessages.map((m) => m.msgId)).toEqual(["msg-0"]);
    expect(await bucketKeys(`works/${workId}/img/`)).toEqual([key]);

    const puts: string[] = [];
    const retry = await deliver([{ upload_id: id }], {
      attempts: 2,
      handler: ingestWorker({ bucket: beforePut(async (k) => void puts.push(k)) }),
    });

    expect(puts).toContain(key);
    expect(await bucketKeys(`works/${workId}/img/`)).toEqual([key]);
    expect((await uploadRow(id)).status).toBe("live");
    expect(retry.explicitAcks).toEqual(["msg-0"]);
  });

  it("An opted-out author's images are never written", async () => {
    const pseud = `someone${token()}`;
    await addOptOut(pseud);
    const workId = freshAo3WorkId();
    const id = await pendingUpload(epubWithImages(workId, { "one.png": png("o") }, pseud));

    await deliver([{ upload_id: id }]);

    expect((await uploadRow(id)).status).toBe("opted_out");
    expect(await bucketKeys(`works/${workId}/`)).toEqual([]);
  });

  it("A work under takedown has no images written", async () => {
    const removed = await seededWork({ status: "removed" });
    await addTakedown(removed.workId, TAKEDOWN_REMOVED);
    const id = await pendingUpload(epubWithImages(removed.ao3WorkId, { "one.png": png("t") }));

    await deliver([{ upload_id: id }]);

    expect((await uploadRow(id)).status).toBe("opted_out");
    expect(await bucketKeys(`works/${removed.ao3WorkId}/img/`)).toEqual([]);
  });

  it("Sanitizer fixes can be backfilled", async () => {
    const workId = freshAo3WorkId();
    const epub = ao3Epub({ workId });
    const before = await ingestBeforeFix(epub);
    const old = await versionsOf(workId);
    const [oldKey] = old.versions[0]?.chapterKeys ?? [];
    const oldText = await bucketText(oldKey ?? "");
    expect(oldText).toContain(UNSAFE);

    const result = await deliver([backfillOf(old)], { queue: BACKFILL });

    expect(result.explicitAcks).toEqual(["msg-0"]);
    const now = await versionsOf(workId);
    expect(now.versions).toHaveLength(2);
    const remade = now.versions.find((v) => v.id === now.current);
    expect(remade).toMatchObject({
      upload_id: null,
      source: "backfill",
      source_upload_id: before.id,
      r2_prefix: `works/${workId}/${now.current}/`,
    });
    // Re-sanitized by the processor as it is now, from the stored original.
    const fixed = (await processEpub(epub)).chapters[0]?.html;
    expect(await bucketText(remade?.chapterKeys[0] ?? "")).toBe(fixed);
    // The old version's fragment is never rewritten.
    expect(await bucketText(oldKey ?? "")).toBe(oldText);
  });
});

describe("re-sanitize backfill", () => {
  /** A work ingested before the fix, with its versions as the database holds them. */
  async function unfixedWork(steps: Partial<Steps> = {}) {
    const workId = freshAo3WorkId();
    const { id } = await ingestBeforeFix(ao3Epub({ workId }), steps);
    return { ao3WorkId: workId, uploadId: id, ...(await versionsOf(workId)) };
  }

  const backfill = (
    bodies: unknown[],
    options: { handler?: ReturnType<typeof ingestWorker>; attempts?: number } = {},
  ) => deliver(bodies, { queue: BACKFILL, ...options });

  it("delivering the same message twice makes one new version", async () => {
    const work = await unfixedWork();

    await backfill([backfillOf(work)]);
    const again = await backfill([backfillOf(work)]);

    expect(again.explicitAcks).toEqual(["msg-0"]);
    const now = await versionsOf(work.ao3WorkId);
    expect(now.versions).toHaveLength(2);
  });

  it("a version no longer current is acked with nothing written", async () => {
    const work = await unfixedWork();
    const keys = await bucketKeys(`works/${work.ao3WorkId}/`);

    const result = await backfill([{ work_id: work.workId, version_id: crypto.randomUUID() }]);

    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect((await versionsOf(work.ao3WorkId)).versions).toHaveLength(1);
    expect(await bucketKeys(`works/${work.ao3WorkId}/`)).toEqual(keys);
  });

  it("a removed work is acked with nothing written", async () => {
    const work = await unfixedWork();
    await setWorkStatus(work.ao3WorkId, "removed");
    const keys = await bucketKeys(`works/${work.ao3WorkId}/`);

    const result = await backfill([backfillOf(work)]);

    expect(result.explicitAcks).toEqual(["msg-0"]);
    const now = await versionsOf(work.ao3WorkId);
    expect(now.versions).toHaveLength(1);
    expect(now.current).toBe(work.current);
    expect(await bucketKeys(`works/${work.ao3WorkId}/`)).toEqual(keys);
  });

  it("a hidden work is backfilled and stays hidden", async () => {
    const work = await unfixedWork();
    await hideWork(work.ao3WorkId);

    await backfill([backfillOf(work)]);

    const now = await versionsOf(work.ao3WorkId);
    expect(now.status).toBe("hidden");
    expect(now.versions).toHaveLength(2);
    expect(now.current).not.toBe(work.current);
  });

  it("an author who has opted out since is never published again", async () => {
    const pseud = `someone${token()}`;
    const workId = freshAo3WorkId();
    const { id } = await ingestBeforeFix(ao3Epub({ workId, pseud }));
    const work = await versionsOf(workId);
    await addOptOut(pseud);
    const puts: string[] = [];

    const result = await backfill([backfillOf(work)], {
      handler: ingestWorker({ bucket: beforePut(async (key) => void puts.push(key)) }),
    });

    expect(result.explicitAcks).toEqual(["msg-0"]);
    expect(puts).toEqual([]);
    expect((await versionsOf(workId)).current).toBe(work.current);
    expect((await uploadRow(id)).status).toBe("live");
  });

  it("an original the processor now refuses keeps the current version", async () => {
    const work = await unfixedWork();
    const refusing = ingestWorker({
      process: async () => {
        throw new EpubError("parse_failed", "a synthetic refusal");
      },
    });

    const result = await backfill([backfillOf(work)], { handler: refusing });

    expect(result.explicitAcks).toEqual(["msg-0"]);
    const now = await versionsOf(work.ao3WorkId);
    expect(now.versions).toHaveLength(1);
    expect(now.current).toBe(work.current);
  });

  it("a failing R2 write leaves no rows, and the message is retried", async () => {
    const work = await unfixedWork();
    const failing = ingestWorker({
      bucket: beforePut(async (key) => {
        if (key.startsWith(`works/${work.ao3WorkId}/`)) throw new Error("injected R2 failure");
      }),
    });

    const result = await backfill([backfillOf(work)], { handler: failing });

    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["msg-0"]);
    const now = await versionsOf(work.ao3WorkId);
    expect(now.versions).toHaveLength(1);
    expect(now.current).toBe(work.current);
  });

  it("a batch of several works backfills each", async () => {
    const works = [await unfixedWork(), await unfixedWork()];

    const result = await backfill(works.map(backfillOf));

    expect(result.explicitAcks).toEqual(["msg-0", "msg-1"]);
    for (const work of works) {
      const now = await versionsOf(work.ao3WorkId);
      expect(now.versions).toHaveLength(2);
      expect(now.current).not.toBe(work.current);
    }
  });

  it("a backfill version is backfilled again from the same original", async () => {
    const work = await unfixedWork();
    await backfill([backfillOf(work)]);
    const once = await versionsOf(work.ao3WorkId);

    await backfill([backfillOf(once)]);

    const twice = await versionsOf(work.ao3WorkId);
    expect(twice.versions).toHaveLength(3);
    expect(twice.versions.find((v) => v.id === twice.current)).toMatchObject({
      source: "backfill",
      source_upload_id: work.uploadId,
    });
  });

  it("a moderator's check carries over only when the review reasons are the same", async () => {
    const reasons = ["chapter_split_guessed"];
    const doubtful: Partial<Steps> = {
      process: async (bytes) => ({ ...(await processEpub(bytes)), reviewReasons: reasons }),
    };
    const same = await unfixedWork(doubtful);
    const changed = await unfixedWork(doubtful);
    await checkVersion(same.current);
    await checkVersion(changed.current);

    await backfill([backfillOf(same)], { handler: ingestWorker(doubtful) });
    await backfill([backfillOf(changed)]);

    const kept = await versionsOf(same.ao3WorkId);
    expect(kept.versions.find((v) => v.id === kept.current)?.checked_at).not.toBeNull();
    const reset = await versionsOf(changed.ao3WorkId);
    expect(reset.versions.find((v) => v.id === reset.current)?.checked_at).toBeNull();
  });
});
