#!/usr/bin/env node
// The wait list's purge (ARCHITECTURE, Wait list, Deleting the list): after the archive is open
// (PRELAUNCH off) and the launch send has finished, the operator runs it once, locally, to
// delete every waitlist row, confirmed or not.
//
//   DATABASE_URL=... node scripts/waitlist-purge.mjs [--force]
//
// The database URL comes from the environment only: no .env file, no flag. Turn PRELAUNCH off
// first: the script can't see the Worker's setting, and while the form is live new rows keep
// arriving. It refuses, and deletes nothing, while a confirmed address still has notified_at
// empty (the launch send has not finished) or while the newest notified_at is under 24 hours old
// (a dead-lettered email can still come back, and it needs its row). A list with no confirmed
// address has nothing to send, so it is purged. --force skips both refusals and nothing else.
// The check and the delete are one transaction under a table lock, so a launch send's open claim
// can't change the table between them. Ages are the database's clock, not this machine's.
//
// The script prints counts and a code, and nothing else: no address, link or raw error, since
// any of those can carry one. Exits 0 when the list was purged, 1 when it refused or the
// database failed, and 2 for a missing variable or an unknown flag, before anything is touched.
import { pathToFileURL } from "node:url";
import pg from "pg";

// How long the purge waits for a send's open claim before it gives up.
const LOCK_TIMEOUT_MS = 10_000;
// How long the open transaction may sit idle, holding the table lock, before the server ends it.
const IDLE_TIMEOUT_MS = 60_000;

const USAGE =
  "usage: DATABASE_URL=... node scripts/waitlist-purge.mjs [--force]\nturn PRELAUNCH off first: the script can't see it, and sign-ups after the purge are not deleted";

// A pg error can carry a value, so only a code or a name is ever printed.
const codeOf = (error) => {
  if (!(error instanceof Error)) return "unknown";
  // pg's errors carry a SQLSTATE and Node's a system code such as ECONNREFUSED.
  /** @type {Error & { code?: string }} */
  const withCode = error;
  const code = withCode.code ?? error.name;
  // Only a short code is printed, never a free-text value that might quote one.
  return /^[A-Za-z0-9_]{1,40}$/.test(String(code)) ? String(code) : "unknown";
};

/**
 * @typedef {object} WaitlistPurgeOptions
 * @property {string} connectionString
 * @property {boolean} [force] Skip both refusals.
 * @property {number} [lockTimeoutMs]
 * @property {(line: string) => void} [log]
 */

/**
 * Purges the list. Resolves with how many rows it deleted, the reason it refused (null if it
 * did not) and a message for the operator when the database failed. It never rejects over a
 * database failure.
 * @param {WaitlistPurgeOptions} options
 * @returns {Promise<{ deleted: number, refused: string | null, error: string | null }>}
 */
export async function waitlistPurge({
  connectionString,
  force = false,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
  log = console.log,
}) {
  /** @type {pg.Client} */
  let client;
  try {
    client = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 });
  } catch {
    // The constructor throws on a malformed URL, and its message can quote the URL.
    return { deleted: 0, refused: null, error: "DATABASE_URL is not a valid connection string" };
  }
  // A dropped connection is reported by the statement that was using it.
  client.on("error", () => {});
  let committed = false;
  let began = false;
  try {
    await client.connect();
    await client.query("begin");
    began = true;
    const lockMs =
      Number.isFinite(lockTimeoutMs) && lockTimeoutMs >= 1
        ? Math.floor(lockTimeoutMs)
        : LOCK_TIMEOUT_MS;
    await client.query(`set local lock_timeout = ${lockMs}`);
    // The lock is held to the commit: if this process stalls between statements, the server
    // ends the transaction instead of leaving every join, confirm and unsubscribe write queued
    // behind it.
    await client.query(`set local idle_in_transaction_session_timeout = ${IDLE_TIMEOUT_MS}`);
    // Waits for any open claim (a row write) and holds off new ones until this commits or
    // rolls back. Plain reads are not blocked.
    await client.query("lock table waitlist in exclusive mode");
    const { rows } = await client.query(
      `select
         count(*)::int as total,
         (count(*) filter (where confirmed_at is not null and notified_at is null))::int as unsent,
         coalesce(bool_or(notified_at > now() - interval '24 hours'), false) as recent
       from waitlist`,
    );
    const { total, unsent, recent } = rows[0];
    if (force) {
      log("forced: skipping the refusal checks");
    } else if (unsent > 0) {
      const refused = `${unsent} confirmed ${unsent === 1 ? "address is" : "addresses are"} still waiting for the launch send`;
      log(`refused: ${refused}`);
      log("rerun with --force to purge anyway");
      return { deleted: 0, refused, error: null };
    } else if (recent) {
      const refused = "the last batch was queued less than 24 hours ago";
      log(`refused: ${refused}`);
      log("rerun with --force to purge anyway");
      return { deleted: 0, refused, error: null };
    }
    await client.query("delete from waitlist");
    await client.query("commit");
    committed = true;
    log(`deleted ${total} wait list rows`);
    return { deleted: total, refused: null, error: null };
  } catch (caught) {
    return { deleted: 0, refused: null, error: `database error (${codeOf(caught)})` };
  } finally {
    if (began && !committed) await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--force");
  if (unknown.length > 0) {
    console.error("waitlist-purge: unknown argument, only --force is accepted");
    console.error(USAGE);
    return 2;
  }
  if (!process.env.DATABASE_URL) {
    console.error("waitlist-purge: DATABASE_URL is not set");
    console.error(USAGE);
    return 2;
  }
  const { refused, error } = await waitlistPurge({
    connectionString: process.env.DATABASE_URL,
    force: args.includes("--force"),
  });
  if (refused !== null) return 1;
  if (error !== null) {
    console.error(`waitlist-purge: stopped: ${error}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
