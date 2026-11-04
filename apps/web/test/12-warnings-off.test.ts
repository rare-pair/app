import { createDb } from "@archive/db";
import { putFragments, seedWork } from "@archive/db/seed";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchW, signIn } from "./helpers";

// Every work here has an AO3 work ID in 12100-12199, so no other test file sharing the
// database sees them.
const M = 12101; // Mature
const E = 12102; // Explicit
const V = 12103; // Teen, with a warning
const C = 12104; // Teen, creator chose not to use warnings
const N = 12106; // no rating
const H = 12107; // Mature and hidden

const NO_WARNINGS = { type: "warning" as const, name: "No Archive Warnings Apply" };
const FIELD = "warnings_off";

const db = createDb({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });

beforeAll(async () => {
  const works = [
    { ao3WorkId: M, rating: "Mature", tags: [NO_WARNINGS] },
    { ao3WorkId: E, rating: "Explicit", tags: [NO_WARNINGS] },
    {
      ao3WorkId: V,
      rating: "Teen And Up Audiences",
      tags: [{ type: "warning" as const, name: "Graphic Depictions Of Violence" }],
    },
    {
      ao3WorkId: C,
      rating: "Teen And Up Audiences",
      tags: [{ type: "warning" as const, name: "Creator Chose Not To Use Archive Warnings" }],
    },
    { ao3WorkId: N, rating: null, tags: [NO_WARNINGS], reviewReasons: ["missing_rating"] },
    {
      ao3WorkId: H,
      rating: "Mature",
      tags: [NO_WARNINGS],
      status: "hidden" as const,
      hiddenCause: "moderator" as const,
    },
  ];
  for (const options of works) {
    const w = await seedWork(db, {
      ...options,
      title: `R9 work ${options.ao3WorkId}`,
      // Synthetic markers only: no fic text in tests.
      chapters: Array.from({ length: 5 }, (_, i) => ({
        html: `<p>R9-${options.ao3WorkId}-${i + 1}</p>`,
      })),
    });
    await putFragments(env.BUCKET, w.fragments);
  }
});

afterAll(() => db.destroy());

const chapter = (id: number, n: number) => `/works/${id}/chapters/${n}`;
const full = (id: number) => `/works/${id}/full`;
const FORM = {
  "content-type": "application/x-www-form-urlencoded",
  origin: "https://rarepair.fans",
};

const post = (path: string, fields: Record<string, string>, cookie = "") =>
  fetchW(path, {
    method: "POST",
    headers: { ...FORM, cookie },
    body: new URLSearchParams(fields).toString(),
  });

const warningsOffOf = async (email: string) =>
  (
    await db
      .selectFrom("user")
      .select("warnings_off")
      .where("email", "=", email)
      .executeTakeFirstOrThrow()
  ).warnings_off;

/** The status of reading `path` with `cookie`: 200 when it opens, 302 when it goes to the screen. */
const status = async (path: string, cookie: string) =>
  (await fetchW(path, { headers: { cookie } })).status;

