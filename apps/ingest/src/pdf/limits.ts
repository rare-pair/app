const MiB = 1024 * 1024;

/** What a PDF may hold, for the checks before the parser and the parse itself. */
export const PDF_LIMITS = {
  /** Bytes all of a file's streams may inflate to. */
  maxInflatedBytes: 128 * MiB,
  /** A `/Contents` array's most entries. */
  maxContentsEntries: 8,
  /** Bytes one stream may inflate to, and one page's `/Contents` together. */
  maxStreamInflatedBytes: 16 * MiB,
  /** Objects a file may hold, by its trailer and by what it really has. The largest sample has 8,561. */
  maxObjects: 100_000,
  /** Pages a file may have. The samples run 230 to 554 words a page, so 1.2M to 2.8M words. */
  maxPages: 5_000,
  /** Text items and characters one parse may read: a limit on what it holds, by count. */
  maxTextItems: 500_000,
  maxTextChars: 8 * MiB,
  /** Links to the original archive one parse may keep. A real file has a few hundred. */
  maxLinks: 50_000,
  /** Bytes one file's object streams may cost to read. A real file has a few MB of them. */
  maxObjectStreamWork: 64 * MiB,
  /** Code table entries one file may build. A real one builds a few a stream, each under 32 KB. */
  maxCodeTableEntries: 1024 * MiB,
} as const;
