import { createDb } from "@archive/db";
import { putFragments, seedVersion, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emailsTo, LOGIN_TOKEN, postLogin } from "./helpers";
import {
  forms,
  h1Text,
  links,
  NoJsBrowser,
  scriptTags,
  type Form,
  type Page,
} from "./no-js-browser";

// One database serves every test file in the run, and each queue lists every open item in
// it. So this file keeps to AO3 work IDs 40810 to 40829, gives every row a marker starting
// "nojsmod-", and finds its own rows by that marker. Text is synthetic.
const REPORTED = 40810; // a report: hide, restore, remove
const TAKEDOWN_REJECTED = 40811;
const TAKEDOWN_APPROVED = 40812;
const REQUEST_APPROVED = 40813;
const REQUEST_REJECTED = 40814;
const REQUEST_BLOCKED = 40815;
const REQUEST_RESTORED = 40816;
const CHECKED = 40817; // versions: make current, approve, wrong-version reports, ban

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

/** Signs `email` in through the Worker and makes it a moderator, terms accepted. */
async function moderatorCookie(email: string): Promise<string> {
  expect((await postLogin({ email, "cf-turnstile-response": LOGIN_TOKEN })).status).toBe(200);
  const [sent] = await emailsTo(email);
  const token = new URL(sent!.url).searchParams.get("token")!;
  const res = await postLogin({ token, next: "/" }, { url: "/login/confirm" });
  expect(res.status).toBe(303);
  await db
    .updateTable("user")
    .set({ role: "moderator", terms_accepted_at: new Date() })
    .where("email", "=", email)
    .execute();
  return res.headers.getSetCookie()[0]!.split(";")[0]!;
}

let moderator: NoJsBrowser;
let reportId: string;
let takedownRejectedId: string;
let takedownApprovedId: string;
let requestApprovedId: string;
let requestRejectedId: string;
let requestBlockedId: string;
interface CheckedWork {
  v1: string;
  v2: string;
  held: string;
  uploaderId: string;
}
let seededCurrent: CheckedWork;

const statusOf = async (ao3WorkId: number) => {
  const work = await db
    .selectFrom("works")
    .select(["status", "hidden_cause"])
    .where("ao3_work_id", "=", ao3WorkId)
    .executeTakeFirstOrThrow();
  return work.hidden_cause === null ? work.status : `${work.status}/${work.hidden_cause}`;
};

