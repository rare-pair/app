import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountDelete } from "../../../scripts/account-delete.mjs";
import {
  banUser,
  getLiveWork,
  hideWork,
  insertUpload,
  isUploaderBanned,
  logModerationAction,
} from "../src/index";
import { seedWork } from "../src/seed";
import { createTestDb, type TestDb } from "../src/testing";

// What deleting an account leaves behind, and the operator's script
// (scripts/account-delete.mjs), through the real migrations on PGlite. Cloudflare is never
// called: the function takes a KV client, and the command line's fetch is replaced.
let t: TestDb;
beforeAll(async () => {
  t = await createTestDb({ maxConnections: 3 });
});
afterAll(async () => {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- unset if beforeAll failed
  await t?.close();
});

let users = 0;
async function addUser(role: string | null = null) {
  const id = `acctdel-user-${++users}`;
  const email = `${id}@example.test`;
  await t.db
    .insertInto("user")
    .values({ id, name: id, email, email_verified: true, role })
    .execute();
  return { id, email };
}

/** One session and one account row, as signing in leaves them. */
async function signedIn(userId: string) {
  const now = new Date();
  await t.db
    .insertInto("session")
    .values({
      id: `session-${userId}`,
      expires_at: new Date(now.getTime() + 60_000),
      token: `token-${userId}`,
      user_id: userId,
      updated_at: now,
    })
    .execute();
  await t.db
    .insertInto("account")
    .values({
      id: `account-${userId}`,
      account_id: userId,
      provider_id: "magic-link",
      user_id: userId,
      updated_at: now,
    })
    .execute();
}

const deleteUser = (id: string) => t.db.deleteFrom("user").where("id", "=", id).execute();

const userExists = async (id: string) =>
  (await t.db.selectFrom("user").select("id").where("id", "=", id).execute()).length === 1;

const sessionCount = async (id: string) =>
  (await t.db.selectFrom("session").select("id").where("user_id", "=", id).execute()).length;

