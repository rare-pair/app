// The ingest queue's message contract, as it travels on the queue. `POST /uploads/:id/complete`
// in the web Worker produces it (ARCHITECTURE, Ingestion pipeline, step 3); the ingest Worker
// consumes it. A producer types its queue with this.
export interface IngestMessage {
  upload_id: string;
}

// Upload ids are random text (packages/db, 0002): a uuid in practice, bounded here.
const MAX_ID = 64;

// Returns the message if its body keeps the contract, or null. A body that doesn't names no
// upload, so retrying it can never succeed.
export function parseMessage(body: unknown): IngestMessage | null {
  if (typeof body !== "object" || body === null) return null;
  // SAFETY: body is a non-null object, so reading a named property off it is safe; the value
  // is checked below.
  const { upload_id } = body as Record<string, unknown>;
  if (typeof upload_id !== "string" || upload_id.length === 0 || upload_id.length > MAX_ID) {
    return null;
  }
  return { upload_id };
}

// The backfill queue's message contract. scripts/backfill.mjs produces it, one per stored work;
// the ingest Worker consumes it from `ingest-backfill`. `version_id` is the work's current
// version when the message was made: the version the job re-makes, and only while it is still
// current.
export interface BackfillMessage {
  work_id: string;
  version_id: string;
}

// Work and version ids are random text too (packages/db, 0002).
const isId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_ID;

// Returns the message if its body keeps the contract, or null, which no retry can change.
export function parseBackfillMessage(body: unknown): BackfillMessage | null {
  if (typeof body !== "object" || body === null) return null;
  // SAFETY: body is a non-null object, so reading named properties off it is safe; the values
  // are checked below.
  const { work_id, version_id } = body as Record<string, unknown>;
  if (!isId(work_id) || !isId(version_id)) return null;
  return { work_id, version_id };
}
