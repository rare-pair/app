# Scenario: Accessibility, no-JS behaviour and device performance

Relates to: docs/FRONTEND-DISCOVERY.md § Decisions so far (JavaScript, Pagination), § Principles, § Page inventory, § Where the frontend changes the architecture (1. Forms with Turnstile need JS), § Typographic system, § Accessibility and devices; docs/ARCHITECTURE.md § Reading, § Sanitizing (security requirement), § Surge controls

## Setup
- Every page in the page inventory: home, search, tag listing, work, warnings, chapter, entire work, reader settings, sign in, confirm sign-in, sign out, accept terms, upload, my uploads, remove, report, DMCA, admin queues (including works to check), work admin, about/terms/privacy, hidden, removed, too many requests, not found
- A browser with JavaScript off, one with CSS off, and a 360 px wide viewport
- An automated WCAG 2.2 AA checker

## Cases

### Pages render with JavaScript off and only the Turnstile forms need it
- GIVEN JavaScript is off, and a session already exists where a journey needs one
- WHEN a user opens every page in the inventory and completes each journey without a Turnstile check: find and read, change reader settings, check uploads, report, moderate
- THEN every page renders and every one of those journeys can be completed
- AND reading, browsing, search and reader settings work fully
- AND sign in, upload, `/remove` and the copyright notice at `/dmca` show their `<noscript>` message instead of a working form

### Scripts only enhance pages without a Turnstile check
- GIVEN JavaScript is on
- WHEN pages load
- THEN on sign in, upload, `/remove` and `/dmca` scripts run Turnstile and the form, including upload progress
- AND on the sign-in link page, a script submits its form once for a browser that holds the sign-in marker; the page has the "Sign in" button either way, and without the marker it has no script
- AND on every other page scripts only add reader settings without reload, saving reading position and in-place upload status

### WCAG 2.2 AA
- GIVEN every page in the inventory
- WHEN it is checked against WCAG 2.2 AA
- THEN it passes

### Skip link, landmarks and one h1 in the page chrome
- GIVEN any page
- WHEN it renders
- THEN it has a skip link, landmarks and exactly one `<h1>` in its own chrome (the page or work title)
- AND heading order matches the visual order

### Headings inside chapter content are not counted
- GIVEN a chapter whose sanitized HTML contains two `<h1>` elements
- WHEN the reader page renders
- THEN the page chrome still has exactly one `<h1>`
- AND the chapter's own headings appear inside `<article class="chapter">` as written

### No sideways scrolling at 360 px
- GIVEN a 360 px wide viewport
- WHEN each page renders, including a work card with 20+ tags and long warnings
- THEN nothing scrolls sideways

### Every action reachable by keyboard
- GIVEN a keyboard-only user
- WHEN they navigate any page
- THEN every link, form control and action can be reached and used

### Focus rings always visible
- GIVEN a keyboard-only user moving focus
- WHEN any element receives focus
- THEN a focus ring in the accent colour is visible

### Pages make sense with CSS off
- GIVEN CSS is off
- WHEN any page renders
- THEN its HTML order is the reading order and the content makes sense

### Colour is never the only signal
- GIVEN ratings and warnings on cards and work pages
- WHEN they render
- THEN they have no colour coding and are bold text with labels spelled out

### Tag types are announced without colour
- GIVEN a tag list
- WHEN a screen reader reads it
- THEN each tag's type is given by a visually hidden label

### No web fonts
- GIVEN any page
- WHEN it loads
- THEN only system font stacks are used and no font file is downloaded

### Warnings screen needs no focus trap
- GIVEN the warnings screen
- WHEN a keyboard user reaches it
- THEN it is a full page, not a modal, and focus moves normally

### Reduced motion respected
- GIVEN `prefers-reduced-motion` is set
- WHEN the reader navigates within a page
- THEN no smooth scrolling happens

### Interface type and rhythm
- GIVEN any interface page
- WHEN it renders
- THEN interface text uses a 16 px base with line height 1.45, and the reader uses line height 1.6 at `66ch`
