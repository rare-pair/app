// The site stylesheet, served by the Worker from a string so it needs no
// wrangler.jsonc change. System fonts only (FRONTEND-DISCOVERY, Typographic
// system): the wait list's web fonts belong to its own pages, not here.

export const STYLESHEET = `:root {
  color-scheme: light dark;
  --space: 4px;
  --text-1: 13px;
  --text-2: 16px;
  --text-3: 20px;
  --text-4: 25px;
  --text-5: 31px;
  --text-6: 39px;
  --ink: #1a1a1a;
  --paper: #fafaf7;
  --muted: #5c5c57;
  --rule: #d8d8d2;
  --accent: #0b5cad;
  --ui: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --reading: Charter, "Bitstream Charter", "Iowan Old Style", Georgia, serif;
  --reading-size: 18px;
}

/* The system's preference holds only until the reader chooses a theme (R5). */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    --ink: #e8e8e3;
    --paper: #151515;
    --muted: #a3a39d;
    --rule: #3a3a36;
    --accent: #7ab4f0;
  }
}

html {
  font-size: 16px;
}

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--ui);
  font-size: var(--text-2);
  line-height: 1.45;
}

a {
  color: var(--accent);
}

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.skip {
  position: absolute;
  left: calc(var(--space) * 2);
  top: calc(var(--space) * -12);
  padding: calc(var(--space) * 2) calc(var(--space) * 3);
  background: var(--paper);
}

.skip:focus {
  top: calc(var(--space) * 2);
}

.banner {
  margin: 0;
  padding: calc(var(--space) * 2) calc(var(--space) * 4);
  border-bottom: 1px solid var(--rule);
  font-size: var(--text-1);
  text-align: center;
}

header,
main,
footer {
  max-width: 66ch;
  margin: 0 auto;
  padding: 0 calc(var(--space) * 4);
}

header {
  padding-top: calc(var(--space) * 4);
  padding-bottom: calc(var(--space) * 4);
}

.site-name {
  font-size: var(--text-3);
  font-weight: 600;
  color: var(--ink);
  text-decoration: none;
}

main {
  padding-top: calc(var(--space) * 6);
  padding-bottom: calc(var(--space) * 12);
}

h1 {
  margin: 0 0 calc(var(--space) * 4);
  font-size: var(--text-5);
  line-height: 1.2;
}

h2 {
  margin: calc(var(--space) * 8) 0 calc(var(--space) * 2);
  font-size: var(--text-3);
}

.banner a,
footer a {
  display: inline-block;
  min-height: 24px;
  line-height: 24px;
}

/* A link to a page that isn't open yet: no href, so no hover or focus state. */
footer a[aria-disabled="true"] {
  color: var(--muted);
  cursor: not-allowed;
  text-decoration: none;
}

.draft {
  color: var(--muted);
  font-size: var(--text-1);
}

form[role="search"] {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--space) * 2);
  align-items: center;
}

input[type="search"] {
  flex: 1 1 16em;
  font: inherit;
  padding: calc(var(--space) * 2);
}

button {
  font: inherit;
  padding: calc(var(--space) * 2) calc(var(--space) * 4);
}

input[type="search"]:disabled,
button:disabled {
  color: var(--muted);
  cursor: not-allowed;
}

footer {
  padding-top: calc(var(--space) * 4);
  padding-bottom: calc(var(--space) * 8);
  border-top: 1px solid var(--rule);
  font-size: var(--text-1);
}

/* Layout containment makes the chapter the containing block of anything positioned
   inside it, so no fragment can lay itself over the page. Paint containment clips at
   its edge, so the padding keeps focus rings inside it. */
article.chapter {
  font-family: var(--reading);
  font-size: var(--reading-size);
  line-height: 1.6;
  max-width: 66ch;
  contain: content;
  padding: var(--space);
}

@media (prefers-reduced-motion: reduce) {
  *,
  ::before,
  ::after {
    scroll-behavior: auto;
    animation: none;
    transition: none;
  }
}

/* The chapter reader (R2). Paint containment clips what overflows the chapter: long
   words break through main's overflow-wrap, images shrink to fit, and wide tables scroll. */
article.chapter img {
  max-width: 100%;
  height: auto;
}

article.chapter table {
  display: block;
  max-width: 100%;
  overflow-x: auto;
}

/* The slim top bar scrolls away with the page: it is never sticky or fixed. */
.reader-bar {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--space) * 2) calc(var(--space) * 4);
  align-items: baseline;
  justify-content: space-between;
  padding-bottom: calc(var(--space) * 2);
  border-bottom: 1px solid var(--rule);
}

.reader-bar h1 {
  margin: 0;
  font-size: var(--text-2);
}

.chapter-nav,
.chapter-nav form {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--space) * 2) calc(var(--space) * 4);
  align-items: center;
}

.chapter-nav {
  margin: calc(var(--space) * 4) 0;
}

.chapter-nav select {
  font: inherit;
  max-width: 100%;
}

/* Work cards (FRONTEND-DISCOVERY, Work card): sections by whitespace and a hairline. */
.work-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.work-card {
  padding: calc(var(--space) * 4) 0;
  border-bottom: 1px solid var(--rule);
}

/* By the card's own lines, never a summary's elements. */
.card-title {
  margin: 0;
}

.work-card > p {
  margin: var(--space) 0;
}

/* Rating and warnings: the author's size at weight 600, never clamped or hidden. */
.card-rating {
  overflow-wrap: anywhere;
}

.card-rating strong {
  font-weight: 600;
}

/* The whole summary stays in the HTML; only three lines show. */
.card-summary {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
  contain: content;
  /* Markup the clamp counts no lines in, such as a table, is cut at three lines too. */
  max-height: calc(3 * 1.45em);
}

.card-summary > * {
  margin: 0;
}

/* A summary's headings look like its text, not a card title or the page's
   (screen readers still list them: #250). */
.card-summary :is(h1, h2, h3, h4, h5, h6) {
  margin: 0;
  font-size: inherit;
  font-weight: inherit;
  line-height: inherit;
}

/* An image takes about one of the three lines rather than its own height. */
.card-summary img {
  max-width: 100%;
  max-height: 1.45em;
  width: auto;
  height: auto;
}

/* Tags and stats, the least prominent lines, in small type. */
.card-tags,
.card-stats {
  font-size: var(--text-1);
}

/* work page */

.authors,
.rating-warnings {
  font-size: var(--text-3);
}

.rating-warnings {
  font-weight: 600;
}

.tags {
  font-size: var(--text-1);
}

.stats {
  font-size: var(--text-1);
  color: var(--muted);
}

/* the report form: one reason a line, each a large target, and details as wide as the page */

.report-form fieldset {
  margin: 0 0 calc(var(--space) * 4);
}

.report-form fieldset label {
  display: block;
  min-height: 24px;
  padding: var(--space) 0;
}

.report-form > label {
  display: block;
}

.report-form textarea {
  box-sizing: border-box;
  width: 100%;
  margin: var(--space) 0 calc(var(--space) * 4);
  font: inherit;
}

/* any page */

/* A word longer than the line, such as a tag or a URL, breaks rather than scrolling sideways. */
main {
  overflow-wrap: anywhere;
}

/* Text for screen readers only, such as a tag's type. */

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* Reader settings (R5): attributes on <html> from the settings cookie or the settings
   script. Themes set the colours; size, spacing and face change only the chapter. */

:root[data-theme="light"] {
  color-scheme: light;
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --ink: #e8e8e3;
  --paper: #151515;
  --muted: #a3a39d;
  --rule: #3a3a36;
  --accent: #7ab4f0;
}

/* Draft palette for the operator to proof; text, muted text and links pass AA on the paper. */
:root[data-theme="sepia"] {
  color-scheme: light;
  --ink: #433422;
  --paper: #f4ecd8;
  --muted: #6b5a43;
  --rule: #d9cdb3;
  --accent: #8a4b12;
}

html[data-size="s"] {
  --reading-size: 16px;
}

html[data-size="m"] {
  --reading-size: 18px;
}

html[data-size="l"] {
  --reading-size: 20px;
}

html[data-size="xl"] {
  --reading-size: 23px;
}

html[data-leading="compact"] article.chapter {
  line-height: 1.45;
}

html[data-leading="normal"] article.chapter {
  line-height: 1.6;
}

html[data-leading="relaxed"] article.chapter {
  line-height: 1.8;
}

html[data-face="sans"] {
  --reading: var(--ui);
}

/* The settings controls: in the reader bar only once the script shows them. */
.reader-settings {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--space) * 2) calc(var(--space) * 4);
  align-items: center;
}

.reader-settings[hidden] {
  display: none;
}

.reader-settings select {
  font: inherit;
}

.flash {
  margin: 0;
  padding: calc(var(--space) * 2) calc(var(--space) * 4);
  border-bottom: 1px solid var(--rule);
  text-align: center;
}

/* Listing sort and filters, and its pages (FRONTEND-DISCOVERY, Pagination): rows that wrap at 360px. */

.listing-filters {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--space) * 2) calc(var(--space) * 4);
  align-items: end;
  margin: calc(var(--space) * 4) 0;
  padding-bottom: calc(var(--space) * 4);
  border-bottom: 1px solid var(--rule);
}

.listing-filters p {
  margin: 0;
}

.listing-filters label {
  display: block;
  font-size: var(--text-1);
}

.listing-filters select,
.listing-filters input {
  font: inherit;
  max-width: 100%;
}

.pager ul {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--space) * 2) calc(var(--space) * 4);
  list-style: none;
  margin: calc(var(--space) * 4) 0;
  padding: 0;
}

/* The current page is bold text, not a link: not colour alone. */
.pager [aria-current="page"] {
  font-weight: bold;
}

/* the removal form (X1): a field a line, full width, a wrong one marked by more than colour */

.remove-form label {
  display: block;
  margin-top: calc(var(--space) * 4);
}

.remove-form input[type="email"],
.remove-form input[type="text"],
.remove-form textarea {
  box-sizing: border-box;
  width: 100%;
  margin: var(--space) 0;
  font: inherit;
}

.remove-form [aria-invalid="true"] {
  border: 2px solid currentColor;
}

.field-error {
  margin: var(--space) 0 0;
  font-weight: 600;
}

.field-error::before {
  content: "Error: ";
}

.remove-form .cf-turnstile,
.remove-form button {
  margin-top: calc(var(--space) * 4);
}
`;

// FNV-1a, enough to give each version of the stylesheet its own URL.
export const fnv1a = (text: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const STYLESHEET_PATH = `/assets/site.${fnv1a(STYLESHEET)}.css`;
