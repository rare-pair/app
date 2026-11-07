// The site stylesheet, served by the Worker from a string so it needs no
// wrangler.jsonc change. System fonts only (FRONTEND-DISCOVERY, Typographic
// system): the wait list's web fonts belong to its own pages, not here.

// The site's width, header to footer, in one place. A length in px, not ch: ch follows the
// font size, which would make the footer's smaller text a narrower column than main's.
const SITE_WIDTH = "960px";
// The measure of running text: a chapter, and the prose on the pages that carry it.
const MEASURE = "66ch";

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
  /* The screen's height at least, so a short page's footer sits at the bottom of it. 100vh
     is the fallback: on phones it is taller than the visible screen, which 100dvh is. */
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
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
  box-sizing: border-box;
  max-width: ${SITE_WIDTH};
  margin: 0 auto;
  padding: 0 calc(var(--space) * 4);
}

/* Auto margins stop a flex item stretching, so the site's own header, main and footer take
   the column's width to keep it. */
body > header,
body > main,
body > footer {
  width: 100%;
}

/* Prose on a page keeps a readable measure inside the wider column: paragraphs and plain
   lists directly in main, and the work summary. A list with a class is a layout (cards,
   chapters, tags), not running text. A page that puts prose anywhere else gives it a rule. */
main > p,
main > ul:not([class]),
main > ol:not([class]),
main > section.summary,
main form > p.note {
  max-width: ${MEASURE};
}

body > main {
  flex: 1 0 auto;
}

header {
  padding-top: calc(var(--space) * 4);
  padding-bottom: calc(var(--space) * 4);
}

/* The site header is the page's own, a child of body: a header a chapter carries is not
   laid out as one. */
body > header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: calc(var(--space) * 2) calc(var(--space) * 4);
}

body > header nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: calc(var(--space) * 1) calc(var(--space) * 4);
  min-width: 0;
}

body > header nav form {
  display: inline-flex;
  margin: 0;
}

/* Sign out sits in the row with the links, so it is no taller than they are (24 px, the
   smallest target). */
body > header nav button {
  min-height: 24px;
  padding: 0 calc(var(--space) * 2);
  line-height: 22px;
}

.site-name {
  font-size: var(--text-3);
  font-weight: 600;
  color: var(--ink);
  text-decoration: none;
}

