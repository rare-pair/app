import { createDb, type UploadStatus } from "@archive/db";
import type { Context } from "hono";
import type { Bindings } from "./env";
import { escapeHtml, layout } from "./pages";
import type { SecurityVariables } from "./security";
import type { SessionVariables } from "./session";
import { joinedWork, uploadStatusBody } from "./upload-status";

// FRONTEND-DISCOVERY, Page inventory (My uploads). The page lists the signed-in user's
// uploads and, with no JavaScript, refreshes itself while one is in progress.

type MyUploadsContext = Context<{
  Bindings: Bindings;
  Variables: SecurityVariables & SessionVariables;
}>;

// The newest uploads shown, with no paging. Rows made before a confirm, and rejections,
// aren't counted by the quota, so a long list is possible: the page says when it is cut.
const LIST_LIMIT = 50;

// Seconds between refreshes while an upload is in progress.
const REFRESH_SECONDS = 5;

// The badge text for each status that isn't a rejection. Every other status is a
// rejection code, so one added later still gets the generic label. Draft copy: U6c
// words the messages for each code.
const LABELS: Partial<Record<UploadStatus, string>> = {
  pending: "Not uploaded yet",
  processing: "Processing",
  live: "Live",
  held_for_review: "Held for review",
  duplicate: "Already in the archive",
};
const REJECTED = "Rejected";

/** A confirmed `pending` upload waits for ingest, so it counts as in progress. */
const inProgress = (status: UploadStatus, confirmed: boolean) =>
  status === "processing" || (status === "pending" && confirmed);

/** The badge text for an upload. */
const badgeLabel = (status: UploadStatus, confirmed: boolean): string =>
  status === "pending" && confirmed ? "Processing" : (LABELS[status] ?? REJECTED);

/** "2026-03-04 05:06 UTC" */
const utcMinute = (at: Date) => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

interface Row {
  id: string;
  status: UploadStatus;
  created_at: Date;
  quota_counted_at: Date | null;
  ao3_work_id: number | null;
  work_status: string | null;
  title: string | null;
}

function item(row: Row): string {
  const link = uploadStatusBody(row, joinedWork(row)).work;
  const name =
    link !== null && row.title !== null
      ? `<a href="${escapeHtml(link.url)}">${escapeHtml(row.title)}</a>`
      : escapeHtml(`Upload of ${utcMinute(row.created_at)}`);
  const label = badgeLabel(row.status, row.quota_counted_at !== null);
  return `<li data-upload-id="${escapeHtml(row.id)}" data-status="${escapeHtml(row.status)}">${name} <span class="badge">${label}</span><p class="upload-message"></p></li>`;
}

/**
 * The `/me/uploads` page, in `layout`. The meta refresh sits in the head, and only
 * while some upload is in progress.
 */
export function myUploadsPage(rows: Row[]) {
  const refresh = rows.some((r) => inProgress(r.status, r.quota_counted_at !== null))
    ? `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">`
    : "";
  const body =
    rows.length === 0
      ? `<p>You haven't uploaded anything yet. <a href="/upload">Upload a work</a>.</p>`
      : `<ul class="upload-list">\n${rows.map(item).join("\n")}\n</ul>${
          rows.length === LIST_LIMIT
            ? `\n<p>Showing your ${LIST_LIMIT} most recent uploads.</p>`
            : ""
        }`;
  return layout("My uploads", body, refresh);
}

/** `GET /me/uploads`: the signed-in user's uploads, newest first. Signing in is `requireSignIn`'s. */
export async function showMyUploads(c: MyUploadsContext) {
  // `requireSignIn` runs first, so there is a session here.
  const user = c.var.session?.user;
  if (user === undefined) return c.notFound();

  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    const rows = await db
      .selectFrom("uploads")
      .leftJoin("works", "works.id", "uploads.work_id")
      .select([
        "uploads.id",
        "uploads.status",
        "uploads.created_at",
        "uploads.quota_counted_at",
        "works.ao3_work_id",
        "works.status as work_status",
        "works.title",
      ])
      .where("uploads.user_id", "=", user.id)
      .orderBy("uploads.created_at", "desc")
      .orderBy("uploads.id")
      .limit(LIST_LIMIT)
      .execute();
    c.header("Cache-Control", "no-store");
    return c.html(myUploadsPage(rows));
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
