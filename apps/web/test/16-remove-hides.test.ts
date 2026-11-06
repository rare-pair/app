import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BASE,
  confirmRemoval,
  fetchW,
  freshIp,
  REMOVE_TOKEN,
  TURNSTILE,
  withoutHiddenChrome,
  withoutNonce,
} from "./helpers";

// X2 (#62), reworked for X3b (#487): a request hides only once its emailed link is pressed,
// so each case posts, then confirms (`confirmRemoval`). One database serves every test file in the run, so this file keeps to AO3 work
// IDs 40000 to 40099, finds its requests by its own `example.test` contact emails, and names
// every title and tag with an "x2" marker. Everything here is synthetic.
const HERE = 40001; // asked for by its address on this site
const AO3 = 40002; // asked for by its address at the original archive
const SAME_A = 40003; // two live works, asked for by two people, for the confirmation's bytes
const HIDDEN_BY_MODERATOR = 40004;
const REMOVED = 40005;
const CHAPTERED = 40006; // asked for by an address with a path after the id
const UNKNOWN = 40099;
const RECEIVED =
  "Check your email: we've sent a link to the address you gave. Open it and press the button to confirm your request. The link works once, for 7 days, and nothing happens until you confirm.";

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

const titleOf = (id: number) => `x2zorblat${id}`;
const tagOf = (id: number) => `x2-hide-tag-${id}`;
const tagHref = (id: number) => `/tags/freeform/x2%20hide%20tag%20${id}`;

const seed = async (id: number, extra: Parameters<typeof seedWork>[1] = {}) => {
  const w = await seedWork(db, {
    ao3WorkId: id,
    title: titleOf(id),
    tags: [{ type: "freeform", name: tagOf(id) }],
    chapters: [{ html: "<p>x2 text one</p>" }, { html: "<p>x2 text two</p>" }],
    ...extra,
  });
  await putFragments(env.BUCKET, w.fragments);
  return w;
};

beforeAll(async () => {
  for (const id of [HERE, AO3, SAME_A, CHAPTERED]) await seed(id);
  await seed(HIDDEN_BY_MODERATOR, { status: "hidden", hiddenCause: "moderator" });
  await seed(REMOVED, { status: "removed" });
});
afterAll(() => db.destroy());

const fresh = (name: string) => `x2-${name}-${crypto.randomUUID().slice(0, 8)}@example.test`;

const post = (fields: Record<string, string>) =>
  fetchW("/remove", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE,
      "sec-fetch-site": "same-origin",
      "cf-connecting-ip": freshIp(),
    },
    body: new URLSearchParams({ "cf-turnstile-response": REMOVE_TOKEN, ...fields }).toString(),
  });

const requestsFrom = (email: string) =>
  db.selectFrom("requests").selectAll().where("contact_email", "=", email).execute();

const stateOf = (ao3WorkId: number) =>
  db
    .selectFrom("works")
    .select(["id", "status", "hidden_cause"])
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirstOrThrow();

const linksOf = (requestId: string) =>
  db.selectFrom("request_works").selectAll().where("request_id", "=", requestId).execute();

const searchHas = async (id: number) => {
  const res = await fetchW(`/search?q=${titleOf(id)}`);
  expect(res.status).toBe(200);
  return (await res.text()).includes(`href="/works/${id}"`);
};
const tagListingHas = async (id: number) => {
  const res = await fetchW(tagHref(id));
  return res.status === 200 && (await res.text()).includes(`href="/works/${id}"`);
};

/** The work hidden, and gone from every way in. */
async function expectHiddenEverywhere(id: number) {
  const { status, hidden_cause } = await stateOf(id);
  expect(status).toBe("hidden");
  expect(hidden_cause).toBe("removal_request");
  for (const url of [`/works/${id}`, `/works/${id}/chapters/1`, `/works/${id}/full`]) {
    const res = await fetchW(url);
    expect(res.status, url).toBe(451);
    expect(await res.text(), url).toContain("Temporarily hidden after a removal request");
  }
  expect(await searchHas(id)).toBe(false);
  expect(await tagListingHas(id)).toBe(false);
  const home = await (await fetchW("/")).text();
  expect(home).not.toContain(`href="/works/${id}"`);
}

