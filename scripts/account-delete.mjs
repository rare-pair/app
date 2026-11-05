#!/usr/bin/env node
// Deletes one account when its owner asks (ARCHITECTURE, Deleting an account): the operator runs
// it locally, once a request has reached admin@rarepair.fans. It removes the account, its
// sessions and its saved reading positions. Upload rows stay with no user attached, and works and
// versions stay public.
//
//   DATABASE_URL=... CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
//   POSITIONS_NAMESPACE_ID=... node scripts/account-delete.mjs <address>
//
// Every secret comes from the environment: no .env file, no flag. The API token needs Workers KV
// Storage Write. POSITIONS_NAMESPACE_ID is the id of apps/web's POSITIONS binding.
//
// It shows what it will delete, then asks for the address to be typed again. Then it takes the
// sessions first, so a signed-in reader stops saving positions; then the keys, relisted; then the
// row. A failure leaves the row, so running it again finishes the job: with the row gone first,
// the keys could no longer be found from the address. It refuses a banned account, because a ban
// lives on the row, and deleting it would let the person sign up again.
//
// The script prints the address it was given, counts, an HTTP status or a code, and nothing else:
// no key, since a key names a work, and no token or raw error, since those can carry a secret.
// Exits 0 when the account was deleted, 1 when it refused or stopped on an error, and 2 for a
// missing variable or a bad argument, before anything is touched.
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import pg from "pg";

// The KV API's caps: keys a list page returns, and names a bulk delete takes.
const LIST_LIMIT = 1000;
const DELETE_LIMIT = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;

const NAMES = [
  "DATABASE_URL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "POSITIONS_NAMESPACE_ID",
];

const USAGE = `usage: ${NAMES.join("=... ")}=... node scripts/account-delete.mjs <address>`;

// A pg or fetch error can carry a value, so only a code or a name is ever printed.
const codeOf = (error) => {
  if (!(error instanceof Error)) return "unknown";
  // A DOMException's code is a legacy number: its name (AbortError, TimeoutError) says more.
  if (error instanceof DOMException) return error.name;
  // pg's errors carry a SQLSTATE and Node's a system code such as ECONNREFUSED.
  /** @type {Error & { code?: string }} */
  const withCode = error;
  const code = withCode.code ?? error.name;
  // Only a short code is printed, never a free-text value that might quote one.
  return /^[A-Za-z0-9_]{1,40}$/.test(String(code)) ? String(code) : "unknown";
};

/** A KV failure, whose message is safe to print. */
class KvError extends Error {}

/**
 * The POSITIONS namespace, through the Cloudflare KV HTTP API.
 * @param {object} options
 * @param {string} options.accountId
 * @param {string} options.apiToken
 * @param {string} options.namespaceId
 * @param {typeof fetch} [options.fetch]
 */
