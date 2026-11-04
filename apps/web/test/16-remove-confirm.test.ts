import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseMessage, type EmailMessage } from "../../mailer/src/message";
import app from "../src/index";
import {
  BASE,
  confirmRemoval,
  deliveredEmails,
  emailsTo,
  fetchW,
  freshIp,
  postConfirmRemoval,
  REMOVE_TOKEN,
  removalTokenFor,
  STRICT,
  withoutNonce,
} from "./helpers";

// X3b (#487): a removal request or opt-out hides only after its emailed link is confirmed.
// One database serves every test file in the run, so this file keeps to AO3 work IDs 40700
// to 40799, finds its requests by its own `example.test` contact emails, and names every
// pseud "x3b". Everything here is synthetic.
const LIVE = 40701;
const HIDDEN = 40702; // hidden by a moderator already
const REMOVED = 40703;
const EXPIRES = 40704;
const REJECTED = 40705;
const ONCE = 40706;
const RACE = 40707;
const SCANNED = 40708;
const FAILS = 40709;
const OPT_LIVE = 40710; // by the pseud the opt-out cases use
const OPT_BY_ANOTHER = 40711;
const MOD_LIVE = 40712;
const SAME_LIVE = 40713;
const OPT_FAILS = 40714; // by the pseud the failing opt-out names
// 40750 is 18-moderation-detail.test.ts's, 40799 is held by no work.
const PSEUD = "x3b Opted Pseud";

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

beforeAll(async () => {
  for (const id of [LIVE, EXPIRES, REJECTED, ONCE, RACE, SCANNED, FAILS, MOD_LIVE, SAME_LIVE]) {
    await seedWork(db, { ao3WorkId: id });
  }
  await seedWork(db, { ao3WorkId: HIDDEN, status: "hidden", hiddenCause: "moderator" });
  await seedWork(db, { ao3WorkId: REMOVED, status: "removed" });
  await seedWork(db, { ao3WorkId: OPT_LIVE, authors: [{ pseud: PSEUD, ao3_user: null }] });
  await seedWork(db, {
    ao3WorkId: OPT_FAILS,
    authors: [{ pseud: "x3b Failing Pseud", ao3_user: null }],
  });
  await seedWork(db, {
    ao3WorkId: OPT_BY_ANOTHER,
    authors: [{ pseud: "x3b Someone Else", ao3_user: null }],
  });
});
afterAll(() => db.destroy());

const fresh = (name: string) => `x3b-${name}-${crypto.randomUUID().slice(0, 8)}@example.test`;

const submit = (fields: Record<string, string>, bindings: Partial<Cloudflare.Env> = {}) =>
  runLogged(
    new Request(`${BASE}/remove`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE,
        "sec-fetch-site": "same-origin",
        "cf-connecting-ip": freshIp(),
      },
      body: new URLSearchParams({ "cf-turnstile-response": REMOVE_TOKEN, ...fields }).toString(),
    }),
    bindings,
  );

/** The app run on `bindings` over the test env, with every console line captured. */
async function runLogged(request: Request, bindings: Partial<Cloudflare.Env> = {}) {
  const logged: string[] = [];
  const spies = (["error", "warn", "log", "info", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args) => {
      logged.push(args.map((arg) => inspect(arg, { depth: Infinity })).join(" "));
    }),
  );
  try {
    const ctx = createExecutionContext();
    const res = await app.fetch(request, { ...env, ...bindings }, ctx);
    await waitOnExecutionContext(ctx);
    return { res, logged };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

const requestsFrom = (email: string) =>
  db.selectFrom("requests").selectAll().where("contact_email", "=", email).execute();

const stateOf = async (ao3WorkId: number) =>
  (
    await db
      .selectFrom("works")
      .select(["id", "status", "hidden_cause"])
      .where("ao3_work_id", "=", ao3WorkId)
      .executeTakeFirstOrThrow()
  ).status;

const linksOf = (requestId: string) =>
  db.selectFrom("request_works").selectAll().where("request_id", "=", requestId).execute();

const optoutsOf = (requestId: string) =>
  db.selectFrom("optouts").selectAll().where("request_id", "=", requestId).execute();

/** The page with its per-response nonce taken out, so two can be compared. */
const bytesOf = async (res: Response) => {
  const nonce = res.headers.get("content-security-policy")?.match(/'nonce-([^']*)'/)?.[1];
  const html = await res.text();
  return nonce === undefined ? html : html.replaceAll(nonce, "NONCE");
};

