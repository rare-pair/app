import { describe, expect, it } from "vitest";
import { TAKEDOWN_REMOVED } from "../src/lists";
import { ingestWorker } from "../src/worker";
import {
  addOptOut,
  addTakedown,
  beforePut,
  bucketKeys,
  bucketObject,
  bucketText,
  deliver,
  epubWithImages,
  failingPut,
  freshAo3WorkId,
  imageBytes,
  pendingUpload,
  seededWork,
  sha256Hex,
  token,
  uploadRow,
} from "./helpers";

const ORIGIN = "https://content.rarepair.fans";

const png = (fill: string) => ({ mediaType: "image/png", data: imageBytes("png", fill) });

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
});