describe("12-warnings-interstitial: turning the screen off", () => {
  it("Signed-out readers get no turn-off option", async () => {
    const screen = await (await fetchW(`/works/${M}/warnings`)).text();
    expect(screen).not.toContain(FIELD);
    const settings = await (await fetchW("/settings/reader")).text();
    expect(settings).not.toContain(FIELD);
    expect(settings).not.toContain("warnings_screen");
    // A signed-out post that carries the field changes nothing but the usual cookie.
    const posted = await post(`/works/${M}/warnings`, { next: chapter(M, 1), [FIELD]: "on" });
    expect(posted.status).toBe(303);
    expect(posted.headers.getSetCookie().map((c) => c.split("=")[0])).toEqual(["__Host-warned"]);
    expect(await status(chapter(E, 1), "")).toBe(302);
  });

  it("Signed-in readers can turn the screen off", async () => {
    const email = "r9-a@example.invalid";
    const cookie = await signIn(email, { acceptTerms: true });
    const screen = await (await fetchW(`/works/${M}/warnings`, { headers: { cookie } })).text();
    expect(screen).toContain(`name="${FIELD}"`);
    expect(await warningsOffOf(email)).toBe(false);

    const posted = await post(
      `/works/${M}/warnings`,
      { next: chapter(M, 1), [FIELD]: "on" },
      cookie,
    );
    expect(posted.status).toBe(303);
    expect(await warningsOffOf(email)).toBe(true);

    // The session cookie alone: no __Host-warned.
    expect(await status(chapter(E, 1), cookie)).toBe(200);
    expect(await status(chapter(V, 3), cookie)).toBe(200);
    expect(await status(full(C), cookie)).toBe(200);
    expect(await status(chapter(N, 1), cookie)).toBe(200);
    // The screen itself goes straight on to the page asked for.
    expect(await status(`/works/${E}/warnings`, cookie)).toBe(302);

    // Another device: a new session for the same account.
    const other = await signIn(email, { acceptTerms: true });
    expect(await status(chapter(E, 1), other)).toBe(200);
  });

  it("Another account still gets the screen", async () => {
    const cookie = await signIn("r9-b@example.invalid", { acceptTerms: true });
    expect(await status(chapter(M, 1), cookie)).toBe(302);
  });

  it("Continuing without the box ticked leaves the account alone", async () => {
    const email = "r9-c@example.invalid";
    const cookie = await signIn(email, { acceptTerms: true });
    await post(`/works/${M}/warnings`, { next: chapter(M, 1) }, cookie);
    expect(await warningsOffOf(email)).toBe(false);
  });

  it("A hidden work stays withheld for a reader with warnings off", async () => {
    const cookie = await signIn("r9-a@example.invalid", { acceptTerms: true });
    expect(await status(chapter(H, 1), cookie)).toBe(451);
  });

  it("A cross-site post turns nothing off", async () => {
    const email = "r9-d@example.invalid";
    const cookie = await signIn(email, { acceptTerms: true });
    const res = await fetchW(`/works/${M}/warnings`, {
      method: "POST",
      headers: { ...FORM, origin: "https://evil.example", cookie },
      body: new URLSearchParams({ next: chapter(M, 1), [FIELD]: "on" }).toString(),
    });
    expect(res.status).toBe(403);
    expect(await warningsOffOf(email)).toBe(false);
  });

  it("Signed-in readers can turn it off from settings", async () => {
    const email = "r9-e@example.invalid";
    const cookie = await signIn(email, { acceptTerms: true });
    const page = await (await fetchW("/settings/reader", { headers: { cookie } })).text();
    expect(page).toContain(`name="warnings_screen"`);
    expect(page).toMatch(/<option value="skip"[^>]*>/);

    const saved = await post(
      "/settings/reader",
      { warnings_screen: "skip", next: "/settings/reader" },
      cookie,
    );
    expect(saved.status).toBe(303);
    expect(await warningsOffOf(email)).toBe(true);
    // The settings cookie carries only the display settings.
    const settingsCookie = saved.headers.getSetCookie().find((c) => c.startsWith("__Host-reader="));
    expect(settingsCookie).toBeDefined();
    expect(settingsCookie).not.toContain("warn");
    expect(await status(chapter(E, 1), cookie)).toBe(200);

    const again = await (await fetchW("/settings/reader", { headers: { cookie } })).text();
    expect(again).toMatch(/<option value="skip" selected>/);

    // A post without the field (the reader bar's) leaves the account value alone.
    await post("/settings/reader", { theme: "dark" }, cookie);
    expect(await warningsOffOf(email)).toBe(true);
    // Turning it back on.
    await post("/settings/reader", { warnings_screen: "show" }, cookie);
    expect(await warningsOffOf(email)).toBe(false);
    expect(await status(chapter(E, 1), cookie)).toBe(302);
  });

  it("A signed-out settings post with the field writes nothing", async () => {
    const res = await post("/settings/reader", { warnings_screen: "skip" });
    expect(res.status).toBe(303);
    expect(await status(chapter(E, 1), "")).toBe(302);
  });
});
