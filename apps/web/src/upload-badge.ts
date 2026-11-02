import type { UploadStatus } from "@archive/db";

// What the My uploads page says about an upload's status. The server renders it and the
// page's script (my-uploads-script.ts) repeats it, so both read this one table.

// Seconds between refreshes (the no-JS meta refresh) and between polls (the script)
// while an upload is in progress.
export const REFRESH_SECONDS = 5;

// The badge text for each status that isn't a rejection. Every other status is treated
// as a rejection code, so one added later still gets the generic label. Draft copy: U6c
// words the messages for each code.
export const LABELS: Partial<Record<UploadStatus, string>> = {
  pending: "Not uploaded yet",
  processing: "Processing",
  live: "Live",
  held_for_review: "Held for review",
  duplicate: "Already in the archive",
  // ARCHITECTURE: over_quota is not a rejection, the day's limit was spent.
  over_quota: "Daily limit reached",
};
export const REJECTED = "Rejected";

/** A confirmed `pending` upload waits for ingest, so it counts as in progress. */
export const inProgress = (status: UploadStatus, confirmed: boolean) =>
  status === "processing" || (status === "pending" && confirmed);

/** The badge text for an upload. */
export const badgeLabel = (status: UploadStatus, confirmed: boolean): string =>
  status === "pending" && confirmed ? "Processing" : (LABELS[status] ?? REJECTED);
