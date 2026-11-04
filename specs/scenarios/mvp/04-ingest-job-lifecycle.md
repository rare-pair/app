# Scenario: Ingest job lifecycle (lease, save order, retries, dead-letter)

Relates to: docs/ARCHITECTURE.md § EPUB processor (steps 1 and 8), § Ingestion pipeline (step 4), § Surge controls (Queue backpressure)

## Setup
- The ingest Worker consumes the ingest queue with a batch size of about 5, retries and a dead-letter queue
- A maximum consumer concurrency is configured
- `packages/epub` is a pure function (bytes in, parsed work out); `apps/ingest` handles R2, Postgres and job status
- An `uploads` row in `pending` with a valid AO3 epub object in R2
- Fault injection is available to fail the job at a chosen stage

## Cases

### Lease claims a pending upload
- GIVEN an upload in `pending`
- WHEN the consumer receives its `{upload_id}` message
- THEN one atomic `UPDATE` sets `status='processing'` and a future `lease_until`

### Duplicate delivery does not double-process
- GIVEN an upload already in `processing` with a lease that has not expired
- WHEN a second copy of the same queue message is delivered
- THEN the lease update matches no row and the second delivery does no work

### Expired lease can be re-claimed
- GIVEN an upload in `processing` whose `lease_until` is in the past
- WHEN its message is delivered again
- THEN the lease update matches and the job runs again

### Concurrent deliveries claim the lease once
- GIVEN an upload in `pending`
- WHEN two consumers receive its message at the same time
- THEN exactly one lease update succeeds

### A long job keeps its lease
- GIVEN a job that runs for longer than the lease
- WHEN a second consumer receives the upload's message after the first lease would have expired
- THEN the running job has renewed its lease, so the second delivery does no work
- AND the first job still ends the upload `live`

### A job that has lost its lease stops before writing
- GIVEN a running job whose upload another job has taken over
- WHEN the job reaches its next stage or its next R2 write
- THEN it writes nothing more, deletes nothing, and logs `ingest.lease_lost` with the upload id and stage
- AND its message is acked, and the row stays as the other job left it

### Retry overwrites only its own output
- GIVEN a job for upload A that wrote some output to R2 and then failed
- WHEN the job for upload A is retried
- THEN it writes under `works/<ao3_work_id>/<upload_id>/` for upload A, overwriting its own earlier files
- AND no files written for any other upload are touched

### Successful job saves in order and goes live last
- GIVEN a valid AO3 epub for a new work
- WHEN the job completes
- THEN chapter fragments and images are written to R2 first
- AND one Postgres transaction then upserts the work, adds the version, chapters and tags, and points `current_version_id` at the new version
- AND the work is set `live` last

### Failure before the transaction leaves nothing in Postgres
- GIVEN a job that has written chapter fragments to R2
- WHEN it fails before the Postgres transaction commits
- THEN no work, version, chapter or tag rows from that job exist
- AND the R2 files are left under `works/<ao3_work_id>/<upload_id>/` for that upload, for the sweep to delete once the prefix is a day old and no version points at it

### Failure inside the transaction rolls back
- GIVEN a job whose Postgres transaction fails part-way
- WHEN the transaction aborts
- THEN none of the work, version, chapter or tag changes from that job are visible
- AND `current_version_id` of an existing work is unchanged

### Permanent failure goes to the dead-letter queue as parse_failed
- GIVEN a job that fails on every retry
- WHEN its retries are used up
- THEN the message goes to the dead-letter queue
- AND the upload's status is `parse_failed`
- AND `error_stage` and `error` on the upload row record the failing stage and error

### Consumer concurrency stays bounded under a flood
- GIVEN many more uploads enqueued than the maximum consumer concurrency
- WHEN the queue drains
- THEN no more consumers run at once than the configured maximum
- AND the remaining uploads wait in the backlog rather than failing

### Original file is kept
- GIVEN a job that ingests an upload successfully
- WHEN the job finishes
- THEN the raw file has been copied from `uploads/` to `originals/`

### A refused upload's stored epub is deleted
- GIVEN an upload whose raw epub is stored under `originals/<upload_id>.epub`
- WHEN the job ends the upload refused: any rejection code, a save the database refused inside its transaction, a retry that ends `opted_out` or `account_banned`, or a failure for good
- THEN `originals/<upload_id>.epub` is deleted after the ending write, and only when that write matched
- AND the log says what was deleted with the upload id and a count, never the file or the reader
- AND a failed delete changes neither the upload's status nor the message's verdict
- AND a job that lost its lease deletes nothing a takeover job shares
- AND a crash between the ending write and the delete leaves the file, which nothing deletes yet (https://github.com/rare-pair/app/issues/592)
