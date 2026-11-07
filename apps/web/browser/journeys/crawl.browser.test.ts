import type { BrowserContext, Page } from "playwright";
import { beforeAll, describe, expect, it } from "vitest";
import { useInventorySite } from "../a11y/inventory-suite";
import {
  assertNone,
  crawl,
  staleUnlinked,
  unreachedPages,
  type CrawlResult,
} from "../harness/crawl";
import { useJourneySite } from "../harness/journey";
import { OPEN_PAGES, PRELAUNCH_PAGES, type Visitor } from "../harness/pages";
import type { Inventory } from "../harness/seed";
import { signedIn } from "../harness/sessions";
import { freshIp, type Site } from "../harness/site";
import { KNOWN_GAPS, UNLINKED } from "../harness/unlinked";

// Every page of spec 21's inventory can be reached by a link, from the home page, by the
// visitor it is for. The crawl (harness/crawl.ts) reads links, as the server serves them: it
// cannot tell a link a person can't see or use, and the journeys, which click, are what show
// that. Pages with no link are named, with the reason, in harness/unlinked.ts. Works here take
// AO3 ids 43300 to 43306; the closed archive's crawl seeds nothing.

/** A visitor's context as the crawl needs it: its cookies as a header, and an address of its own. */
async function visitorOf(context: BrowserContext | undefined) {
  const cookies = context === undefined ? [] : await context.cookies();
  const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  return { cookie: cookie === "" ? undefined : cookie, ip: freshIp() };
}

/** A page that shows nothing, in a context of its own, to read HTML with. */
const blankParser = async (site: Site): Promise<Page> => (await site.newContext()).newPage();

describe("crawl: the open archive", () => {
  const running = useInventorySite({ prelaunch: false, firstId: 43300, prefix: "jh-crawl" });
  const VISITORS = ["anonymous", "reader", "moderator"] as const satisfies Visitor[];
  let parser: Page;
  let first: Record<(typeof VISITORS)[number], CrawlResult>;

  const crawlAs = (visitor: Visitor, rewrite?: (html: string) => string) =>
    visitorOf(running.visitors.contexts[visitor]).then((options) =>
      crawl(running.site, parser, { ...options, rewrite }),
    );

  beforeAll(async () => {
    parser = await blankParser(running.site);
    const [anonymous, reader, moderator] = await Promise.all(VISITORS.map((v) => crawlAs(v)));
    // SAFETY: Promise.all over three visitors gives three results, in order.
    first = { anonymous, reader, moderator } as typeof first;
  });

  const unreached = (visitor: Visitor, result: CrawlResult) =>
    unreachedPages(result, OPEN_PAGES, running.seeded, visitor, UNLINKED);

  describe.each(VISITORS)("as %s", (visitor) => {
    it("reaches every page of the inventory that is not on the unlinked list", () => {
      // SAFETY: a page the crawl didn't reach has no link, or one that was removed.
      assertNone("pages no link reaches", visitor, unreached(visitor, first[visitor]));
    });

    it("follows no link to a page that is gone or refuses", () => {
      expect(first[visitor].dead).toEqual([]);
    });

    it("stops at no limit, so no page was left unread", () => {
      expect(first[visitor].capped).toEqual([]);
    });

    it("finds no link to a page on the unlinked list", () => {
      // SAFETY: a page reached after all is taken off the list, so a lost link is seen again.
      const stale = staleUnlinked(first[visitor], OPEN_PAGES, running.seeded, visitor, UNLINKED);
      assertNone("unlinked pages a link now reaches", visitor, stale);
    });
  });

  it("A moderator has no link to the admin page of a work that is neither in Works to check nor reported", () => {
    // SAFETY: if a link appears, KNOWN_GAPS is out of date: remove its entry.
    expect(KNOWN_GAPS.map(({ what }) => what)).toHaveLength(1);
    const { seen } = first.moderator;
    const workAdmin = [...seen].filter((key) => key.startsWith("/admin/works/"));
    // A report's page links to its work's admin page, where "Mark as adult" is.
    expect(workAdmin.sort()).toEqual(
      [`/admin/works/${running.seeded.toCheck}`, `/admin/works/${running.seeded.work}`].sort(),
    );
  });

  // The proof that the crawl fails when a link goes: the real Worker's pages with one link
  // taken out of the HTML before the crawl reads it, naming what the crawl then can't reach.
  // `hrefsTo` turns every href that starts with `path` (a prefix: `/admin` also takes the links
  // to /admin/requests) into "#", in the HTML the crawl reads. So each case below proves only
  // that the crawl misses the page when those links are gone from that HTML. It doesn't prove
  // the link is there, visible or usable on the real page: the journeys click for that.
  const hrefsTo = (path: RegExp) => (html: string) =>
    html.replace(new RegExp(`href="${path.source}[^"]*"`, "g"), 'href="#"');

  const removals: [string, Visitor, (seeded: Inventory) => RegExp, string[]][] = [
    ["the header's Admin link", "moderator", () => /\/admin/, ["admin"]],
    ["the header's My uploads link", "reader", () => /\/me\/uploads/, ["my uploads"]],
    [
      "a work's Report link",
      "reader",
      (seeded) => new RegExp(`/works/${seeded.work}/report`),
      ["report"],
    ],
    [
      "the reader bar's Reader settings link",
      "reader",
      () => /\/settings\/reader/,
      ["reader settings, signed in"],
    ],
    [
      "the reader bar's Reader settings link, signed out",
      "anonymous",
      () => /\/settings\/reader/,
      ["reader settings"],
    ],
    ["the footer's Copyright notice link", "anonymous", () => /\/dmca/, ["DMCA"]],
    // Add work and a work's Report answer a signed-out visitor with the sign-in page, so the
    // header's Sign in isn't the only way in: all three go, and the crawl then loses it (see
    // the next test).
    [
      "every link to sign in, Add work and Report",
      "anonymous",
      () => /\/(login|upload|works\/\d+\/report)/,
      ["sign in"],
    ],
  ];

  it.each(removals)(
    "Without %s, the crawl as %s fails, naming what it lost",
    async (_, visitor, path, lost) => {
      const result = await crawlAs(visitor, hrefsTo(path(running.seeded)));
      const names = unreached(visitor, result);
      // SAFETY: the crawl without the link must lose the pages that only it led to.
      expect(names).toEqual(expect.arrayContaining(lost));
      // SAFETY: `lost` has at least one name in every case above.
      const [firstLost] = lost as [string, ...string[]];
      expect(() => assertNone("pages no link reaches", visitor, names)).toThrow(firstLost);
    },
  );

  it("Without the header's Sign in link alone, sign in is still reached: Add work leads to it", async () => {
    const result = await crawlAs("anonymous", hrefsTo(/\/login/));
    // SAFETY: a blind spot the crawl has, written down: it counts a redirect as a way in, so
    // one missing link goes unseen while another leads to the same page. The header journey,
    // which clicks Sign in, is what shows that link.
    expect(unreached("anonymous", result)).toEqual([]);
  });

  it("A link to a page that is gone fails the crawl as a dead link", async () => {
    const add = (html: string) => html.replace("</body>", '<a href="/q1b-gone">x</a></body>');
    const result = await crawlAs("anonymous", add);
    expect(result.dead.map(({ to, status }) => [to, status])).toEqual([["/q1b-gone", 404]]);
  });

  it("A link to a page on the unlinked list fails the crawl, so the list can't go stale", async () => {
    const add = (html: string) => html.replace("</body>", '<a href="/logout">x</a></body>');
    const result = await crawlAs("reader", add);
    const stale = staleUnlinked(result, OPEN_PAGES, running.seeded, "reader", UNLINKED);
    expect(stale).toEqual(["sign out"]);
  });
});

