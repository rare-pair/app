import { createDb } from "@archive/db";
import { seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BASE,
  emailsTo,
  fetchW,
  nonceOf,
  LOGIN_TOKEN,
  postLogin,
  signIn as signInAs,
  STRICT,
  withoutNonce,
} from "./helpers";

// One database serves every test file in the run, so this file keeps to AO3 work
// IDs 12500 to 12599, names every tag it seeds with an "x4-" prefix, and finds its
// reports by its own reporters. Text is synthetic.
const W = 12500;
/** Hidden after reports, so its pages are not served. */
const HIDDEN = 12501;
const REMOVED = 12502;
/** No work has it. */
const UNKNOWN = 12599;
const REPORT = `/works/${W}/report`;
/** Where a signed-out reader is sent: the sign-in form, carrying the report form's path. */
const TO_SIGN_IN = `/login?next=${encodeURIComponent(REPORT)}`;

const X4_TAGS = [
  { type: "rating", name: "x4-General Audiences" },
  { type: "fandom", name: "x4-Fandom" },
] as const;

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

beforeAll(async () => {
  await seedWork(db, { ao3WorkId: W, title: "x4 Work W", tags: [...X4_TAGS] });
  await seedWork(db, {
    ao3WorkId: HIDDEN,
    status: "hidden",
    hiddenCause: "reports",
    tags: [...X4_TAGS],
  });
  await seedWork(db, { ao3WorkId: REMOVED, status: "removed", tags: [...X4_TAGS] });
});
afterAll(() => db.destroy());

// These cases report W from many accounts, and the third hides it (17-report-auto-hide
// tests that). Each case starts with W live again, so it can be reported and shown.
const makeWLive = async () => {
  await db
    .updateTable("works")
    .set({ status: "live", hidden_cause: null })
    .where("ao3_work_id", "=", W)
    .execute();
};
beforeEach(makeWLive);

/** Signs `email` in through the Worker, accepting the terms, and returns its session cookie. */
const signIn = (email: string) => signInAs(email, { acceptTerms: true });

/** The headers a browser on rarepair.fans sends with the report form. */
const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  origin: BASE,
  "sec-fetch-site": "same-origin",
};

/** Submits the report form for work `id`, as a browser on rarepair.fans does. */
const postReport = (
  fields: Record<string, string>,
  {
    cookie,
    id = W,
    headers = {},
  }: { cookie?: string; id?: number | string; headers?: Record<string, string> } = {},
) => {
  const sent = new Headers({ ...FORM_HEADERS, ...headers });
  if (cookie !== undefined) sent.set("cookie", cookie);
  return fetchW(`/works/${id}/report`, {
    method: "POST",
    headers: sent,
    body: new URLSearchParams(fields).toString(),
  });
};

/** How many reports W has, from anyone. */
const reportCount = async () =>
  (
    await db
      .selectFrom("reports")
      .innerJoin("works", "works.id", "reports.work_id")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("works.ao3_work_id", "=", W)
      .executeTakeFirstOrThrow()
  ).n;

/** The reports `email`'s account has made on W, oldest first. */
const reportsBy = (email: string) =>
  db
    .selectFrom("reports")
    .innerJoin("works", "works.id", "reports.work_id")
    .innerJoin("user", "user.id", "reports.reporter_id")
    .select(["reports.kind", "reports.body", "reports.status"])
    .where("works.ao3_work_id", "=", W)
    .where("user.email", "=", email)
    .orderBy("reports.created_at")
    .execute();

