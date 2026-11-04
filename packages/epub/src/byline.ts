import type { Author } from "./types";

/** Review reasons for a byline the opt-out check can't fully trust (ARCHITECTURE, step 4). */
export const BYLINE_MISSING = "byline_missing";
export const BYLINE_AMBIGUOUS = "byline_ambiguous";

// The matching rule's two pieces, copied from `normalizePseud` in `packages/db/src/pseud.ts`
// (this package doesn't depend on `@archive/db`): a pseud with nothing left after dropping
// Unicode whitespace and invisible characters is blank, and two names are the same when their
// normalised forms are. Ingest keeps `normalizePseud(x) === ""` as the final judge.
const BLANK = /^[\p{White_Space}\p{Default_Ignorable_Code_Point}]*$/u;
const WHITESPACE = /\p{White_Space}+/gu;
const INVISIBLE = /\p{Default_Ignorable_Code_Point}+/gu;

export function isBlank(pseud: string): boolean {
  return BLANK.test(pseud);
}

function sameKey(pseud: string): string {
  return pseud
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(WHITESPACE, " ")
    .trim();
}

/** A byline's or creator's text cut into names where AO3 would write a list: ", " and " and ". */
export function splitNames(text: string): string[] {
  // ", and P" (an Oxford comma) is one separator, not a piece "and P".
  return text.split(/\s*,\s*(?:and\s+)?|\s+and\s+/).filter((name) => !isBlank(name));
}

/** The authors the opt-out check reads and the review reasons for a byline it can't trust. */
export interface Byline {
  authors: Author[];
  reviewReasons: string[];
}

/**
 * Who the opt-out check reads (ARCHITECTURE, EPUB processor, step 4): the preface's named
 * authors, then every OPF creator they don't already name, so a blank or partial preface byline
 * never hides the author. A creator holding several names ("A and B") is cut into its names,
 * each checked beside the whole text, and flagged: nothing says it isn't one pseud.
 *
 * @param ambiguous the preface byline had no profile links and split into several names
 */
export function resolveByline(
  preface: readonly Author[],
  ambiguous: boolean,
  creators: readonly string[],
): Byline {
  const authors = preface.filter((a) => !isBlank(a.pseud));
  const named = new Set(authors.map((a) => sameKey(a.pseud)));
  let creatorAmbiguous = false;
  const add = (pseud: string): void => {
    const key = sameKey(pseud);
    if (key === "" || named.has(key)) return;
    named.add(key);
    authors.push({ pseud, user: null });
  };
  for (const creator of creators) {
    if (isBlank(creator)) continue;
    // A profile link already named it: a pseud like "Salt and Pepper" is then not a list.
    if (named.has(sameKey(creator))) continue;
    const names = splitNames(creator);
    // Every piece already named ("A and B" beside links to A and B): nothing new, nothing guessed.
    if (names.length > 1 && names.every((name) => named.has(sameKey(name)))) continue;
    add(creator);
    // A stray separator ("P,") leaves one piece that differs from the whole: it is checked too.
    for (const name of names) add(name);
    if (names.length > 1) creatorAmbiguous = true;
  }
  const reviewReasons: string[] = [];
  if (authors.length === 0) reviewReasons.push(BYLINE_MISSING);
  if (ambiguous || creatorAmbiguous) reviewReasons.push(BYLINE_AMBIGUOUS);
  return { authors, reviewReasons };
}
