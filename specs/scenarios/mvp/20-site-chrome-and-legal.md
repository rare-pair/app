# Scenario: Temporary banner, branding, legal pages and shared page chrome

Relates to: docs/ARCHITECTURE.md § Opening, § MVP vs later (8. Terms, privacy notice and banner); docs/FRONTEND-DISCOVERY.md § Decisions so far (Branding), § Principles (4. Honest about being temporary), § Page inventory (About / terms / privacy, Not found), § Components (Flash message, Temporary banner), § Copy and tone

## Setup
- The web Worker serves every app page with the shared layout
- A signed-out visitor and a signed-in user

## Cases

### Temporary banner on every page
- GIVEN any app page, including the reader, upload, remove and admin pages
- WHEN it renders
- THEN one line at the very top says this is an unofficial stopgap and links to `/about`

### No AO3 or OTW branding
- GIVEN any app page
- WHEN it renders
- THEN it uses no AO3 or OTW name, logo, symbols or site styling, and does not imply affiliation or approval

### Ratings and warnings are text, not symbols
- GIVEN any page showing a rating or warning
- WHEN it renders
- THEN they are spelled-out text badges, not symbol icons

### About, terms and privacy pages
- GIVEN any visitor
- WHEN they open `/about`, `/terms` and `/privacy`
- THEN each is a static page that renders without sign-in or JavaScript

### Footer links to removal
- GIVEN any app page
- WHEN it renders
- THEN the footer has a "Remove my work" link to `/remove`
- AND a "Removed works" link to `/removed`

### Not-found page
- GIVEN a URL that matches no page
- WHEN a visitor opens it
- THEN the page shows a search box and a home link

### Flash message after a POST
- GIVEN a form that POSTs and redirects, such as reader settings
- WHEN the redirected page renders
- THEN a one-line notice shows at the top, carried over the redirect in a short-lived cookie

### Credit goes to the original work
- GIVEN any work page
- WHEN it renders
- THEN credit is given through a link to the original AO3 work URL
