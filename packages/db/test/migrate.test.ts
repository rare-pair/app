import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrations } from "../migrations/index";
import { migrate } from "../src/index";
import { createTestDb, type TestDb } from "../src/testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ migrate: false });
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

// Expected columns: Better Auth 1.7.14's core schema (its `getMigrations` for
// Postgres with the magic-link plugin, mapped to snake_case), plus our five
// `user` fields from ARCHITECTURE's Data model.
const expected = {
  user: {
    id: { type: "text", nullable: false },
    name: { type: "text", nullable: false },
    email: { type: "text", nullable: false },
    email_verified: { type: "bool", nullable: false },
    image: { type: "text", nullable: true },
    created_at: { type: "timestamptz", nullable: false },
    updated_at: { type: "timestamptz", nullable: false },
    role: { type: "text", nullable: true },
    upload_quota_used: { type: "int4", nullable: false },
    upload_quota_day: { type: "date", nullable: true },
    banned_at: { type: "timestamptz", nullable: true },
    terms_accepted_at: { type: "timestamptz", nullable: true },
    warnings_off: { type: "bool", nullable: false },
  },
  session: {
    id: { type: "text", nullable: false },
    expires_at: { type: "timestamptz", nullable: false },
    token: { type: "text", nullable: false },
    created_at: { type: "timestamptz", nullable: false },
    updated_at: { type: "timestamptz", nullable: false },
    ip_address: { type: "text", nullable: true },
    user_agent: { type: "text", nullable: true },
    user_id: { type: "text", nullable: false },
  },
  account: {
    id: { type: "text", nullable: false },
    account_id: { type: "text", nullable: false },
    provider_id: { type: "text", nullable: false },
    user_id: { type: "text", nullable: false },
    access_token: { type: "text", nullable: true },
    refresh_token: { type: "text", nullable: true },
    id_token: { type: "text", nullable: true },
    access_token_expires_at: { type: "timestamptz", nullable: true },
    refresh_token_expires_at: { type: "timestamptz", nullable: true },
    scope: { type: "text", nullable: true },
    password: { type: "text", nullable: true },
    created_at: { type: "timestamptz", nullable: false },
    updated_at: { type: "timestamptz", nullable: false },
  },
  verification: {
    id: { type: "text", nullable: false },
    identifier: { type: "text", nullable: false },
    value: { type: "text", nullable: false },
    expires_at: { type: "timestamptz", nullable: false },
    created_at: { type: "timestamptz", nullable: false },
    updated_at: { type: "timestamptz", nullable: false },
  },
} satisfies Record<string, Record<string, { type: string; nullable: boolean }>>;

describe("packages/db migrations", () => {
  it("Every migration applies to an empty database", async () => {
    expect(await migrate(t.db)).toEqual(migrations.map((m) => m.name));

    const tables = await t.db.introspection.getTables();
    for (const [table, columns] of Object.entries(expected)) {
      const found = tables.find((x) => x.name === table);
      expect(found, `table ${table}`).toBeDefined();
      const actual = Object.fromEntries(
        found!.columns.map((c) => [c.name, { type: c.dataType, nullable: c.isNullable }]),
      );
      expect(actual, `columns of ${table}`).toEqual(columns);
    }
  });

  it("Applying the migrations again changes nothing", async () => {
    await migrate(t.db);
    await t.db
      .insertInto("user")
      .values({ id: "kept", name: "kept", email: "kept@example.test", email_verified: true })
      .execute();

    expect(await migrate(t.db)).toEqual([]);

    const users = await t.db.selectFrom("user").select("id").execute();
    expect(users).toEqual([{ id: "kept" }]);
  });
});