describe("17-reports-and-dmca", () => {
  it("Every work has a report button", async () => {
    const res = await fetchW(`/works/${W}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`<a href="/works/${W}/report">Report</a>`);
  });

  it("Signed-in reader can report a work", async () => {
    const cookie = await signIn("x4-signed-in@example.test");
    const res = await fetchW(REPORT, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain(`<form class="report-form" method="post" action="${REPORT}">`);
    expect(html).toContain("x4 Work W");
  });

  it("Report form asks for a reason and optional details", async () => {
    const cookie = await signIn("x4-form@example.test");
    const res = await fetchW(REPORT, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // A reason, as radio buttons in a labelled group, one of them "This version is wrong".
    expect(html).toMatch(/<fieldset>\s*<legend>Reason<\/legend>/);
    expect(html).toContain(
      '<label><input type="radio" name="reason" value="wrong_version"> This version is wrong</label>',
    );
    expect(html.match(/type="radio" name="reason"/g)?.length).toBeGreaterThan(1);
    // Optional details, labelled.
    expect(html).toContain('<label for="details">Details (optional');
    expect(html).toContain('<textarea id="details" name="details"');
    expect(html).not.toMatch(/<textarea[^>]*required/);
    expect(html).toContain('<button type="submit">');
    // It works with JavaScript off: no script and no anti-spam check.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("cf-turnstile");
    // The strict policy, with a fresh nonce and no frames, and HSTS.
    const csp = res.headers.get("content-security-policy");
    expect(withoutNonce(csp)).toBe(STRICT);
    const again = await fetchW(REPORT, { headers: { cookie } });
    expect(nonceOf(again.headers.get("content-security-policy"))).not.toBe(nonceOf(csp));
    expect(res.headers.get("strict-transport-security")).toMatch(/^max-age=\d+/);
  });

  it("Signed-out reader is sent to sign in before reporting", async () => {
    const res = await fetchW(REPORT);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(TO_SIGN_IN);
    expect(await res.text()).not.toContain("<form");

    // Signing in from there, through the emailed link, comes back to the form.
    const email = "x4-signed-out-get@example.test";
    const login = new URL(res.headers.get("location")!, BASE);
    const form = await (await fetchW(login.pathname + login.search)).text();
    expect(form).toContain(`<input type="hidden" name="next" value="${REPORT}">`);
    const next = login.searchParams.get("next")!;
    const asked = await postLogin({ email, next, "cf-turnstile-response": LOGIN_TOKEN });
    expect(asked.status).toBe(200);
    const [sent] = await emailsTo(email);
    const link = new URL(sent!.url);
    const confirmed = await postLogin(
      { token: link.searchParams.get("token")!, next: link.searchParams.get("next")! },
      { url: "/login/confirm" },
    );
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get("location")).toBe(`${BASE}${REPORT}`);
  });

  it("Submitting a report stores it and confirms", async () => {
    const email = "x4-submits@example.test";
    const cookie = await signIn(email);
    const res = await postReport(
      { reason: "wrong_version", details: "x4 synthetic details" },
      { cookie },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = await res.text();
    expect(html).toContain("<h1>Report sent</h1>");
    expect(html).toContain("A moderator will look at it");
    // A wrong version is checked, never counted toward hiding the work.
    expect(html).not.toContain("hidden");
    const [report, ...more] = await reportsBy(email);
    expect(more).toEqual([]);
    // Open, and by U (reportsBy finds it through reporter_id). MOD1's queue and
    // X7's count read `open` and `wrong_version` as stored.
    expect(report!.status).toBe("open");
    expect(report!.kind).toBe("wrong_version");
    expect(report!.body).toBe("x4 synthetic details");
  });

  it("Report without details is accepted", async () => {
    const email = "x4-no-details@example.test";
    const cookie = await signIn(email);
    expect((await postReport({ reason: "other" }, { cookie })).status).toBe(200);
    // Details left empty, or only spaces, store none.
    expect((await postReport({ reason: "other", details: "  \r\n " }, { cookie })).status).toBe(
      200,
    );
    const reports = await reportsBy(email);
    expect(reports).toEqual([
      { kind: "other", body: null, status: "open" },
      { kind: "other", body: null, status: "open" },
    ]);
  });

  it("Banned account cannot report", async () => {
    const email = "x4-banned@example.test";
    const cookie = await signIn(email);
    // Banned after signing in: the session stays valid, the account can't report.
    await db
      .updateTable("user")
      .set({ banned_at: new Date() })
      .where("email", "=", email)
      .execute();
    const res = await postReport({ reason: "other", details: "x4 synthetic details" }, { cookie });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("You can't send reports from this account.");
    expect(await reportsBy(email)).toEqual([]);
    // Nor is it shown the form.
    const form = await fetchW(REPORT, { headers: { cookie } });
    expect(form.status).toBe(403);
    expect(await form.text()).not.toContain("<form");
  });

  it("Signed-out report submission redirects to sign in", async () => {
    const before = await reportCount();
    const res = await postReport({ reason: "other", details: "x4 synthetic details" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(TO_SIGN_IN);
    expect(res.headers.get("strict-transport-security")).toMatch(/^max-age=\d+/);
    expect(await reportCount()).toBe(before);
  });
});

/** The href of W's work page's "Report" link. */
async function reportLink(): Promise<string> {
  const page = await (await fetchW(`/works/${W}`)).text();
  const href = page.match(/<a href="([^"]*)">Report<\/a>/)?.[1];
  expect(href).toBeDefined();
  return href!;
}

// The work page's cases for its Report link, kept here so R1's test file is untouched.
describe("10-work-page", () => {
  it("Report link opens the report form for signed-in readers", async () => {
    const cookie = await signIn("x4-link-signed-in@example.test");
    const res = await fetchW(await reportLink(), { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      `<form class="report-form" method="post" action="${REPORT}">`,
    );
  });

  it("Report link sends signed-out readers to sign in first", async () => {
    const res = await fetchW(await reportLink());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(TO_SIGN_IN);
  });
});

describe("report form checks", () => {
  it("A missing or unknown reason gets the form again, and stores nothing", async () => {
    const email = "x4-no-reason@example.test";
    const cookie = await signIn(email);
    const refused: Record<string, string>[] = [
      { details: "x4 synthetic details" },
      { reason: "", details: "x4 synthetic details" },
      { reason: "spam<b>", details: "x4 synthetic details" },
    ];
    for (const fields of refused) {
      const res = await postReport(fields, { cookie });
      expect(res.status, JSON.stringify(fields)).toBe(400);
      // It holds what the reader typed, so it is kept out of caches.
      expect(res.headers.get("cache-control")).toBe("no-store");
      const html = await res.text();
      expect(html).toContain('<p role="alert">Choose a reason.</p>');
      expect(html).toContain(`<form class="report-form" method="post" action="${REPORT}">`);
      // What was typed comes back, escaped; a value that is no reason doesn't.
      expect(html).toContain('maxlength="2000">\nx4 synthetic details</textarea>');
      expect(html).not.toContain("spam<b>");
      expect(html).not.toContain("checked");
    }
    expect(await reportsBy(email)).toEqual([]);
  });

  it("A reason comes back chosen when the form does", async () => {
    const cookie = await signIn("x4-reason-kept@example.test");
    const res = await postReport(
      { reason: "not_this_work", details: "x".repeat(2001) },
      { cookie },
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('value="not_this_work" checked>');
  });

  it("Details over 2000 characters get the form again, and store nothing", async () => {
    const email = "x4-long-details@example.test";
    const cookie = await signIn(email);
    const res = await postReport({ reason: "other", details: "x".repeat(2001) }, { cookie });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('<p role="alert">Details can be up to 2000 characters.</p>');
    // 2000 exactly is fine.
    const ok = await postReport({ reason: "other", details: "y".repeat(2000) }, { cookie });
    expect(ok.status).toBe(200);
    expect(await reportsBy(email)).toEqual([
      { kind: "other", body: "y".repeat(2000), status: "open" },
    ]);
  });

  it("Details the form allows are accepted, line breaks and any script included", async () => {
    const email = "x4-full-details@example.test";
    const cookie = await signIn(email);
    // The form counts a line break as one character, and a browser submits it as CRLF.
    const lines = `${"a".repeat(999)}\r\n${"b".repeat(1000)}`;
    expect((await postReport({ reason: "other", details: lines }, { cookie })).status).toBe(200);
    // The first report may have been W's third account's: show W again for the second.
    await makeWLive();
    // 2000 characters of three UTF-8 bytes each, percent-encoded: about 18 KB of body.
    const wide = "字".repeat(2000);
    expect((await postReport({ reason: "other", details: wide }, { cookie })).status).toBe(200);
    expect(await reportsBy(email)).toEqual([
      { kind: "other", body: `${"a".repeat(999)}\n${"b".repeat(1000)}`, status: "open" },
      { kind: "other", body: wide, status: "open" },
    ]);
  });

  it("Details past the cap in any script come back to edit, not thrown away", async () => {
    const cookie = await signIn("x4-wide-over@example.test");
    // 2001 emoji: two UTF-16 units and 12 encoded bytes each, about 24 KB of body.
    const emoji = "\u{1F600}".repeat(2001);
    const res = await postReport({ reason: "other", details: emoji }, { cookie });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(`${emoji}</textarea>`);
  });

  it("Details that start with a line break come back unchanged", async () => {
    const cookie = await signIn("x4-leading-line@example.test");
    const res = await postReport({ details: "\r\nx4 second line" }, { cookie });
    expect(res.status).toBe(400);
    // The parser drops one newline straight after <textarea>, so the page gives it two.
    expect(await res.text()).toContain('maxlength="2000">\n\nx4 second line</textarea>');
  });

  it("A NUL in the details, which no one types, is dropped rather than failing", async () => {
    const email = "x4-nul@example.test";
    const cookie = await signIn(email);
    const res = await postReport({ reason: "other", details: "x4\u0000details" }, { cookie });
    expect(res.status).toBe(200);
    expect(await reportsBy(email)).toEqual([{ kind: "other", body: "x4details", status: "open" }]);
  });

  it("A body too large to be the form is refused, and nothing of it shown back", async () => {
    const email = "x4-too-large@example.test";
    const cookie = await signIn(email);
    const res = await postReport(
      { reason: "other", details: `x4-echo-${"z".repeat(70 * 1024)}` },
      { cookie },
    );
    expect(res.status).toBe(413);
    expect(await res.text()).not.toContain("x4-echo-");
    expect(await reportsBy(email)).toEqual([]);
  });

  it("A report posted from another site is refused before anything else", async () => {
    const email = "x4-cross-site@example.test";
    const cookie = await signIn(email);
    for (const headers of [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "https://upload.rarepair.fans", "sec-fetch-site": "same-site" },
    ]) {
      const res = await postReport({ reason: "other" }, { cookie, headers });
      expect(res.status).toBe(403);
      expect(res.headers.get("strict-transport-security")).toMatch(/^max-age=\d+/);
    }
    // Signed out too: refused, not sent to sign in.
    const signedOut = await postReport(
      { reason: "other" },
      { headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } },
    );
    expect(signedOut.status).toBe(403);
    expect(signedOut.headers.get("cache-control")).toBe("no-store");
    expect(await reportsBy(email)).toEqual([]);
  });

  it("Only a live work can be reported, as only a live work has a page", async () => {
    const email = "x4-not-live@example.test";
    const cookie = await signIn(email);
    for (const id of [HIDDEN, REMOVED, UNKNOWN, "0", "012500", "abc", "1.25e4", "2147483648"]) {
      const form = await fetchW(`/works/${id}/report`, { headers: { cookie } });
      expect(form.status, `GET ${id}`).toBe(404);
      expect(await form.text()).toContain("Page not found");
      const post = await postReport({ reason: "other" }, { cookie, id });
      expect(post.status, `POST ${id}`).toBe(404);
    }
    const stored = await db
      .selectFrom("reports")
      .innerJoin("user", "user.id", "reports.reporter_id")
      .select("reports.id")
      .where("user.email", "=", email)
      .execute();
    expect(stored).toEqual([]);
  });
});
