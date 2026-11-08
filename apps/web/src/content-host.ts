import type { UploadFormat } from "@archive/db";

// The content host's URLs, which apps/content serves (ARCHITECTURE, Hosts): the work page
// links them, and a removal purges them from the cache, so both build them here.

/** The host apps/content serves images and original downloads on. */
export const CONTENT_HOST = "content.rarepair.fans";

/**
 * An upload's original, `originals/<one segment>` as apps/content serves it: the extensionless
 * URL. Ingest stores it under its format's key, and the work page links `originalFileUrl`.
 */
export const originalUrl = (uploadId: string) =>
  `https://${CONTENT_HOST}/originals/${encodeURIComponent(uploadId)}`;

/** The URL of an upload's original, under the key its format stores it at. */
export const originalFileUrl = (uploadId: string, format: UploadFormat) =>
  `${originalUrl(uploadId)}.${format}`;
