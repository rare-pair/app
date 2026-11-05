import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, confirmRemoval, fetchW, freshIp, REMOVE_TOKEN, withoutLogo } from "./helpers";

// X3 (#63), reworked for X3b (#487): an opt-out takes effect only once its emailed link is
// pressed, so each case posts, then confirms (`confirmRemoval`). One database serves every test file in the run, so this file keeps to AO3 work
// IDs 40100 to 40199, finds its requests by its own `example.test` contact emails, and names
// every pseud, title and tag with an "x3" marker. Everything here is synthetic.
const PSEUD = "x3 Moon Child";
const OTHER_PSEUD = "x3 Sun Child";
const W1 = 40101;
const W2 = 40102;
const W3 = 40103;
const BYSTANDER = 40104; // another pseud's work
const CO_AUTHORED = 40105; // the pseud among two authors
const PUNCT = 40106; // "x3 Moon_Child": not the same pseud
const MODERATED = 40107;
const REPORTED = 40108;
const EARLIER_REQUEST = 40109;
const REMOVED = 40110;
const SECOND = 40111; // for the second opt-out
const TWICE = 40112; // two authors that both match the pseud
const FRESH = 40120; // for the confirmation page
const RECEIVED =
  "Check your email: we've sent a link to the address you gave. Open it and press the button to confirm your request. The link works once, for 7 days, and nothing happens until you confirm.";

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

const titleOf = (id: number) => `x3zorblat${id}`;
const tagOf = (id: number) => `x3-hide-tag-${id}`;

const seed = async (
  id: number,
  pseud: string | string[],
  extra: Parameters<typeof seedWork>[1] = {},
) => {
  const w = await seedWork(db, {
    ao3WorkId: id,
    title: titleOf(id),
    authors: [pseud].flat().map((p) => ({ pseud: p, ao3_user: null })),
    tags: [{ type: "freeform", name: tagOf(id) }],
    chapters: [{ html: "<p>x3 text one</p>" }, { html: "<p>x3 text two</p>" }],
    ...extra,
  });
  await putFragments(env.BUCKET, w.fragments);
  return w;
};

beforeAll(async () => {
  for (const id of [W1, W2, W3]) await seed(id, PSEUD);
  await seed(BYSTANDER, OTHER_PSEUD);
  await seed(CO_AUTHORED, [OTHER_PSEUD, PSEUD]);
  await seed(PUNCT, "x3 Moon_Child");
  await seed(MODERATED, PSEUD, { status: "hidden", hiddenCause: "moderator" });
  await seed(REPORTED, PSEUD, { status: "hidden", hiddenCause: "reports" });
  await seed(EARLIER_REQUEST, PSEUD, { status: "hidden", hiddenCause: "removal_request" });
  await seed(REMOVED, PSEUD, { status: "removed" });
  await seed(SECOND, OTHER_PSEUD);
  await seed(TWICE, [PSEUD, "X3  moon child"]);
  await seed(FRESH, "x3 Fresh Pseud");
});
afterAll(() => db.destroy());

const fresh = (name: string) => `x3-${name}-${crypto.randomUUID().slice(0, 8)}@example.test`;

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

const optoutsOf = (requestId: string) =>
  db.selectFrom("optouts").selectAll().where("request_id", "=", requestId).execute();

const searchHas = async (id: number) => {
  const res = await fetchW(`/search?q=${titleOf(id)}`);
  expect(res.status).toBe(200);
  return (await res.text()).includes(`href="/works/${id}"`);
};

