import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { waitlistPurge } from "../../../scripts/waitlist-purge.mjs";
import { createTestDb, type TestDb } from "../src/testing";

// The operator's script (scripts/waitlist-purge.mjs), run against the real migrations on PGlite.
// maxConnections: 3 is `db` plus the purge and, in the lock case, a launch send's open claim.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ maxConnections: 3 });
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});
beforeEach(async () => {
  await t.db.deleteFrom("waitlist").execute();
});

const CONFIRMED = new Date("2026-10-01T00:00:00Z");

interface Seed {
  email: string;
  confirmed?: boolean;
  /** SQL for notified_at, evaluated on the database clock; omitted leaves it empty. */
  notifiedAgo?: string;
}

/** Seeds rows; the notified times are SQL intervals, since the script uses the database clock. */
async function seed(...rows: Seed[]) {
  for (const row of rows) {
    await t.db
      .insertInto("waitlist")
      .values({
        email: row.email,
        confirmed_at: row.confirmed === false ? null : CONFIRMED,
        notified_at:
          row.notifiedAgo === undefined ? null : sql<Date>`now() - ${row.notifiedAgo}::interval`,
      })
      .execute();
  }
}

const count = async () => (await t.db.selectFrom("waitlist").select("email").execute()).length;
const noAddress = (lines: string[]) => expect(lines.join("\n")).not.toMatch(/@|example\.test/);

const run = (extra: { force?: boolean; lockTimeoutMs?: number } = {}) => {
  const lines: string[] = [];
  return waitlistPurge({
    connectionString: t.connectionString,
    log: (l: string) => lines.push(l),
    ...extra,
  }).then((result) => ({ ...result, lines }));
};

