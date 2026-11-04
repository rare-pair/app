# Scenario: Public list of removed works and opted-out pseuds

Relates to: docs/ARCHITECTURE.md § Decisions so far (Removal list, Author identity), § Data model (works.removed_reason, works.removed_at, works.list_withheld, requests.pseud_typed, optouts.listed_at, optouts.list_withheld), § Author requests & takedowns (The removal list, Moderation); docs/FRONTEND-DISCOVERY.md § Page inventory (Removal list), § Copy and tone; specs/scenarios/mvp/16-removal-and-opt-out.md; specs/scenarios/mvp/17-reports-and-dmca.md

## Setup
- Public reasons and their wording:
  - `dmca`: "Removed after a DMCA notice"
  - `removal_request`: "Removed after a removal request"
  - `wrong_file`: "Removed by a moderator: the file was wrong or damaged"
  - `site_safety`: "Removed by a moderator to keep the site safe"
  - An opted-out pseud always reads "Opted out after a request"
- Live work W with AO3 work ID 12345, titled `Tide Tables`, by pseuds `Moon Child` and `Sol`
- Pseud P, written `Moon Child` by the requester of a confirmed opt-out
- `PRELAUNCH` is off, unless a case says otherwise
- The visitor is signed out, unless a case says otherwise

## Cases

### The lists are public
- GIVEN a signed-out visitor with JavaScript off
- WHEN they open `/removed` and `/removed/pseuds`
- THEN each page renders in full without asking them to sign in

### Footer links to the list
- GIVEN any app page
- WHEN it renders
- THEN the footer has a "Removed works" link to `/removed`

### The list stays closed before launch
- GIVEN `PRELAUNCH` is on
- WHEN a visitor opens `/removed` or `/removed/pseuds`
- THEN they are redirected to `/`, like every other app page

### A removed work's entry
- GIVEN W removed with the reason `dmca`
- WHEN a visitor opens `/removed`
- THEN W's entry shows `Tide Tables`, `Moon Child` and `Sol`, AO3 work ID 12345 linked to its AO3 URL, the removal date and "Removed after a DMCA notice"
- AND the entry doesn't link to W's page on this site

### An anonymous byline stays anonymous
- GIVEN a removed work whose byline is "Anonymous"
- WHEN it is listed
- THEN the entry shows "Anonymous", and nothing tries to identify the author

### Entries are newest first and paged
- GIVEN more than one page of removed works
- WHEN a visitor opens `/removed`
- THEN the most recently removed work comes first
- AND they can reach the older ones through GET links

### Titles and names are shown as text
- GIVEN a removed work whose title holds HTML, and a confirmed opt-out whose typed pseud holds HTML
- WHEN each list renders
- THEN the text is escaped, and no markup or script from it runs

### Only removed works are listed
- GIVEN a live work, a work hidden by a removal request, a work hidden by reader reports and a work hidden by a moderator
- WHEN a visitor opens `/removed`
- THEN none of them is listed

### Works hidden by an opt-out are not listed
- GIVEN pseud P with an approved opt-out and its works hidden
- WHEN a visitor opens `/removed`
- THEN none of those works is listed, because they are hidden, not removed

### Open items are not listed or counted
- GIVEN a pending DMCA notice, a pending removal request, an unconfirmed opt-out and a confirmed opt-out no moderator has approved
- WHEN a visitor opens either list
- THEN none of them is listed, and neither page gives a count of pending or hidden items

### Private fields never appear
- GIVEN entries from a takedown, a removal request and an opt-out
- WHEN a visitor opens either list
- THEN no statement, DMCA basis or requester, contact email, IP hash, moderator or moderation note appears on the page

### Approving a takedown sets its reason
- GIVEN a pending DMCA notice on W
- WHEN a moderator approves it
- THEN W is removed with the reason `dmca` and is listed

### Approving a removal request sets its reason
- GIVEN a confirmed removal request for W
- WHEN a moderator approves it
- THEN W is removed with the reason `removal_request` and is listed

### The approved item decides the reason when a work has both
- GIVEN W with a confirmed removal request and a pending DMCA notice
- WHEN a moderator approves the removal request
- THEN W is removed with the reason `removal_request`
- AND the pending notice is marked `removed` and W's AO3 work ID goes on the takedown list

### A moderator's own remove asks for a reason
- GIVEN W with no pending DMCA notice, with or without a confirmed removal request
- WHEN a moderator opens the remove confirm step on W's admin page
- THEN it asks them to choose `wrong_file` or `site_safety`, and offers no free text
- AND a pending removal request on W stays pending

### A remove with no valid reason changes nothing
- GIVEN W with no pending DMCA notice
- WHEN a moderator posts the remove with a missing or unknown reason
- THEN the post is refused, W is unchanged and no log row is written

