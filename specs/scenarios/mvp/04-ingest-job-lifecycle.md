# Scenario: Ingest job lifecycle (lease, save order, retries, dead-letter)

Relates to: docs/ARCHITECTURE.md § EPUB processor (steps 1 and 8), § Ingestion pipeline (step 4), § Surge controls (Queue backpressure)

## Setup
- The ingest Worker consumes the ingest queue with a batch size of 1, retries and a dead-letter queue, and consumes the dead-letter queue too
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

### A job that dies for good is recorded as failed
- GIVEN an upload still `pending`, or `processing` with an expired lease, because every delivery of its message died before recording an ending
- WHEN its message reaches the dead-letter queue
- THEN the upload's status is `parse_failed`, with `error_stage` empty because the stage is unknown, and no lease
- AND the message is acked
- AND My uploads shows it failed and tells the uploader to try uploading it again
- AND any stored original stays: the consumer writes nothing to R2 (https://github.com/rare-pair/app/issues/592)

### A dead-letter message for a finished upload changes nothing
- GIVEN a `live`, `duplicate`, already failed or rejected upload
- WHEN its message reaches the dead-letter queue, once or more than once
- THEN the upload's row stays as it is, the job's own `error_stage` and `error` included
- AND each message is acked

### A dead-letter message waits while the upload's lease is live
- GIVEN an upload `processing` under a lease that has not expired, whose job may still end it or may have just died
- WHEN its message reaches the dead-letter queue
- THEN the upload's row stays as it is, and the message is retried
- AND a later delivery that finds the lease expired records the upload as failed

### A job that outlives its lease saves nothing once its upload has failed
- GIVEN a job still running whose lease has lapsed
- WHEN a dead-letter message for its upload fails the upload, and the job then reaches its transaction
- THEN the job's transaction rolls back, leaving no work or version, and its message is acked
- AND the upload stays `parse_failed`

### A repeat dead-letter message for an upload it failed is harmless
- GIVEN an upload a dead-letter message has already recorded as failed
- WHEN the message is delivered again
- THEN the upload's row stays as it is, and the message is acked

### A dead-letter message for no upload, or with a bad body, is acked
- GIVEN a dead-letter message naming no upload, or whose body doesn't keep the message contract
- WHEN it is delivered
- THEN it is acked, since no retry can change it

### A dead-letter message is retried while Postgres is down
- GIVEN an upload still `pending`, and Postgres unreachable
- WHEN its dead-letter message is delivered
- THEN the message is retried
- AND a message still undelivered after the consumer's retries is deleted, leaving the upload as it was: there is no redrive

### The dead-letter consumer outlasts a short Postgres outage and a dying job's lease
- GIVEN the dead-letter queue's consumer as configured
- THEN it takes one message per invocation, one invocation at once, retrying for an hour with a delay longer than the job's lease
- AND no dead-letter queue sits behind it

### One upload is handled per invocation
- GIVEN the ingest queue's consumer as configured
- THEN its batch size is 1, so a crash in one job has no batch-mate to spend the retries of

### Once a job has failed for good, the sweep no longer skips its work
- GIVEN a work whose sweep skips it as `in_flight`, because of an upload left `processing`
- WHEN the upload's message reaches the dead-letter queue, and the sweep next runs
- THEN the sweep doesn't skip the work, and deletes the upload's old prefix and the work's unreferenced images

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
- WHEN the job ends the upload refused: a save the database refused inside its transaction, a retry that ends `opted_out`, a ban that lands while or between attempts, or a failure for good the job records itself (not `work_removed`, whose save already deleted its files)
- THEN `originals/<upload_id>.epub` is deleted after the ending write, and only when that write matched
- AND the log says what was deleted with the upload id and a count, never the file or the reader
- AND a failed delete changes neither the upload's status nor the message's verdict
- AND a job that lost its lease deletes nothing a takeover job shares
- AND a crash between the ending write and the delete leaves the file, which nothing deletes yet (https://github.com/rare-pair/app/issues/592)

### A refused upload's staging file is deleted
- GIVEN an upload whose raw file is at its own key under `uploads/`
- WHEN the job ends the upload `opted_out`, for an opt-out or a takedown, or `work_removed`
- THEN that file is deleted after the ending write, and only when that write matched
- AND the log says what was deleted with the upload id and a count, never the file or the reader
- AND a failed delete changes neither the upload's status nor the message's verdict
- AND an attempt that will be retried, an ending write that fails and a job that lost its lease all keep the file, since a later attempt reads it
- AND a stored key not under `uploads/` is left alone

### Other final refusals keep their staging file until it expires
- GIVEN an upload whose raw file is at its own key under `uploads/`
- WHEN the job ends the upload refused any other way, such as `account_banned` or `parse_failed`
- THEN the file stays, for the 7-day expiry to delete
