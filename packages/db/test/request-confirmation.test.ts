import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrations } from "../migrations/index";
import { createTestDb, type TestDb } from "../src/testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ migrate: false });
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

const MIGRATION = "0019_request_confirmation";

describe("16-removal-and-opt-out: migration 0019", () => {
  it("Requests made before it count as confirmed from the day they were made", async () => {
    const m = migrations.findIndex((x) => x.name === MIGRATION);
    expect(m).toBeGreaterThan(0);
    // Every migration before this one, then a request as X2 stored it, then this one.
    // (Later migrations are not applied: this database is only for this case.)
    for (const earlier of migrations.slice(0, m)) await sql.raw(earlier.sql).execute(t.db);
    await sql`insert into requests (kind, pseud_norm, contact_email, statement, ip_hash, created_at)
      values ('opt_out', 'old-pseud', 'old@example.test', '', 'h', '2026-10-01T12:00:00Z')`.execute(
      t.db,
    );

    await sql.raw(migrations[m]!.sql).execute(t.db);

    const rows = await sql<{ confirmed_at: Date; confirm_token_hash: string | null }>`
      select confirmed_at, confirm_token_hash from requests where pseud_norm = 'old-pseud'`.execute(
      t.db,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.confirmed_at.toISOString()).toBe("2026-10-01T12:00:00.000Z");
    expect(rows.rows[0]!.confirm_token_hash).toBeNull();
  });

  it("A confirmation token hash belongs to one request, and unconfirmed requests may share none", async () => {
    const full = await createTestDb();
    const base = {
      kind: "opt_out" as const,
      contact_email: "new@example.test",
      statement: "",
      ip_hash: "h",
    };
    const add = (pseud: string, hash: string | null) =>
      full.db
        .insertInto("requests")
        .values({ ...base, pseud_norm: pseud, confirm_token_hash: hash })
        .execute();
    await add("new-a", "hash-1");
    await expect(add("new-b", "hash-1")).rejects.toThrow();
    await add("new-c", null);
    await add("new-d", null);
    await full.close();
  });
});
