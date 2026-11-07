export { processEpub, sanitizeFragment } from "./process";
export { nodeBudget } from "./dom";
export { countWords } from "./words";
export { parseStats } from "./preface";
export { EpubError, type EpubErrorCode } from "./errors";
export { LIMITS } from "./unzip";
export type {
  Author,
  Chapter,
  ImageRef,
  ParsedWork,
  ProcessOptions,
  SeriesRef,
  Stats,
} from "./types";
export { BYLINE_AMBIGUOUS, BYLINE_MISSING, resolveByline, splitNames } from "./byline";
