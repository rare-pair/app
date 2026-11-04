#!/usr/bin/env node
// The wait list's launch send (ARCHITECTURE, Wait list): the operator runs it once, locally. It
// claims confirmed wait list rows with notified_at empty, a batch at a time, in one statement that
// also stores each row's unsubscribe token hash, and puts a launch email for each on the
// `email-bulk` queue through the Cloudflare Queues HTTP API. The claim stays uncommitted until the
// push has succeeded, so a batch whose push fails, or a run that dies, leaves notified_at empty
// again, and a failed push stops the run. Rerunning it, or running two at once, queues no
// address twice. It prints how many confirmed addresses are still waiting.
//
//   DATABASE_URL=... CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//   EMAIL_BULK_QUEUE_ID=... node scripts/launch-send.mjs
//
// Every secret comes from the environment: no .env file, no flag. The API token needs Queues
// Write. The script prints counts, an HTTP status or a Cloudflare error code, and nothing else:
// no address, link, token or raw error, since any of those can carry one.
// Exits 0 only when no confirmed address is left waiting, 1 when the run stopped on an error or
// any address is still waiting, and 2 when an environment variable is missing, before anything is
// touched.
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";

const SITE = "https://rarepair.fans";
// The queue API's per-call cap on messages (Cloudflare Queues limits).
const BATCH_SIZE = 100;
// A push that takes longer is treated as failed. The outcome is then unknown: ARCHITECTURE, Wait list, The launch send.
const PUSH_TIMEOUT_MS = 30_000;

// apps/web's newToken: 32 random bytes, base64url, no padding.
const newToken = () => randomBytes(32).toString("base64url");
// apps/web's hashToken: lowercase hex SHA-256. The confirm and unsubscribe routes look a row up
// by this, so the two must agree.
const hashToken = (token) => createHash("sha256").update(token).digest("hex");

// Claims up to $2 confirmed rows nobody has claimed, and gives the nth its nth hash from $1. One
// statement, so it is atomic: two runs at once never take a row twice, and `skip locked` passes
// over the rows the other holds instead of waiting for it. `for update` can't share a select with
// a window function, hence `picked` and then `numbered`.
const CLAIM = `
  with picked as (
    select email from waitlist
    where confirmed_at is not null and notified_at is null
    order by email limit $2 for update skip locked
  ), numbered as (
    select email, row_number() over (order by email) as n from picked
  ), hashes as (
    select h, n from unnest($1::text[]) with ordinality as t(h, n)
  )
  update waitlist w
  set notified_at = now(), unsubscribe_token_hash = hashes.h
  from numbered join hashes using (n)
  where w.email = numbered.email
  returning w.email, w.unsubscribe_token_hash`;

// A pg or fetch error can carry a value, so only a code or a name is ever printed.
const codeOf = (error) => {
  if (!(error instanceof Error)) return "unknown";
  // A DOMException's code is a legacy number: its name (AbortError, TimeoutError) says more.
  if (error instanceof DOMException) return error.name;
  // pg's errors carry a SQLSTATE and Node's a system code such as ECONNREFUSED.
  /** @type {Error & { code?: string }} */
  const withCode = error;
  return withCode.code ?? error.name;
};

/**
 * @typedef {object} LaunchSendOptions
 * @property {string} connectionString
 * @property {string} accountId
 * @property {string} queueId
 * @property {string} apiToken
 * @property {typeof fetch} [fetch]
 * @property {number} [batchSize]
 * @property {(line: string) => void} [log]
 * @property {AbortSignal} [signal] Stops the run: the batch in flight is cleared first.
 */

/**
 * Runs the send. Resolves with how many addresses it queued, how many confirmed addresses are
 * still waiting (null if that could not be counted), and a message for the operator when it
 * stopped on an error. It never rejects over a database or queue failure.
 * @param {LaunchSendOptions} options
 * @returns {Promise<{ queued: number, remaining: number | null, error: string | null }>}
 */
