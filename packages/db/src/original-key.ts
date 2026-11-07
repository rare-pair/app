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

/** The type an original is stored and served with. */
export const ORIGINAL_MEDIA_TYPES: Record<UploadFormat, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
};
