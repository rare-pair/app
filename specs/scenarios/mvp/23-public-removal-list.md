# Scenario: Public list of removed works and opted-out pseuds

Relates to: docs/ARCHITECTURE.md § Decisions so far (Removal list, Author identity), § Data model (works.removed_reason, works.removed_at, works.list_withheld, requests.pseud_typed, listed_pseuds), § Author requests & takedowns (The removal list, Moderation); docs/FRONTEND-DISCOVERY.md § Page inventory (Removal list, Listed pseuds, Work admin), § Copy and tone; specs/scenarios/mvp/16-removal-and-opt-out.md; specs/scenarios/mvp/17-reports-and-dmca.md; specs/scenarios/mvp/20-site-chrome-and-legal.md (Footer links to removal)

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

### The footer link is disabled before launch
- GIVEN `PRELAUNCH` is on
- WHEN any page renders
- THEN the footer's "Removed works" link is disabled, like "Remove my work"

### The lists are public
- GIVEN a signed-out visitor with JavaScript off
- WHEN they open `/removed` and `/removed/pseuds`
- THEN each page renders in full without asking them to sign in

### A removed work's entry
- GIVEN W removed with the reason `dmca`
- WHEN a visitor opens `/removed`
- THEN W's entry shows `Tide Tables`, `Moon Child` and `Sol`, the removal date and "Removed after a DMCA notice"
- AND a link reading "The original work" and showing 12345 goes to W's AO3 URL, with the same note as on the work page
- AND the entry doesn't link to W's page on this site
- AND the page's copy doesn't name the original archive

### An anonymous byline stays anonymous
- GIVEN a removed work whose byline is "Anonymous", and one whose byline names nobody
- WHEN they are listed
- THEN each entry shows "Anonymous", and nothing tries to identify the author

### A long byline is cut short
- GIVEN a removed work with more than 10 names in its byline
- WHEN it is listed
- THEN the entry shows the first 10 names and "+n more"

### Entries are newest first and paged
- GIVEN more than one page of removed works
- WHEN a visitor opens `/removed`
- THEN the most recently removed work comes first
- AND they can reach the older ones through GET links

### An empty list says so
- GIVEN no removed works, or no listed pseuds
- WHEN a visitor opens that list
- THEN the page says there are no entries, with a 200

### Bad page numbers act as they do on browse listings
- GIVEN either list
- WHEN a visitor asks for page 0, a page past the last, or a page that isn't a number
- THEN the answer is the same as a tag listing's for that page

### Titles and names are shown as text
- GIVEN a removed work whose title holds HTML, and an approved opt-out whose typed pseud holds HTML
- WHEN each list, the confirm steps and `/admin/listed-pseuds` render
- THEN the text is escaped, and no markup or script from it runs

### Only removed works are listed
- GIVEN a live work, and works hidden by a removal request, by reader reports, by a moderator and by an approved opt-out
- WHEN a visitor opens `/removed`
- THEN none of them is listed

### Open items are not listed or counted
- GIVEN a pending DMCA notice, a pending removal request, an unconfirmed opt-out, and a confirmed opt-out no moderator has approved, whose works are hidden and whose uploads are rejected
- WHEN a visitor opens either list
- THEN none of them is listed, and neither page gives a count of pending or hidden items

### Private fields never appear
- GIVEN entries from a takedown, a removal request and an opt-out
- WHEN a visitor opens either list
- THEN no statement, DMCA basis or requester, contact email, IP hash, moderator or moderation note appears on the page

### Approving a notice gives the DMCA reason
- GIVEN W with a confirmed removal request and a pending DMCA notice
- WHEN a moderator approves the notice
- THEN W is removed with the reason `dmca` and is listed

### Approving a removal request gives its reason
- GIVEN W with a confirmed removal request and a pending DMCA notice
- WHEN a moderator approves the removal request
- THEN W is removed with the reason `removal_request` and is listed
- AND the pending notice is marked `removed` and W's AO3 work ID goes on the takedown list

### A moderator's own remove asks for a reason
- GIVEN W with no pending DMCA notice, no confirmed pending removal request and no active opt-out covering it
- WHEN a moderator opens the remove confirm step on W's admin page
- THEN it asks them to choose `wrong_file` or `site_safety`, and offers no free text

