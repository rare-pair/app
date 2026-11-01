import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STRICT, fetchW, nonceOf, withoutNonce } from "./helpers";

// One database serves every test file in the run, so this file keeps to work IDs
// 15000 to 15099, and every tag it seeds is named with an "r3-" prefix. Text is
// synthetic: the markers below must never reach a hidden or removed work's page.
const H = 15001; // hidden after a removal request
const HR = 15002; // hidden after reader reports
const HM = 15003; // hidden by a moderator
const R = 15004; // removed
const LIVE = 15005;
const UNKNOWN = 15099;

const MARKERS = {
  title: "R3-TITLE-MARKER",
  pseud: "R3-PSEUD-MARKER",
  summary: "R3-SUMMARY-MARKER",
  tag: "r3-Tag-Marker",
  chapterTitle: "R3-CHAPTER-TITLE-MARKER",
  text: "R3-FRAGMENT-TEXT-MARKER",
};

const seed = (ao3WorkId: number, extra: Parameters<typeof seedWork>[1] = {}) =>
  seedWork(db, {
    ao3WorkId,
    title: MARKERS.title,
    authors: [{ pseud: MARKERS.pseud, ao3_user: "r3-user" }],
    summary: `<p>${MARKERS.summary}</p>`,
    tags: [{ type: "freeform", name: MARKERS.tag }],
    chapters: [
      { title: MARKERS.chapterTitle, html: `<p>${MARKERS.text}</p>` },
      { html: `<p>${MARKERS.text}</p>` },
    ],
    ...extra,
  });

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

beforeAll(async () => {
  for (const [id, extra] of [
    [H, { status: "hidden", hiddenCause: "removal_request" }],
    [HR, { status: "hidden", hiddenCause: "reports" }],
    [HM, { status: "hidden", hiddenCause: "moderator" }],
    [R, { status: "removed" }],
    [LIVE, {}],
  ] as const) {
    const w = await seed(id, extra);
    await putFragments(env.BUCKET, w.fragments);
  }
});

afterAll(() => db.destroy());

/** Nothing of the work: no marker, no link into it, no title. */
function expectNoDetails(html: string, id: number) {
  for (const marker of Object.values(MARKERS)) expect(html).not.toContain(marker);
  expect(html).not.toContain(`/works/${id}`);
  expect(html).not.toContain("archiveofourown.org");
  expect(html).not.toMatch(/\/download|\/report|\/full/);
}

const PAGES = (id: number) => [
  `/works/${id}`,
  `/works/${id}/chapters/1`,
  `/works/${id}/chapters/2`,
  `/works/${id}/chapters/999`,
  `/works/${id}/chapters/0`,
  `/works/${id}/chapters/abc`,
  `/works/${id}/full`,
];

describe("10 work page", () => {
  it("Hidden work returns 451 and names a removal request", async () => {
    const res = await fetchW(`/works/${H}`);
    const html = await res.text();

    expect(res.status).toBe(451);
    expect(html).toContain("Temporarily hidden after a removal request");
    expectNoDetails(html, H);
  });

  it("Work hidden after reports names the reports", async () => {
    const res = await fetchW(`/works/${HR}`);
    const html = await res.text();

    expect(res.status).toBe(451);
    expect(html).toContain("Temporarily hidden after reader reports");
    expectNoDetails(html, HR);
  });

  it("Work hidden by a moderator says so", async () => {
    const res = await fetchW(`/works/${HM}`);
    const html = await res.text();

    expect(res.status).toBe(451);
    expect(html).toContain("Temporarily hidden by a moderator");
    expectNoDetails(html, HM);
  });

  it("Removed work returns 410", async () => {
    const res = await fetchW(`/works/${R}`);
    const html = await res.text();

    expect(res.status).toBe(410);
    expect(html).toContain("This work has been removed");
    expect(html).not.toMatch(/Temporarily hidden/);
    expectNoDetails(html, R);
  });
});

describe("11 reader and CSP", () => {
  it("Hidden work's chapters and entire work return 451", async () => {
    for (const url of PAGES(HR).slice(1)) {
      const res = await fetchW(url);
      const html = await res.text();

      expect(res.status, url).toBe(451);
      expect(html, url).toContain("Temporarily hidden after reader reports");
      expectNoDetails(html, HR);
    }
  });

  it("Removed work's chapters and entire work return 410", async () => {
    for (const url of PAGES(R).slice(1)) {
      const res = await fetchW(url);
      const html = await res.text();

      expect(res.status, url).toBe(410);
      expect(html, url).toContain("This work has been removed");
      expectNoDetails(html, R);
    }
  });

  it("A withheld page carries the strict CSP with a fresh nonce, HSTS and no-store", async () => {
    const nonces = new Set<string | null>();
    for (const url of [
      `/works/${H}`,
      `/works/${R}`,
      `/works/${HR}/full`,
      `/works/${HM}/chapters/1`,
    ]) {
      const res = await fetchW(url);
      await res.text();

      const csp = res.headers.get("content-security-policy");
      expect(withoutNonce(csp), url).toBe(STRICT);
      nonces.add(nonceOf(csp));
      expect(res.headers.get("cache-control"), url).toBe("private, no-store");
      expect(res.headers.get("strict-transport-security"), url).toMatch(/max-age=/);
      expect(res.headers.get("content-type"), url).toMatch(/^text\/html/);
    }
    expect(nonces.size).toBe(4);
  });

  it("HEAD keeps the status", async () => {
    expect((await fetchW(`/works/${H}`, { method: "HEAD" })).status).toBe(451);
    expect((await fetchW(`/works/${R}/chapters/1`, { method: "HEAD" })).status).toBe(410);
  });

  it("An unknown work stays a 404 on every page, and a live work still opens", async () => {
    for (const url of PAGES(UNKNOWN)) {
      const res = await fetchW(url);
      await res.text();
      expect(res.status, url).toBe(404);
    }
    const live = await fetchW(`/works/${LIVE}`);
    await live.text();
    expect(live.status).toBe(200);
    const chapter = await fetchW(`/works/${LIVE}/chapters/1`);
    expect(chapter.status).toBe(200);
    expect(await chapter.text()).toContain(MARKERS.text);
    expect((await fetchW(`/works/${LIVE}/full`)).status).toBe(200);
  });

  it("A malformed work ID is a 404, not a status", async () => {
    for (const url of ["/works/0", "/works/007", "/works/2147483648/chapters/1"]) {
      const res = await fetchW(url);
      await res.text();
      expect(res.status, url).toBe(404);
    }
  });
});