export function positionsKv({
  accountId,
  apiToken,
  namespaceId,
  fetch: doFetch = globalThis.fetch,
}) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}`;

  const call = async (url, init = {}) => {
    let response;
    let body;
    try {
      response = await doFetch(url, {
        ...init,
        headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      body = await response.json();
    } catch (caught) {
      const status = response === undefined ? "" : `HTTP ${response.status}, `;
      throw new KvError(`KV request failed (${status}${codeOf(caught)})`);
    }
    if (!response.ok || body?.success !== true) {
      const code = Number(body?.errors?.[0]?.code);
      const named = Number.isInteger(code) ? `, code ${code}` : "";
      throw new KvError(`KV request refused (HTTP ${response.status}${named})`);
    }
    return body;
  };

  return {
    async listKeys(prefix) {
      const keys = [];
      let cursor = "";
      do {
        const params = new URLSearchParams({ prefix, limit: String(LIST_LIMIT) });
        if (cursor !== "") params.set("cursor", cursor);
        const body = await call(`${base}/keys?${params.toString()}`);
        for (const key of body.result ?? []) keys.push(key.name);
        cursor = body.result_info?.cursor ?? "";
      } while (cursor !== "");
      return keys;
    },
    async deleteKeys(keys) {
      for (let start = 0; start < keys.length; start += DELETE_LIMIT) {
        const body = await call(`${base}/bulk/delete`, {
          method: "POST",
          body: JSON.stringify(keys.slice(start, start + DELETE_LIMIT)),
        });
        const missed = body.result?.unsuccessful_keys?.length ?? 0;
        if (missed > 0) throw new KvError(`KV could not delete ${missed} keys`);
      }
    },
  };
}

const counted = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Addresses are compared in any case. */
const normalized = (address) => address.trim().toLowerCase();

const BANNED = "this account is banned, and the ban would go with the row";

/**
 * @typedef {object} AccountDeleteOptions
 * @property {string} connectionString
 * @property {string} address
 * @property {{ listKeys: (prefix: string) => Promise<string[]>, deleteKeys: (keys: string[]) => Promise<void> }} kv
 * @property {(prompt: string) => Promise<string>} ask
 * @property {(line: string) => void} [log]
 */

/**
 * Deletes the account. Resolves with whether it did, the reason it refused (null if it did not)
 * and a message for the operator when it stopped on a failure. It never rejects over a database
 * or KV failure.
 * @param {AccountDeleteOptions} options
 * @returns {Promise<{ deleted: boolean, refused: string | null, error: string | null }>}
 */
export async function accountDelete({ connectionString, address, kv, ask, log = console.log }) {
  const refuse = (refused) => {
    log(`refused: ${refused}`);
    return { deleted: false, refused, error: null };
  };
  // A pool, not one client: the prompt can sit long enough for the server to drop an idle
  // connection, and the pool opens another.
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 15_000 });
  // A dropped connection is reported by the statement that was using it.
  pool.on("error", () => {});
  try {
    const { rows: found } = await pool.query(
      `select id, email, role, banned_at from "user" where lower(email) = $1`,
      [normalized(address)],
    );
    if (found.length === 0) return refuse("no account has that address");
    // Sign-in lowercases addresses, so this needs an older row or a hand edit. Which one is meant
    // is for a person to look at.
    if (found.length > 1) return refuse("more than one account has that address");
    const [user] = found;
    if (user.banned_at !== null) return refuse(BANNED);

    // apps/web's positionKey, whose TypeScript and imports a script can't load.
    const prefix = `pos:${user.id}:`;
    const { rows } = await pool.query(
      `select
         (select count(*)::int from session where user_id = $1) as sessions,
         (select count(*)::int from uploads where user_id = $1) as uploads,
         (select count(*)::int from reports where reporter_id = $1) as reports,
         (select count(*)::int from takedowns where resolved_by = $1) as takedowns,
         (select count(*)::int from requester_blocks where created_by = $1) as blocks,
         (select count(*)::int from moderation_actions where moderator_id = $1) as actions`,
      [user.id],
    );
    const { sessions, uploads, reports, takedowns, blocks, actions } = rows[0];
    const positions = (await kv.listKeys(prefix)).length;
    log(`account: ${user.email}${user.role === null ? "" : `, role ${user.role}`}`);
    log(
      `will delete: the account, ${counted(sessions, "session")}, ${counted(positions, "saved reading position")}`,
    );
    log(
      `will stay: ${counted(uploads, "upload")} with no account attached, ${counted(reports, "report")}, ${counted(takedowns, "takedown")} resolved, ${counted(blocks, "requester block")}, ${counted(actions, "moderation log row")}`,
    );

    const typed = await ask("type the address again to delete this account: ");
    if (normalized(typed) !== normalized(address)) return refuse("not confirmed");

    const ended = await pool.query("delete from session where user_id = $1", [user.id]);
    const keys = await kv.listKeys(prefix);
    await kv.deleteKeys(keys);
    // A ban that landed while the prompt waited keeps the row. The sessions and positions are
    // gone by then, which costs a banned account little.
    const gone = await pool.query(`delete from "user" where id = $1 and banned_at is null`, [
      user.id,
    ]);
    if (gone.rowCount === 0) return refuse(BANNED);
    log(
      `deleted the account, ${counted(ended.rowCount ?? 0, "session")}, ${counted(keys.length, "saved reading position")}`,
    );
    return { deleted: true, refused: null, error: null };
  } catch (caught) {
    const error = caught instanceof KvError ? caught.message : `database error (${codeOf(caught)})`;
    return { deleted: false, refused: null, error };
  } finally {
    await pool.end().catch(() => {});
  }
}

/** One line from standard input; closed input is an empty answer. */
function askOnStdin(prompt) {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    reader.once("close", () => resolve(""));
    reader.question(prompt, (answer) => {
      resolve(answer);
      reader.close();
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  // The flag check too: a database URL given as a flag has an @ in it.
  if (args.length !== 1 || args[0].startsWith("-") || !args[0].includes("@")) {
    console.error("account-delete: give one address and no flags");
    console.error(USAGE);
    return 2;
  }
  const missing = NAMES.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    for (const name of missing) console.error(`account-delete: ${name} is not set`);
    console.error(USAGE);
    return 2;
  }
  const { deleted, error } = await accountDelete({
    connectionString: process.env.DATABASE_URL ?? "",
    address: args[0],
    kv: positionsKv({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
      namespaceId: process.env.POSITIONS_NAMESPACE_ID ?? "",
    }),
    ask: askOnStdin,
  });
  if (error !== null) {
    console.error(`account-delete: stopped: ${error}. Run it again to finish.`);
  }
  return deleted ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
