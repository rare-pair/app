# Scenario: DaisyUI as the UI baseline, and the theme picker

Relates to: docs/FRONTEND-DISCOVERY.md § Decisions so far (Visual direction, Warnings, JavaScript, Branding), § Principles, § Where the frontend changes the architecture (2. Reader settings under the CSP), § Typographic system, § Components, § Reading experience, § Accessibility and devices; docs/ARCHITECTURE.md § Reading, § MVP vs later; specs/scenarios/mvp/07-sanitizing-and-images.md; specs/scenarios/mvp/11-reader-and-csp.md; specs/scenarios/mvp/13-reader-settings-and-position.md; specs/scenarios/mvp/20-site-chrome-and-legal.md; specs/scenarios/mvp/21-accessibility-and-no-js.md; specs/scenarios/mvp/22-waitlist.md

Operator rulings, 2026-11-04: DaisyUI is the new UI baseline, replacing "not boxes, shadows or imagery". The picker includes synthwave and black. The app gains a Tailwind build step for its CSS, and the browser floor in Setup follows from that. DaisyUI's 14 px field text and its navbar height stand, on reader pages too.

Operator rulings, 2026-11-06: Adopt DaisyUI and Tailwind completely, Preflight included. Chapters use Tailwind's `prose`, with custom CSS where it's needed, so they no longer have to look as they did. DaisyUI's classes carry the `d-` prefix. Work page and card summaries may take DaisyUI's resets and styling.

## Setup
- DaisyUI 5, Tailwind and Tailwind's typography plugin, each pinned to one exact version, built into one site stylesheet that holds only what Tailwind's source scan finds
- DaisyUI's classes carry the `d-` prefix
- Tailwind's Preflight is in the stylesheet and applies to the whole site, except the wait list's pages
- `article.chapter` has the `prose` class, set by our own template, on the chapter and entire-work pages. Custom CSS covers what `prose` and Preflight leave wrong
- DaisyUI is the baseline for the site's own interface:
  - site header and footer: navbar and footer
  - banner, flash messages and the review notice: alert
  - work cards: card
  - status badges: badge
  - pagination: join and button
  - forms: button, select, input, textarea, checkbox, radio, fieldset, label and validator
  - upload bars: progress
  - lists and admin queues: list and table
- The wait list's pages take nothing from DaisyUI or Tailwind. Chapters take their colours from the theme, their type from `prose` and their size, spacing and face from the reader settings. Uploaded summaries may take DaisyUI's styling
- The theme picker is the existing Theme control on `/settings/reader` and in the reader bar. Its setting is still `theme` in the `__Host-reader` cookie, written as `data-theme` on `<html>`
- The themes offered, in this order: Match my device, Light, Dark, Sepia, Dim, Night, Silk, Lofi, Synthwave, Black
- Light, Dark and Sepia are the site's own palettes. The other six are DaisyUI's, changed only where a case below needs it
- A live work W with a chapter whose sanitized HTML has `h1`–`h6`, lists, links, an image, a blockquote and a table
- Supported browsers: Chrome and Edge 120, Firefox 128, Safari and iOS Safari 17.2, Samsung Internet 23, and anything newer

## Cases

### Existing behaviour holds
- GIVEN this feature is built
- WHEN the specs in `specs/scenarios/mvp/` are run
- THEN every case in them still passes, with DaisyUI's 14 px field text as the one exception to spec 21's "Interface type and rhythm"

### Pages use the baseline
- GIVEN every page in the page inventory except the wait list's
- WHEN it renders
- THEN the elements listed in Setup have their DaisyUI classes in the markup
- AND they render with DaisyUI's size, padding and colours, which the site's own element rules don't override
- AND with JavaScript off, each DaisyUI component works or shows its content

### Warnings stay in plain view
- GIVEN a work card, a work page or the warnings screen
- WHEN it renders
- THEN rating and warnings are visible text, never inside a collapse, dropdown, tooltip or modal

### Colour is never the only signal
- GIVEN a status badge, a flash message, a field error or a link inside a sentence
- WHEN it renders
- THEN its meaning is given in text, and the link is underlined

### Site classes don't pick up DaisyUI by accident
- GIVEN a site class that shares a name with a DaisyUI or Tailwind class that Setup doesn't choose for it, such as `stats` on the work page and `rating` on the warnings screen
- WHEN the page renders
- THEN no rule from DaisyUI or Tailwind applies to that element through that class

