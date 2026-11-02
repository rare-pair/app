// The content host's URLs, which apps/content serves (ARCHITECTURE, Hosts): the work page
// links them, and a removal purges them from the cache, so both build them here.

/** The host apps/content serves images and original downloads on. */
export const CONTENT_HOST = "content.rarepair.fans";

/**
 * An upload's original epub, `originals/<one segment>` as apps/content serves it.
 * Provisional: #119 settles the key.
 */
export const originalUrl = (uploadId: string) =>
  `https://${CONTENT_HOST}/originals/${encodeURIComponent(uploadId)}`;
