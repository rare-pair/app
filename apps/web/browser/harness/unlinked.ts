// The pages of spec 21's inventory that no link on the site reaches, each with the reason it
// is allowed to have none. The crawl (crawl.ts) fails when an inventory page is neither
// reached nor named here, and fails when a page named here is reached: the list cannot go
// stale. The names are the inventory's (pages.ts).
//
// Not here, because they are not in the inventory: a refusal page for a client that declares
// itself an automated one (spec 24). The crawl sends a browser's User-Agent, so never meets it.

export type Unlinked = { name: string; reason: string };

const EMAILED = "reached only by the link in an email, which a person follows from a mail app";
const BUTTON = "the header's Sign out is a button that posts; this page is a typed address";
const GATE = "a redirect to a signed-in account that has not accepted the terms, not a link";
const NATURE = "reached only by an address that is wrong, saved or sent, never by a link";

export const UNLINKED: Unlinked[] = [
  { name: "sign-in link refused", reason: "the redirect after a bad sign-in link is posted" },
  { name: "confirm sign-in", reason: EMAILED },
  { name: "accept terms", reason: GATE },
  { name: "sign out", reason: BUTTON },
  { name: "sign out, signed out", reason: BUTTON },
  { name: "confirm removal", reason: EMAILED },
  { name: "hidden", reason: `a hidden work is not listed anywhere; ${NATURE}` },
  { name: "removed", reason: `a removed work is not listed anywhere; ${NATURE}` },
  { name: "too many requests", reason: "reached only by going over a rate limit" },
  { name: "not found", reason: NATURE },
  { name: "wait list confirm", reason: EMAILED },
  { name: "wait list unsubscribe", reason: EMAILED },
  { name: "confirm sign-in, before launch", reason: EMAILED },
  { name: "accept terms, before launch", reason: GATE },
  { name: "sign out, before launch", reason: BUTTON },
  { name: "sign out, signed out, before launch", reason: BUTTON },
];

/**
 * Pages outside the inventory's names that have no link, and are a gap the operator has asked
 * to fix, not a choice. The crawl checks each stays unlinked (and fails when one gains a link,
 * so the entry is removed).
 */
export const KNOWN_GAPS = [
  {
    what: "work admin (/admin/works/:id) for a work that is not in Works to check",
    reason:
      "a moderator reaches a work's admin page only from its row in Works to check; a work they " +
      "found by reading has no link to it. The operator wants a moderator dashboard, not yet scoped",
  },
];
