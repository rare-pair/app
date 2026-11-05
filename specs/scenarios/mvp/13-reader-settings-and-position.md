# Scenario: Reader settings and saved reading position

Relates to: docs/ARCHITECTURE.md § Reading; docs/FRONTEND-DISCOVERY.md § Where the frontend changes the architecture (2. Reader settings under the CSP), § Page inventory (Reader settings, Chapter reader, Entire work), § Typographic system, § Reading experience

## Setup
- A live work W with 5 chapters
- A signed-out reader and a signed-in reader U
- KV stores reading positions keyed by `user:work`
- The reader settings script is served from `'self'` with the page nonce

## Cases

### Settings come from a cookie as attributes on html
- GIVEN a reader whose settings cookie holds theme dark, size L and relaxed line spacing
- WHEN they open a chapter of W
- THEN the server renders `<html data-theme="dark" data-size="l" data-leading="relaxed">`
- AND no inline `style` attribute is used anywhere on the page

### Settings form works without JS
- GIVEN a reader on a chapter of W with JavaScript off
- WHEN they open `/settings/reader`, change the theme to sepia and submit the POST form
- THEN the settings cookie is set
- AND they are redirected back to the chapter, now rendered with `data-theme="sepia"`

### Settings apply live with JS
- GIVEN a reader on a chapter of W with JavaScript on
- WHEN they change the font size from the reader
- THEN a script flips the attribute on `<html>` without a reload
- AND writes the new value to the settings cookie

### Font sizes S, M, L and XL
- GIVEN the reader stylesheet
- WHEN the size setting is S, M, L or XL
- THEN reading body text is 16, 18, 20 or 23 px respectively

### Default reading size is 18 px
- GIVEN a reader with no settings cookie
- WHEN they open a chapter
- THEN reading body text is 18 px

### Themes light, dark and sepia
- GIVEN a reader
- WHEN they choose light, dark or sepia
- THEN the page renders in that theme via `data-theme`

### Default theme follows prefers-color-scheme
- GIVEN a reader with no theme set and a system preference for dark
- WHEN they open a chapter
- THEN the page renders in the dark theme

### Serif or sans-serif reading face
- GIVEN a reader with no face setting
- WHEN they open a chapter
- THEN the reading face is `Charter, "Bitstream Charter", "Iowan Old Style", Georgia, serif`
- AND choosing sans-serif in settings switches the reading face to sans-serif

### Line spacing setting
- GIVEN a reader who changes line spacing in settings
- WHEN they open a chapter
- THEN the line spacing setting is applied via `data-leading`

### Settings work for signed-out readers
- GIVEN a signed-out reader
- WHEN they change reader settings
- THEN the settings are stored in a cookie and applied without signing in

### Reading position saved for signed-in readers with JS
- GIVEN signed-in reader U reading chapter 3 of W with JavaScript on
- WHEN they scroll through the chapter
- THEN the chapter and scroll percentage are saved to KV under `U:W` every few seconds, with a short debounce

### Scrolling back up does not lower the saved position
- GIVEN signed-in reader U who has read to 60% of chapter 3 of W, and whose position is saved
- WHEN U scrolls back to the top of chapter 3 and leaves, by the title link in the reader bar or by closing the page
- THEN the saved position is still chapter 3 at 60%
- AND U rereading chapter 3 from the start, and leaving short of 60%, is still offered 60% on W's work page
- AND reading further than 60% in chapter 3 saves the further point

### Another chapter saves its own position
- GIVEN signed-in reader U whose saved position is 60% of chapter 3 of W
- WHEN U reads chapter 4 and scrolls, even to a point lower than 60%
- THEN the saved position is chapter 4 at that point
- AND the furthest-point rule applies within one chapter only: going to another chapter, or to the entire-work page, replaces the saved position, and each of those keeps its own furthest point

### Entire work view saves position
- GIVEN signed-in reader U on `/works/:id/full` with JavaScript on
- WHEN they scroll
- THEN their reading position is saved to KV

### No position saved for signed-out readers
- GIVEN a signed-out reader reading chapter 3 of W
- WHEN they scroll
- THEN nothing is written to KV for them

### Returning reader is offered their place
- GIVEN signed-in reader U with a saved position in chapter 3 of W
- WHEN U opens W's work page
- THEN a "Continue where you left off" link appears and U is not moved there automatically

### Reduced motion turns off smooth scrolling
- GIVEN a reader whose system sets `prefers-reduced-motion`
- WHEN they use any in-page navigation
- THEN no smooth scrolling happens

### Reading column measure
- GIVEN any chapter page
- WHEN it renders
- THEN the text column is centred, capped at `66ch`, with line height 1.6
