# Scenario: Updates from a static JSON file, with a list page and paging

Relates to: specs/scenarios/mvp/25-updates.md; docs/FRONTEND-DISCOVERY.md § Decisions so far (Updates), § Page inventory (Update post)

Builds on specs/scenarios/mvp/25-updates.md, which keeps updates in code with no list page. What that spec says about the home page, a post's contents and its address still holds.

## Setup
- Updates live in one static JSON file in the repository, bundled with the web Worker. There is still no database table or admin page, and adding an update is still a commit and a deploy
- Each entry has the slug, title, summary, author, created date and body that spec 25 names
- More updates than fit on one list page, unless a case says otherwise

## Cases

### Moving to JSON changes nothing a reader sees
- GIVEN the updates that were in code
- WHEN they are served from the JSON file
- THEN the home page and every post render as before, at the same addresses, with the first update's text still word for word

### A bad entry fails the build, not the site
- GIVEN an entry missing a field, with a repeated slug or with a date that isn't a real calendar date
- WHEN the standing checks run
- THEN they fail and name the entry

### The list page
- GIVEN any visitor
- WHEN they open `/updates`
- THEN they see every update as a summary card, newest first, with the title, summary, author and created date
- AND the page answers 200 with one plain line when there are no updates

### The list page is paged
- GIVEN more updates than fit on one page
- WHEN a visitor opens `/updates`
- THEN Next and Previous are real links, as on the tag listing, and work with JavaScript off
- AND a page past the end answers as the tag listing does

### The home page links to the list
- GIVEN at least one update
- WHEN a visitor opens `/`
- THEN the "Updates" section still shows up to three cards, newest first, and has an "All updates" link to `/updates`

### Moving between posts
- GIVEN a post with a newer and an older update
- WHEN it renders
- THEN it has a "Newer update" and an "Older update" link, each naming the title it goes to
- AND the newest post has no "Newer update" link, and the oldest has no "Older update" link

### Closed before launch, and bots refused
- GIVEN `PRELAUNCH` is on, or a declared automated client
- WHEN `/updates` is requested
- THEN it is answered as spec 25 answers a post