describe("16-removal-and-opt-out", () => {
  // The first test of this describe hides the pseud's works; later ones read what it left.
  let optOutId = "";

  it("Opt-out by pseud hides every existing work once confirmed", async () => {
    expect(await searchHas(W2)).toBe(true);
    expect((await fetchW(`/works/${W2}`)).status).toBe(200);

    const email = fresh("main");
    const res = await post({ email, pseud: "  X3 MOON   child ", statement: "x3" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(RECEIVED);

    const [row, ...rest] = await requestsFrom(email);
    expect(rest).toEqual([]);
    expect(row?.kind).toBe("opt_out");
    expect(row?.status).toBe("pending");
    expect(row?.pseud_norm).toBe("x3 moon child");
    optOutId = row?.id ?? "";

    // Unconfirmed: no opt-out row, no link, every work as it was.
    expect(await optoutsOf(optOutId)).toEqual([]);
    expect(await linksOf(optOutId)).toEqual([]);
    for (const id of [W1, W2, W3, CO_AUTHORED, TWICE]) {
      expect((await stateOf(id)).status, String(id)).toBe("live");
    }

    expect((await confirmRemoval(email)).status).toBe(200);

    const [optout, ...restOptouts] = await optoutsOf(optOutId);
    expect(restOptouts).toEqual([]);
    expect(optout?.pseud_norm).toBe("x3 moon child");
    expect(optout?.active).toBe(true);

    for (const id of [W1, W2, W3, CO_AUTHORED, TWICE]) {
      expect(await stateOf(id), String(id)).toMatchObject({
        status: "hidden",
        hidden_cause: "removal_request",
      });
    }
    expect((await stateOf(BYSTANDER)).status).toBe("live");
    expect((await stateOf(PUNCT)).status).toBe("live");

    const linked = (await linksOf(optOutId)).map((l) => l.work_id).sort();
    const expected = await Promise.all(
      [W1, W2, W3, CO_AUTHORED, TWICE].map(async (id) => (await stateOf(id)).id),
    );
    expect(linked).toEqual(expected.sort());
  });

  it("Opt-out hides use the removal-request wording", async () => {
    expect(optOutId).not.toBe("");
    for (const url of [`/works/${W2}`, `/works/${W2}/chapters/1`, `/works/${W2}/full`]) {
      const res = await fetchW(url);
      expect(res.status, url).toBe(451);
      expect(await res.text(), url).toContain("Temporarily hidden after a removal request");
    }
    expect(await searchHas(W2)).toBe(false);
    const tag = await fetchW(`/tags/freeform/x3%20hide%20tag%20${W2}`);
    expect(tag.status === 200 && (await tag.text()).includes(`href="/works/${W2}"`)).toBe(false);
    expect(await (await fetchW("/")).text()).not.toContain(`href="/works/${W2}"`);
    // A work by another pseud is still reachable.
    expect((await fetchW(`/works/${BYSTANDER}`)).status).toBe(200);
  });

  it("leaves works already hidden or removed as they are, with no link for this request", async () => {
    expect(optOutId).not.toBe("");
    expect(await stateOf(MODERATED)).toMatchObject({ status: "hidden", hidden_cause: "moderator" });
    expect(await stateOf(REPORTED)).toMatchObject({ status: "hidden", hidden_cause: "reports" });
    expect(await stateOf(EARLIER_REQUEST)).toMatchObject({
      status: "hidden",
      hidden_cause: "removal_request",
    });
    expect(await stateOf(REMOVED)).toMatchObject({ status: "removed", hidden_cause: null });
    const linkedIds = (await linksOf(optOutId)).map((l) => l.work_id);
    for (const id of [MODERATED, REPORTED, EARLIER_REQUEST, REMOVED]) {
      expect(linkedIds).not.toContain((await stateOf(id)).id);
    }
  });

  it("a second opt-out for the same pseud stores its own rows and hides nothing new", async () => {
    expect(optOutId).not.toBe("");
    const email = fresh("second");
    const res = await post({ email, pseud: PSEUD });
    expect(res.status).toBe(200);
    expect((await confirmRemoval(email)).status).toBe(200);
    const [row] = await requestsFrom(email);
    expect(row?.kind).toBe("opt_out");
    expect(await linksOf(row?.id ?? "")).toEqual([]);
    const [optout, ...rest] = await optoutsOf(row?.id ?? "");
    expect(rest).toEqual([]);
    expect(optout?.active).toBe(true);
    expect((await stateOf(SECOND)).status).toBe("live");
    // The first request still owns every link and its opt-out row.
    expect((await linksOf(optOutId)).length).toBe(5);
    expect((await optoutsOf(optOutId)).length).toBe(1);
  });

  describe("Confirmation page for an opt-out", () => {
    const bytesOf = async (res: Response) => {
      const nonce = res.headers.get("content-security-policy")?.match(/'nonce-([^']*)'/)?.[1];
      const html = await res.text();
      return nonce === undefined ? html : html.replaceAll(nonce, "NONCE");
    };

    it("reads the same whether or not anything was hidden, and says nothing of hiding", async () => {
      const emailA = fresh("page-a");
      const emailB = fresh("page-b");
      const hid = await post({ email: emailA, pseud: "x3 Fresh Pseud" });
      const none = await post({ email: emailB, pseud: `x3 nobody ${crypto.randomUUID()}` });
      expect(hid.status).toBe(200);
      expect((await stateOf(FRESH)).status).toBe("live");
      // The confirmed pages read the same too, whether or not the opt-out hid anything.
      const confirmedHid = await confirmRemoval(emailA);
      const confirmedNone = await confirmRemoval(emailB);
      expect((await stateOf(FRESH)).status).toBe("hidden");
      expect(confirmedHid.status).toBe(200);
      expect(await bytesOf(confirmedNone)).toBe(await bytesOf(confirmedHid));
      const hidHtml = await bytesOf(hid);
      expect(hidHtml).toContain(RECEIVED);
      expect(withoutLogo(hidHtml)).not.toMatch(/hidden|hide/i);
      expect(await bytesOf(none)).toBe(hidHtml);
    });
  });
});
