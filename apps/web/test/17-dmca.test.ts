import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BASE,
  consoleDuring,
  DMCA_IP_LIMIT,
  DMCA_TOKEN,
  fetchW,
  freshIp,
  nonceOf,
  signIn as signInAs,
  LOGIN_TOKEN,
  TURNSTILE,
  windowHeadroom,
  withoutNonce,
} from "./helpers";

// One database serves every test file in the run, so this file keeps to AO3 work IDs
// 17800 to 17899, names every tag it seeds with an "x8-" prefix, and finds its notices by
// its own work or marker. Text is synthetic; addresses are @example.test.
const W = 17800;
const HIDDEN = 17801;
const REMOVED = 17802;
/** No work has it. */
const UNKNOWN = 17899;
/** One work for each notice that leaves out an element, so each finds its own row. */
const OMISSION_BASE = 17810;

const X8_TAGS = [
  { type: "rating", name: "x8-General Audiences" },
  { type: "fandom", name: "x8-Fandom" },
] as const;

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

/** Each element of a notice (17 U.S.C. 512(c)(3)(A)), as the form names it. */
const COMPLETE = {
  work: String(W),
  copyrighted_work: "x8 My original story, first published in 2020",
  infringing_material: "x8 The whole text of the work named above",
  contact: "x8 Pat Example, pat@example.test, 1 Example Road",
  good_faith: "yes",
  accuracy_authority: "yes",
  signature: "x8 Pat Example",
};

const OMISSIONS = [
  "copyrighted_work",
  "infringing_material",
  "contact",
  "good_faith",
  "accuracy_authority",
  "signature",
] as const;

let moderator: string;

beforeAll(async () => {
  await seedWork(db, { ao3WorkId: W, title: "x8 Work W", tags: [...X8_TAGS] });
  await seedWork(db, {
    ao3WorkId: HIDDEN,
    status: "hidden",
    hiddenCause: "moderator",
    tags: [...X8_TAGS],
  });
  await seedWork(db, { ao3WorkId: REMOVED, status: "removed", tags: [...X8_TAGS] });
  for (const [i] of OMISSIONS.entries()) {
    await seedWork(db, {
      ao3WorkId: OMISSION_BASE + i,
      title: `x8 Omission ${i}`,
      tags: [...X8_TAGS],
    });
  }
  const email = "x8-moderator@example.test";
  moderator = await signInAs(email, { acceptTerms: true });
  await db.updateTable("user").set({ role: "moderator" }).where("email", "=", email).execute();
});
afterAll(() => db.destroy());

/** The headers a browser on rarepair.fans sends with the notice form. */
const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  origin: BASE,
  "sec-fetch-site": "same-origin",
};

/** Submits the notice form from a fresh address, as a browser on rarepair.fans does. */
const postNotice = (
  fields: Record<string, string>,
  { headers = {}, ip = freshIp() }: { headers?: Record<string, string>; ip?: string } = {},
) =>
  fetchW("/dmca", {
    method: "POST",
    headers: { ...FORM_HEADERS, "cf-connecting-ip": ip, ...headers },
    body: new URLSearchParams({ "cf-turnstile-response": DMCA_TOKEN, ...fields }).toString(),
  });

/** The notices stored for AO3 work `ao3WorkId`, oldest first. */
const noticesFor = (ao3WorkId: number) =>
  db
    .selectFrom("takedowns")
    .innerJoin("works", "works.id", "takedowns.work_id")
    .select([
      "takedowns.requester",
      "takedowns.basis",
      "takedowns.status",
      "takedowns.signature",
      "takedowns.infringing_material",
      "takedowns.good_faith",
      "takedowns.accuracy_authority",
      "takedowns.incomplete",
      "works.status as work_status",
    ])
    .where("works.ao3_work_id", "=", ao3WorkId)
    .orderBy("takedowns.created_at")
    .execute();

/** The notices whose contact is `contact`, from anyone. */
const noticesFrom = (contact: string) =>
  db.selectFrom("takedowns").selectAll().where("requester", "=", contact).execute();