### Picker offers a fixed list of themes
- GIVEN a reader on `/settings/reader`
- WHEN they open the Theme control
- THEN it offers the themes in Setup, each with its name in text
- AND the reader bar's Theme control offers the same list in the same order

### Every theme works through the reader settings flow
- GIVEN any named theme in the list
- WHEN a reader chooses it as in spec 13's "Settings form works without JS" and, in the reader bar, "Settings apply live with JS"
- THEN those cases hold for that theme
- AND the next page has it on `<html>` as sent by the server, so no other theme shows first

### Match my device
- GIVEN a reader whose cookie holds Synthwave
- WHEN they choose Match my device
- THEN the cookie holds no theme and `<html>` has no `data-theme`
- AND a page renders in Dark with a system preference for dark, and in Light with a system preference for light

### Only themes in the list are written
- GIVEN a cookie or a form post whose theme is outside the list, including a DaisyUI theme that isn't offered
- WHEN the server handles it
- THEN no `data-theme` comes from that value
- AND a form post leaves the cookie's saved theme as it was

### Light, Dark and Sepia keep their colours
- GIVEN a reader whose cookie holds light, dark or sepia from before this feature
- WHEN they open a page
- THEN the theme is still applied, with the same text, muted, rule, accent and paper colours as before

### Each theme supplies everything its components read
- GIVEN any theme in the list
- WHEN its values are checked
- THEN the site's text, muted, rule, accent and paper colours and every colour DaisyUI's components read come from that theme
- AND it sets a light or dark `color-scheme`
- AND Light, Dark and Sepia set a radius, border and size for components

### Every theme passes AA
- GIVEN any theme in the list
- WHEN its colours are checked
- THEN text, muted text, links, field errors and focus rings pass 4.5:1 on its paper, using a colour other than the theme's own wherever that fails
- AND text on each component, in each state an enabled component can show, passes 4.5:1 on that component
- AND the visible boundary of an input, select, textarea, checkbox or radio passes 3:1 on what is behind it
- AND disabled controls are exempt from these ratios, as in WCAG

### Chapters are styled by prose
- GIVEN the built site stylesheet and a chapter of W
- WHEN it renders, on its chapter page and on the entire-work page, in any theme
- THEN `article.chapter` has the `prose` class
- AND headings, lists and their markers, links, the blockquote and the table each look like what they are
- AND text, links and table borders pass AA on the theme's paper

### Prose adds nothing to what the author wrote
- GIVEN a chapter with a blockquote and inline code
- WHEN it renders
- THEN no quotation marks, backticks or other characters are added around them by the stylesheet

### Reader settings still work on chapters
- GIVEN spec 13's reader settings
- WHEN a reader changes text size, line spacing or face, with JavaScript on and off
- THEN the chapter's text changes as that spec says, because those settings win over `prose`'s own sizes, leading and font
- AND the reading column keeps its measure, with no `prose` limit narrowing or widening it

### What Preflight strips stays right in chapters
- GIVEN a chapter with an image inside a sentence, a wide table and each element spec 07's sanitizer keeps
- WHEN it renders
- THEN the image stays in the line of text, and no kept element has lost the meaning its author gave it
- AND at 360 px nothing makes the page scroll sideways

### Summaries stay readable
- GIVEN a work whose uploaded summary has a list and a heading
- WHEN its work page and a work card render, in any theme
- THEN the list still shows its markers and the heading is still set apart from the text, with `prose` or custom CSS since Preflight removes them
- AND the text passes AA on what is behind it
- AND on the card, the summary still clamps to three lines, with its "more" link

### Uploaded text cannot use DaisyUI
- GIVEN spec 07's sanitizer and an epub whose chapter or summary has elements with `data-theme`, `class="btn"`, `class="modal"` or `<input class="theme-controller" checked>`
- WHEN it is sanitized and rendered
- THEN none of those attributes or inputs reach the page, and neither does a `not-prose` class
- AND the theme is unchanged

### CSP is unchanged
- GIVEN the CSP spec 11 requires, and the rule in spec 13 against inline `style`
- WHEN any page renders
- THEN both still hold
- AND the served stylesheet contains no `data:` URL

