import type { Insertable } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestTable } from "../src/index";
import { seedWork } from "../src/seed";
import { createTestDb, type TestDb } from "../src/testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

// Expected columns: ARCHITECTURE's Data model for reports, takedowns, requests,
// opt-outs and requester blocks.
const expected = {
  reports: {
    id: { type: "text", nullable: false },
    work_id: { type: "text", nullable: false },
    reporter_id: { type: "text", nullable: false },
    kind: { type: "text", nullable: false },
    body: { type: "text", nullable: true },
    status: { type: "text", nullable: false },
    created_at: { type: "timestamptz", nullable: false },
  },
  takedowns: {
    id: { type: "text", nullable: false },
    work_id: { type: "text", nullable: false },
    requester: { type: "text", nullable: false },
    basis: { type: "text", nullable: false },
    status: { type: "text", nullable: false },
    resolved_by: { type: "text", nullable: true },
    created_at: { type: "timestamptz", nullable: false },
    signature: { type: "text", nullable: false },
    infringing_material: { type: "text", nullable: false },
    good_faith: { type: "bool", nullable: false },
    accuracy_authority: { type: "bool", nullable: false },
    incomplete: { type: "bool", nullable: false },
  },
  requests: {
    id: { type: "text", nullable: false },
    kind: { type: "text", nullable: false },
    work_id: { type: "text", nullable: true },
    pseud_norm: { type: "text", nullable: true },
    contact_email: { type: "text", nullable: false },
    statement: { type: "text", nullable: false },
    status: { type: "text", nullable: false },
    ip_hash: { type: "text", nullable: false },
    created_at: { type: "timestamptz", nullable: false },
  },
  optouts: {
    id: { type: "text", nullable: false },
    pseud_norm: { type: "text", nullable: false },
    ao3_user: { type: "text", nullable: true },
    request_id: { type: "text", nullable: false },
    active: { type: "bool", nullable: false },
    created_at: { type: "timestamptz", nullable: false },
  },
  requester_blocks: {
    id: { type: "text", nullable: false },
    contact_email: { type: "text", nullable: true },
    ip_hash: { type: "text", nullable: true },
    created_by: { type: "text", nullable: false },
    created_at: { type: "timestamptz", nullable: false },
  },
} satisfies Record<string, Record<string, { type: string; nullable: boolean }>>;