/* A character in the system fonts, so it takes the site name's colour in both themes. */
.logo {
  margin-right: var(--space);
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
body > header nav a,
footer a,
.chapters a {
  display: inline-block;
  min-height: 24px;
  line-height: 24px;
}

/* A link to a page that isn't open yet: no href, so no hover or focus state. */
footer a[aria-disabled="true"],
body > header a[aria-disabled="true"] {
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

/* The search box and its button are compact (32 px, above the 24 px touch minimum). */
form[role="search"] input[type="search"],
form[role="search"] button {
  box-sizing: border-box;
  min-height: 32px;
  padding-top: var(--space);
  padding-bottom: var(--space);
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
  max-width: ${MEASURE};
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

/* Chapter notes (first in the chapter) and end notes (last): a label <p> then a
   <blockquote>. The sanitizer drops class and id, so they are matched by position; a real
   quote block placed the same way is styled the same (accepted, ARCHITECTURE Reading). */
article.chapter > p:first-child:has(+ blockquote),
article.chapter > p:first-child + blockquote,
article.chapter > div:first-child > p:first-child:has(+ blockquote),
article.chapter > div:first-child > p:first-child + blockquote,
article.chapter > p:has(+ blockquote:last-child),
article.chapter > p + blockquote:last-child,
article.chapter > div:last-child > p:has(+ blockquote:last-child),
article.chapter > div:last-child > p + blockquote:last-child {
  font-size: 0.85em;
  color: var(--muted);
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

/* The reading column is centred in the site's width, at the width the page's column had
   before the site widened (66ch of the interface font), so a chapter's line length is
   unchanged; the chapter's own 66ch, in the reading face and size, can only narrow it. The
   chapter's heading, the chapter navigation and the link back sit in the same column and
   share the chapter's edges (its padding is one space). The reader bar above it keeps the
   site's full width. */
.reading {
  max-width: ${MEASURE};
  margin: 0 auto;
}

.reading > .chapter-title,
.reading > .chapter-nav,
.reading > p.back {
  padding-left: var(--space);
  padding-right: var(--space);
}

/* The form is a flex item and the select is as wide as its longest option (a long chapter
   title): without min-width: 0 neither shrinks below that, and the page scrolls sideways. */
.chapter-nav form {
  min-width: 0;
  max-width: 100%;
}

.chapter-nav select {
  font: inherit;
  max-width: 100%;
  min-width: 0;
}

/* My uploads: rows like work cards; the badge is text in bold, never colour alone. */
.upload-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.upload-list li {
  padding: calc(var(--space) * 3) 0;
  border-bottom: 1px solid var(--rule);
  overflow-wrap: anywhere;
}

.upload-message {
  margin: 0;
}

.badge {
  font-weight: 600;
  white-space: nowrap;
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

.dmca-form > label {
  display: block;
  margin-top: calc(var(--space) * 3);
}

.dmca-form input[type="text"],
.dmca-form textarea {
  box-sizing: border-box;
  width: 100%;
  margin: var(--space) 0;
  font: inherit;
}

.dmca-form label.check {
  display: flex;
  gap: calc(var(--space) * 2);
  align-items: flex-start;
  min-height: 24px;
}

.dmca-form button {
  margin-top: calc(var(--space) * 4);
}

/* any page */

/* A word longer than the line, such as a tag or a URL, breaks rather than scrolling sideways. */
main {
  overflow-wrap: anywhere;
}

/* The upload page's drop area: a dashed box, with a solid one while a file is over it. */
.drop-area {
  border: 2px dashed currentcolor;
  padding: calc(var(--space) * 4);
  margin-bottom: calc(var(--space) * 4);
}

.drop-area.over {
  border-style: solid;
}

#files li button {
  margin: 0 calc(var(--space) * 2);
}

/* The upload page's bars: never wider than a narrow screen. */
progress {
  max-width: 100%;
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

/* The sign-in page (#726): one centred column, 28rem, with its heading, alert and notes
   in it, and room between the label, the field, the anti-spam check and the button. */
.sign-in {
  max-width: 28rem;
  margin: 0 auto calc(var(--space) * 6);
}

main:has(.sign-in) > :not(.sign-in) {
  max-width: 28rem;
  margin-left: auto;
  margin-right: auto;
}

main:has(.sign-in) > p[role="alert"] {
  box-sizing: border-box;
  padding: calc(var(--space) * 3) calc(var(--space) * 4);
  border: 2px solid currentColor;
  font-weight: 600;
}

/* Help, not a warning: a quiet rule at the side, in the muted colour, with no box. */
.sign-in-help {
  box-sizing: border-box;
  padding-left: calc(var(--space) * 3);
  border-left: 3px solid var(--rule);
  color: var(--muted);
}

.sign-in label {
  display: block;
  margin-bottom: calc(var(--space) * 2);
  font-weight: 600;
}

.sign-in input[type="email"] {
  box-sizing: border-box;
  width: 100%;
  min-height: 44px;
  padding: calc(var(--space) * 2) calc(var(--space) * 3);
  font: inherit;
}

.sign-in .cf-turnstile,
.sign-in button {
  margin-top: calc(var(--space) * 6);
}

.sign-in button {
  width: 100%;
  min-height: 44px;
}

/* Updates: summary cards on the home page, and a post's byline and body. */
.update-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.update {
  padding: calc(var(--space) * 3) 0;
  border-bottom: 1px solid var(--rule);
  overflow-wrap: anywhere;
}

.update h3,
.update p,
.update-meta {
  margin: 0;
}

.update-body {
  max-width: ${MEASURE};
  overflow-wrap: anywhere;
}

.fandom-list {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--space) * 2) calc(var(--space) * 4);
  list-style: none;
  margin: 0;
  padding: 0;
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
