import { describe, expect, it } from "vitest";
import { deleteWorkObjects } from "../src/remove-objects";
import { fakeBucket } from "./fake-bucket";

const chapters = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(5, "0")}.html`);

describe("deleteWorkObjects", () => {
  it("Deletes every object under works/<ao3_work_id>/ across list pages, 1000 a call at most", async () => {
    const own = chapters("works/143/up-1/", 2500);
    const neighbour = chapters("works/1430/up-2/", 3);
    const { bucket, held } = fakeBucket([...own, ...neighbour, "works/143/img/" + "a".repeat(64)]);
    await deleteWorkObjects(bucket, 143, []);
    expect([...held].sort()).toEqual(neighbour);
  });

  it("Deletes exactly 1000 and 1001 listed keys, with upload keys across the batch edge", async () => {
    for (const n of [1000, 1001]) {
      const id = 140000 + n;
      const { bucket, held } = fakeBucket([
        ...chapters(`works/${id}/up-1/`, n),
        `originals/up-${n}.epub`,
        `uploads/up-${n}.epub`,
      ]);
      await deleteWorkObjects(bucket, id, [{ id: `up-${n}`, r2_key: `uploads/up-${n}.epub` }]);
      expect(held.size, String(n)).toBe(0);
    }
  });

  it("Deletes each upload's original and raw file, and nothing else", async () => {
    const { bucket, held } = fakeBucket([
      "originals/up-1.epub",
      "originals/up-2.epub",
      "uploads/up-2.epub",
      "originals/up-other.epub",
      "uploads/up-other.epub",
    ]);
    await deleteWorkObjects(bucket, 143, [
      { id: "up-1", r2_key: "uploads/up-1.epub" },
      { id: "up-2", r2_key: "uploads/up-2.epub" },
    ]);
    expect([...held].sort()).toEqual(["originals/up-other.epub", "uploads/up-other.epub"]);
  });

  it("12-pdf-upload: deletes an upload's original whichever format it is", async () => {
    const { bucket, held } = fakeBucket([
      "originals/up-1.pdf",
      "originals/up-2.epub",
      "originals/up-other.pdf",
    ]);
    await deleteWorkObjects(bucket, 143, [
      { id: "up-1", r2_key: "uploads/up-1.epub" },
      { id: "up-2", r2_key: "uploads/up-2.epub" },
    ]);
    expect([...held]).toEqual(["originals/up-other.pdf"]);
  });

  it("Never deletes a stored raw-file key outside uploads/", async () => {
    const { bucket, held } = fakeBucket(["works/999/up-9/00000.html", "originals/up-9.epub"]);
    await deleteWorkObjects(bucket, 143, [
      { id: "up-1", r2_key: "works/999/up-9/00000.html" },
      { id: "up-2", r2_key: "originals/up-9.epub" },
    ]);
    expect([...held].sort()).toEqual(["originals/up-9.epub", "works/999/up-9/00000.html"]);
  });

  it("Deletes the raw files of more than 1000 uploads in calls of 1000 at most", async () => {
    const uploads = Array.from({ length: 600 }, (_, i) => ({
      id: `up-${i}`,
      r2_key: `uploads/up-${i}.epub`,
    }));
    const keys = uploads.flatMap((u) => [`originals/${u.id}.epub`, u.r2_key]);
    const { bucket, held } = fakeBucket(keys);
    await deleteWorkObjects(bucket, 143, uploads);
    expect(held.size).toBe(0);
  });
});