describe("packages/db requests, reports and moderation", () => {
  it("The moderation tables have the Data model's columns", async () => {
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

  it("Report without details is accepted", async () => {
    const { workId } = await seedWork(t.db);
    const reporter = await addUser();
    const row = await t.db
      .insertInto("reports")
      .values({ work_id: workId, reporter_id: reporter, kind: "wrong_version" })
      .returning(["id", "reporter_id", "body", "status"])
      .executeTakeFirstOrThrow();
    expect(row.id).toHaveLength(36);
    expect(row).toMatchObject({ reporter_id: reporter, body: null, status: "open" });
  });

  it("A new request and a new DMCA notice are pending", async () => {
    const { workId } = await seedWork(t.db);
    const request = await addRequest({ kind: "remove_work", work_id: workId });
    expect(request.status).toBe("pending");
    const takedown = await t.db
      .insertInto("takedowns")
      .values({ work_id: workId, requester: "A rights holder", basis: "A stated basis" })
      .returning("status")
      .executeTakeFirstOrThrow();
    expect(takedown.status).toBe("pending");
  });
});

describe("17 reports and DMCA", () => {
  it("Repeat reports from one account count once", async () => {
    const { workId } = await seedWork(t.db);
    const [u, u2] = [await addUser(), await addUser()];
    for (const reporter_id of [u, u2, u, u]) {
      await t.db
        .insertInto("reports")
        .values({ work_id: workId, reporter_id, kind: "other" })
        .execute();
    }
    await t.db
      .insertInto("reports")
      .values({ work_id: workId, reporter_id: await addUser(), kind: "wrong_version" })
      .execute();
    const counted = await t.db
      .selectFrom("reports")
      .select((eb) => [
        eb.fn.countAll<string>().as("stored"),
        eb.fn.count<string>("reporter_id").distinct().as("accounts"),
      ])
      .where("work_id", "=", workId)
      .where("status", "=", "open")
      .where("kind", "<>", "wrong_version")
      .executeTakeFirstOrThrow();
    expect(counted).toEqual({ stored: "4", accounts: "2" });
  });

  it("Pending DMCA notice does not block an upload", async () => {
    // The notice's own outcome says whether it removed the work. The docs name
    // no status values, so these two stand in for the ones X8 and MOD1 choose.
    const REMOVED = "removed";
    const REJECTED = "rejected";
    const moderator = await addUser();
    const takenDown = await seedWork(t.db, { status: "removed" });
    const pending = await seedWork(t.db);
    // A rejected notice, on a work later removed for another reason.
    const removedOtherwise = await seedWork(t.db, { status: "removed" });
    for (const [{ workId }, outcome] of [
      [takenDown, { status: REMOVED, resolved_by: moderator }],
      [pending, {}],
      [removedOtherwise, { status: REJECTED, resolved_by: moderator }],
    ] as const) {
      await t.db
        .insertInto("takedowns")
        .values({
          work_id: workId,
          requester: "A rights holder",
          basis: "A stated basis",
          ...outcome,
        })
        .execute();
    }
    // The takedown list: works a moderator removed after a notice.
    const listed = await t.db
      .selectFrom("takedowns")
      .innerJoin("works", "works.id", "takedowns.work_id")
      .select("works.ao3_work_id")
      .where("takedowns.status", "=", REMOVED)
      .where("works.ao3_work_id", "in", [
        takenDown.ao3WorkId,
        pending.ao3WorkId,
        removedOtherwise.ao3WorkId,
      ])
      .execute();
    expect(listed).toEqual([{ ao3_work_id: takenDown.ao3WorkId }]);
  });
});

describe("16 removal and opt-out", () => {
  it("Mistaken opt-out can be reversed", async () => {
    const request = await addRequest({ kind: "opt_out", pseud_norm: "moon child" });
    for (const active of [true, false]) {
      await t.db
        .insertInto("optouts")
        .values({ pseud_norm: "moon child", request_id: request.id, active })
        .execute();
    }
    // The ingest check, for a byline's pseud_norm.
    const activeFor = (pseudNorm: string) =>
      t.db
        .selectFrom("optouts")
        .select("active")
        .where("pseud_norm", "=", pseudNorm)
        .where("active", "=", true)
        .execute();
    expect(await activeFor("moon child")).toEqual([{ active: true }]);
    expect(await activeFor("moon_child")).toEqual([]);
    await t.db
      .updateTable("optouts")
      .set({ active: false })
      .where("request_id", "=", request.id)
      .execute();
    expect(await activeFor("moon child")).toEqual([]);
  });

  it("Requests from one email are found whatever its case", async () => {
    await addRequest({
      kind: "opt_out",
      pseud_norm: "p",
      contact_email: "Mixed.Case@Example.test",
    });
    const found = await t.db
      .selectFrom("requests")
      .select("contact_email")
      .where((eb) => eb(eb.fn("lower", ["contact_email"]), "=", "mixed.case@example.test"))
      .execute();
    expect(found).toEqual([{ contact_email: "Mixed.Case@Example.test" }]);
  });
});

describe("packages/db moderation constraints", () => {
  it("A request of another kind is refused", async () => {
    await expect(
      // SAFETY: an invalid kind on purpose, to show the database refuses it.
      addRequest({ kind: "takedown" as RequestTable["kind"], pseud_norm: "x" }),
    ).rejects.toThrow(/check constraint/i);
  });

  it("A removal request without its work is refused", async () => {
    await expect(addRequest({ kind: "remove_work" })).rejects.toThrow(/check constraint/i);
  });

  it("An opt-out request without its pseud is refused", async () => {
    await expect(addRequest({ kind: "opt_out" })).rejects.toThrow(/check constraint/i);
  });

  it("An opt-out for a blank pseud is refused", async () => {
    await expect(addRequest({ kind: "opt_out", pseud_norm: "" })).rejects.toThrow(
      /check constraint/i,
    );
    const request = await addRequest({ kind: "opt_out", pseud_norm: "p" });
    await expect(
      t.db
        .insertInto("optouts")
        .values({ pseud_norm: "", request_id: request.id, active: true })
        .execute(),
    ).rejects.toThrow(/check constraint/i);
  });

  it("A blank email or IP hash is refused", async () => {
    const moderator = await addUser();
    for (const values of [
      { contact_email: "", ip_hash: "hash-of-an-ip" },
      { contact_email: "blocked@example.test", ip_hash: "" },
      { contact_email: " ", ip_hash: "hash-of-an-ip" },
      { contact_email: "blocked@example.test", ip_hash: "\t" },
    ]) {
      await expect(
        t.db
          .insertInto("requester_blocks")
          .values({ ...values, created_by: moderator })
          .execute(),
      ).rejects.toThrow(/check constraint/i);
      await expect(addRequest({ kind: "opt_out", pseud_norm: "p", ...values })).rejects.toThrow(
        /check constraint/i,
      );
    }
  });

  it("A requester block with neither email nor IP hash is refused", async () => {
    const moderator = await addUser();
    await expect(
      t.db.insertInto("requester_blocks").values({ created_by: moderator }).execute(),
    ).rejects.toThrow(/check constraint/i);
  });

  it("A report for a work or account that doesn't exist is refused", async () => {
    const { workId } = await seedWork(t.db);
    const reporter = await addUser();
    const report = (work_id: string, reporter_id: string) =>
      t.db.insertInto("reports").values({ work_id, reporter_id, kind: "other" }).execute();
    await expect(report("no-such-work", reporter)).rejects.toThrow(/foreign key/i);
    await expect(report(workId, "no-such-user")).rejects.toThrow(/foreign key/i);
  });

  it("Rows that point at a missing work, request or moderator are refused", async () => {
    await expect(addRequest({ kind: "remove_work", work_id: "no-such-work" })).rejects.toThrow(
      /foreign key/i,
    );
    await expect(
      t.db
        .insertInto("optouts")
        .values({ pseud_norm: "x", request_id: "no-such-request", active: true })
        .execute(),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      t.db
        .insertInto("takedowns")
        .values({ work_id: "no-such-work", requester: "r", basis: "b" })
        .execute(),
    ).rejects.toThrow(/foreign key/i);
    const { workId } = await seedWork(t.db);
    await expect(
      t.db
        .insertInto("takedowns")
        .values({ work_id: workId, requester: "r", basis: "b", resolved_by: "no-such-user" })
        .execute(),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      t.db
        .insertInto("requester_blocks")
        .values({ ip_hash: "h", created_by: "no-such-user" })
        .execute(),
    ).rejects.toThrow(/foreign key/i);
  });

  it("A reported work or reporter can't be deleted", async () => {
    const { workId } = await seedWork(t.db);
    const reporter = await addUser();
    await t.db
      .insertInto("reports")
      .values({ work_id: workId, reporter_id: reporter, kind: "other" })
      .execute();
    await expect(t.db.deleteFrom("works").where("id", "=", workId).execute()).rejects.toThrow(
      /foreign key/i,
    );
    await expect(t.db.deleteFrom("user").where("id", "=", reporter).execute()).rejects.toThrow(
      /foreign key/i,
    );
  });
});

let users = 0;
async function addUser(id = `moderation-user-${++users}`) {
  await t.db
    .insertInto("user")
    .values({ id, name: id, email: `${id}@example.test`, email_verified: true })
    .execute();
  return id;
}

async function addRequest(
  values: Pick<Insertable<RequestTable>, "kind"> & Partial<Insertable<RequestTable>>,
) {
  return t.db
    .insertInto("requests")
    .values({
      contact_email: "requester@example.test",
      statement: "A short statement.",
      ip_hash: "hash-of-an-ip",
      ...values,
    })
    .returning(["id", "status"])
    .executeTakeFirstOrThrow();
}
