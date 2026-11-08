// What an upload may be. Kept apart from src/upload.ts so that pages.ts, which
// upload.ts imports, can use it too.

/** The two types `PUT /uploads/:id` accepts (ARCHITECTURE, Ingestion pipeline). */
export const EPUB_TYPE = "application/epub+zip";
export const PDF_TYPE = "application/pdf";

/** The most files one `POST /uploads` may ask for; the page's script holds to it too. */
export const MAX_BATCH_FILES = 10;

/** Whether an upload may be of `type`, and what's said when it may not. */
export const isUploadType = (type: string) => type === EPUB_TYPE || type === PDF_TYPE;
export const WRONG_TYPE = "Only epub and PDF files can be uploaded.";

/** The limit in MiB, as the pages say it: "25 MB". */
export const MAX_UPLOAD_MB = 25;

/** A PDF's limit in MiB (operator ruling, 2026-11-07). */
export const MAX_PDF_MB = 10;

/** The largest zip of epubs the page opens, in MiB (operator ruling, 2026-11-07). */
export const MAX_ZIP_MB = 100;

/** The same limit in bytes. */
export const MAX_ZIP_BYTES = MAX_ZIP_MB * 1024 * 1024;

/**
 * The largest declared size `POST /uploads` accepts: 25 MiB, the processor's
 * `LIMITS.maxInputBytes` (packages/epub/src/unzip.ts). Restated, since importing
 * it would bundle the processor into this Worker; test/upload-limit.node.test.ts
 * holds the two equal.
 */
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

/** A PDF's limit in bytes, the processor's `LIMITS.maxPdfBytes`, held equal the same way. */
export const MAX_PDF_BYTES = MAX_PDF_MB * 1024 * 1024;

/** What's said of a file over its type's limit. */
export const overLimit = (type: string, subject = "That file") =>
  type === PDF_TYPE
    ? `${subject} is over the ${MAX_PDF_MB} MB limit for a PDF, so it can't be uploaded.`
    : `${subject} is over the ${MAX_UPLOAD_MB} MB limit, so it can't be uploaded.`;

/** The largest size of a file of `type`. */
export const maxBytesFor = (type: string) => (type === PDF_TYPE ? MAX_PDF_BYTES : MAX_UPLOAD_BYTES);

// Upload ids are random text bounded at 64 characters (apps/ingest/src/message.ts). Nothing
// longer, or holding a NUL, which Postgres refuses, can name an upload.
const MAX_ID = 64;

/** Whether a path's id could name an upload at all. */
export const isUploadId = (id: string) => id.length <= MAX_ID && !id.includes("\0");
