#!/usr/bin/env node
// The re-sanitize backfill (ARCHITECTURE, EPUB processor, step 8): the operator runs it locally
// after a sanitizer fix. It reads every live or hidden work's current version, in work id order,
// and puts one `{ work_id, version_id }` message for each on the `ingest-backfill` queue through
// the Cloudflare Queues HTTP API, a batch at a time. The ingest Worker re-makes each version from
// its original with the processor as it then is, as a new version, while the message's version
// is still current. Removed works are left out: their files are gone.
//
//   DATABASE_URL=... CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//   INGEST_BACKFILL_QUEUE_ID=... [BACKFILL_AFTER=<work id>] node scripts/backfill.mjs
//
// It only reads the database and marks nothing, so a rerun queues every work again, and each is
// re-made again. A failed push stops the run and prints the last work queued: rerun with
// BACKFILL_AFTER set to it to go on from there. Nothing records which sanitizer made a version
// (a follow-up), so no run can skip works already re-made for the latest fix.
//
// Every secret comes from the environment: no .env file, no flag. The API token needs Queues
// Write. The script prints counts, work ids, an HTTP status or a Cloudflare error code, and
// nothing else: no raw error, since one can carry a connection string.
// Exits 0 when every work was queued, 1 when the run stopped on an error, and 2 when an
// environment variable is missing, before anything is touched.
import { pathToFileURL } from "node:url";
import pg from "pg";

// The queue API's per-call cap on messages (Cloudflare Queues limits).
const BATCH_SIZE = 100;
// A push that takes longer is treated as failed: the batch may or may not have been queued.
const PUSH_TIMEOUT_MS = 30_000;

// The works a backfill re-makes, after work id $1 (NULL for the first), $2 at a time. The id is
// the primary key, so the order is total and a page never repeats or skips a work.
const PAGE = `
  select id, current_version_id from works
  where status in ('live', 'hidden') and current_version_id is not null
    and ($1::text is null or id > $1::text)
  order by id limit $2`;

// A pg or fetch error can carry a value, so only a code or a name is ever printed.
const codeOf = (error) => {
  if (!(error instanceof Error)) return "unknown";
  if (error instanceof DOMException) return error.name;
  /** @type {Error & { code?: string }} */
  const withCode = error;
  return withCode.code ?? error.name;
};

/**
 * @typedef {object} BackfillOptions
 * @property {string} connectionString
 * @property {string} accountId
 * @property {string} queueId
 * @property {string} apiToken
 * @property {string | null} [after] Start after this work id: where a stopped run got to.
 * @property {typeof fetch} [fetch]
 * @property {number} [batchSize]
 * @property {(line: string) => void} [log]
 * @property {AbortSignal} [signal] Stops the run, aborting a push in flight.
 */

/**
 * Runs the backfill's enqueue. Resolves with how many works it queued, the last work id
 * queued (where a rerun goes on from, or null when none was), whether it reached the last
 * work, and a message for the operator when it stopped on an error. It never rejects over a
 * database or queue failure.
 * @param {BackfillOptions} options
 * @returns {Promise<{ queued: number, after: string | null, done: boolean, error: string | null }>}
 */
export async function backfill({
  connectionString,
  accountId,
  queueId,
  apiToken,
  after: start = null,
  fetch: doFetch = globalThis.fetch,
  batchSize = BATCH_SIZE,
  log = console.log,
  signal,
}) {
  const size = Number.isFinite(batchSize)
    ? Math.min(Math.max(1, Math.floor(batchSize)), BATCH_SIZE)
    : BATCH_SIZE;
  let after = start;
  let queued = 0;
  /** @type {pg.Client} */
  let client;
  try {
    client = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 });
  } catch {
    // The constructor throws on a malformed URL, and its message can quote the URL.
    return { queued, after, done: false, error: "DATABASE_URL is not a valid connection string" };
  }
  // A dropped connection is reported by the query that was using it.
  client.on("error", () => {});
  let error = null;
  let done = false;
  try {
    await client.connect();
    while (!signal?.aborted) {
      const { rows } = await client.query(PAGE, [after, size]);
      if (rows.length === 0) {
        done = true;
        break;
      }
      error = await push({
        messages: rows.map((row) => ({
          body: { work_id: row.id, version_id: row.current_version_id },
          content_type: "json",
        })),
      });
      // A stop during the push aborts it: the batch may or may not have been queued.
      if (error !== null && signal?.aborted) {
        error = `interrupted during a push of ${rows.length} works, which may or may not be queued`;
      }
      if (error !== null) break;
      queued += rows.length;
      after = rows.at(-1).id;
      log(`queued ${queued} so far, up to work ${after}`);
    }
  } catch (caught) {
    error = `database error (${codeOf(caught)})`;
  }
  await client.end().catch(() => {});
  return { queued, after, done, error };

  /** Pushes one batch. Resolves with null on success, or the reason it failed. */
  async function push(body) {
    let response;
    try {
      response = await doFetch(
        // Encoded, so a pasted id with a slash or `?` can't send the token to another endpoint.
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/queues/${encodeURIComponent(queueId)}/messages/batch`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.any([
            AbortSignal.timeout(PUSH_TIMEOUT_MS),
            ...(signal ? [signal] : []),
          ]),
        },
      );
    } catch (caught) {
      return `request failed (${codeOf(caught)})`;
    }
    if (!response.ok) return `HTTP ${response.status}`;
    // Cloudflare's reply: { success, errors: [{ code, message }] }. Only the codes are read.
    /** @type {{ success?: boolean, errors?: { code?: number }[] } | null} */
    let reply = null;
    try {
      reply = await response.json();
    } catch {
      return "unreadable reply";
    }
    if (reply?.success === true) return null;
    try {
      const codes = (reply?.errors ?? [])
        .map((e) => e.code)
        .filter((code) => Number.isInteger(code));
      if (codes.length > 0) return `Cloudflare error ${codes.join(", ")}`;
    } catch {
      // errors was not a list of objects: say only that it failed.
    }
    return "Cloudflare reported failure";
  }
}

const NAMES = [
  "DATABASE_URL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "INGEST_BACKFILL_QUEUE_ID",
];

async function main() {
  const missing = NAMES.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    for (const name of missing) console.error(`backfill: ${name} is not set`);
    console.error(
      `usage: ${NAMES.join("=... ")}=... [BACKFILL_AFTER=...] node scripts/backfill.mjs`,
    );
    return 2;
  }
  // A stop ends the run after the page in hand, aborting its push if one is in flight. A second
  // one ends the process at once.
  const stop = new AbortController();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(name, () => {
      if (stop.signal.aborted) process.exit(1);
      stop.abort();
    });
  }
  const { queued, after, done, error } = await backfill({
    connectionString: process.env.DATABASE_URL ?? "",
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
    queueId: process.env.INGEST_BACKFILL_QUEUE_ID ?? "",
    after: process.env.BACKFILL_AFTER || null,
    signal: stop.signal,
  });
  console.log(`backfill: queued ${queued} works`);
  if (done && error === null) return 0;
  const resume = after === null ? "" : `, rerun with BACKFILL_AFTER=${after} to go on`;
  console.error(`backfill: stopped: ${error ?? "interrupted"}${resume}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
