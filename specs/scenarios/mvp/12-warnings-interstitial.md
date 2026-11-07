# Scenario: Rating and warnings interstitial

Relates to: docs/ARCHITECTURE.md § Data model (user.warnings_off), § Reading (Warnings screen); docs/FRONTEND-DISCOVERY.md § Key journeys (1, step 5), § Page inventory (Warnings screen, Reader settings), § Reading experience, § Accessibility and devices

## Setup
- Live works, each with 5 chapters:
  - M rated Mature, no archive warnings
  - E rated Explicit, no archive warnings
  - V rated Teen And Up with archive warning "Graphic Depictions Of Violence"
  - C rated Teen And Up marked "Choose Not To Use Archive Warnings"
  - G rated General Audiences with no archive warnings
  - N with no rating (its version has the `missing_rating` review reason) and no archive warnings
- A signed-out reader and a signed-in reader
- Having seen a work's warnings screen is remembered per work in a session cookie; a signed-in reader's choice to turn warnings off is stored on their account (`user.warnings_off`)

## Cases

### Mature work shows the interstitial before chapter 1
- GIVEN live work M and a reader who hasn't seen its warnings screen this session
- WHEN they go to read chapter 1
- THEN they first see the warnings screen showing the rating "Mature"

### Explicit work shows the interstitial
- GIVEN live work E and a reader who hasn't seen its warnings screen this session
- WHEN they go to read chapter 1
- THEN they first see the warnings screen showing the rating "Explicit"

### Work with archive warnings shows the interstitial
- GIVEN live work V and a reader who hasn't seen its warnings screen this session
- WHEN they go to read chapter 1
- THEN they first see the warnings screen listing "Graphic Depictions Of Violence"

### Choose Not To Use Archive Warnings shows the interstitial
- GIVEN live work C and a reader who hasn't seen its warnings screen this session
- WHEN they go to read chapter 1
- THEN they first see the warnings screen showing "Choose Not To Use Archive Warnings"

### Unrated work shows the interstitial as Not Rated
- GIVEN live work N and a reader who hasn't seen its warnings screen this session
- WHEN they go to read chapter 1
- THEN they first see the warnings screen showing the rating "Not Rated"
- AND "Continue" takes them to chapter 1

### An unknown rating shows the interstitial
- GIVEN a live work whose stored rating is none of the archive's five, such as a misspelt or new one
- WHEN a reader goes to read chapter 1
- THEN they first see the warnings screen, as for a Not Rated work

### A mild rating with the Rape/Non-Con or Underage warning shows the interstitial
- GIVEN a live work rated General Audiences or Teen And Up Audiences with the archive warning "Rape/Non-Con" or "Underage"
- WHEN a reader goes to read chapter 1
- THEN they first see the warnings screen showing that warning

### A work a moderator marked as adult shows the interstitial
- GIVEN a live work rated General Audiences with no archive warnings, which a moderator has marked as adult
- WHEN a reader goes to read chapter 1
- THEN they first see the warnings screen, still showing the rating "General Audiences"
- AND the screen says "A moderator marked this work as adult."

### Unwarned general work skips the interstitial
- GIVEN live work G
- WHEN a reader goes to read chapter 1
- THEN chapter 1 opens directly with no warnings screen

### Direct link to a later chapter shows the interstitial first
- GIVEN live work M and a reader who hasn't seen its warnings screen this session
- WHEN they open a shared link to `/works/:id/chapters/3`
- THEN they first see the warnings screen
- AND "Continue" takes them to chapter 3

### Entire work shows the interstitial first
- GIVEN live work V and a reader who hasn't seen its warnings screen this session
- WHEN they open `/works/:id/full`
- THEN they first see the warnings screen
- AND "Continue" takes them to the entire work

### Continue goes to the chapter
- GIVEN a reader on `/works/:id/warnings` for work M, reached on the way to chapter 1
- WHEN they follow "Continue"
- THEN chapter 1 of M opens

### Interstitial is remembered for the work in the session
- GIVEN a reader who has continued past M's warnings screen in this browser session
- WHEN they open chapter 4 of M, or `/works/:id/full` for M
- THEN the page opens directly with no warnings screen
- AND opening chapter 1 of E in the same session still shows E's warnings screen

### Interstitial comes back in a new session
- GIVEN a reader who continued past M's warnings screen in an earlier browser session, so the session cookie is gone
- WHEN they open chapter 2 of M
- THEN they see the warnings screen again

### Warnings screen is a full page, not a modal
- GIVEN a reader with JavaScript off
- WHEN they open `/works/:id/warnings` for work V
- THEN it renders as its own full page with a working Continue link and needs no focus trapping

### Signed-out readers get no turn-off option
- GIVEN a signed-out reader
- WHEN they open the warnings screen for work M, or `/settings/reader`
- THEN no option to turn the warnings screen off is shown

### Signed-in readers can turn the screen off
- GIVEN a signed-in reader on the warnings screen for work M
- WHEN they tick the turn-off checkbox and continue
- THEN `warnings_off` is set on their account
- AND later works rated Mature or Explicit, Not Rated, or carrying warnings open from any entry point without the warnings screen for that reader, on any device where they are signed in

### Signed-in readers can turn it off from settings
- GIVEN a signed-in reader on `/settings/reader`
- WHEN they turn off the warnings screen
- THEN the choice is saved to their account, not the settings cookie
- AND chapter 1 of work E opens without the warnings screen for that reader
