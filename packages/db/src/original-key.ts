import { sql } from "kysely";
import type { UploadFormat } from "./schema";

export const UPLOAD_FORMATS: readonly UploadFormat[] = ["epub", "pdf"];

/** Where the raw file of an upload is kept: every reader of an original goes through this. */
export const originalKey = (uploadId: string, format: UploadFormat): string =>
  `originals/${uploadId}.${format}`;

/**
 * The upload's key in each format, for what deletes an original: a delete of a key that isn't
 * there is no error, and it finds the file even if the job died before recording its format.
 */
export const originalKeys = (uploadId: string): string[] =>
  UPLOAD_FORMATS.map((format) => originalKey(uploadId, format));

/**
 * The format of the upload a version was made from, as a column of a query over `work_versions`:
 * its own upload's, or a backfill version's, the one it was re-made from.
 */
export const versionOriginalFormat = sql<UploadFormat>`(
  select format from uploads
  where uploads.id = coalesce(work_versions.upload_id, work_versions.source_upload_id)
)`;

/** What a served path's last segment names: the upload, and its format by the extension. */
export function parseOriginalSegment(segment: string) {
  for (const format of UPLOAD_FORMATS) {
    const extension = `.${format}`;
    if (segment.endsWith(extension)) {
      return { uploadId: segment.slice(0, -extension.length), format };
    }
  }
  // A bare id (#119) is checked the same way, and has only ever been an epub's.
  return { uploadId: segment, format: "epub" as const };
}

/** The type an original is stored and served with. */
export const ORIGINAL_MEDIA_TYPES: Record<UploadFormat, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
};