### One theme store
- GIVEN any page
- WHEN it runs
- THEN no theme is read from or written to `localStorage`
- AND no page renders an `input.theme-controller`

### The stylesheet is built from the app's own markup
- GIVEN a clean checkout
- WHEN `/gate`'s standing checks run in their order: lint, format check, typecheck, test, then build
- THEN each one passes and the site stylesheet is produced, with no step run by hand
- AND every DaisyUI and Tailwind class on every page in the page inventory has its rules in that stylesheet

### CSS stays small
- GIVEN the served site stylesheet, one request at a content-hashed, immutable URL
- WHEN it is measured with Node's default brotli settings
- THEN it is under 15 KB compressed and under 100 KB raw
- AND no page adds another stylesheet for DaisyUI

### Supported browsers
- GIVEN the built stylesheet and each browser in Setup at its oldest supported version
- WHEN the stylesheet's CSS features are checked against published browser support data
- THEN every feature that colour, layout or a control's use depends on is supported, and anything newer only adds polish
- AND a chapter, a listing and `/settings/reader` render and work in one theme in the oldest Chromium, Firefox and WebKit the browser tests can run
- AND iOS Safari and Samsung Internet are covered by the data check alone

### Reduced motion stops component animation
- GIVEN a reader whose system sets `prefers-reduced-motion`
- WHEN they use any DaisyUI component
- THEN it doesn't animate

### The baseline fits a phone
- GIVEN a 360 px wide viewport, and spec 21's "No sideways scrolling at 360 px" holding in the default theme
- WHEN `/settings/reader`, a chapter's reader bar and a card with 20+ tags and long warnings render in each theme
- THEN nothing scrolls sideways
- AND the reader bar is still not sticky or fixed

### The wait list is unchanged
- GIVEN `PRELAUNCH` on
- WHEN the coming-soon and other wait list pages render
- THEN no DaisyUI or Tailwind rule applies to them, and they look as they did before

## Notes

- **Why Tailwind.** The app had no CSS build, but the baseline needs far more of DaisyUI. Measured on 5.7.50 with eight theme files, a sample of the classes in Setup and a scan of `apps/web/src`:

  | | Raw | Brotli |
  | --- | --- | --- |
  | Today's stylesheet | 11.5 KB | 2.7 KB |
  | Tailwind build, no prefix, plus today's stylesheet | about 96 KB | about 14.3 KB |
  | Tailwind build, `d-` class prefix, plus today's stylesheet | about 78 KB | about 12.1 KB |
  | DaisyUI's pre-built files, plus today's stylesheet, no build | 325 KB | 18 KB |

- **The class prefix.** Tailwind's scan turns plain words in the source into rules, such as `stats`, `rating`, `fixed` and `hidden`. Without a prefix, the budget has almost no room left before any markup moves. DaisyUI's `d-` prefix, which is what was measured, leaves room and ends collisions with DaisyUI's classes. Collisions with Tailwind's utilities need Tailwind's own prefix, which is still open: see *Open before tickets*.

- **Measured contrast.** Measured on 5.7.50 from the theme files, not in a browser:

  | Theme | Body | Primary on paper | Text on primary | Text at 70% | Error on paper |
  | --- | --- | --- | --- | --- | --- |
  | Dim | 7.88 | 9.08 | 13.01 | 4.71 | 7.43 |
  | Night | 10.98 | 8.33 | 9.16 | 5.95 | 6.6 |
  | Silk | 8.46 | 15.43 | 14.83 | 3.85 | 2.35 |
  | Lofi | 21 | 19.44 | 19.44 | 8.52 | 2.18 |
  | Synthwave | 9.78 | 7.01 | 5.37 | 5.13 | 8.16 |
  | Black | 14.45 | 1.86 | 11.31 | 7.08 | 5.25 |

  Black's links, Silk's muted text and the field errors in Silk and Lofi fail AA as shipped, so the AA case needs adjustments there.
