import { createDb, type UploadStatus } from "@archive/db";
import type { Context } from "hono";
import type { Bindings } from "./env";
import type { SecurityVariables } from "./security";
import type { SessionVariables } from "./session";

// ARCHITECTURE, Ingestion pipeline, step 5. The My uploads page's script polls
// `GET /uploads/:id` while an upload is in progress.

type StatusContext = Context<{
  Bindings: Bindings;
  Variables: SecurityVariables & SessionVariables;
}>;

// A reply names one user's upload: no cache keeps it.
const NO_STORE = { "Cache-Control": "no-store" };

/** What the poll answers: the status as stored, and the work only once it is open to read. */
export interface UploadStatusBody {
  id: string;
  status: UploadStatus;
  work: { id: number; url: string } | null;
}

/**
 * The poll's JSON for an `uploads` row and the work it points at. Only a live or
 * duplicate upload links its work, and only while that work is itself live: a hidden
 * or removed work's existence isn't something the uploader is told here.
 */
export function uploadStatusBody(
  upload: { id: string; status: UploadStatus },
  work: { ao3_work_id: number; status: string } | null,
): UploadStatusBody {
  const linked =
    work !== null &&
    work.status === "live" &&
    (upload.status === "live" || upload.status === "duplicate");
  return {
    id: upload.id,
    status: upload.status,
    work: linked ? { id: work.ao3_work_id, url: `/works/${work.ao3_work_id}` } : null,
  };
}

/**
 * `GET /uploads/:id`: the upload's status as JSON, to the user who made it. Anyone
 * else, and an id that doesn't exist, get the same 404, from one query, so the two
 * can't be told apart.
 */
export async function showUploadStatus(c: StatusContext) {
  // A script can't follow a sign-in redirect, so it gets a 401 to act on.
  const user = c.var.session?.user;
  if (user === undefined) return c.json({ error: "Sign in to see your uploads." }, 401, NO_STORE);

  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  try {
    const row = await db
      .selectFrom("uploads")
      .leftJoin("works", "works.id", "uploads.work_id")
      .select(["uploads.id", "uploads.status", "works.ao3_work_id", "works.status as work_status"])
      .where("uploads.id", "=", c.req.param("id") ?? "")
      .where("uploads.user_id", "=", user.id)
      .executeTakeFirst();
    if (row === undefined) return c.json({ error: "That upload wasn't found." }, 404, NO_STORE);
    const work =
      row.ao3_work_id === null || row.work_status === null
        ? null
        : { ao3_work_id: row.ao3_work_id, status: row.work_status };
    return c.json(uploadStatusBody(row, work), 200, NO_STORE);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
}
