// A work's admin page under /admin: every version of it, and "Make current", which
// repoints the work at one of them (FRONTEND-DISCOVERY, Moderation queues). Mounted in
// admin.ts, behind `adminGate`.

import { makeVersionCurrent } from "@archive/db";
import { Hono } from "hono";
import type { AdminEnv } from "./admin";
import { workByAo3Id } from "./admin-items";
import { resultPage, workActions, workAdminPage, workStatusText } from "./admin-pages";
import { readForm } from "./login";

/** Plenty for the one field the form carries: a version's id. */
const MAX_FORM = 1024;

export const adminWork = new Hono<AdminEnv>();

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
      "user.email",
    ])
    .where("work_versions.work_id", "=", found.id)
    .orderBy("work_versions.created_at")
    .orderBy("work_versions.id")
    .execute();
  return c.html(
    workAdminPage(
      work.title,
      work.ao3_work_id,
      workStatusText(work.status, work.hidden_cause),
      versions.map((v) => ({
        id: v.id,
        added: v.created_at.toISOString(),
        uploader: v.email ?? "",
        chapters: v.chapter_count,
        current: v.id === work.current_version_id,
        held: v.upload_status !== "live",
      })),
      workActions(work.ao3_work_id, null),
    ),
  );
});

adminWork.post("/works/:id/current", async (c) => {
  const found = await workByAo3Id(c, c.req.param("id"));
  if (!found) return c.notFound();
  // The segment passed `workByAo3Id`, so it is digits: normalised, as the page's forms are.
  const back = `/admin/works/${Number(c.req.param("id"))}`;
  const form = await readForm(c.req.raw, MAX_FORM);
  const versionId = form?.get("version");
  // Ids are uuids: anything else is no version, and never reaches the database.
  if (versionId === null || versionId === undefined || !/^[\w-]{1,64}$/.test(versionId)) {
    return c.notFound();
  }
  // Only one of this work's own versions: the database refuses any other (a composite
  // foreign key), and a version of another work is a page that isn't there.
  const version = await c.var.db
    .selectFrom("work_versions")
    .innerJoin("uploads", "uploads.id", "work_versions.upload_id")
    .select("uploads.status")
    .where("work_versions.id", "=", versionId)
    .where("work_versions.work_id", "=", found.id)
    .executeTakeFirst();
  if (!version) return c.notFound();
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
