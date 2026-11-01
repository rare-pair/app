// Deleting a removed work's objects from R2 (ARCHITECTURE, "Removal really removes"):
// everything under `works/<ao3_work_id>/` (every version's fragments and the shared
// images), and each upload's raw file, kept by ingest under `originals/` and, until it
// expires, at the upload's own key.

/** The part of R2's binding this needs, so the loop can be tested in Node. */
export interface ObjectBucket {
  list(options: {
    prefix: string;
    cursor?: string;
    limit?: number;
  }): Promise<
    { objects: { key: string }[] } & ({ truncated: true; cursor: string } | { truncated: false })
  >;
  delete(keys: string[]): Promise<void>;
}

/** R2's most for one list page and for one delete call. */
const R2_BATCH = 1000;

/**
 * Deletes the work's objects. Every key is listed before any is deleted, so the
 * listing's cursor never meets a page that changed under it. Deleting a key that is
 * already gone is no error, so a repeat run is safe.
 */
export async function deleteWorkObjects(
  bucket: ObjectBucket,
  ao3WorkId: number,
  uploads: { id: string; r2_key: string }[],
): Promise<void> {
  // The trailing slash keeps works/12/ from matching works/123/.
  const prefix = `works/${ao3WorkId}/`;
  const keys = uploads.flatMap((u) => [`originals/${u.id}.epub`, u.r2_key]);
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ prefix, cursor, limit: R2_BATCH });
    keys.push(...page.objects.map((o) => o.key));
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  for (let i = 0; i < keys.length; i += R2_BATCH) {
    await bucket.delete(keys.slice(i, i + R2_BATCH));
  }
}
