import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ipHash } from "../src/ip-hash";
import { BASE, confirmRemoval, fetchW, freshIp, REMOVE_TOKEN, signIn } from "./helpers";

// X6 (#67): a moderator blocks a requester from a request's page. One database serves every
// test file in the run, so this file keeps to AO3 work IDs 40410 to 40419, finds its requests
// by its own `example.test` contact emails, and names every pseud "x6". Synthetic text only.
const LATER = 40411;
const OPT_A = 40412;
const OPT_B = 40413;
const OPT_C = 40414;
const PSEUD = "x6 Approved Pseud";
const OTHER = 40415;

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

let moderator: string;
let plainUser: string;
let moderatorId: string;

beforeAll(async () => {
  for (const id of [LATER, OTHER]) await seedWork(db, { ao3WorkId: id });
  for (const id of [OPT_A, OPT_B, OPT_C]) {
    await seedWork(db, { ao3WorkId: id, authors: [{ pseud: PSEUD, ao3_user: null }] });
  }
  moderator = await signIn("x6-block-moderator@example.test", { acceptTerms: true });
  plainUser = await signIn("x6-block-user@example.test", { acceptTerms: true });
  await db
    .updateTable("user")
    .set({ role: "moderator" })
    .where("email", "=", "x6-block-moderator@example.test")
    .execute();
  moderatorId = (
    await db
      .selectFrom("user")
      .select("id")
      .where("email", "=", "x6-block-moderator@example.test")
      .executeTakeFirstOrThrow()
  ).id;
});
afterAll(() => db.destroy());

const fresh = (name: string) => `x6-${name}-${crypto.randomUUID().slice(0, 8)}@example.test`;

const submit = (fields: Record<string, string>, ip: string | null = freshIp()) => {
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    origin: BASE,
    "sec-fetch-site": "same-origin",
  });
  if (ip !== null) headers.set("cf-connecting-ip", ip);
  return fetchW("/remove", {
    method: "POST",
    headers,
    body: new URLSearchParams({ "cf-turnstile-response": REMOVE_TOKEN, ...fields }).toString(),
  });
};

const post = (path: string, cookie: string) =>
  fetchW(path, {
    method: "POST",
    headers: {
      origin: BASE,
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
      cookie,
    },
    body: "",
  });

const get = (path: string, cookie: string) => fetchW(path, { headers: { cookie } });

const requestOf = (email: string) =>
  db
    .selectFrom("requests")
    .selectAll()
    .where("contact_email", "=", email)
    .executeTakeFirstOrThrow();

const stateOf = async (ao3WorkId: number) =>
  (
    await db
      .selectFrom("works")
      .select("status")
      .where("ao3_work_id", "=", ao3WorkId)
      .executeTakeFirstOrThrow()
  ).status;

const blocksOf = (email: string) =>
  db
    .selectFrom("requester_blocks")
    .selectAll()
    .where(({ eb, fn }) => eb(fn("lower", ["contact_email"]), "=", email.toLowerCase()))
    .execute();

const logRows = (targetId: string) =>
  db
    .selectFrom("moderation_actions")
    .select(["moderator_id", "action", "target_kind", "target_id", "note"])
    .where("target_id", "=", targetId)
    .orderBy("created_at")
    .execute();

describe("18-moderation", () => {
  describe("Moderator blocks a requester", () => {
    it("blocks the contact email and IP hash, logs once, and stops their later requests", async () => {
      const email = fresh("blocked");
      const ip = freshIp();
      await submit({ email, work: `${BASE}/works/${OTHER}` }, ip);
      const first = await requestOf(email);

      const page = await (await get(`/admin/requests/${first.id}`, moderator)).text();
      expect(page).toContain(`/admin/requests/${first.id}/block`);

      const res = await post(`/admin/requests/${first.id}/block`, moderator);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");

      const [block, ...more] = await blocksOf(email);
      expect(more).toEqual([]);
      expect(block?.contact_email).toBe(email);
      expect(block?.ip_hash).toBe(await ipHash(env.IP_HASH_KEY, ip));
      expect(block?.created_by).toBe(moderatorId);
      expect(await logRows(first.id)).toEqual([
        {
          moderator_id: moderatorId,
          action: "block",
          target_kind: "request",
          target_id: first.id,
          note: null,
        },
      ]);

      // Their later request, from the same email, stays live after confirm.
      await submit({ email, work: `${BASE}/works/${LATER}` });
      expect((await confirmRemoval(email, 1)).status).toBe(200);
      expect(await stateOf(LATER)).toBe("live");
    });

    it("a repeat block changes and logs nothing", async () => {
      const email = fresh("repeat");
      await submit({ email, work: `${BASE}/works/${OTHER}` });
      const row = await requestOf(email);
      await post(`/admin/requests/${row.id}/block`, moderator);
      const again = await post(`/admin/requests/${row.id}/block`, moderator);
      expect(await again.text()).toContain("nothing changed");
      expect(await blocksOf(email)).toHaveLength(1);
      expect(await logRows(row.id)).toHaveLength(1);
    });

    it("a request with no address blocks the email only", async () => {
      const email = fresh("noaddress");
      await submit({ email, work: `${BASE}/works/${OTHER}` }, null);
      const row = await requestOf(email);
      expect(row.ip_hash).toBe(await ipHash(env.IP_HASH_KEY, null));
      await post(`/admin/requests/${row.id}/block`, moderator);
      const [block] = await blocksOf(email);
      expect(block?.ip_hash).toBeNull();
    });

    it("is for moderators only, and an unknown request is not found", async () => {
      const email = fresh("auth");
      await submit({ email, work: `${BASE}/works/${OTHER}` });
      const row = await requestOf(email);
      expect((await post(`/admin/requests/${row.id}/block`, plainUser)).status).toBe(404);
      expect(await blocksOf(email)).toEqual([]);
      expect((await post("/admin/requests/x6-no-such-request/block", moderator)).status).toBe(404);
    });

    it("approving a blocked requester's opt-out applies it once", async () => {
      const email = fresh("approve");
      await submit({ email, work: `${BASE}/works/${OTHER}` });
      await post(`/admin/requests/${(await requestOf(email)).id}/block`, moderator);
      expect((await submit({ email, pseud: PSEUD })).status).toBe(200);
      expect((await confirmRemoval(email, 1)).status).toBe(200);
      const row = await db
        .selectFrom("requests")
        .selectAll()
        .where("contact_email", "=", email)
        .where("kind", "=", "opt_out")
        .executeTakeFirstOrThrow();
      for (const id of [OPT_A, OPT_B, OPT_C]) expect(await stateOf(id)).toBe("live");

      const res = await post(`/admin/requests/${row.id}/approve`, moderator);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("active");
      const optouts = await db
        .selectFrom("optouts")
        .select("active")
        .where("request_id", "=", row.id)
        .execute();
      expect(optouts).toEqual([{ active: true }]);
      for (const id of [OPT_A, OPT_B, OPT_C]) expect(await stateOf(id)).toBe("hidden");
      const links = await db
        .selectFrom("request_works")
        .select("work_id")
        .where("request_id", "=", row.id)
        .execute();
      expect(links).toHaveLength(3);
      expect((await logRows(row.id)).map((r) => r.action)).toEqual(["approve"]);

      const again = await post(`/admin/requests/${row.id}/approve`, moderator);
      expect(await again.text()).toContain("decided already");
      expect(
        await db.selectFrom("optouts").select("id").where("request_id", "=", row.id).execute(),
      ).toHaveLength(1);
    });
  });
});
