// Test-only helper, exported as `@archive/db/testing`. Node only: it starts an
// in-process PGlite (WASM Postgres) behind a local Postgres wire socket, so
// tests reach it through the same `pg` driver `createDb` uses in production.
// PGlite is a dev dependency here: a workspace importing this lists it too.
import { PGlite, type ExecProtocolOptionsStream } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { Kysely } from "kysely";
import { createDb } from "./client";
import { migrate } from "./migrate";
import type { Database } from "./schema";

export interface TestDb {
  db: Kysely<Database>;
  /** Where another client reaches the same database, such as a Worker's local Hyperdrive. */
  connectionString: string;
  /** Closes the client, the socket and the database. Call it in `afterAll`. */
  close(): Promise<void>;
}

export interface TestDbOptions {
  /** Left out or true, every migration is applied. */
  migrate?: boolean;
  /**
   * How many clients the socket takes at once, `db` included. The default of 1
   * is `db` alone; give more when other clients use `connectionString` too.
   */
  maxConnections?: number;
}

// Frontend messages that end a cycle: after them the backend answers
// ReadyForQuery (Sync, Query, FunctionCall, a cleartext PasswordMessage, and
// CopyDone or CopyFail) or closes (Terminate). Any other (Parse, Bind, Describe,
// Execute, Close, Flush, CopyData) is part-way through one. Nothing here uses
// COPY or SASL, and neither is kept whole: a Query that starts a COPY, and a SASL
// response ('p' too), are answered with more of the exchange, not ReadyForQuery.
const ENDS_CYCLE = new Set(["S", "Q", "F", "p", "c", "f", "X"]);

/**
 * PGlite that keeps each client's protocol cycle whole. pglite-socket 0.2.16
 * queues every client's messages one by one, and keeps to one client only while
 * `isInTransaction()`. Outside a transaction, another client's Parse could land
 * between one's Parse and Bind and replace the unnamed statement ("bind message
 * supplies 2 parameters, but prepared statement "" requires 3"). So this reports
 * "in a transaction" from a cycle's first message to its Sync too. Check the
 * socket's rule again when pglite-socket is upgraded.
 */
class OneCycleAtATime extends PGlite {
  private midCycle = false;

  override isInTransaction(): boolean {
    return this.midCycle || super.isInTransaction();
  }

  override async execProtocolRawStream(
    message: Uint8Array,
    options: ExecProtocolOptionsStream,
  ): Promise<void> {
    // A startup packet has no type byte: it begins with its length's high byte, 0.
    const type = message[0] ?? 0;
    this.midCycle = type !== 0 && !ENDS_CYCLE.has(String.fromCharCode(type));
    // A throw here stalls pglite-socket's whole queue anyway (#248), so midCycle stays.
    await super.execProtocolRawStream(message, options);
  }
}

/** A fresh, empty database. With `migrate: false`, no migration is applied. */
export async function createTestDb(options: TestDbOptions = {}): Promise<TestDb> {
  // Not `OneCycleAtATime.create()`: PGlite's factory always builds the base class.
  // pg_trgm backs fuzzy search; migration 0008 runs `create extension` for it.
  const lite = new OneCycleAtATime({ extensions: { pg_trgm } });
  await lite.waitReady;
  const server = new PGLiteSocketServer({
    db: lite,
    port: 0,
    maxConnections: options.maxConnections,
  });
  let db: Kysely<Database> | undefined;
  const close = async () => {
    await db?.destroy();
    await server.stop();
    await lite.close();
  };
  try {
    await server.start();
    // PGlite ignores the password; Miniflare's Hyperdrive refuses a URL without one.
    const connectionString = `postgresql://postgres:postgres@${server.getServerConn()}/postgres`;
    // `db` shares PGlite's one session with other clients: see OneCycleAtATime.
    db = createDb({ connectionString, max: 1 });
    if (options.migrate !== false) await migrate(db);
    return { db, connectionString, close };
  } catch (err) {
    await close();
    throw err;
  }
}