export async function launchSend({
  connectionString,
  accountId,
  queueId,
  apiToken,
  fetch: doFetch = globalThis.fetch,
  batchSize = BATCH_SIZE,
  log = console.log,
  signal,
}) {
  // The queue takes at most 100 messages a call.
  const size = Number.isFinite(batchSize)
    ? Math.min(Math.max(1, Math.floor(batchSize)), BATCH_SIZE)
    : BATCH_SIZE;
  /** @type {pg.Client} */
  let client;
  try {
    client = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 });
  } catch {
    // The constructor throws on a malformed URL, and its message can quote the URL.
    return { queued: 0, remaining: null, error: "DATABASE_URL is not a valid connection string" };
  }
  // A dropped connection is reported by the statement that was using it; without a listener the
  // client would also throw it unhandled.
  client.on("error", () => {});
  let queued = 0;
  let error = null;
  try {
    await client.connect();
    while (error === null && !signal?.aborted) {
      const tokens = Array.from({ length: size }, newToken);
      // The claim, the push and the commit are one transaction: if the push fails, or the process
      // or its connection dies at any point before the commit, the database rolls the claim back
      // and the rows wait again. The rows stay locked meanwhile, so `skip locked` keeps a second
      // run off them.
      await client.query("begin");
      let committed = false;
      let count = 0;
      try {
        const claimed = await client.query(CLAIM, [tokens.map(hashToken), size]);
        const byHash = new Map(tokens.map((token) => [hashToken(token), token]));
        const rows = claimed.rows.map((row) => ({
          to: row.email,
          token: byHash.get(row.unsubscribe_token_hash),
        }));
        if (rows.length === 0) break;
        count = rows.length;
        error = rows.some((row) => row.token === undefined)
          ? "a claimed row did not match its token, nothing was queued"
          : await push({
              messages: rows.map(({ to, token }) => ({
                body: {
                  kind: "waitlist-launch",
                  to,
                  url: `${SITE}/waitlist/unsubscribe?token=${token}`,
                },
                content_type: "json",
              })),
            });
        if (error === null) {
          try {
            await client.query("commit");
            committed = true;
          } catch (caught) {
            error = `commit failed (${codeOf(caught)}) after the push was accepted: up to ${count} addresses will be queued again by the next run`;
          }
        }
      } finally {
        // Whatever stopped it, even a throw, the batch's rows go back to waiting. If this fails,
        // the connection is gone and the server rolls the transaction back itself.
        if (!committed) await client.query("rollback").catch(() => {});
      }
      if (committed) {
        queued += count;
        log(`queued ${queued} so far, ${await remainingOf(client)} still waiting`);
      }
    }
  } catch (caught) {
    error ??= `database error (${codeOf(caught)})`;
  }
  const remaining = await remainingOf(client);
  await client.end().catch(() => {});
  log(`${remaining ?? "unknown number of"} confirmed addresses still waiting`);
  return { queued, remaining, error };

  /** Pushes one batch. Resolves with null on success, or the reason it failed. */
  async function push(body) {
    let response;
    try {
      response = await doFetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${queueId}/messages/batch`,
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

async function remainingOf(client) {
  try {
    const { rows } = await client.query(
      "select count(*)::int as n from waitlist where confirmed_at is not null and notified_at is null",
    );
    return rows[0]?.n ?? null;
  } catch {
    return null;
  }
}

const NAMES = [
  "DATABASE_URL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "EMAIL_BULK_QUEUE_ID",
];

async function main() {
  const missing = NAMES.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    for (const name of missing) console.error(`launch-send: ${name} is not set`);
    console.error(`usage: ${NAMES.join("=... ")}=... node scripts/launch-send.mjs`);
    return 2;
  }
  // A stop arrives as an abort, so the batch in flight is rolled back before the process ends. A
  // second one ends the process at once: the database rolls back an open transaction itself.
  const stop = new AbortController();
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(name, () => {
      if (stop.signal.aborted) process.exit(1);
      stop.abort();
    });
  }
  const { error, remaining } = await launchSend({
    connectionString: process.env.DATABASE_URL ?? "",
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
    queueId: process.env.EMAIL_BULK_QUEUE_ID ?? "",
    signal: stop.signal,
  });
  if (error === null && remaining === 0) return 0;
  // Not 0 while anything waits: a run that ended with rows held by another run, or interrupted
  // between batches, has not finished the list.
  const why =
    remaining === null
      ? "could not count the addresses still waiting, check and run it again"
      : "addresses are still waiting, run it again";
  console.error(`launch-send: stopped: ${error ?? why}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
