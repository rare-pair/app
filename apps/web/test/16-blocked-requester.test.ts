import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ipHash } from "../src/ip-hash";
import {
  BASE,
  confirmRemoval,
  emailsTo,
  fetchW,
  freshIp,
  REMOVE_TOKEN,
  removalTokenFor,
  signIn,
  withoutNonce,
} from "./helpers";

// X6 (#67): a blocked requester's removal requests and opt-outs are stored and queued but hide
// nothing, and look the same to them. One database serves every test file in the run, so this
// file keeps to AO3 work IDs 40400 to 40409, finds its requests by its own `example.test`
// contact emails, and names every pseud "x6". Everything here is synthetic.
const BY_EMAIL = 40401;
const BY_IP = 40402;
const OPT_A = 40403; // the three works of one pseud
const OPT_B = 40404;
const OPT_C = 40405;
const PAIR_BLOCKED = 40406; // the same request, blocked and not
const PAIR_FREE = 40407;
const MARKER = 40408;
const PSEUD = "x6 Blocked Pseud";
const PSEUD_FREE = "x6 Parity Free Pseud";
const PSEUD_BLOCKED = "x6 Parity Blocked Pseud";

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

let moderatorId: string;
let moderatorCookie: string;
beforeAll(async () => {
  for (const id of [BY_EMAIL, BY_IP, PAIR_BLOCKED, PAIR_FREE, MARKER]) {
    await seedWork(db, { ao3WorkId: id });
  }
  for (const id of [OPT_A, OPT_B, OPT_C]) {
    await seedWork(db, { ao3WorkId: id, authors: [{ pseud: PSEUD, ao3_user: null }] });
  }
  await seedWork(db, {
    ao3WorkId: 40409,
    authors: [{ pseud: PSEUD_BLOCKED, ao3_user: null }],
  });
  await seedWork(db, { ao3WorkId: 40400, authors: [{ pseud: PSEUD_FREE, ao3_user: null }] });
  moderatorCookie = await signIn("x6-moderator@example.test", { acceptTerms: true });
  await db
    .updateTable("user")
    .set({ role: "moderator" })
    .where("email", "=", "x6-moderator@example.test")
    .execute();
  moderatorId = (
    await db
      .selectFrom("user")
      .select("id")
      .where("email", "=", "x6-moderator@example.test")
      .executeTakeFirstOrThrow()
  ).id;
});
afterAll(() => db.destroy());

const fresh = (name: string) => `x6-${name}-${crypto.randomUUID().slice(0, 8)}@example.test`;

const block = (by: { email?: string; ip?: string }) =>
  db
    .insertInto("requester_blocks")
    .values({
      contact_email: by.email ?? null,
      ip_hash: by.ip ?? null,
      created_by: moderatorId,
    })
    .execute();

const submit = (fields: Record<string, string>, ip: string | null = freshIp()) => {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    origin: BASE,
    "sec-fetch-site": "same-origin",
  };
  if (ip !== null) headers["cf-connecting-ip"] = ip;
  return fetchW("/remove", {
    method: "POST",
    headers,
    body: new URLSearchParams({ "cf-turnstile-response": REMOVE_TOKEN, ...fields }).toString(),
  });
};

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

const linksOf = (requestId: string) =>
  db.selectFrom("request_works").selectAll().where("request_id", "=", requestId).execute();

const optoutsOf = (requestId: string) =>
  db.selectFrom("optouts").selectAll().where("request_id", "=", requestId).execute();

/** What the moderators' queue of requests shows, as text. */
async function queue() {
  const res = await fetchW("/admin/requests", { headers: { cookie: moderatorCookie } });
  expect(res.status).toBe(200);
  return res.text();
}

