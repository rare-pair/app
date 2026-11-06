// Updates: short posts from the operator, one list in code (specs/scenarios/mvp/25-updates.md).
// Adding one is a code change and a deploy. No database, no admin page.

import { RELEASE_0_1_0_BODY } from "./update-release-0-1-0";

export type Update = {
  /** Lowercase letters, digits and hyphens: the post's address is `/updates/<slug>`. */
  slug: string;
  /** Plain text. */
  title: string;
  /** Plain text. */
  summary: string;
  /** Plain text. */
  author: string;
  /** A calendar date, `YYYY-MM-DD`, with no time. */
  created: string;
  /** Hand-written, trusted HTML: no inline style, no script. */
  body: string;
};

/** In the order they were added: a new update goes at the end. */
export const UPDATES: readonly Update[] = [
  {
    slug: "release-0-1-0-chuhura",
    title: 'rarepair v0.1.0 "Chuhura"',
    summary:
      "rarepair is open. It is a temporary, community-run reading archive for fanworks while the original archive is offline.",
    author: "admin and 🤖",
    created: "2026-11-06",
    body: RELEASE_0_1_0_BODY,
  },
];

/** Newest created date first; of two on one day, the one added to the list later. */
export const newestFirst = (list: readonly Update[]): Update[] =>
  list
    .map((update, added) => ({ update, added }))
    // Dates are `YYYY-MM-DD`, so comparing them as text compares them as dates.
    .sort((a, b) => b.update.created.localeCompare(a.update.created) || b.added - a.added)
    .map(({ update }) => update);

export const latestUpdates = (list: readonly Update[], count = 3): Update[] =>
  newestFirst(list).slice(0, count);
