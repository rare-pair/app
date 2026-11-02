// A work's admin page under /admin: every version of it, and "Make current", which
// repoints the work at one of them (FRONTEND-DISCOVERY, Moderation queues). Mounted in
// admin.ts, behind `adminGate`.

import { approveVersion, closeWrongVersionReports, makeVersionCurrent } from "@archive/db";
import { Hono, type Context } from "hono";
import { isModerator, type AdminEnv } from "./admin";
import { workByAo3Id } from "./admin-items";
import { resultPage, workActions, workAdminPage, workStatusText } from "./admin-pages";
import { readForm } from "./login";

/** Plenty for the one field the form carries: a version's id. */
const MAX_FORM = 1024;

export const adminWork = new Hono<AdminEnv>();

/**
 * The version a form's `version` field names, when it is one of this work's own: its id and
 * its upload's status. Null otherwise, which is a page that isn't there. Ids are uuids:
 * anything else is no version, and never reaches the database. The database refuses another
 * work's version too (a composite foreign key).
 */
async function formVersion(c: Context<AdminEnv>, workId: string) {
  const form = await readForm(c.req.raw, MAX_FORM);
  const versionId = form?.get("version");
  if (versionId === null || versionId === undefined || !/^[\w-]{1,64}$/.test(versionId)) {
    return null;
  }
  const version = await c.var.db
    .selectFrom("work_versions")
    .innerJoin("uploads", "uploads.id", "work_versions.upload_id")
    .select(["work_versions.id", "uploads.status"])
    .where("work_versions.id", "=", versionId)
    .where("work_versions.work_id", "=", workId)
    .executeTakeFirst();
  return version ?? null;
}

adminWork.get("/works/:id", async (c) => {
  const found = await workByAo3Id(c, c.req.param("id"));
  if (!found) return c.notFound();
  const work = await c.var.db
    .selectFrom("works")
    .select(["title", "ao3_work_id", "status", "hidden_cause", "current_version_id"])
    .where("id", "=", found.id)
    .executeTakeFirstOrThrow();
  const versions = await c.var.db
    .selectFrom("work_versions")
    .innerJoin("uploads", "uploads.id", "work_versions.upload_id")
    .leftJoin("user", "user.id", "uploads.user_id")
    .select([
      "work_versions.id",
      "work_versions.created_at",
      "work_versions.chapter_count",
      "uploads.status as upload_status",
      "work_versions.review_reasons",
      "work_versions.checked_at",
      "work_versions.hold_reason",
      "user.id as user_id",
      "user.email",
      "user.banned_at",
      "user.role",
    ])
    .where("work_versions.work_id", "=", found.id)
    .orderBy("work_versions.created_at")
    .orderBy("work_versions.id")
    .execute();
  const wrong = await c.var.db
    .selectFrom("reports")
    .select((eb) => eb.fn.countAll<string>().as("open"))
    .where("work_id", "=", found.id)
    .where("kind", "=", "wrong_version")
    .where("status", "=", "open")
    .executeTakeFirstOrThrow();
  return c.html(
    workAdminPage(
      work.title,
      work.ao3_work_id,
      workStatusText(work.status, work.hidden_cause),
      versions.map((v) => ({
        id: v.id,
        added: v.created_at.toISOString(),
        uploader: v.email ?? "",
        // A moderator or an admin can't be banned, so their rows offer no form.
        uploaderId: isModerator(v.role) ? null : v.user_id,
        banned: v.banned_at !== null,
        chapters: v.chapter_count,
        current: v.id === work.current_version_id,
        held: v.upload_status !== "live",
        holdReason: v.hold_reason,
        reviewReasons: v.review_reasons,
        checked: v.checked_at !== null,
      })),
      workActions(work.ao3_work_id, `/admin/works/${work.ao3_work_id}`),
      Number(wrong.open),
    ),
  );
});

adminWork.post("/works/:id/current", async (c) => {
  const found = await workByAo3Id(c, c.req.param("id"));
  if (!found) return c.notFound();
  // The segment passed `workByAo3Id`, so it is digits: normalised, as the page's forms are.
  const back = `/admin/works/${Number(c.req.param("id"))}`;
  const version = await formVersion(c, found.id);
  if (!version) return c.notFound();
  const versionId = version.id;
  // Only a moderator's approval makes a held version current (ARCHITECTURE, step 7), so
  // only a version whose upload went live (as every replaced one did) is offered here.
  if (version.status !== "live") {
    return c.html(resultPage("Nothing changed: that version is held for review.", back));
  }
  // The work then describes the version: its columns, byline, tags and search text. Not a
  // removed work, and not one ingest is still finishing (it sets the version itself).
  const changed = await makeVersionCurrent(c.var.db, found.id, versionId, {
    actor: c.var.userId,
  });
  return c.html(
    resultPage(
      changed
        ? "That version is now current."
        : "Nothing changed: the work is removed or not finished processing.",
      back,
    ),
  );
});

// Approve: a held version is published, the current version's review notice is cleared.
// Worded from what the write returned: a re-read could come from Hyperdrive's cache.
adminWork.post("/works/:id/approve", async (c) => {
  const found = await workByAo3Id(c, c.req.param("id"));
  if (!found) return c.notFound();
  const back = `/admin/works/${Number(c.req.param("id"))}`;
  const version = await formVersion(c, found.id);
  if (!version) return c.notFound();
  const outcome = await approveVersion(c.var.db, found.id, version.id, { actor: c.var.userId });
  const message = {
    cleared: "The notice is cleared.",
    published: "That version is now published.",
    nothing: "Nothing changed: that version has nothing to approve.",
    unavailable: "Nothing changed: the work is removed or not finished processing.",
  }[outcome];
  return c.html(resultPage(message, back));
});

// Closes the work's open "This version is wrong" reports, which nothing else closes.
adminWork.post("/works/:id/reports/close", async (c) => {
  const found = await workByAo3Id(c, c.req.param("id"));
  if (!found) return c.notFound();
  const back = `/admin/works/${Number(c.req.param("id"))}`;
  const closed = await closeWrongVersionReports(c.var.db, found.id, { actor: c.var.userId });
  return c.html(
    resultPage(
      closed > 0
        ? `Closed ${closed} ${closed === 1 ? "report" : "reports"}.`
        : "Nothing changed: no open reports that a version is wrong.",
      back,
    ),
  );
});