- **Why Light, Dark and Sepia stay the site's own.** DaisyUI's `dark` fails AA as shipped: link 3.4:1, text on a primary button 4.14:1. It has no sepia, and Match my device has to resolve to the site's own Dark.
- **Preflight and prose.** Preflight removes heading sizes, list bullets, link styling and inline images from any markup with no classes, which is all uploaded text, because the sanitizer drops classes. `prose` restores most of that on chapters, set by our template on the wrapper, so the sanitizer doesn't need to allow any class. This drops the earlier requirement that chapters keep their computed styles. Reading is still the site's main job, so the cases above hold it to being readable and working with the reader settings instead.
- **What `prose` is likely to get wrong here.** None of this has been run. It is thought to add quotation marks to blockquotes and backticks to inline code, set its own measure, font size and leading, and Preflight to make images block-level. Each has a case above, and custom CSS answers them. Fics use these elements for letters, texts and asides, so the added characters would change what the author wrote.
- **Where uploaded HTML shows.** `article.chapter` on the chapter and entire-work pages, `.summary` on the work page and `.card-summary` on cards. Summaries come from `summary_html` in Postgres, sanitized at ingest. A summary sits inside a `d-card`, so it inherits that card's text styles.
- **Layers.** Tailwind's rules sit in CSS layers, and unlayered rules beat layered ones, so the site's unlayered `button` and `input` rules would override DaisyUI, against "Pages use the baseline". They need a lower layer or scoping. Custom CSS for chapters has to be placed knowing this too.
- **`data:` URLs.** Every measured Tailwind build has one, in the `--fx-noise` variable DaisyUI always emits, and the whole of `daisyui.css` has 42. `img-src` would block them if used, so they must be left out.
- **Why not `theme-controller` or `theme-change`.** A checked `theme-controller` input overrides `data-theme`, so the page and the cookie can disagree. `theme-change` keeps the choice in `localStorage`, which the server can't read, so the wrong theme shows first and JS-off readers get nothing. DaisyUI's `[data-theme]` selectors already work with the cookie.
- **Wait list stylesheets.** These pages load the site stylesheet and then their own, which is why they need a way to stay out of the baseline, Preflight above all. `22-waitlist.prelaunch.test.ts` pins those two stylesheets today, so it changes with this.
- **Browser floor.** Firefox 128 (July 2024) is Tailwind 4's documented minimum, and the operator raised the floor to it. The other browsers are December 2023 releases, from caniuse data, with Samsung Internet 23 as that browser's last 2023 release. All of them are at or above Tailwind's minimums of Chrome 111 and Safari 16.4.
- **14 px field text.** It is off the 13/16/20 scale, and iOS Safari zooms in when a reader focuses a field under 16 px. The operator accepted this.
- **Not yet proven.** No page has been rendered with DaisyUI, and the budget rests on a sample of classes rather than the app's real markup. Those measurements leave out the typography plugin and Preflight, so "CSS stays small" may no longer fit.

## Open before tickets

- **Build order.** `/gate`'s order runs the tests before the build, but pages need the built stylesheet to test against. Either commit the stylesheet, or build before testing, which changes the gate's order.
- **New dependencies.** Tailwind, its typography plugin and DaisyUI are third-party installs. Agents install nothing on their own, so the operator approves adding them, pinned to exact versions.
- **Tailwind's own prefix.** Whether to use one for its utilities, given the collisions in the notes.

- **The budget.** If the typography plugin and Preflight push the stylesheet past 15 KB, whether to raise the limit or trim.

The first ticket should add the build, put `prose` on chapters and style one button and one form, then run the chapter cases and measure the stylesheet. That proves reading and the budget on real markup before the rest is committed.

## Docs to change with this

- FRONTEND-DISCOVERY § Decisions so far: replace the Visual direction row with DaisyUI as the baseline, and add the browser floor and the Tailwind build. The Warnings and Branding rows stand
- FRONTEND-DISCOVERY § Principles: 2 (text is the interface, one accent colour) and 3 (tiny CSS, with the budget above)
- FRONTEND-DISCOVERY § Typographic system: Measure and rhythm ("not boxes"), Colour (the theme list) and Scale (add DaisyUI's 14 px field text)
- FRONTEND-DISCOVERY § Reading experience: the navbar's height on reader pages replaces "the only chrome is a slim top bar", and chapters are styled by `prose`
- FRONTEND-DISCOVERY § Components: Work card, Status badge, Flash message and Pagination
- ARCHITECTURE § Reading: the reader's theme list
- ARCHITECTURE § MVP vs later: add this to the Later list
- specs/scenarios/mvp/21-accessibility-and-no-js.md: record the 14 px exception in "Interface type and rhythm"