/** The text of the moderators' queue row for work `ao3WorkId`, or undefined. */
const queueRow = async (ao3WorkId: number) => {
  const res = await fetchW("/admin/takedowns", { headers: { cookie: moderator } });
  expect(res.status).toBe(200);
  const html = await res.text();
  return html.split("<tr>").find((row) => row.includes(`(${ao3WorkId})</td>`));
};

describe("17-reports-and-dmca: DMCA", () => {
  it("DMCA form is public", async () => {
    const res = await fetchW("/dmca");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The anti-spam check's frame is allowed, and nothing else.
    const csp = res.headers.get("content-security-policy");
    const nonce = nonceOf(csp);
    expect(nonce).not.toBeNull();
    expect(withoutNonce(csp)).toBe(TURNSTILE);
    const html = await res.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toHaveLength(2);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
    expect(html).toContain(
      `<script nonce="${nonce}">document.getElementById("dmca").hidden = false;</script>`,
    );
    expect(html).toContain(
      '<form id="dmca" class="dmca-form" method="post" action="/dmca" hidden>',
    );
    expect(html).toContain('<div class="cf-turnstile"');
    expect(html).toContain('data-action="dmca"');
    expect(html).toContain("<noscript>");
    for (const name of [...OMISSIONS, "work"]) {
      expect(html, name).toMatch(new RegExp(`name="${name}"`));
    }
    expect(html).toContain('<input type="checkbox" name="good_faith"');
  });

  it("A notice without a passing anti-spam check is not stored, and the form says why", async () => {
    const wrongHost = `${DMCA_TOKEN}@other.example`;
    for (const token of ["", LOGIN_TOKEN, wrongHost]) {
      const marker = `x8-nocheck-${crypto.randomUUID()}`;
      const res = await postNotice({
        ...COMPLETE,
        contact: marker,
        "cf-turnstile-response": token,
      });
      expect(res.status, token).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain("The anti-spam check did not pass.");
      // Everything typed comes back, with a fresh widget.
      expect(html).toContain(marker);
      expect(html).toContain("x8 The whole text of the work named above");
      expect(html).toMatch(/name="good_faith" value="yes" checked/);
      expect(html).toMatch(/name="accuracy_authority" value="yes" checked/);
      expect(html).toContain('class="cf-turnstile"');
      expect(await noticesFrom(marker)).toEqual([]);
    }
  });

  it("A notice posted with no token field at all is refused the same way", async () => {
    const marker = `x8-notoken-${crypto.randomUUID()}`;
    const res = await fetchW("/dmca", {
      method: "POST",
      headers: { ...FORM_HEADERS, "cf-connecting-ip": freshIp() },
      body: new URLSearchParams({ ...COMPLETE, contact: marker }).toString(),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(marker);
    expect(await noticesFrom(marker)).toEqual([]);
  });

  it("A long notice survives an anti-spam check that fails", async () => {
    const long = `x8 ${"a".repeat(3990)}`;
    const res = await postNotice({
      ...COMPLETE,
      copyrighted_work: long,
      infringing_material: long,
      contact: long,
      "cf-turnstile-response": "",
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html.split(long).length - 1).toBe(3);
  });

  it("A notice is kept in the form when the anti-spam check is not answering", async () => {
    const marker = `x8-down-${crypto.randomUUID()}`;
    const res = await postNotice({
      ...COMPLETE,
      contact: marker,
      "cf-turnstile-response": "siteverify-down",
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("The anti-spam check is not answering just now.");
    expect(html).toContain(marker);
    expect(html).toContain('class="cf-turnstile"');
    expect(await noticesFrom(marker)).toEqual([]);
  });

  it("A refusal after the check passes still shows a fresh widget", async () => {
    const res = await postNotice({ ...COMPLETE, work: String(UNKNOWN) });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('class="cf-turnstile"');
    const bad = await postNotice({ ...COMPLETE, work: "" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('class="cf-turnstile"');
  });

  it("The limit is counted before the anti-spam check", async () => {
    await windowHeadroom(60);
    const ip = freshIp();
    for (let i = 0; i < DMCA_IP_LIMIT; i++) {
      // Each counts, solved or not; none of these is stored.
      expect((await postNotice({ ...COMPLETE, work: String(UNKNOWN) }, { ip })).status).toBe(404);
    }
    const res = await postNotice({ ...COMPLETE, "cf-turnstile-response": "" }, { ip });
    expect(res.status).toBe(429);
  });

  it("The page without JavaScript names the notices address and what a notice needs", async () => {
    const html = await (await fetchW("/dmca")).text();
    const noscript = html.match(/<noscript>[\s\S]*?<\/noscript>/)?.[0] ?? "";
    expect(noscript).toMatch(/^<noscript><p>[^<]*needs JavaScript[^<]*<\/p><\/noscript>$/);
    expect(env.NOTICES_EMAIL).not.toBe("");
    expect(noscript).toContain(env.NOTICES_EMAIL);
    expect(noscript).toContain("not authorised by the copyright owner, its agent or the law");
    expect(noscript).toContain("under penalty of perjury");
    expect(noscript).toContain("as your signature");
    expect(noscript).toContain("online queue");
    // Nothing can be submitted without the script that shows the form.
    expect(html).toMatch(/<form\b[^>]*\bhidden\b/);
  });

  it("Submitting a DMCA notice creates a takedown", async () => {
    const res = await postNotice(COMPLETE);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("Notice received");

    expect(await noticesFor(W)).toEqual([
      {
        requester: COMPLETE.contact,
        basis: COMPLETE.copyrighted_work,
        status: "pending",
        signature: COMPLETE.signature,
        infringing_material: COMPLETE.infringing_material,
        good_faith: true,
        accuracy_authority: true,
        incomplete: false,
        // Unlike /remove, a notice leaves the work live until a moderator decides.
        work_status: "live",
      },
    ]);
    expect((await fetchW(`/works/${W}`)).status).toBe(200);
    const row = await queueRow(W);
    expect(row).toContain(COMPLETE.contact);
    expect(row).toContain(COMPLETE.copyrighted_work);
    expect(row).not.toContain("Incomplete");
  });

  describe("Incomplete DMCA notice is noted in the queue", () => {
    for (const [i, omitted] of OMISSIONS.entries()) {
      it(`leaves out ${omitted}`, async () => {
        const id = OMISSION_BASE + i;
        const { [omitted]: _omitted, ...fields } = { ...COMPLETE, work: String(id) };

        expect((await postNotice(fields)).status).toBe(200);

        const [notice, ...rest] = await noticesFor(id);
        expect(rest).toEqual([]);
        expect(notice).toMatchObject({ status: "pending", incomplete: true, work_status: "live" });
        expect((await fetchW(`/works/${id}`)).status).toBe(200);
        expect(await queueRow(id)).toContain("Incomplete");
      });
    }

    it("counts a field of only spaces as missing", async () => {
      const id = OMISSION_BASE;
      await postNotice({ ...COMPLETE, work: String(id), contact: " \r\n\t " });
      const notices = await noticesFor(id);
      expect(notices.at(-1)).toMatchObject({ requester: "", incomplete: true });
    });
  });

  it("Names the work by its ID, its address here or its address on the original archive", async () => {
    const id = OMISSION_BASE + 1;
    const before = (await noticesFor(id)).length;
    for (const work of [
      `${id}`,
      ` https://rarepair.fans/works/${id} `,
      `https://archiveofourown.org/works/${id}/chapters/1?view_adult=true`,
    ]) {
      expect((await postNotice({ ...COMPLETE, work })).status, work).toBe(200);
    }
    expect(await noticesFor(id)).toHaveLength(before + 3);
  });

  it("Accepts a notice on a hidden or removed work, and changes neither", async () => {
    for (const [id, status] of [
      [HIDDEN, "hidden"],
      [REMOVED, "removed"],
    ] as const) {
      expect((await postNotice({ ...COMPLETE, work: String(id) })).status).toBe(200);
      expect(await noticesFor(id), String(id)).toMatchObject([
        { status: "pending", work_status: status },
      ]);
    }
  });

  it("Says a work that isn't in the archive isn't, and stores nothing", async () => {
    const marker = `x8-unknown-${crypto.randomUUID()}`;
    const res = await postNotice({ ...COMPLETE, work: String(UNKNOWN), contact: marker });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("not in the archive");
    // The form comes back with what was typed, so a mistaken address costs no retyping.
    expect(html).toContain(marker);
    expect(html).toContain(COMPLETE.infringing_material);
    expect(await noticesFrom(marker)).toEqual([]);
  });

  it("Asks again, with what was typed escaped, when no work is named", async () => {
    const echo = `<b>x8-echo</b>`;
    for (const work of [
      "",
      "   ",
      "not a work",
      "https://example.test/stories/12",
      // Only this site's and the original archive's addresses name a work.
      `https://evil.example/works/${W}`,
      `https://rarepair.fans.evil.example/works/${W}`,
      "0",
      "99999999999",
    ]) {
      const res = await postNotice({ ...COMPLETE, work, contact: echo });
      expect(res.status, work).toBe(400);
      expect(res.headers.get("cache-control"), work).toBe("no-store");
      const html = await res.text();
      expect(html, work).toContain('role="alert"');
      expect(html, work).toContain("&lt;b&gt;x8-echo&lt;/b&gt;");
      expect(html, work).not.toContain(echo);
    }
    expect(await noticesFrom(echo)).toEqual([]);
  });

  it("Refuses a field over its length, with what was typed shown back", async () => {
    const before = (await noticesFor(W)).length;
    const long = `x8-long-${"y".repeat(4001)}`;
    const res = await postNotice({ ...COMPLETE, infringing_material: long });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("up to 4000 characters");
    expect(await noticesFor(W)).toHaveLength(before);
  });

  it("Refuses a post from another site, and a body too large to be the form", async () => {
    const before = (await noticesFor(W)).length;
    const cross = await postNotice(COMPLETE, {
      headers: { origin: "https://other.example", "sec-fetch-site": "cross-site" },
    });
    expect(cross.status).toBe(403);

    const marker = `x8-big-${crypto.randomUUID()}`;
    const res = await postNotice({
      ...COMPLETE,
      contact: marker,
      infringing_material: "z".repeat(300 * 1024),
    });
    expect(res.status).toBe(413);
    expect(await res.text()).not.toContain(marker);
    expect(await noticesFrom(marker)).toEqual([]);
    expect(await noticesFor(W)).toHaveLength(before);
  });

  it("Needs no sign-in, and logs nothing of the requester", async () => {
    const marker = `x8-private-${crypto.randomUUID()}@example.test`;
    const ip = freshIp();
    const logged = await consoleDuring(async () => {
      expect((await postNotice({ ...COMPLETE, contact: marker }, { ip })).status).toBe(200);
    });
    const log = logged.join("\n");
    expect(log).not.toContain(marker);
    expect(log).not.toContain(ip);
  });

  it("Notices are rate-limited per IP, and another IP isn't held up", async () => {
    await windowHeadroom(60);
    const ip = freshIp();
    // Each post counts, whether or not it stores a notice.
    for (let i = 0; i < DMCA_IP_LIMIT; i++) {
      expect((await postNotice({ ...COMPLETE, work: "" }, { ip })).status).toBe(400);
    }
    const marker = `x8-limited-${crypto.randomUUID()}`;
    const res = await postNotice({ ...COMPLETE, contact: marker }, { ip });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.text()).toContain("Too many requests");
    expect(await noticesFrom(marker)).toEqual([]);
    expect((await postNotice(COMPLETE)).status).toBe(200);
  });

  it("Is linked from the footer beside Remove my work", async () => {
    const html = await (await fetchW("/about")).text();
    expect(html).toContain('<a href="/remove">Remove my work</a> · <a href="/dmca">');
  });
});