beforeAll(async () => {
  moderator = new NoJsBrowser().withCookie(await moderatorCookie("nojsmod-moderator@example.test"));
  const created = "2001-06-01T00:00:00Z";

  const reported = await seedWork(db, { ao3WorkId: REPORTED, title: "nojsmod-reported" });
  const [report] = await db
    .insertInto("reports")
    .values({
      work_id: reported.workId,
      reporter_id: reported.userId,
      kind: "nojsmod-reason",
      body: "nojsmod-report-seen",
      created_at: created,
    })
    .returning("id")
    .execute();
  reportId = report!.id;

  const takedown = async (ao3WorkId: number, basis: string) => {
    const seeded = await seedWork(db, { ao3WorkId, title: `nojsmod-${ao3WorkId}` });
    const row = await db
      .insertInto("takedowns")
      .values({
        work_id: seeded.workId,
        requester: `${basis}@example.test`,
        basis,
        created_at: created,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  };
  takedownRejectedId = await takedown(TAKEDOWN_REJECTED, "nojsmod-takedown-rejected");
  takedownApprovedId = await takedown(TAKEDOWN_APPROVED, "nojsmod-takedown-approved");

  const request = async (
    ao3WorkId: number,
    statement: string,
    hidden: Parameters<typeof seedWork>[1] = {},
  ) => {
    const seeded = await seedWork(db, { ao3WorkId, title: `nojsmod-${ao3WorkId}`, ...hidden });
    const row = await db
      .insertInto("requests")
      .values({
        kind: "remove_work",
        work_id: seeded.workId,
        contact_email: `${statement}@example.test`,
        statement,
        ip_hash: `${statement}-ip`,
        confirmed_at: new Date(),
        created_at: created,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (hidden.status === "hidden") {
      await db
        .insertInto("request_works")
        .values({ request_id: row.id, work_id: seeded.workId })
        .execute();
    }
    return row.id;
  };
  requestApprovedId = await request(REQUEST_APPROVED, "nojsmod-request-approved");
  requestRejectedId = await request(REQUEST_REJECTED, "nojsmod-request-rejected");
  requestBlockedId = await request(REQUEST_BLOCKED, "nojsmod-request-blocked");
  await request(REQUEST_RESTORED, "nojsmod-request-restored", {
    status: "hidden",
    hiddenCause: "removal_request",
  });

  // CHECKED: v1 replaced by v2 (current), and a third held for review.
  const seeded = await seedWork(db, {
    ao3WorkId: CHECKED,
    title: "nojsmod-checked",
    chapters: [{ html: "<p>nojsmod-v1</p>" }],
    addedAt: "2001-01-01T00:00:00Z",
  });
  const second = await seedVersion(db, seeded, {
    chapters: [{ html: "<p>nojsmod-v2</p>" }],
    addedAt: "2001-02-01T00:00:00Z",
  });
  const held = await seedVersion(db, seeded, {
    current: false,
    chapters: 2,
    addedAt: "2001-03-01T00:00:00Z",
  });
  await putFragments(env.BUCKET, [...seeded.fragments, ...second.fragments]);
  seededCurrent = {
    v1: seeded.versionId,
    v2: second.versionId,
    held: held.versionId,
    uploaderId: seeded.userId,
  };
  await db
    .insertInto("reports")
    .values({
      work_id: seeded.workId,
      reporter_id: seeded.userId,
      kind: "wrong_version",
      body: "nojsmod-wrong-version",
    })
    .execute();
});

/** The first link in the row of `html`'s table that holds `marker`. */
function rowLink(html: string, marker: string): string {
  const row = (html.match(/<tr>[\s\S]*?<\/tr>/g) ?? []).find((r) => r.includes(marker));
  expect(row, `a row with ${marker}`).toBeDefined();
  const link = links(row!)[0];
  expect(link, `a link in the row with ${marker}`).toBeDefined();
  return link!.href;
}

/** Opens `queue` from the /admin home page's own links, as a moderator clicks through. */
async function openQueue(name: string): Promise<Page> {
  const home = await moderator.go("/admin");
  const link = links(home.html).find((l) => l.text === name);
  expect(link, `/admin links to ${name}`).toBeDefined();
  const queue = await moderator.click(home, link!.href);
  expect(queue.res.status).toBe(200);
  return queue;
}

/** Opens the item whose row in `queue` holds `marker`. */
async function openItem(queue: string, marker: string): Promise<Page> {
  const page = await openQueue(queue);
  const item = await moderator.click(page, rowLink(page.html, marker));
  expect(item.res.status).toBe(200);
  return item;
}

/** The form on `page` that posts to a path ending `suffix` (and holds `field`, if given). */
function formTo(page: Page, suffix: string, field?: [string, string]): Form {
  const form = forms(page.html).find(
    (f) =>
      f.method === "post" &&
      f.action.endsWith(suffix) &&
      (field === undefined || f.fields.some((x) => x.name === field[0] && x.value === field[1])),
  );
  expect(form, `${page.path} has a form to ${suffix}`).toBeDefined();
  return form!;
}

/** Presses the button of the form to `suffix` on `page`, and expects a page answer. */
async function press(page: Page, suffix: string, field?: [string, string]): Promise<Page> {
  const next = await moderator.submit(page, formTo(page, suffix, field));
  expect(next.res.status, `${suffix} from ${page.path}`).toBe(200);
  return next;
}

/** The page an action answered with: "Done", and a way back to the item. */
function expectDone(page: Page, message: string | RegExp) {
  expect(h1Text(page.html)).toBe("Done");
  expect(page.html).toMatch(message);
  expect(links(page.html).map((l) => l.text)).toContain("Back to the item");
}

describe("18-moderation", () => {
  it("Moderation works without JS", async () => {
    // Every page of the walk: no script anywhere (checked as it is met).
    const met: Page[] = [];
    const record = <T extends Page>(page: T) => (met.push(page), page);

    // The home page links to all four queues.
    const home = record(await moderator.go("/admin"));
    expect(links(home.html).map((l) => l.text)).toEqual(
      expect.arrayContaining(["Reports", "Takedowns", "Requests", "Works to check"]),
    );

    // A report: hide, restore, then remove, which asks first.
    let item = record(await openItem("Reports", "nojsmod-report-seen"));
    expect(item.path).toBe(`/admin/reports/${reportId}`);
    let done = record(await press(item, "/hide"));
    expectDone(done, /hidden by a moderator/);
    expect(await statusOf(REPORTED)).toBe("hidden/moderator");
    item = record(
      await moderator.click(
        done,
        links(done.html).find((l) => l.text === "Back to the item")!.href,
      ),
    );
    done = record(await press(item, "/restore"));
    expect(await statusOf(REPORTED)).toBe("live");
    item = record(
      await moderator.click(
        done,
        links(done.html).find((l) => l.text === "Back to the item")!.href,
      ),
    );
    const confirm = record(await press(item, "/remove"));
    expect(h1Text(confirm.html)).toBe("Remove work");
    expect(await statusOf(REPORTED)).toBe("live");
    done = record(await press(confirm, "/remove"));
    expectDone(done, /removed/);
    expect(await statusOf(REPORTED)).toBe("removed");

    // A takedown: reject one, approve (and confirm) another.
    item = record(await openItem("Takedowns", "nojsmod-takedown-rejected"));
    expect(item.path).toBe(`/admin/takedowns/${takedownRejectedId}`);
    expectDone(record(await press(item, "/reject")), /Rejected/);
    expect(
      (
        await db
          .selectFrom("takedowns")
          .select("status")
          .where("id", "=", takedownRejectedId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("rejected");

    item = record(await openItem("Takedowns", "nojsmod-takedown-approved"));
    expect(item.path).toBe(`/admin/takedowns/${takedownApprovedId}`);
    const approving = record(await press(item, "/approve"));
    expect(await statusOf(TAKEDOWN_APPROVED)).toBe("live");
    done = record(await press(approving, "/approve"));
    expect(h1Text(done.html)).toBe("Done");
    expect(await statusOf(TAKEDOWN_APPROVED)).toBe("removed");

    // A request: approve (and confirm), reject, block the requester.
    item = record(await openItem("Requests", "nojsmod-request-approved"));
    expect(item.path).toBe(`/admin/requests/${requestApprovedId}`);
    done = record(await press(record(await press(item, "/approve")), "/approve"));
    expect(h1Text(done.html)).toBe("Done");
    expect(await statusOf(REQUEST_APPROVED)).toBe("removed");

    item = record(await openItem("Requests", "nojsmod-request-rejected"));
    expect(item.path).toBe(`/admin/requests/${requestRejectedId}`);
    expectDone(record(await press(item, "/reject")), /Rejected/);
    expect(
      (
        await db
          .selectFrom("requests")
          .select("status")
          .where("id", "=", requestRejectedId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("rejected");

    item = record(await openItem("Requests", "nojsmod-request-blocked"));
    expect(item.path).toBe(`/admin/requests/${requestBlockedId}`);
    expectDone(record(await press(item, "/block")), /Requester blocked/);
    expect(
      await db
        .selectFrom("requester_blocks")
        .select("id")
        .where("contact_email", "=", "nojsmod-request-blocked@example.test")
        .execute(),
    ).toHaveLength(1);

    // Restoring the works a request hid.
    expect(await statusOf(REQUEST_RESTORED)).toBe("hidden/removal_request");
    item = record(await openItem("Requests", "nojsmod-request-restored"));
    expectDone(record(await press(item, "/restore-related")), /./);
    expect(await statusOf(REQUEST_RESTORED)).toBe("live");

    // Works to check: close the wrong-version reports, make an older version current,
    // approve the held one, ban the uploader. (Making a version current closes the
    // reports too, so they are closed first.)
    let admin = record(await openItem("Works to check", "nojsmod-checked"));
    expect(admin.path).toBe(`/admin/works/${CHECKED}`);
    const currentOf = async () =>
      (
        await db
          .selectFrom("works")
          .select("current_version_id")
          .where("ao3_work_id", "=", CHECKED)
          .executeTakeFirstOrThrow()
      ).current_version_id;
    expect(await currentOf()).toBe(seededCurrent.v2);

    expect(admin.html).toContain("Close wrong-version reports");
    done = record(await press(admin, "/reports/close"));
    expectDone(done, /Closed 1 report/);
    expect(
      await db
        .selectFrom("reports")
        .select("status")
        .where("body", "=", "nojsmod-wrong-version")
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "closed" });

    admin = record(await moderator.go(`/admin/works/${CHECKED}`));
    done = record(await press(admin, "/current", ["version", seededCurrent.v1]));
    expectDone(done, /now current/);
    expect(await currentOf()).toBe(seededCurrent.v1);

    admin = record(await moderator.go(`/admin/works/${CHECKED}`));
    done = record(await press(admin, "/approve", ["version", seededCurrent.held]));
    expectDone(done, /approved and now current/);
    expect(await currentOf()).toBe(seededCurrent.held);

    admin = record(await moderator.go(`/admin/works/${CHECKED}`));
    done = record(await press(admin, `/users/${seededCurrent.uploaderId}/ban`));
    expectDone(done, /banned/);
    expect(
      (
        await db
          .selectFrom("user")
          .select("banned_at")
          .where("id", "=", seededCurrent.uploaderId)
          .executeTakeFirstOrThrow()
      ).banned_at,
    ).not.toBeNull();

    // No page of the walk needed a script, and each was a whole page of the site.
    for (const page of met) {
      expect(scriptTags(page.html), page.path).toHaveLength(0);
      expect(page.html, page.path).toContain('<main id="main">');
      expect(page.html.match(/<h1\b/g), page.path).toHaveLength(1);
      expect(/<a\b[^>]*>/.exec(page.html)?.[0], page.path).toBe('<a class="skip" href="#main">');
    }
  });
});
