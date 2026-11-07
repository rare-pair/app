# Scenario: Bulk upload from a zip of epubs

Relates to: docs/ARCHITECTURE.md § Ingestion pipeline (steps 1-3); docs/FRONTEND-DISCOVERY.md § What to validate first (5. Uploader motivation); specs/scenarios/mvp/02-upload-handshake.md; specs/scenarios/mvp/03-upload-status.md

The page unzips in the browser, with the browser's built-in decompression and no library. There is no server change: each epub inside goes through the normal upload path and pipeline, as if it had been picked.

## Setup
- A signed-in uploader U on the upload page, with remaining daily quota
- A small synthetic zip of epub-named files (no real epubs)

## Cases

### Zip of epubs adds each epub to the list
- GIVEN uploader U on the upload page
- WHEN U picks or drops a zip containing several epubs
- THEN each epub inside is a row in the list, with its own size and Remove button
- AND nothing is sent until U presses Upload
- AND each epub then goes through the normal upload path as its own upload

### Each epub in the zip gets its own status
- GIVEN a zip of epubs whose rows have been sent
- WHEN the uploads finish and U opens `/me/uploads`
- THEN each epub has its own row on the page, and its own status there (live, held for review or rejected, as in 03-upload-status)

### Zip over 100 MB is refused before it is read
- GIVEN a zip over 100 MB
- WHEN U picks it
- THEN the page says a zip over 100 MB isn't accepted, and the file is not read
- AND nothing is added to the list

### The 25 MB limit applies to each epub inside
- GIVEN a zip holding an epub over 25 MB
- WHEN U adds it
- THEN that epub is listed with the over-the-limit message, as a picked file would be, and is not sent
- AND the other epubs in the zip are added as usual

### An entry that expands past the limit stops being read
- GIVEN a zip whose entry says it is small but expands past 25 MB
- WHEN U adds it
- THEN the page stops reading that entry at the limit, so the tab is not exhausted
- AND it is listed with the over-the-limit message

### Folders are searched and other files are shown as skipped
- GIVEN a zip holding epubs in folders, a text file, and a zip
- WHEN U adds it
- THEN the epubs inside the folders are added
- AND the text file is listed as skipped because it isn't an epub
- AND the nested zip is listed as skipped, and is not opened

### A zip with no epubs adds nothing
- GIVEN a zip holding no epubs
- WHEN U adds it
- THEN the page says there are no epubs in it, and nothing is added to the list

### A file that isn't a valid zip adds nothing
- GIVEN a file named `.zip` whose bytes are not a zip
- WHEN U adds it
- THEN the page says it isn't a valid zip, and nothing is added to the list

### Epubs past the remaining daily quota stay listed
- GIVEN a zip of epubs, and U with less daily quota left than the zip holds
- WHEN U adds it and presses Upload
- THEN the epubs are listed and sent as any picked files are: what fits is sent, and the rest stay listed and say they were not uploaded

### A browser without built-in decompression is told to upload the epubs directly
- GIVEN a browser with no `DecompressionStream`
- WHEN U adds a zip
- THEN the page says the browser can't open zip files and to upload the epubs directly
- AND nothing is added to the list