### A moderator's own remove can name the request behind it
- GIVEN W with no pending DMCA notice, and a confirmed pending removal request or an active opt-out covering it
- WHEN a moderator opens the remove confirm step on W's admin page
- THEN it also offers `removal_request`, already selected
- AND a pending removal request on W stays pending

### Every removal shows the entry first and offers to withhold it
- GIVEN any confirm step that removes a work: a moderator's own remove, or approving a request or a notice
- WHEN it renders
- THEN it shows the title and byline as the list will show them, with a choice to withhold the details
- AND the requester's statement is on the page
- AND the choice is applied in the same transaction as the removal, so the details are never listed first

### A site safety removal withholds by default
- GIVEN a moderator's own remove of W
- WHEN they choose `site_safety`
- THEN withholding is already selected, and they can clear it

### A first remove with no valid reason changes nothing
- GIVEN W not yet removed, with no pending DMCA notice
- WHEN a moderator posts the remove with a missing or unknown reason
- THEN the post is refused, W is unchanged and no log row is written

### A pending DMCA notice decides the reason
- GIVEN W with a pending DMCA notice
- WHEN a moderator removes W from its admin page or the notice's page
- THEN W is removed with the reason `dmca`, and no reason is asked for

### Repeating a remove keeps the first reason
- GIVEN W already removed with the reason `site_safety`
- WHEN a moderator repeats the remove with no reason to retry a failed purge, or approves a request or a notice on W
- THEN the action goes ahead
- AND the reason and the removal date stay as they were

### A work removed before the list has a derived reason
- GIVEN works removed before the migration: one with a `removed` takedown, one with an `approved` removal request, one with both, one hidden by a request or opt-out that wasn't rejected (a `request_works` row) and one with none of these
- WHEN the migration runs
- THEN their reasons are `dmca`, `removal_request`, `dmca`, `removal_request` and `site_safety`
- AND each `removed_at` is the time of its latest `remove` log row, or the migration's time if it has none

### An opt-out from before the list is never listed
- GIVEN an opt-out approved before the migration, and one still pending
- WHEN the migration runs
- THEN both keep a NULL `pseud_typed` and neither is listed, because their requesters were never told a name would be published
- AND when a moderator opens the pending one's approve, the confirm step says it won't be listed, and approving adds no entry

### A reversal doesn't fall back to an opt-out from before the list
- GIVEN an opt-out for P approved before the migration, and a later approved opt-out that lists P
- WHEN a moderator rejects the later one
- THEN P's row is deleted, and P leaves the list

### A failed purge still lists the work
- GIVEN a moderator's remove of W whose cache purge fails
- WHEN a visitor opens `/removed`
- THEN W is listed, because its status is `removed`

### A removed work stays listed
- GIVEN W listed
- WHEN a moderator posts Restore on W
- THEN nothing changes, because a removed work can't be restored, and W stays listed
- AND a moderator who removed W by mistake can withhold its details

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

### A typed pseud is cleaned before it is stored
- GIVEN an opt-out request whose pseud holds zero-width or direction-control characters, or extra whitespace
- WHEN it is stored
- THEN `pseud_typed` has those characters removed and its whitespace trimmed and collapsed, as for `pseud_norm`, with its case kept
- AND the confirm step and the list show that form

### An opt-out for a pseud with no works withholds by default
- GIVEN a confirmed opt-out for a pseud with no works in the archive
- WHEN a moderator opens its approve
- THEN the confirm step says no work here has this name, and withholding is already selected
- AND if the moderator clears it and approves, the pseud is listed

### Two opt-outs for one pseud make one entry
- GIVEN two approved opt-outs with the same `pseud_norm`, typed `Moon Child` and `moon child`
- WHEN a visitor opens `/removed/pseuds`
- THEN one entry appears, with the name and date of the first approval

### A second approval confirms the entry already there
- GIVEN P listed, or withheld, and a second confirmed opt-out for the same `pseud_norm`
- WHEN a moderator opens its approve
- THEN the confirm step shows the entry as it stands, with the choice to withhold it if it is listed
- AND approving keeps its name and date, and a withhold chosen there applies, with its `withhold` row
- AND approving never un-withholds an entry

