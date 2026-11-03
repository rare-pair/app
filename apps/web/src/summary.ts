// A work's summary as the pages show it. The sanitizer keeps a summary's headings
// and list items as written (scenario 07), so a summary can add a second `<h1>`
// to a page or hold a list item with no list. Both are put right here, when the
// page is rendered, so works already stored are covered too.
//
// These functions read the sanitizer's canonical output only: tag names in lower
// case, `<` and `>` escaped in text and attributes, so `[^<>]*` spans exactly one
// tag. Never use them on markup the sanitizer hasn't seen.

const TOKEN = /<(\/?)(h[1-6]|ul|ol|li)\b[^<>]*>/gi;

/**
 * Headings become bold text in a div, which keeps their emphasis without a place in
 * the page's outline; a list item outside any list becomes a div. The headings'
 * attributes are dropped. Balanced in, balanced out: each open tag and its close
 * tag are rewritten alike. Linear, and a second pass finds nothing more to change.
 */
export function tidySummary(html: string): string {
  let lists = 0;
  // Whether each open list item was outside every list.
  const items: boolean[] = [];
  return html.replace(TOKEN, (tag: string, slash: string, name: string) => {
    const closing = slash === "/";
    const lower = name.toLowerCase();
    if (lower.startsWith("h")) {
      return closing ? "</strong></div>" : '<div class="summary-heading"><strong>';
    }
    if (lower === "li") {
      if (!closing) {
        const stray = lists === 0;
        items.push(stray);
        return stray ? "<div>" : tag;
      }
      return items.pop() ? "</div>" : tag;
    }
    lists = closing ? Math.max(0, lists - 1) : lists + 1;
    return tag;
  });
}

/**
 * Links become their text, so nothing in a clamped card summary can take keyboard
 * focus while its text is hidden. An image inside a link keeps its alt.
 */
export const withoutLinks = (html: string): string => html.replace(/<a\b[^<>]*>|<\/a>/gi, "");