describe("crawl: before launch", () => {
  const running = useJourneySite({ prelaunch: true });
  let parser: Page;
  let results: Record<"anonymous" | "moderator", CrawlResult>;
  // SAFETY: these pages ignore the seeded ids; a closed archive has none.
  const seeded = {} as Inventory;

  beforeAll(async () => {
    const { site } = running;
    parser = await blankParser(site);
    const moderator = await signedIn(site, {
      email: "jh-prelaunch@example.test",
      role: "moderator",
    });
    const crawlWith = async (context: BrowserContext | undefined) =>
      crawl(site, parser, await visitorOf(context));
    results = {
      anonymous: await crawlWith(undefined),
      moderator: await crawlWith(moderator.context),
    };
  });

  it.each(["anonymous", "moderator"] as const)(
    "As %s, reaches every page that is not on the unlinked list",
    (visitor) => {
      const names = unreachedPages(results[visitor], PRELAUNCH_PAGES, seeded, visitor, UNLINKED);
      assertNone("pages no link reaches before launch", visitor, names);
      assertNone(
        "unlinked pages a link now reaches before launch",
        visitor,
        staleUnlinked(results[visitor], PRELAUNCH_PAGES, seeded, visitor, UNLINKED),
      );
      expect(results[visitor].dead).toEqual([]);
    },
  );

  it("Reaches none of /upload, /me/uploads, /remove and /dmca by a link before launch", () => {
    // Before launch these are disabled, with no href, so they lead nowhere. This reads the
    // crawl's record of the pages it reached, not how the disabled items look or read.
    const { seen } = results.moderator;
    // The premise: the crawl read the signed-in header, so an empty record can't pass this.
    expect(seen.has("/admin")).toBe(true);
    for (const closed of ["/upload", "/me/uploads", "/remove", "/dmca"]) {
      expect(seen.has(closed)).toBe(false);
    }
  });
});