describe("22-waitlist purge script", () => {
  it("The wait list is deleted after the launch send", async () => {
    await seed(
      { email: "a@example.test", notifiedAgo: "3 days" },
      { email: "b@example.test", notifiedAgo: "25 hours" },
      { email: "unconfirmed@example.test", confirmed: false },
    );

    const result = await run();

    expect(result).toMatchObject({ deleted: 3, refused: null, error: null });
    expect(result.lines).toEqual(["deleted 3 wait list rows"]);
    expect(await count()).toBe(0);
  });

  it("The wait list is deleted after the launch send: an empty list succeeds with 0", async () => {
    const result = await run();
    expect(result).toMatchObject({ deleted: 0, refused: null, error: null });
  });

  it("The wait list is deleted after the launch send: a list with no confirmed address is purged", async () => {
    await seed(
      { email: "u1@example.test", confirmed: false },
      { email: "u2@example.test", confirmed: false },
    );

    const result = await run();

    expect(result).toMatchObject({ deleted: 2, refused: null, error: null });
    expect(await count()).toBe(0);
  });

  it("The wait list is deleted after the launch send: refuses while a confirmed address is unsent", async () => {
    await seed(
      { email: "sent@example.test", notifiedAgo: "3 days" },
      { email: "waiting1@example.test" },
      { email: "waiting2@example.test" },
      { email: "unconfirmed@example.test", confirmed: false },
    );

    const result = await run();

    expect(result.deleted).toBe(0);
    expect(result.error).toBeNull();
    expect(result.refused).toBe("2 confirmed addresses are still waiting for the launch send");
    expect(result.lines).toEqual([
      "refused: 2 confirmed addresses are still waiting for the launch send",
      "rerun with --force to purge anyway",
    ]);
    expect(await count()).toBe(4);
  });

  it("The wait list is deleted after the launch send: one waiting address is refused in the singular", async () => {
    await seed({ email: "waiting@example.test" });

    const result = await run();

    expect(result.refused).toBe("1 confirmed address is still waiting for the launch send");
    expect(await count()).toBe(1);
  });

  it("The wait list is deleted after the launch send: a lock timeout that is not a finite number falls back to the default", async () => {
    await seed({ email: "a@example.test", notifiedAgo: "3 days" });
    for (const lockTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, -5, 0]) {
      await seed({ email: `w${lockTimeoutMs}@example.test`.replace(/[^\w@.]/g, "") });
      const result = await run({ lockTimeoutMs });
      expect(result.error, String(lockTimeoutMs)).toBeNull();
      expect(result.refused, String(lockTimeoutMs)).not.toBeNull();
    }
    expect(await count()).toBe(5);
  });

  it("The wait list is deleted after the launch send: refuses while the last batch is under a day old", async () => {
    // The newest notified_at decides, not the oldest.
    await seed(
      { email: "old@example.test", notifiedAgo: "5 days" },
      { email: "new@example.test", notifiedAgo: "23 hours" },
    );

    const result = await run();

    expect(result.deleted).toBe(0);
    expect(result.refused).toBe("the last batch was queued less than 24 hours ago");
    expect(result.lines).toContain("rerun with --force to purge anyway");
    expect(await count()).toBe(2);
  });

  it("The wait list is deleted after the launch send: a batch just over 24 hours old is old enough", async () => {
    // The boundary itself can't be pinned on a moving clock: a minute either side of it can.
    await seed({ email: "a@example.test", notifiedAgo: "24 hours 1 minute" });
    expect(await run()).toMatchObject({ deleted: 1, refused: null });

    await seed({ email: "b@example.test", notifiedAgo: "23 hours 59 minutes" });
    expect(await run()).toMatchObject({ deleted: 0, refused: expect.any(String) });
    expect(await count()).toBe(1);
  });

  it("The wait list is deleted after the launch send: forced, it deletes in both refusal cases and says so", async () => {
    await seed(
      { email: "waiting@example.test" },
      { email: "new@example.test", notifiedAgo: "1 hour" },
    );

    const result = await run({ force: true });

    expect(result).toMatchObject({ deleted: 2, refused: null, error: null });
    expect(result.lines).toEqual([
      "forced: skipping the refusal checks",
      "deleted 2 wait list rows",
    ]);
    expect(await count()).toBe(0);
  });

  it("The wait list is deleted after the launch send: a send's open claim is committed before the purge judges the rows", async () => {
    await seed({ email: "a@example.test", notifiedAgo: "3 days" }, { email: "b@example.test" });
    // A launch send's claim: b is marked notified in a transaction not yet committed. The test
    // socket serves one client at a time while one is in a transaction, so the purge queues
    // behind the claim, as the table lock makes it wait on a real server (which PGlite can't
    // show). Judged before the commit, b would look unsent.
    const send = new pg.Client({ connectionString: t.connectionString });
    await send.connect();
    try {
      await send.query("begin");
      await send.query("update waitlist set notified_at = now() where email = 'b@example.test'");
      const purging = run();
      await new Promise((r) => setTimeout(r, 200));
      await send.query("commit");

      const result = await purging;

      expect(result.refused).toBe("the last batch was queued less than 24 hours ago");
      expect(await count()).toBe(2);
    } finally {
      await send.query("rollback").catch(() => {});
      await send.end();
    }
  });

  it("Reader privacy: no log line, refusal or error carries an address", async () => {
    await seed({ email: "waiting@example.test" });
    const refusal = await run();
    noAddress([...refusal.lines, refusal.refused ?? ""]);

    const forced = await run({ force: true });
    noAddress([...forced.lines, forced.refused ?? "", forced.error ?? ""]);
  });

  it("Secrets only from the environment: a malformed connection string is refused without quoting it", async () => {
    const bad = "postgres://user:not-a-password@host:notaport/db";
    const result = await waitlistPurge({ connectionString: bad });
    expect(result).toEqual({
      deleted: 0,
      refused: null,
      error: "DATABASE_URL is not a valid connection string",
    });
  });

  it("Secrets only from the environment: an unreachable database is reported by code, not quoted", async () => {
    const bad = "postgres://user:not-a-password@127.0.0.1:1/db";
    const result = await waitlistPurge({ connectionString: bad });
    expect(result.deleted).toBe(0);
    expect(result.error).toMatch(/^database error \(\w+\)$/);
    expect(result.error).not.toContain("not-a-password");
  });
});