/** An account that has done everything an account can leave rows for. */
async function activeAccount(ao3WorkId: number) {
  const user = await addUser("moderator");
  await signedIn(user.id);
  const work = await seedWork(t.db, { ao3WorkId, title: "acctdel-title", userId: user.id });
  const report = await t.db
    .insertInto("reports")
    .values({ work_id: work.workId, reporter_id: user.id, kind: "other" })
    .returning("id")
    .executeTakeFirstOrThrow();
  const takedown = await t.db
    .insertInto("takedowns")
    .values({
      work_id: work.workId,
      requester: "acctdel requester",
      basis: "acctdel basis",
      status: "rejected",
      resolved_by: user.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const block = await t.db
    .insertInto("requester_blocks")
    .values({ contact_email: `blocked-${user.id}@example.test`, created_by: user.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  await logModerationAction(t.db, {
    moderatorId: user.id,
    action: "hide",
    targetKind: "work",
    targetId: work.workId,
  });
  return { ...user, work, report: report.id, takedown: takedown.id, block: block.id };
}

const uploadUsers = (workId: string) =>
  t.db.selectFrom("uploads").select("user_id").where("work_id", "=", workId).execute();

/** The KV namespace, in memory, with a way to make a call fail. */
function fakeKv(keys: string[] = []) {
  const held = new Set(keys);
  const kv = {
    held,
    failDelete: false,
    listKeys: async (prefix: string) => [...held].filter((key) => key.startsWith(prefix)),
    deleteKeys: async (names: string[]) => {
      if (kv.failDelete) throw new Error("kv refused");
      for (const name of names) held.delete(name);
    },
  };
  return kv;
}

/** Runs the script's function; the operator types `typed` at the prompt. */
async function run(
  address: string,
  kv: ReturnType<typeof fakeKv>,
  typed = address,
  atPrompt: () => Promise<void> = async () => {},
) {
  const lines: string[] = [];
  const result = await accountDelete({
    connectionString: t.connectionString,
    address,
    kv,
    ask: async () => {
      await atPrompt();
      return typed;
    },
    log: (line: string) => lines.push(line),
  });
  return { ...result, lines };
}

// The command line against a real database. spawn, not spawnSync: PGlite runs in this process.
// --import swaps fetch before the script loads, so nothing reaches Cloudflare.
const NO_CLOUDFLARE = `data:text/javascript,${encodeURIComponent(`
  globalThis.fetch = async (url, init) => {
    const body = init?.method === "POST"
      ? { success: true, result: { successful_key_count: 0 } }
      : { success: true, result: [], result_info: { count: 0, cursor: "" } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
`)}`;
const SCRIPT = fileURLToPath(new URL("../../../scripts/account-delete.mjs", import.meta.url));

function cli(address: string, stdin: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", NO_CLOUDFLARE, SCRIPT, address], {
      env: {
        ...process.env,
        DATABASE_URL: t.connectionString,
        CLOUDFLARE_ACCOUNT_ID: "test-account",
        CLOUDFLARE_API_TOKEN: "test-not-a-token",
        POSITIONS_NAMESPACE_ID: "test-namespace",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.end(stdin);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("18-moderation", () => {
  it("An account is deleted on request: the delete succeeds for an account that has uploaded, reported and moderated", async () => {
    const a = await activeAccount(60900);

    await deleteUser(a.id);

    // THEN the account and its sign-ins are gone.
    expect(await userExists(a.id)).toBe(false);
    expect(await sessionCount(a.id)).toBe(0);
    expect(
      await t.db.selectFrom("account").select("id").where("user_id", "=", a.id).execute(),
    ).toEqual([]);
    // AND its upload row stays with no user, and its work stays public.
    expect(await uploadUsers(a.work.workId)).toEqual([{ user_id: null }]);
    const live = await getLiveWork(t.db, 60900);
    expect(live?.work.title).toBe("acctdel-title");
    // AND the report, the takedown's resolver, the block's maker and the log keep the id.
    const report = await t.db
      .selectFrom("reports")
      .select("reporter_id")
      .where("id", "=", a.report)
      .executeTakeFirstOrThrow();
    expect(report.reporter_id).toBe(a.id);
    const takedown = await t.db
      .selectFrom("takedowns")
      .select("resolved_by")
      .where("id", "=", a.takedown)
      .executeTakeFirstOrThrow();
    expect(takedown.resolved_by).toBe(a.id);
    const block = await t.db
      .selectFrom("requester_blocks")
      .select("created_by")
      .where("id", "=", a.block)
      .executeTakeFirstOrThrow();
    expect(block.created_by).toBe(a.id);
    const log = await t.db
      .selectFrom("moderation_actions")
      .select(["moderator_id", "action"])
      .where("target_id", "=", a.work.workId)
      .execute();
    expect(log).toEqual([{ moderator_id: a.id, action: "hide" }]);
  });

  it("An account is deleted on request: its reports still count toward hiding the work", async () => {
    const work = await seedWork(t.db, { ao3WorkId: 60901 });
    const stays = await addUser();
    const goes = await addUser();
    for (const reporter of [stays.id, goes.id]) {
      await t.db
        .insertInto("reports")
        .values({ work_id: work.workId, reporter_id: reporter, kind: "other" })
        .execute();
    }

    await deleteUser(goes.id);

    expect(await hideWork(t.db, work.workId, "reports", { minReporters: 2 })).toBe(true);
  });

  it("An account is deleted on request: an upload still waiting is refused like a banned uploader's", async () => {
    const user = await addUser();
    const { id } = await insertUpload(t.db, {
      userId: user.id,
      r2Key: `uploads/${crypto.randomUUID()}`,
      bytes: 10,
    });
    expect(await isUploaderBanned(t.db, id)).toBe(false);

    await deleteUser(user.id);

    expect(await isUploaderBanned(t.db, id)).toBe(true);
  });

  it("An account is deleted on request: the script removes the account, its sessions and its pos: keys", async () => {
    const a = await activeAccount(60902);
    const other = await addUser();
    const kv = fakeKv([
      `pos:${a.id}:60902`,
      `pos:${a.id}:60903`,
      `pos:${other.id}:60902`,
      // Shares the id's start: the colon ends the prefix.
      `pos:${a.id}9:60902`,
    ]);

    const result = await run(a.email, kv);

    expect(result).toMatchObject({ deleted: true, refused: null, error: null });
    expect(await userExists(a.id)).toBe(false);
    expect(await sessionCount(a.id)).toBe(0);
    expect(kv.held).toEqual(new Set([`pos:${other.id}:60902`, `pos:${a.id}9:60902`]));
    expect(await userExists(other.id)).toBe(true);
    expect(await uploadUsers(a.work.workId)).toEqual([{ user_id: null }]);
  });

  it("An account is deleted on request: the script shows what it will delete before it asks", async () => {
    const a = await activeAccount(60904);
    const lines: string[] = [];
    let seen: string[] = [];

    await accountDelete({
      connectionString: t.connectionString,
      address: a.email,
      kv: fakeKv([`pos:${a.id}:60904`, `pos:${a.id}:60905`]),
      ask: async () => {
        seen = [...lines];
        return "";
      },
      log: (line: string) => lines.push(line),
    });

    expect(seen).toEqual([
      `account: ${a.email}, role moderator`,
      "will delete: the account, 1 session, 2 saved reading positions",
      "will stay: 1 upload with no account attached, 1 report, 1 takedown resolved, 1 requester block, 1 moderation log row",
    ]);
  });

  it("An account is deleted on request: the address matches in any case", async () => {
    const a = await addUser();
    const result = await run(a.email.toUpperCase(), fakeKv(), a.email);
    expect(result.deleted).toBe(true);
    expect(await userExists(a.id)).toBe(false);
  });

  it("Deleting an account needs confirmation: anything but the address deletes nothing", async () => {
    const a = await addUser();
    await signedIn(a.id);
    const kv = fakeKv([`pos:${a.id}:60906`]);

    for (const typed of ["", "yes", "someone-else@example.test"]) {
      const result = await run(a.email, kv, typed);
      expect(result, typed).toMatchObject({
        deleted: false,
        refused: "not confirmed",
        error: null,
      });
    }

    expect(await userExists(a.id)).toBe(true);
    expect(await sessionCount(a.id)).toBe(1);
    expect(kv.held.size).toBe(1);
  });

  it("Deleting an account needs an account: an unknown address touches nothing", async () => {
    const other = await addUser();
    const kv = fakeKv([`pos:${other.id}:60907`]);
    let asked = false;

    const result = await run("nobody-acctdel@example.test", kv, undefined, async () => {
      asked = true;
    });

    expect(result).toMatchObject({
      deleted: false,
      refused: "no account has that address",
      error: null,
    });
    expect(asked).toBe(false);
    expect(kv.held.size).toBe(1);
    expect(await userExists(other.id)).toBe(true);
  });

  it("Deleting an account needs an account: two rows for one address touch nothing", async () => {
    const a = await addUser();
    const twin = `twin-${users}`;
    await t.db
      .insertInto("user")
      .values({ id: twin, name: twin, email: a.email.toUpperCase(), email_verified: true })
      .execute();

    const result = await run(a.email, fakeKv());

    expect(result.refused).toBe("more than one account has that address");
    expect(await userExists(a.id)).toBe(true);
    expect(await userExists(twin)).toBe(true);
  });

  it("Deleting a banned account is refused: the ban would go with the row", async () => {
    const a = await addUser();
    await banUser(t.db, a.id, { actor: "acctdel-moderator" });
    await signedIn(a.id);
    const kv = fakeKv([`pos:${a.id}:60908`]);

    const result = await run(a.email, kv);

    expect(result.deleted).toBe(false);
    expect(result.refused).toMatch(/banned/);
    expect(result.lines.join("\n")).toMatch(/banned/);
    expect(await userExists(a.id)).toBe(true);
    expect(await sessionCount(a.id)).toBe(1);
    expect(kv.held.size).toBe(1);
  });

  it("Deleting a banned account is refused: a ban that lands at the prompt keeps the row", async () => {
    const a = await addUser();

    const result = await run(a.email, fakeKv(), a.email, async () => {
      await banUser(t.db, a.id, { actor: "acctdel-moderator" });
    });

    expect(result.deleted).toBe(false);
    expect(result.refused).toMatch(/banned/);
    expect(await userExists(a.id)).toBe(true);
  });

  it("A failed delete can be retried: the account stays until the keys are gone", async () => {
    const a = await addUser();
    await signedIn(a.id);
    const kv = fakeKv([`pos:${a.id}:60909`]);
    kv.failDelete = true;

    const failed = await run(a.email, kv);

    expect(failed.deleted).toBe(false);
    expect(failed.error).not.toBeNull();
    expect(await userExists(a.id)).toBe(true);

    kv.failDelete = false;
    const retried = await run(a.email, kv);

    expect(retried.deleted).toBe(true);
    expect(await userExists(a.id)).toBe(false);
    expect(kv.held.size).toBe(0);
  });

  it("Reader privacy: the script's output names no work and no key", async () => {
    const a = await addUser();
    const result = await run(a.email, fakeKv([`pos:${a.id}:60910`]));
    expect(result.lines.join("\n")).not.toMatch(/60910|pos:/);
  });

  it("Secrets only from the environment: a bad or unreachable database is reported by code, not quoted", async () => {
    for (const connectionString of [
      "postgres://user:not-a-password@127.0.0.1:1/db",
      "postgres://user:not-a-password@host:notaport/db",
    ]) {
      const result = await accountDelete({
        connectionString,
        address: "a@example.test",
        kv: fakeKv(),
        ask: async () => "",
        log: () => {},
      });
      expect(result.deleted).toBe(false);
      expect(result.error).toMatch(/^database error \(\w+\)$/);
    }
  });

  it("Deleting an account needs confirmation: at the command line, closed input deletes nothing", async () => {
    const a = await addUser();

    const { code, stdout } = await cli(a.email, "");

    expect(code).toBe(1);
    expect(stdout).toContain("will delete: the account");
    expect(stdout).toContain("not confirmed");
    expect(await userExists(a.id)).toBe(true);
  });

  it("An account is deleted on request: at the command line, typing the address deletes it", async () => {
    const a = await addUser();
    await signedIn(a.id);

    const { code, stdout, stderr } = await cli(a.email, `${a.email}\n`);

    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("deleted the account");
    expect(stdout).not.toContain("test-not-a-token");
    expect(await userExists(a.id)).toBe(false);
  });

  it("Deleting an account needs an account: at the command line, an unknown address exits 1", async () => {
    const { code, stdout } = await cli("nobody-acctdel@example.test", "");
    expect(code).toBe(1);
    expect(stdout).toContain("no account has that address");
  });
});
