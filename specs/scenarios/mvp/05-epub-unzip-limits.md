# Scenario: EPUB unzip limits and structure (not_epub, zip_bomb, too_large, parse_failed)

Relates to: docs/ARCHITECTURE.md § EPUB processor (step 2), § Rejection codes, § Testing

## Setup
- `packages/epub` unzips with `fflate`, and its tests run in the Workers runtime
- Hand-built bad files: zip bombs, a zip whose index under-reports sizes, path traversal names, duplicate entry names, wrong or missing `mimetype` entry, a non-zip file, a ZIP64 archive, a zip whose central directory disagrees with its local headers, a missing `META-INF/container.xml`, a missing OPF, an OPF that declares XML entities, a malformed `container.xml`, OPF or NCX, a document nested more than 256 elements deep, and an epub whose documents hold more than 300,000 elements and text nodes in total
- Size-edge fixtures built for each limit: entry counts of 2,000 and 2,001; uncompressed totals of exactly 40 MB and just over; a single entry of exactly 20 MB and just over

## Cases

### Valid AO3 epub passes the unzip checks
- GIVEN a real AO3 epub fixture
- WHEN the processor unzips it
- THEN no unzip rule is broken and processing continues to indexing

### Zip index is checked before anything is decompressed
- GIVEN a zip whose file index declares more than 40 MB uncompressed in total
- WHEN the processor reads it
- THEN it is rejected with `zip_bomb` from the file index alone, before any entry is decompressed

### Exactly 2,000 entries is accepted
- GIVEN an otherwise valid epub with exactly 2,000 zip entries
- WHEN the processor unzips it
- THEN the entry count rule is not broken

### More than 2,000 entries is rejected
- GIVEN an epub with 2,001 zip entries
- WHEN the processor unzips it
- THEN it is rejected with `zip_bomb`

### Exactly 40 MB uncompressed in total is accepted
- GIVEN an otherwise valid epub whose entries total exactly 40 MB uncompressed
- WHEN the processor unzips it
- THEN the total size rule is not broken

### More than 40 MB uncompressed in total is rejected
- GIVEN an epub whose entries total more than 40 MB uncompressed
- WHEN the processor unzips it
- THEN it is rejected with `zip_bomb`

### Exactly 20 MB in one entry is accepted
- GIVEN an otherwise valid epub with one entry of exactly 20 MB uncompressed
- WHEN the processor unzips it
- THEN the per-entry size rule is not broken

### More than 20 MB in one entry is rejected
- GIVEN an epub with one entry over 20 MB uncompressed
- WHEN the processor unzips it
- THEN it is rejected with `zip_bomb`

### Zip that lies about its sizes is caught during decompression
- GIVEN a zip whose index declares small sizes but whose entries decompress to more than the limits
- WHEN the processor decompresses it
- THEN bytes are counted as they decompress and it is rejected with `zip_bomb` once a limit is passed

### File that is not a zip is rejected
- GIVEN a file that is not a zip archive
- WHEN the processor unzips it
- THEN it is rejected with `not_epub`

### Entry name with .. is rejected
- GIVEN an epub containing an entry named `../../evil.xhtml`
- WHEN the processor unzips it
- THEN it is rejected with `not_epub`

### Entry name with a leading slash is rejected
- GIVEN an epub containing an entry named `/etc/evil.xhtml`
- WHEN the processor unzips it
- THEN it is rejected with `not_epub`

### Entry name with a drive letter is rejected
- GIVEN an epub containing an entry named `C:\evil.xhtml`
- WHEN the processor unzips it
- THEN it is rejected with `not_epub`

### Duplicate entry name is rejected
- GIVEN an epub containing two entries with the same name
- WHEN the processor unzips it
- THEN it is rejected with `not_epub`

### Central directory that disagrees with the local headers is rejected
- GIVEN a zip whose central directory lists entries that differ from its local file headers
- WHEN the processor unzips it
- THEN it is rejected with `not_epub`

### ZIP64 archive is rejected
- GIVEN a ZIP64 archive
- WHEN the processor unzips it
- THEN it is rejected with `not_epub`

### Wrong mimetype entry is rejected
- GIVEN a zip whose `mimetype` entry is not `application/epub+zip`
- WHEN the processor unzips it
- THEN it is rejected with `not_epub`

### Missing mimetype entry is rejected
- GIVEN a zip with no `mimetype` entry
- WHEN the processor unzips it
- THEN it is rejected with `not_epub`

### Missing container.xml is rejected
- GIVEN an epub with no `META-INF/container.xml`
- WHEN the processor indexes it
- THEN it is rejected with `not_epub`

### Missing OPF is rejected
- GIVEN an epub whose `container.xml` points to an OPF that isn't in the zip
- WHEN the processor indexes it
- THEN it is rejected with `not_epub`

### XML entity declarations are rejected
- GIVEN an epub whose OPF declares an XML entity (`<!ENTITY`)
- WHEN the processor parses it
- THEN it is rejected with `not_epub` and no entity is expanded

### Malformed package XML is rejected as not_epub
- GIVEN an epub whose `container.xml`, OPF or NCX is not well-formed XML
- WHEN the processor parses it
- THEN it is rejected with `not_epub`, not `parse_failed`

### Object larger than 25 MB is not processed
- GIVEN an uploads object larger than 25 MB
- WHEN it reaches the size checks
- THEN it is rejected with `too_large` without being parsed
- AND the uploader sees a plain-language size rejection

### Passing the node budget is rejected as too large
- GIVEN an epub whose documents together hold more than 300,000 elements and text nodes
- WHEN the processor parses it
- THEN it is rejected with `too_large`

### Nesting more than 256 deep fails to parse
- GIVEN an epub with a document whose elements are nested more than 256 deep
- WHEN the processor parses it
- THEN it is rejected with `parse_failed`

### Rejected upload records its code
- GIVEN an epub rejected at the unzip stage
- WHEN the job ends
- THEN the upload's status is the rejection code and the work is not created