### A reversed opt-out leaves the list
- GIVEN P listed
- WHEN a moderator rejects its only approved opt-out
- THEN P's row is deleted, and P is gone from `/removed/pseuds` within about 2 minutes

### Reversing the named opt-out moves the name
- GIVEN P listed under the name from the first of two approved opt-outs
- WHEN a moderator rejects the first
- THEN the entry shows the second's typed name, with its date unchanged
- AND a rejected request's text is never shown

### Reversing the other opt-out keeps the entry
- GIVEN P listed under the name from the first of two approved opt-outs
- WHEN a moderator rejects the second
- THEN P's entry stays as it was

### Approve and reject at once leave the list right
- GIVEN P listed from an approved opt-out, and a second confirmed opt-out for the same `pseud_norm`
- WHEN one moderator approves the second as another rejects the first
- THEN P is listed under the second's name

### Withholding a work's details
- GIVEN W listed
- WHEN a moderator withholds its details on W's admin page
- THEN within about 2 minutes W's entry shows only "Details withheld", the date and the reason
- AND the title, byline and original work link don't appear on the page
- AND one `withhold` row in `moderation_actions` records it, on the work

### Withholding a pseud
- GIVEN P listed, with one or more approved opt-outs
- WHEN a moderator withholds it on `/admin/listed-pseuds`
- THEN within about 2 minutes P is not listed, and its opt-outs stay active
- AND one `withhold` row in `moderation_actions` records it, with target kind `pseud`

### A withheld pseud leaves the bylines on the list too
- GIVEN P withheld, and removed work W with the byline `Moon Child` and `Sol`, whose details aren't withheld
- WHEN a visitor opens `/removed`
- THEN W's byline shows "Name withheld" and `Sol`

### Moderators can find every listed pseud
- GIVEN a listed pseud and a withheld one
- WHEN a moderator opens `/admin/listed-pseuds`
- THEN both are in the table, marked listed or withheld
- AND anyone else gets 404

### A reversal remembers a withhold
- GIVEN P withheld, and its only approved opt-out rejected
- WHEN a new opt-out for the same `pseud_norm` is confirmed and approved
- THEN P stays withheld, and the confirm step says so
- AND if a moderator later un-withholds P, the entry shows the new opt-out's typed name

### A withheld entry can be shown again
- GIVEN W's details or P withheld, with an approved opt-out for P
- WHEN a moderator un-withholds it
- THEN the entry is shown in full again
- AND one `unwithhold` row in `moderation_actions` records it

### Un-withholding a pseud with no opt-out left publishes nothing
- GIVEN P withheld, and its only approved opt-out rejected
- WHEN a moderator un-withholds it
- THEN P's row is deleted and P is not listed

### The page says how to ask to be taken off
- GIVEN any visitor
- WHEN they open `/removed` or `/removed/pseuds`
- THEN the page says nobody's identity is checked, so an entry is not a statement about who wrote or asked for anything
- AND it says a byline comes from the uploaded file, and that the people it names may not have uploaded the work, asked for its removal or done anything wrong
- AND it gives the moderators' contact address for asking that a name or title be withheld

### Requesters are told before they ask
- GIVEN the `/remove` form and the `/dmca` form
- WHEN each renders
- THEN it says that a removed work's title, byline and reason are published on `/removed`
- AND `/remove` says that an approved opt-out publishes the pseud on `/removed/pseuds`
- AND each says to mention it in the statement if the requester wants a name or title left off, which a moderator weighs at the confirm step

### The privacy notice covers the list
- GIVEN any visitor
- WHEN they open `/privacy`
- THEN it describes what the lists publish, and how to ask for an entry to be withheld
- AND it says that withholding changes only this site, so a copy someone already made can't be recalled

### Search engines are asked to leave the lists out
- GIVEN any visitor
- WHEN they open `/removed` or `/removed/pseuds`
- THEN the response carries `X-Robots-Tag: noindex`

### Removed work pages show no reason
- GIVEN W removed and listed
- WHEN anyone opens W's work page, any chapter URL or `/full`
- THEN the 410 page shows no reason
