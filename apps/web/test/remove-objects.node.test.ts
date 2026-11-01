import { describe, expect, it } from "vitest";
import { deleteWorkObjects, type ObjectBucket } from "../src/remove-objects";

/**
 * An in-memory stand-in for R2 with the limits Cloudflare documents: a list page holds
 * at most 1000 keys (and 1000 by default), `truncated` with a `cursor` says there are
 * more, and one delete call takes at most 1000 keys.
 */
function fakeBucket(keys: string[]) {
  const held = new Set(keys);
  const bucket: ObjectBucket = {
    async list({ prefix, cursor, limit = 1000 }) {
      const all = [...held].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor === undefined ? 0 : all.findIndex((k) => k > cursor);
      const page = start < 0 ? [] : all.slice(start, start + Math.min(limit, 1000));
      const truncated = start >= 0 && start + page.length < all.length;
      return truncated
        ? { objects: page.map((key) => ({ key })), truncated, cursor: page.at(-1)! }
        : { objects: page.map((key) => ({ key })), truncated };
    },
    async delete(toDelete) {
      if (toDelete.length > 1000) throw new Error("R2 deletes at most 1000 keys a call");
      for (const k of toDelete) held.delete(k);
    },
  };
  return { bucket, held };
}

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
