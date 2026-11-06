import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countSignInEmail, createDb } from "../src/index";
import { createTestDb, type TestDb } from "../src/testing";

// The daily cap on sign-in emails per address, counted in Postgres. The day is the UTC
// calendar day, by the database's clock.
let t: TestDb;
beforeAll(async () => {
  // `db` plus the clients of the parallel case.
  t = await createTestDb({ maxConnections: 8 });
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

const TODAY = sql<string>`(now() at time zone 'utc')::date`;
const YESTERDAY = sql<string>`(now() at time zone 'utc')::date - 1`;

const rowsOf = (hash: string) =>
  t.db
    .selectFrom("sign_in_email_counts")
    .select("count")
    .where("address_hash", "=", hash)
    .execute();

/** Six requests at once against a limit of 5, each on its own connection, as isolates would be. */
async function sixAtOnce(hash: string) {
  const clients = Array.from({ length: 6 }, () =>
    createDb({ connectionString: t.connectionString, max: 1 }),
  );
  const results = await Promise.all(clients.map((db) => countSignInEmail(db, hash, 5)));
  await Promise.all(clients.map((db) => db.destroy()));
  return results;
}

describe("01-auth-magic-link: the daily count", () => {
  it("counts up to the limit, then refuses and changes nothing", async () => {
    const hash = randomUUID();
    for (let i = 0; i < 5; i++) expect(await countSignInEmail(t.db, hash, 5)).toBe(true);
    expect(await countSignInEmail(t.db, hash, 5)).toBe(false);
    expect(await rowsOf(hash)).toEqual([{ count: 5 }]);
  });

  it("two addresses have their own counts", async () => {
    const [one, other] = [randomUUID(), randomUUID()];
    const results = [
      await countSignInEmail(t.db, one, 1),
      await countSignInEmail(t.db, one, 1),
      await countSignInEmail(t.db, other, 1),
    ];
    expect(results).toEqual([true, false, true]);
  });

  it("a limit under one fits nothing and keeps nothing", async () => {
    const hash = randomUUID();
    expect(await countSignInEmail(t.db, hash, 0)).toBe(false);
    expect(await rowsOf(hash)).toEqual([]);
  });

  it("parallel requests can't both take the last one", async () => {
    const hash = randomUUID();
    await t.db
      .insertInto("sign_in_email_counts")
      .values({ address_hash: hash, day: TODAY, count: 4 })
      .execute();

    expect((await sixAtOnce(hash)).filter(Boolean)).toHaveLength(1);
    expect(await rowsOf(hash)).toEqual([{ count: 5 }]);
  });

  it("parallel first requests of a day make one row and count each", async () => {
    const hash = randomUUID();
    expect((await sixAtOnce(hash)).filter(Boolean)).toHaveLength(5);
    expect(await rowsOf(hash)).toEqual([{ count: 5 }]);
  });

  it("The count starts again the next day", async () => {
    const hash = randomUUID();
    await t.db
      .insertInto("sign_in_email_counts")
      .values({ address_hash: hash, day: YESTERDAY, count: 5 })
      .execute();
    expect(await countSignInEmail(t.db, hash, 5)).toBe(true);
    expect(await rowsOf(hash)).toEqual([{ count: 1 }]);
  });

  it("a counting request deletes every address's counts from before today", async () => {
    const [old, older, today] = [randomUUID(), randomUUID(), randomUUID()];
    await t.db
      .insertInto("sign_in_email_counts")
      .values([
        { address_hash: old, day: YESTERDAY, count: 2 },
        { address_hash: older, day: sql<string>`(now() at time zone 'utc')::date - 30`, count: 5 },
        { address_hash: today, day: TODAY, count: 3 },
      ])
      .execute();

    await countSignInEmail(t.db, randomUUID(), 5);

    expect(await rowsOf(old)).toEqual([]);
    expect(await rowsOf(older)).toEqual([]);
    expect(await rowsOf(today)).toEqual([{ count: 3 }]);
  });
});
