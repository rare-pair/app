import { createDb } from "@archive/db";
import { seedVersion, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchW, signIn } from "./helpers";

// ACCTDEL's page case: a moderator looks at a work whose uploader's account is gone. One database
// serves every test file in the run. This file keeps to AO3 work IDs 60950 to 60959 and gives
// every account an "acctdel-" prefix. Text is synthetic.
const W = 60950;
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

let moderatorCookie: string;

beforeAll(async () => {
  const email = "acctdel-moderator@example.test";
  moderatorCookie = await signIn(email, { acceptTerms: true });
  await db.updateTable("user").set({ role: "moderator" }).where("email", "=", email).execute();
});

describe("18-moderation", () => {
  it("A version whose uploader was deleted shows Deleted account", async () => {
    // GIVEN a work with one version by an account since deleted, and one by an account that stays.
    const gone = "acctdel-gone@example.test";
    const stays = "acctdel-stays@example.test";
    await signIn(gone, { acceptTerms: true });
    await signIn(stays, { acceptTerms: true });
    const ids = await db
      .selectFrom("user")
      .select(["id", "email"])
      .where("email", "in", [gone, stays])
      .execute();
    const idOf = (email: string) => ids.find((u) => u.email === email)?.id ?? "";
    const work = await seedWork(db, { ao3WorkId: W, title: "acctdel-title", userId: idOf(gone) });
    await seedVersion(db, { ...work, userId: idOf(stays) });
    await db.deleteFrom("user").where("id", "=", idOf(gone)).execute();

    // WHEN a moderator opens the work's admin page
    const res = await fetchW(`/admin/works/${W}`, { headers: { cookie: moderatorCookie } });

    // THEN the deleted account's row says so, and only the other row offers a ban.
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Deleted account");
    expect(page).not.toContain(gone);
    expect(page).toContain(stays);
    expect(page).not.toContain(`/admin/users/${idOf(gone)}/ban`);
    expect(page).toContain(`/admin/users/${idOf(stays)}/ban`);
  });
});