### A pending DMCA notice decides the reason
- GIVEN W with a pending DMCA notice
- WHEN a moderator removes W from its admin page or the notice's page
- THEN W is removed with the reason `dmca`, because the notice is marked `removed` and the work goes on the takedown list

### Repeating a remove keeps the first reason
- GIVEN W already removed with the reason `site_safety`
- WHEN a moderator repeats the remove, or approves a request or a notice on W
- THEN the reason and the removal date stay as they were

### A work removed before the list has a derived reason
- GIVEN works removed before the migration: one with a `removed` takedown, one with an `approved` removal request, one with both and one with neither
- WHEN the migration runs
- THEN their reasons are `dmca`, `removal_request`, `dmca` and `site_safety`
- AND each `removed_at` is the time of its latest `remove` log row, or the migration's time if it has none

### A failed purge still lists the work
- GIVEN a moderator's remove of W whose cache purge fails
- WHEN a visitor opens `/removed`
- THEN W is listed, because its status is `removed`

### A restored work leaves the list
- GIVEN W listed with the reason `site_safety`
- WHEN a moderator restores W
- THEN W's reason, removal date and withheld mark are cleared
- AND W is gone from `/removed` within 60 s of the restore

### A work removed again gets a new reason and date
- GIVEN W removed, then restored
- WHEN a moderator removes W again
- THEN W is listed once, with the new reason and date

### Approving an opt-out asks to confirm the public name
- GIVEN a confirmed opt-out for P
- WHEN a moderator opens its approve
- THEN a confirm step shows `Moon Child` as it will appear publicly, with a choice to withhold it
- AND the opt-out is approved only when that step is posted

### An approved opt-out is listed by the pseud as typed
- GIVEN a confirmed opt-out for P
- WHEN a moderator approves it
- THEN `/removed/pseuds` shows `Moon Child`, the date of approval and "Opted out after a request"
- AND it doesn't show `pseud_norm`, the works hidden by the opt-out, or the requester

### An unapproved opt-out is not listed
- GIVEN a confirmed opt-out for P that is active and awaiting a moderator
- WHEN a visitor opens `/removed/pseuds`
- THEN P is not listed, even though its works are hidden and its uploads are rejected

### An opt-out for a pseud with no works is listed once approved
- GIVEN an approved opt-out for a pseud with no works in the archive
- WHEN a visitor opens `/removed/pseuds`
- THEN the pseud is listed

### Two opt-outs for one pseud make one entry
- GIVEN two approved opt-outs with the same `pseud_norm`, typed `Moon Child` and `moon child`
- WHEN a visitor opens `/removed/pseuds`
- THEN one entry appears, with the name and date of the earlier approval

### A reversed opt-out leaves the list
- GIVEN P listed
- WHEN a moderator rejects its only approved opt-out
- THEN P is gone from `/removed/pseuds` within 60 s of the reversal

### Withholding a work's details
- GIVEN W listed
- WHEN a moderator withholds its details
- THEN W's entry shows only "Details withheld", the date and the reason
- AND the title, byline and AO3 work ID don't appear on the page
- AND one `moderation_actions` row records it

### Withholding a pseud
- GIVEN P listed
- WHEN a moderator withholds it
- THEN P is not listed, and its opt-out stays active
- AND one `moderation_actions` row records it

### One withheld opt-out withholds the pseud
- GIVEN two approved opt-outs with the same `pseud_norm`, one of them withheld
- WHEN a visitor opens `/removed/pseuds`
- THEN the pseud is not listed

### A withheld entry can be shown again
- GIVEN W's details or P withheld
- WHEN a moderator un-withholds it
- THEN the entry is shown in full again
- AND one `moderation_actions` row records it

### The page says how to ask to be taken off
- GIVEN any visitor
- WHEN they open `/removed` or `/removed/pseuds`
- THEN the page says nobody's identity is checked, so an entry is not a statement about who wrote or asked for anything
- AND it gives the moderators' contact address for asking that a name or title be withheld

### Requesters are told before they ask
- GIVEN the `/remove` form and the `/dmca` form
- WHEN each renders
- THEN it says that a removed work's title, byline and reason are published on `/removed`
- AND `/remove` says that an approved opt-out publishes the pseud on `/removed/pseuds`

### The privacy notice covers the list
- GIVEN any visitor
- WHEN they open `/privacy`
- THEN it describes what the lists publish, and how to ask for an entry to be withheld

### Search engines are asked to leave the lists out
- GIVEN any visitor
- WHEN they open `/removed` or `/removed/pseuds`
- THEN the response carries `X-Robots-Tag: noindex`

### Removed work pages stay as they are
- GIVEN W removed and listed
- WHEN anyone opens W's work page, any chapter URL or `/full`
- THEN the response is 410 "This work has been removed", with no reason shown
