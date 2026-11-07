// The pseud matching rule (ARCHITECTURE, Pseuds), applied to the opt-out
// request and to every byline at ingest. Pure: no Node or Workers import, so
// the web Worker and ingest can both load it. Deliberately not the tag rule in
// `./tags`: punctuation is kept here.

/** Unicode White_Space, which, unlike `\s`, includes next line (U+0085). */
const WHITESPACE = /\p{White_Space}+/gu;
/**
 * Characters that render as nothing: zero-width spaces and joiners, the word
 * joiner, the soft hyphen, the byte order mark, variation selectors.
 */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}+/gu;

/**
 * A pseud's `pseud_norm`: NFKC, invisible characters dropped, lowercased, NFKC
 * again, inner runs of Unicode whitespace collapsed to one space, then trimmed.
 * Dropping invisibles means `Moon<U+200B> Child` matches `Moon Child`. The
 * second NFKC puts back what lowercasing and the drop can undo: a lowercase
 * letter can have a precomposed form its capital lacks (`J` with a caron), and
 * a dropped grapheme joiner can leave combining marks out of order. Punctuation
 * is never folded into whitespace, so `a_b` and `a b` are different pseuds,
 * though NFKC still rewrites compatibility forms (`…` becomes `...`).
 * `toLowerCase` is not full Unicode case folding (`ß` stays `ß`, not `ss`). A
 * byline's pseud is stored as written, in `work_authors.pseud`.
 */
export function normalizePseud(pseud: string): string {
  return pseud
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(WHITESPACE, " ")
    .trim();
}

/**
 * The `pseud_norm`s the opt-out list is checked against for a byline, one per distinct name: each
 * author's pseud, and the login of each author with one, since a PDF's link can name only the
 * login while the byline shows the printed pseud (spec 12). Blank names match no opt-out (the
 * schema refuses a blank `pseud_norm`), so they are left out; so is the "Anonymous" placeholder
 * a processor gives a byline with no profile link, which names nobody. An author with a profile
 * link whose user is "Anonymous" is a user, and stays.
 */
export function checkedNames(authors: readonly { pseud: string; user: string | null }[]): string[] {
  const norms = new Set<string>();
  for (const a of authors) {
    const norm = normalizePseud(a.pseud);
    if (norm !== "" && (a.user !== null || norm !== "anonymous")) norms.add(norm);
    const login = a.user === null ? "" : normalizePseud(a.user);
    if (login !== "") norms.add(login);
  }
  return [...norms];
}
