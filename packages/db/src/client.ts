import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./schema";

export interface DbConfig {
  /** In a Worker, `env.HYPERDRIVE.connectionString`. */
  connectionString: string;
  /** Pool size. Left out (or 0), pg's default of 10 applies. */
  max?: number;
  /** How long to wait for a connection before failing. Left out, pg waits indefinitely. */
  connectionTimeoutMillis?: number;
  /** How long a query may run, measured by the client, before it fails, on the client and on the server. Left out, no limit. */
  queryTimeoutMillis?: number;
}

/**
 * A Kysely instance over `pg`, typed with the archive's tables. It owns its
 * pool: in a Worker, create one per request and end it with
 * `ctx.waitUntil(db.destroy())`, since connections can't outlive the request.
 */
export function createDb(config: DbConfig): Kysely<Database> {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    query_timeout: config.queryTimeoutMillis,
    // The server's own limit, so a query the client gave up on doesn't keep its connection.
    statement_timeout: config.queryTimeoutMillis,
  });
  // pg reports an idle client's lost connection as an error on the pool, and an
  // EventEmitter with no listener throws it. The pool has already dropped that
  // client, so the error is only reported. In workerd, ending the pool raises one
  // every time (the socket's pending read rejects once it is closed): that one is
  // expected and dropped. The message names no reader, only the connection.
  pool.on("error", (error) => {
    if (!pool.ending) console.error(`postgres: idle connection lost: ${error.message}`);
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
