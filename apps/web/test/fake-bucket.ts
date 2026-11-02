import type { ObjectBucket } from "../src/remove-objects";

// Shared by the Node tests (test/helpers.ts imports cloudflare:workers, so they can't use it).

/**
 * An in-memory stand-in for R2 with the limits Cloudflare documents: a list page holds
 * at most 1000 keys (and 1000 by default), `truncated` with a `cursor` says there are
 * more, and one delete call takes at most 1000 keys. `failDelete` makes every delete
 * throw, as an R2 outage would. `held` is what the bucket holds.
 */
export function fakeBucket(keys: string[], { failDelete = false } = {}) {
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
      if (failDelete) throw new Error("R2 unavailable");
      if (toDelete.length > 1000) throw new Error("R2 deletes at most 1000 keys a call");
      for (const k of toDelete) held.delete(k);
    },
  };
  return { bucket, held };
}
