import { createDb } from "@archive/db";
import { putFragments, seedVersion, seedWork, type SeededVersion } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emailsTo, fetchW, LOGIN_TOKEN, postLogin, signIn as signInAs } from "./helpers";

// I6's web cases: what the signed-out reader, the uploader and a moderator see of a
// version with review reasons and of a held version. The rows are seeded the way ingest
// leaves them (its own end of this is in apps/ingest/test). One database serves every
// test file of a project, so this file keeps to AO3 work IDs 40650 to 40699, titles
// "i6-...", and asserts only its own rows in the queue. Text is synthetic markers.
const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
afterAll(() => db.destroy());

const NOTICE = "Chapters may be imperfect; a moderator will check.";
const TAGS = [{ type: "rating" as const, name: "i6-General Audiences" }];

/** Held: v1 is current, v2 is held for review. */
const HELD = 40650;
/** Live with review reasons from its first upload. */
const FLAGGED = 40651;
/** v1 clean, then a flagged v2 that replaced it. */
const REPLACED = 40652;

let counter = 0;
/** Signs a new user in and returns their id and session cookie. */
async function signIn(): Promise<{ userId: string; cookie: string }> {
  const email = `i6-${Date.now()}-${counter++}@example.test`;
  const cookie = await signInAs(email, { next: "/upload", acceptTerms: true });
  const user = await db
    .selectFrom("user")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirstOrThrow();
  return { userId: user.id, cookie };
}

