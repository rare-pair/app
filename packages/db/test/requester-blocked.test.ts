import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRequesterBlocked } from "../src/index";
import { createTestDb, type TestDb } from "../src/testing";

let t: TestDb;
let moderator: string;
beforeAll(async () => {
  t = await createTestDb();
  moderator = "blocked-moderator";
  await t.db
    .insertInto("user")
    .values({ id: moderator, name: "m", email: "blocked-mod@example.test", email_verified: true })
    .execute();
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

describe("isRequesterBlocked", () => {
  it("Matches a blocked contact email in any case", async () => {
    await t.db
      .insertInto("requester_blocks")
      .values({ contact_email: "Blocked.One@Example.test", created_by: moderator })
      .execute();
    expect(
      await isRequesterBlocked(t.db, { email: "blocked.one@example.test", ipHash: null }),
    ).toBe(true);
    expect(await isRequesterBlocked(t.db, { email: "other.one@example.test", ipHash: null })).toBe(
      false,
    );
  });

  it("Matches a blocked IP hash whatever the email", async () => {
    await t.db
      .insertInto("requester_blocks")
      .values({ ip_hash: "ab".repeat(32), created_by: moderator })
      .execute();
    expect(
      await isRequesterBlocked(t.db, { email: "x@example.test", ipHash: "ab".repeat(32) }),
    ).toBe(true);
    expect(
      await isRequesterBlocked(t.db, { email: "x@example.test", ipHash: "cd".repeat(32) }),
    ).toBe(false);
  });
});
