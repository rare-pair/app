export interface Author {
  pseud: string;
  /** AO3 user name from the byline link, or null (anonymous, or no link). */
  user: string | null;
}

export interface SeriesRef {
  name: string;
  part: number | null;
  ao3SeriesId: string | null;
}

export interface Stats {
  published: string | null;
  updated: string | null;
  completed: string | null;
  words: number | null;
  /** From `Chapters: x/y`. A missing line means a one-shot: 1/1. `total` is null for `?`. */
  chapters: { posted: number; total: number | null };
}

export interface Chapter {
  n: number;
  title: string;
  html: string;
  words: number;
}

export interface ImageRef {
  /** Lowercase hex SHA-256 of the bytes. Also the storage key. */
  key: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  size: number;
  /** Path of the image inside the epub. */
  sourcePath: string;
}

/**
 * Everything the ingest worker needs from one epub. Plain data: no timestamps,
 * no random values, keys always in this order, so the same bytes always give
 * deep-equal output.
 */
export interface ParsedWork {
  ao3WorkId: string;
  title: string;
  authors: Author[];
  rating: string | null;
  warnings: string[];
  categories: string[];
  fandoms: string[];
  relationships: string[];
  characters: string[];
  freeforms: string[];
  language: string | null;
  series: SeriesRef[];
  stats: Stats;
  summaryHtml: string | null;
  notesHtml: string | null;
  endNotesHtml: string | null;
  chapters: Chapter[];
  images: ImageRef[];
  /** Preface labels the parser does not understand yet, keyed by label text. */
  rawMeta: Record<string, string>;
  reviewReasons: string[];
}

export interface ProcessOptions {
  /**
   * Prefix for rewritten image URLs: `src` becomes `${imageBase}${key}`. Default "". A function
   * is called once with the AO3 work ID the preface names, for a prefix that holds it.
   */
  imageBase?: string | ((ao3WorkId: string) => string);
  /**
   * Receives the bytes of each image the output references, once per key, in
   * the same order as `ParsedWork.images`. Keeps `ParsedWork` free of binary data.
   * Awaited one at a time: `processEpub` resolves after the last one has.
   */
  // oxlint-disable-next-line deslop/no-unknown-returns -- any return is awaited and dropped, sync or async
  onImage?: (image: ImageRef, bytes: Uint8Array) => unknown;
}