/** Signs `email` in through the Worker and gives the account the moderator role. */
async function signInModerator(email: string): Promise<string> {
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

const chapters = (marker: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({ html: `<p>${marker}-${i + 1}-TEXT</p>` }));

let uploader: { userId: string; cookie: string };
let stranger: { userId: string; cookie: string };
let moderator: string;
let held: SeededVersion;
let flagged: SeededVersion;
let replaced: SeededVersion;

// R2 writes go in beforeAll: isolated storage undoes those made inside an `it`.
beforeAll(async () => {
  uploader = await signIn();
  stranger = await signIn();
  moderator = await signInModerator("i6-moderator@example.test");

  const v1 = await seedWork(db, {
    ao3WorkId: HELD,
    title: `i6-${HELD}`,
    tags: TAGS,
    userId: uploader.userId,
    chapters: chapters("I6-V1", 3),
  });
  await putFragments(env.BUCKET, v1.fragments);
  // A tampered newer upload, held: four chapters, so chapter 4 is only the held version's.
  held = await seedVersion(db, v1, {
    current: false,
    title: "i6-held-title-marker",
    chapters: chapters("I6-HELD", 4),
  });
  await putFragments(env.BUCKET, held.fragments);

  flagged = await seedWork(db, {
    ao3WorkId: FLAGGED,
    title: `i6-${FLAGGED}`,
    tags: TAGS,
    userId: uploader.userId,
    reviewReasons: ["missing_rating"],
    chapters: chapters("I6-FLAGGED", 3),
  });
  await putFragments(env.BUCKET, flagged.fragments);

  const first = await seedWork(db, {
    ao3WorkId: REPLACED,
    title: `i6-${REPLACED}`,
    tags: TAGS,
    userId: uploader.userId,
    chapters: chapters("I6-OLD", 3),
  });
  await putFragments(env.BUCKET, first.fragments);
  replaced = await seedVersion(db, first, {
    reviewReasons: ["chapter_count_mismatch: parsed 4, Stats says 5"],
    chapters: chapters("I6-NEW", 4),
  });
  await putFragments(env.BUCKET, replaced.fragments);
});

const get = async (path: string, cookie?: string) => {
  const res = await fetchW(path, { headers: cookie === undefined ? {} : { cookie } });
  return { status: res.status, html: await res.text() };
};

const queue = async () => {
  const { status, html } = await get("/admin/works", moderator);
  expect(status).toBe(200);
  return html;
};

/** The cells of the one row that mentions `marker`. */
function rowWith(html: string, marker: string): string[] {
  const rows = html.match(/<tr><td>.*?<\/tr>/g) ?? [];
  const [row, ...others] = rows.filter((r) => r.includes(marker));
  expect(others, marker).toEqual([]);
  expect(row, marker).toBeDefined();
  return [...(row ?? "").matchAll(/<td>(.*?)<\/td>/g)].map((m) => m[1] ?? "");
}

/** The text of the badge in the list item for upload `id`. */
function badgeOf(html: string, id: string): string | undefined {
  const item = html.match(new RegExp(`<li[^>]*data-upload-id="${id}"[^>]*>[\\s\\S]*?</li>`))?.[0];
  return item?.match(/<span class="badge"[^>]*>([^<]*)<\/span>/)?.[1];
}

describe("03-upload-status: review reasons", () => {
  it("Live upload with review reasons is still live", async () => {
    const res = await fetchW(`/uploads/${flagged.uploadId}`, {
      headers: { cookie: uploader.cookie },
    });
    // SAFETY: GET /uploads/:id answers JSON.
    const body = (await res.json()) as { status: string; work: { url: string } | null };

    expect(res.status).toBe(200);
    expect(body.status).toBe("live");
    expect(body.work?.url).toBe(`/works/${FLAGGED}`);
    const page = await get(body.work?.url ?? "");
    expect(page.status).toBe(200);
    expect(page.html).toContain(`<p class="review-notice">${NOTICE}</p>`);
  });
});

describe("08-versioning-and-dedupe: held version", () => {
  it("Held version is never public", async () => {
    const paths = [
      `/works/${HELD}`,
      `/works/${HELD}/chapters/1`,
      `/works/${HELD}/chapters/2`,
      `/works/${HELD}/chapters/3`,
      `/works/${HELD}/full`,
    ];
    for (const path of paths) {
      const { status, html } = await get(path);
      expect(status, path).toBe(200);
      expect(html, path).not.toContain("i6-held-title-marker");
      expect(html, path).not.toContain("I6-HELD");
    }
    // Only v1 is served: its title and its text.
    expect((await get(`/works/${HELD}`)).html).toContain(`i6-${HELD}`);
    const full = (await get(`/works/${HELD}/full`)).html;
    for (const n of [1, 2, 3]) expect(full).toContain(`I6-V1-${n}-TEXT`);
    // A chapter only the held version has is not found.
    expect((await get(`/works/${HELD}/chapters/4`)).status).toBe(404);
  });

  it("The held version is listed for its uploader and for moderators", async () => {
    const mine = await get("/me/uploads", uploader.cookie);
    expect(badgeOf(mine.html, held.uploadId)).toBe("Held for review");
    expect((await get("/me/uploads", stranger.cookie)).html).not.toContain(held.uploadId);

    expect(rowWith(await queue(), `i6-${HELD} (`)[2]).toBe("Held version");
  });
});

describe("08-versioning-and-dedupe: flagged newer upload", () => {
  it("Flagged newer upload replaces and shows the notice", async () => {
    // The work and reader pages are v2's: its chapters, with the notice once on each.
    const work = await get(`/works/${REPLACED}`);
    expect(work.html).toContain(`<p class="review-notice">${NOTICE}</p>`);
    for (const path of [`/works/${REPLACED}/chapters/2`, `/works/${REPLACED}/full`]) {
      const { status, html } = await get(path);
      expect(status, path).toBe(200);
      expect(html.split(NOTICE), path).toHaveLength(2);
      expect(html, path).not.toContain("I6-OLD");
    }
    expect((await get(`/works/${REPLACED}/chapters/4`)).html).toContain("I6-NEW-4-TEXT");

    // Listed in Works to check, with its reason.
    expect(rowWith(await queue(), `i6-${REPLACED} (`)[2]).toBe(
      "Review reasons: chapter_count_mismatch: parsed 4, Stats says 5",
    );

    // Its upload is live, not held.
    const res = await fetchW(`/uploads/${replaced.uploadId}`, {
      headers: { cookie: uploader.cookie },
    });
    // SAFETY: GET /uploads/:id answers JSON.
    expect(((await res.json()) as { status: string }).status).toBe("live");
  });

  it("A live version with review reasons is listed in Works to check", async () => {
    expect(rowWith(await queue(), `i6-${FLAGGED} (`)[2]).toBe("Review reasons: missing_rating");
  });
});
