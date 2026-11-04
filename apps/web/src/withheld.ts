// What a hidden or removed work shows: one fixed line and nothing else about the work
// (ARCHITECTURE, Author requests & takedowns). The work's title, author, text and links
// never come into this file: the only input is the work's status and hide cause.

import type { HiddenCause, WorkAvailability } from "@archive/db";
import type { Context } from "hono";
import { layout } from "./pages";

/** One line per hide cause. A new cause fails the typecheck until it has its line. */
const HIDDEN_LINES: Record<HiddenCause, string> = {
  removal_request: "Temporarily hidden after a removal request",
  reports: "Temporarily hidden after reader reports",
  moderator: "Temporarily hidden by a moderator",
};

const REMOVED_LINE = "This work has been removed";

/**
 * The answer for a work that isn't live: 451 for a hidden one, 410 for a removed one.
 * No Cache-Control here: the CSP middleware's `private, no-store` keeps the nonced page
 * (and a hide that a restore will lift) out of any cache, where 451 and 410 would
 * otherwise be cacheable by default.
 */
export function withheldResponse(c: Context, availability: WorkAvailability) {
  if (availability.status === "removed") return c.html(layout(REMOVED_LINE, ""), 410);
  return c.html(layout(HIDDEN_LINES[availability.cause], ""), 451);
}