/** Submits a request for the work and returns its address and token. */
async function requestFor(name: string, ao3WorkId: number) {
  const email = fresh(name);
  const { res } = await submit({ email, work: `${BASE}/works/${ao3WorkId}` });
  expect(res.status).toBe(200);
  return { email, token: await removalTokenFor(email) };
}

/** How many removal emails have gone to the address. */
const emailCount = async (email: string) =>
  (await deliveredEmails())
    .map(parseMessage)
    .filter((m) => m?.to === email && m.kind === "removal-confirm").length;

describe("16-removal-and-opt-out", () => {
  describe("Removal request sends one confirmation email and hides nothing", () => {
    it("for a work: stores it unconfirmed, queues one email linking to /remove/confirm", async () => {
      const email = fresh("work");
      const { res } = await submit({ email, work: `${BASE}/works/${LIVE}`, statement: "x3b" });
      expect(res.status).toBe(200);

      const [row, ...rest] = await requestsFrom(email);
      expect(rest).toEqual([]);
      expect(row?.confirmed_at).toBeNull();
      expect(row?.confirm_token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.confirm_sent_at).toBeInstanceOf(Date);
      expect(await stateOf(LIVE)).toBe("live");
      expect(await linksOf(row?.id ?? "")).toEqual([]);

      const sent = await emailsTo(email);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.kind).toBe("removal-confirm");
      const link = new URL(sent[0]?.url ?? "");
      expect(link.origin + link.pathname).toBe(`${BASE}/remove/confirm`);
      // The token is the link's only query, and only its hash is stored.
      const token = link.searchParams.get("token") ?? "";
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(row?.confirm_token_hash).not.toContain(token);
    });

    it("for a pseud: stores it unconfirmed, with no opt-out row, and queues one email", async () => {
      const email = fresh("pseud");
      const { res } = await submit({ email, pseud: PSEUD });
      expect(res.status).toBe(200);
      const [row, ...rest] = await requestsFrom(email);
      expect(rest).toEqual([]);
      expect(row?.kind).toBe("opt_out");
      expect(row?.confirmed_at).toBeNull();
      expect(await optoutsOf(row?.id ?? "")).toEqual([]);
      expect(await linksOf(row?.id ?? "")).toEqual([]);
      expect(await stateOf(OPT_LIVE)).toBe("live");
      expect(await emailsTo(email)).toHaveLength(1);
    });

    it("the email names neither the work nor the statement", async () => {
      const email = fresh("private");
      await submit({ email, work: `${BASE}/works/${LIVE}`, statement: "x3b secret statement" });
      const text = JSON.stringify(await emailsTo(email));
      expect(text).not.toContain(String(LIVE));
      expect(text).not.toContain("secret statement");
    });

    it("a request for a work the archive doesn't hold sends nothing", async () => {
      const email = fresh("unknown");
      const { res } = await submit({ email, work: `${BASE}/works/40799` });
      expect(await res.text()).toContain("isn't in the archive");
      expect(await requestsFrom(email)).toEqual([]);
      expect(await emailCount(email)).toBe(0);
    });

    it("an email that can't be queued stores nothing, shows a try-again page and logs no address", async () => {
      const email = fresh("unqueued");
      let tried = 0;
      const queue: Queue<EmailMessage> = {
        send: async (message) => {
          tried += 1;
          throw new Error(`queue refused the email to ${message.to} with ${message.url}`);
        },
        sendBatch: async () => {
          throw new Error("queue refused the batch");
        },
        metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
      };
      const { res, logged } = await submit(
        { email, work: `${BASE}/works/${FAILS}` },
        { EMAIL: queue },
      );
      expect(tried).toBe(1);
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain(email);
      expect(await requestsFrom(email)).toEqual([]);
      expect(await stateOf(FAILS)).toBe("live");
      expect(logged.length).toBeGreaterThan(0);
      const text = logged.join("\n");
      expect(text).not.toContain(email);
      expect(text).not.toMatch(/https?:\/\//);
    });
  });

  it("an opt-out whose email can't be queued stores nothing and activates nothing", async () => {
    const email = fresh("opt-unqueued");
    const queue: Queue<EmailMessage> = {
      send: async () => {
        throw new Error("queue refused");
      },
      sendBatch: async () => {
        throw new Error("queue refused the batch");
      },
      metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
    };
    const { res } = await submit({ email, pseud: "x3b Failing Pseud" }, { EMAIL: queue });
    expect(res.status).toBe(503);
    expect(await requestsFrom(email)).toEqual([]);
    expect(await stateOf(OPT_FAILS)).toBe("live");
  });

  describe("Confirmation link opens a page with a button and changes nothing", () => {
    it("a scanner's GET of the link shows the button and leaves the request unconfirmed", async () => {
      const { email, token } = await requestFor("scanned", SCANNED);
      const res = await fetchW(`/remove/confirm?token=${token}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(STRICT);
      const html = await res.text();
      expect(html).toMatch(/<form[^>]*method="post"[^>]*action="\/remove\/confirm"/);
      expect(html).toContain(`name="token" value="${token}"`);
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toContain(String(SCANNED));
      const [row] = await requestsFrom(email);
      expect(row?.confirmed_at).toBeNull();
      expect(await stateOf(SCANNED)).toBe("live");
    });

    it("a link with no token, or one never issued, gets the refused page without a lookup", async () => {
      for (const url of [
        "/remove/confirm",
        "/remove/confirm?token=short",
        `/remove/confirm?token=${"a".repeat(44)}`,
      ]) {
        const res = await fetchW(url);
        expect(res.status, url).toBe(400);
        expect(await res.text(), url).toContain("already been used or has expired");
      }
    });
  });

  describe("Confirming a removal request hides the work", () => {
    it("hides it and writes the request_works row, in the confirm and not before", async () => {
      const { email, token } = await requestFor("confirm", LIVE);
      expect(await stateOf(LIVE)).toBe("live");
      const res = await postConfirmRemoval(token);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin");
      expect(res.headers.get("set-cookie")).toBeNull();
      // A refused press is kept out of caches the same way.
      const refused = await postConfirmRemoval(token);
      expect(refused.status).toBe(400);
      expect(refused.headers.get("cache-control")).toBe("no-store");
      expect(refused.headers.get("referrer-policy")).toBe("strict-origin");
      const [row] = await requestsFrom(email);
      expect(row?.confirmed_at).toBeInstanceOf(Date);
      // The hash is cleared, so the link works once.
      expect(row?.confirm_token_hash).toBeNull();
      const work = await db
        .selectFrom("works")
        .select(["id", "status", "hidden_cause"])
        .where("ao3_work_id", "=", LIVE)
        .executeTakeFirstOrThrow();
      expect(work).toMatchObject({ status: "hidden", hidden_cause: "removal_request" });
      expect(await linksOf(row?.id ?? "")).toEqual([{ request_id: row?.id, work_id: work.id }]);
      expect((await fetchW(`/works/${LIVE}`)).status).toBe(451);
    });
  });

  describe("Confirming an opt-out activates it", () => {
    it("adds the active opt-out, hides every live work by the pseud and writes the links", async () => {
      const email = fresh("optout");
      await submit({ email, pseud: `  X3B opted   PSEUD ` });
      const [row] = await requestsFrom(email);
      expect(await optoutsOf(row?.id ?? "")).toEqual([]);
      expect((await confirmRemoval(email)).status).toBe(200);

      const [optout, ...rest] = await optoutsOf(row?.id ?? "");
      expect(rest).toEqual([]);
      expect(optout).toMatchObject({ pseud_norm: "x3b opted pseud", active: true });
      expect(await stateOf(OPT_LIVE)).toBe("hidden");
      expect(await stateOf(OPT_BY_ANOTHER)).toBe("live");
      const work = await db
        .selectFrom("works")
        .select("id")
        .where("ao3_work_id", "=", OPT_LIVE)
        .executeTakeFirstOrThrow();
      expect(await linksOf(row?.id ?? "")).toEqual([{ request_id: row?.id, work_id: work.id }]);
    });
  });

  describe("A link works once and expires", () => {
    it("a second press of the same link is refused and writes nothing more", async () => {
      const { email, token } = await requestFor("once", ONCE);
      expect((await postConfirmRemoval(token)).status).toBe(200);
      const [row] = await requestsFrom(email);
      const confirmedAt = row?.confirmed_at;
      const again = await postConfirmRemoval(token);
      expect(again.status).toBe(400);
      expect(await again.text()).toContain("already been used or has expired");
      const [after] = await requestsFrom(email);
      expect(after?.confirmed_at).toEqual(confirmedAt);
      expect(await linksOf(row?.id ?? "")).toHaveLength(1);
    });

    it("a link older than 7 days is refused and the work stays live", async () => {
      const { email, token } = await requestFor("expired", EXPIRES);
      await db
        .updateTable("requests")
        .set({ confirm_sent_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
        .where("contact_email", "=", email)
        .execute();
      const res = await postConfirmRemoval(token);
      expect(res.status).toBe(400);
      expect(await stateOf(EXPIRES)).toBe("live");
      expect((await requestsFrom(email))[0]?.confirmed_at).toBeNull();
    });

    it("a well-formed token that was never issued is refused and changes nothing", async () => {
      const before = await db.selectFrom("request_works").select("request_id").execute();
      const res = await postConfirmRemoval("A".repeat(43));
      expect(res.status).toBe(400);
      expect(await db.selectFrom("request_works").select("request_id").execute()).toEqual(before);
    });

    it("a token of the wrong shape is refused", async () => {
      for (const token of ["", "short", "a".repeat(44), `${"a".repeat(42)}!`]) {
        expect((await postConfirmRemoval(token)).status, token).toBe(400);
      }
    });

    it("a request a moderator rejected can no longer be confirmed", async () => {
      const { email, token } = await requestFor("rejected", REJECTED);
      await db
        .updateTable("requests")
        .set({ status: "rejected" })
        .where("contact_email", "=", email)
        .execute();
      expect((await postConfirmRemoval(token)).status).toBe(400);
      expect(await stateOf(REJECTED)).toBe("live");
      expect((await requestsFrom(email))[0]?.confirmed_at).toBeNull();
    });

    it("two presses at once confirm it once", async () => {
      const { email, token } = await requestFor("race", RACE);
      const answers = await Promise.all([postConfirmRemoval(token), postConfirmRemoval(token)]);
      expect(answers.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 400]);
      const [row] = await requestsFrom(email);
      expect(await linksOf(row?.id ?? "")).toHaveLength(1);
      expect(await stateOf(RACE)).toBe("hidden");
    });

    it("a press from another site is refused and confirms nothing", async () => {
      const email = fresh("cross");
      const { res } = await submit({ email, work: `${BASE}/works/${MOD_LIVE}` });
      expect(res.status).toBe(200);
      const token = await removalTokenFor(email);
      const cross = await fetchW("/remove/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
        body: new URLSearchParams({ token }).toString(),
      });
      expect(cross.status).toBe(403);
      expect((await requestsFrom(email))[0]?.confirmed_at).toBeNull();
      expect(await stateOf(MOD_LIVE)).toBe("live");
    });
  });

  describe("The submit and the confirm answers are the same whatever the work's status", () => {
    it("reads the same for a live, a hidden and a removed work, at submit and at confirm", async () => {
      // Its own live work: LIVE is hidden by an earlier case of this file.
      const ids = [SAME_LIVE, HIDDEN, REMOVED];
      expect(await stateOf(SAME_LIVE)).toBe("live");
      const submitted: string[] = [];
      const confirmed: string[] = [];
      const links: string[] = [];
      for (const id of ids) {
        const email = fresh(`same-${id}`);
        const { res } = await submit({ email, work: `${BASE}/works/${id}` });
        expect(res.status).toBe(200);
        submitted.push(await bytesOf(res));
        const sent = await emailsTo(email);
        expect(sent).toHaveLength(1);
        // The email carries nothing of the work: only its token differs between requests.
        links.push(JSON.stringify({ ...sent[0], to: "", url: "" }));
        const done = await confirmRemoval(email);
        expect(done.status).toBe(200);
        confirmed.push(await bytesOf(done));
      }
      expect(submitted[1]).toBe(submitted[0]);
      expect(submitted[2]).toBe(submitted[0]);
      expect(confirmed[1]).toBe(confirmed[0]);
      expect(confirmed[2]).toBe(confirmed[0]);
      expect(confirmed[0]).not.toMatch(/hidden|hide/i);
      expect(links[1]).toBe(links[0]);
      expect(links[2]).toBe(links[0]);
    });
  });
});
