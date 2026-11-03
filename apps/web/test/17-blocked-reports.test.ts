import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ipHash } from "../src/ip-hash";
import { BASE, fetchW, signIn as signInAs } from "./helpers";

// X6 (#67): reports from an account that matches a blocked requester are stored and queued but
// do not count toward hiding. One database serves every test file in the run, so this file
// keeps to AO3 work IDs 40420 to 40429, signs in its own "x6-rep" accounts, and gives every
// session it blocks an address of its own. Text is synthetic.
const works = { email: 40420, ip: 40421, others: 40422, control: 40423, marker: 40424 } as const;

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

let moderator: string;
let moderatorId: string;
beforeAll(async () => {
  for (const [name, ao3WorkId] of Object.entries(works)) {
    await seedWork(db, { ao3WorkId, title: `x6 report ${name}` });
  }
  moderator = await signInAs("x6-rep-moderator@example.test", { acceptTerms: true });
  await db
    .updateTable("user")
    .set({ role: "moderator" })
    .where("email", "=", "x6-rep-moderator@example.test")
    .execute();
  moderatorId = (
    await db
      .selectFrom("user")
      .select("id")
      .where("email", "=", "x6-rep-moderator@example.test")
      .executeTakeFirstOrThrow()
  ).id;
});
afterAll(() => db.destroy());

const signIn = (email: string) => signInAs(email, { acceptTerms: true });

const report = (cookie: string, id: number) =>
  fetchW(`/works/${id}/report`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
      "sec-fetch-site": "same-origin",
      cookie,
    },
    body: new URLSearchParams({ reason: "other" }).toString(),
  });

const stored = async (id: number) =>
  (
    await db
      .selectFrom("works")
      .select("status")
      .where("ao3_work_id", "=", id)
      .executeTakeFirstOrThrow()
  ).status;

const block = (by: { email?: string; ip?: string }) =>
  db
    .insertInto("requester_blocks")
    .values({ contact_email: by.email ?? null, ip_hash: by.ip ?? null, created_by: moderatorId })
    .execute();

/** Gives the account's sessions the address, as the address the sign-in came from. */
const sessionsFrom = async (email: string, ip: string | null) => {
  const user = await db
    .selectFrom("user")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirstOrThrow();
  await db.updateTable("session").set({ ip_address: ip }).where("user_id", "=", user.id).execute();
};

const openReports = async (id: number, email: string) =>
  (
    await db
      .selectFrom("reports")
      .innerJoin("works", "works.id", "reports.work_id")
      .innerJoin("user", "user.id", "reports.reporter_id")
      .select("reports.status")
      .where("works.ao3_work_id", "=", id)
      .where("user.email", "=", email)
      .execute()
  ).map((r) => r.status);

const randomIp = () => `10.${crypto.getRandomValues(new Uint8Array(3)).join(".")}`;

describe("17-reports-and-dmca", () => {
  describe("Reports matching a blocked requester do not count toward hiding", () => {
    it("by the account's email: the report is stored and queued, the work stays live", async () => {
      const id = works.email;
      const [u, u2, k] = await Promise.all(
        ["u", "u2", "k"].map((n) => signIn(`x6-rep-email-${n}@example.test`)),
      );
      await block({ email: "X6-Rep-Email-K@Example.test" });
      await report(u!, id);
      await report(u2!, id);
      expect((await report(k!, id)).status).toBe(200);
      expect(await stored(id)).toBe("live");
      expect(await openReports(id, "x6-rep-email-k@example.test")).toEqual(["open"]);
      const queue = await (
        await fetchW("/admin/reports", { headers: { cookie: moderator } })
      ).text();
      expect(queue).toContain(`x6 report email`);
    });

    it("by the IP hash of one of the account's sessions", async () => {
      const id = works.ip;
      const ip = randomIp();
      const [u, u2, k] = await Promise.all(
        ["u", "u2", "k"].map((n) => signIn(`x6-rep-ip-${n}@example.test`)),
      );
      await sessionsFrom("x6-rep-ip-k@example.test", ip);
      await block({ ip: await ipHash(env.IP_HASH_KEY, ip) });
      await report(u!, id);
      await report(u2!, id);
      expect((await report(k!, id)).status).toBe(200);
      expect(await stored(id)).toBe("live");
      expect(await openReports(id, "x6-rep-ip-k@example.test")).toEqual(["open"]);
    });

    it("a blocked account's earlier report stays out of a later reporter's count", async () => {
      const id = works.others;
      const [u, k, u3, u4] = await Promise.all(
        ["u", "k", "u3", "u4"].map((n) => signIn(`x6-rep-others-${n}@example.test`)),
      );
      await block({ email: "x6-rep-others-k@example.test" });
      await report(u!, id);
      await report(k!, id);
      await report(u3!, id);
      // U, K and U3 are three accounts, but K is blocked: two count.
      expect(await stored(id)).toBe("live");
      await report(u4!, id);
      expect(await stored(id)).toBe("hidden");
    });

    it("an account no block names still counts", async () => {
      const id = works.control;
      const [u, u2, k] = await Promise.all(
        ["u", "u2", "k"].map((n) => signIn(`x6-rep-control-${n}@example.test`)),
      );
      await report(u!, id);
      await report(u2!, id);
      await report(k!, id);
      expect(await stored(id)).toBe("hidden");
    });

    it("a block on the marker for no address matches no session", async () => {
      const id = works.marker;
      const [u, u2, k] = await Promise.all(
        ["u", "u2", "k"].map((n) => signIn(`x6-rep-marker-${n}@example.test`)),
      );
      await sessionsFrom("x6-rep-marker-k@example.test", null);
      await block({ ip: await ipHash(env.IP_HASH_KEY, null) });
      await report(u!, id);
      await report(u2!, id);
      await report(k!, id);
      expect(await stored(id)).toBe("hidden");
    });
  });
});