describe("16-removal-and-opt-out", () => {
  it("Remove request by the work's URL here hides it once confirmed", async () => {
    expect(await searchHas(HERE)).toBe(true);
    expect(await tagListingHas(HERE)).toBe(true);
    expect((await fetchW(`/works/${HERE}`)).status).toBe(200);

    const email = fresh("here");
    const res = await post({ email, work: `${BASE}/works/${HERE}`, statement: "x2" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(RECEIVED);

    // Stored and emailed, and nothing is hidden yet.
    const work = await stateOf(HERE);
    const [row, ...rest] = await requestsFrom(email);
    expect(rest).toEqual([]);
    expect(row?.kind).toBe("remove_work");
    expect(row?.status).toBe("pending");
    expect(row?.work_id).toBe(work.id);
    expect(row?.confirmed_at).toBeNull();
    expect(work.status).toBe("live");
    expect(await linksOf(row?.id ?? "")).toEqual([]);
    expect((await fetchW(`/works/${HERE}`)).status).toBe(200);
    expect(await searchHas(HERE)).toBe(true);

    const confirmed = await confirmRemoval(email);
    expect(confirmed.status).toBe(200);
    const [after] = await requestsFrom(email);
    expect(after?.confirmed_at).not.toBeNull();
    expect(await linksOf(row?.id ?? "")).toEqual([{ request_id: row?.id, work_id: work.id }]);
    await expectHiddenEverywhere(HERE);
  });

  describe("Remove request by AO3 URL hides it once confirmed", () => {
    it("hides the work asked for by its address at the original archive", async () => {
      const email = fresh("ao3");
      const res = await post({ email, work: `archiveofourown.org/works/${AO3}` });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain(RECEIVED);
      expect((await requestsFrom(email))[0]?.kind).toBe("remove_work");
      expect((await stateOf(AO3)).status).toBe("live");
      await confirmRemoval(email);
      await expectHiddenEverywhere(AO3);
    });

    it("hides it for the address with a scheme, www and a chapter path", async () => {
      const email = fresh("chaptered");
      const res = await post({
        email,
        work: `https://www.archiveofourown.org/works/${CHAPTERED}/chapters/9`,
      });
      expect(res.status).toBe(200);
      expect((await requestsFrom(email))[0]?.kind).toBe("remove_work");
      await confirmRemoval(email);
      await expectHiddenEverywhere(CHAPTERED);
    });
  });

  describe("Remove request for an AO3 work not in the archive stores nothing", () => {
    it("answers with its own page, storing and hiding nothing", async () => {
      const email = fresh("unknown");
      // Only this file's works: other files run alongside and link their own.
      const linksOfThisFile = () =>
        db
          .selectFrom("request_works")
          .innerJoin("works", "works.id", "request_works.work_id")
          .select("request_works.work_id")
          .where("works.ao3_work_id", ">=", 40000)
          .where("works.ao3_work_id", "<", 40100)
          .execute();
      const linksBefore = await linksOfThisFile();
      const res = await post({ email, work: `archiveofourown.org/works/${UNKNOWN}` });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("isn't in the archive");
      expect(html).toContain('href="/remove"');
      expect(html).not.toContain(RECEIVED);
      expect(await requestsFrom(email)).toEqual([]);
      expect(await linksOfThisFile()).toEqual(linksBefore);
      expect(withoutNonce(res.headers.get("content-security-policy"))).toBe(TURNSTILE);
    });
  });

  describe("Confirmation page for a work", () => {
    /** The page with its per-response nonce taken out, so two can be compared. */
    const bytesOf = async (res: Response) => {
      const nonce = res.headers.get("content-security-policy")?.match(/'nonce-([^']*)'/)?.[1];
      const html = await res.text();
      return nonce === undefined ? html : html.replaceAll(nonce, "NONCE");
    };

    it("reads the same for a live work, a hidden one and a removed one, and says nothing of hiding", async () => {
      const live = await post({ email: fresh("same-a"), work: `${BASE}/works/${SAME_A}` });
      const hidden = await post({
        email: fresh("same-b"),
        work: `${BASE}/works/${HIDDEN_BY_MODERATOR}`,
      });
      const removed = await post({ email: fresh("same-c"), work: `${BASE}/works/${REMOVED}` });
      for (const res of [live, hidden, removed]) expect(res.status).toBe(200);
      const liveHtml = await bytesOf(live);
      expect(liveHtml).toContain(RECEIVED);
      expect(withoutHiddenChrome(liveHtml)).not.toMatch(/hidden|hide/i);
      expect(await bytesOf(hidden)).toBe(liveHtml);
      expect(await bytesOf(removed)).toBe(liveHtml);
    });

    it("stores a request for a work already hidden or removed, and changes neither", async () => {
      const email = fresh("kept");
      await post({ email, work: `${BASE}/works/${HIDDEN_BY_MODERATOR}` });
      const emailRemoved = fresh("kept-removed");
      await post({ email: emailRemoved, work: `${BASE}/works/${REMOVED}` });
      for (const e of [email, emailRemoved]) expect((await confirmRemoval(e)).status).toBe(200);
      expect(await stateOf(HIDDEN_BY_MODERATOR)).toMatchObject({
        status: "hidden",
        hidden_cause: "moderator",
      });
      expect(await stateOf(REMOVED)).toMatchObject({ status: "removed", hidden_cause: null });
      for (const e of [email, emailRemoved]) {
        const [row, ...rest] = await requestsFrom(e);
        expect(rest).toEqual([]);
        expect(row?.kind).toBe("remove_work");
        // It hid nothing, so a reversal has nothing of its to restore.
        expect(await linksOf(row?.id ?? "")).toEqual([]);
      }
    });
  });

  it("Hidden work shows a temporary-hide page", async () => {
    // The hide made through the form, end to end: the work, a chapter and the whole work.
    const email = fresh("temporary");
    const id = 40007;
    await seed(id);
    expect((await fetchW(`/works/${id}`)).status).toBe(200);
    await post({ email, work: `${BASE}/works/${id}` });
    await confirmRemoval(email);
    await expectHiddenEverywhere(id);
  });
});