describe("16-removal-and-opt-out", () => {
  describe("Blocked requester's requests only queue", () => {
    it("by contact email, in any case", async () => {
      const email = fresh("email");
      await block({ email: email.toUpperCase() });
      expect((await submit({ email, work: `${BASE}/works/${BY_EMAIL}` })).status).toBe(200);
      expect((await confirmRemoval(email)).status).toBe(200);

      const row = await requestOf(email);
      expect(row.status).toBe("pending");
      expect(row.confirmed_at).toBeInstanceOf(Date);
      expect(row.confirm_token_hash).toBeNull();
      expect(await linksOf(row.id)).toEqual([]);
      expect(await stateOf(BY_EMAIL)).toBe("live");
      expect(await queue()).toContain(row.id);
    });

    it("by IP hash, with another email", async () => {
      const ip = freshIp();
      await block({ ip: await ipHash(env.IP_HASH_KEY, ip) });
      const email = fresh("ip");
      expect((await submit({ email, work: `${BASE}/works/${BY_IP}` }, ip)).status).toBe(200);
      expect((await confirmRemoval(email)).status).toBe(200);

      const row = await requestOf(email);
      expect(row.status).toBe("pending");
      expect(await linksOf(row.id)).toEqual([]);
      expect(await stateOf(BY_IP)).toBe("live");
      expect(await queue()).toContain(row.id);
    });

    it("a block never matches the marker for a request with no address", async () => {
      await block({ ip: await ipHash(env.IP_HASH_KEY, null) });
      const email = fresh("marker");
      expect((await submit({ email, work: `${BASE}/works/${MARKER}` }, null)).status).toBe(200);
      expect((await requestOf(email)).ip_hash).toBe(await ipHash(env.IP_HASH_KEY, null));
      expect((await confirmRemoval(email)).status).toBe(200);
      expect(await stateOf(MARKER)).toBe("hidden");
    });
  });

  describe("Blocked requester's opt-out hides nothing", () => {
    it("stores the request, writes no opt-out and hides no work of the pseud", async () => {
      const email = fresh("optout");
      await block({ email });
      expect((await submit({ email, pseud: PSEUD })).status).toBe(200);
      expect((await confirmRemoval(email)).status).toBe(200);

      const row = await requestOf(email);
      expect(row.kind).toBe("opt_out");
      expect(row.status).toBe("pending");
      expect(await optoutsOf(row.id)).toEqual([]);
      expect(await linksOf(row.id)).toEqual([]);
      for (const id of [OPT_A, OPT_B, OPT_C]) expect(await stateOf(id)).toBe("live");
    });
  });

  describe("Blocked requester sees the same confirmation", () => {
    /** Every page a requester sees for one request, as text with the nonce taken out. */
    async function pagesOf(email: string, fields: Record<string, string>) {
      const sent = await submit({ email, ...fields }, freshIp());
      const token = await removalTokenFor(email);
      const opened = await fetchW(`/remove/confirm?token=${token}`);
      const pressed = await confirmRemoval(email);
      const seen = async (res: Response) => ({
        status: res.status,
        headers: [...res.headers]
          .map(([k, v]) => `${k}: ${k === "content-security-policy" ? withoutNonce(v) : v}`)
          .filter((line) => !line.startsWith("set-cookie") && !line.startsWith("date"))
          .sort(),
        body: withoutNonce(await res.text()).replace(/value="[A-Za-z0-9_-]{43}"/g, 'value="TOKEN"'),
      });
      return [await seen(sent), await seen(opened), await seen(pressed)];
    }

    for (const [kind, free, blocked] of [
      ["a work", { work: `${BASE}/works/${PAIR_FREE}` }, { work: `${BASE}/works/${PAIR_BLOCKED}` }],
      ["a pseud", { pseud: PSEUD_FREE }, { pseud: PSEUD_BLOCKED }],
    ] as const) {
      it(`for ${kind}: the pages are the same as for anyone`, async () => {
        const freeEmail = fresh("same-free");
        const blockedEmail = fresh("same-blocked");
        await block({ email: blockedEmail });
        const unblockedPages = await pagesOf(freeEmail, free);
        const blockedPages = await pagesOf(blockedEmail, blocked);
        expect(blockedPages).toEqual(unblockedPages);
        expect(blockedPages[0]?.body).toContain("Check your email");
        expect(
          blockedPages
            .map((p) => p.body)
            .join()
            .toLowerCase(),
        ).not.toContain("block");
        // The confirmation email is still queued.
        expect(await emailsTo(blockedEmail)).toHaveLength(1);
      });
    }
  });
});
