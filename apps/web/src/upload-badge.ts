import type { UploadStatus } from "@archive/db";
import { MAX_PDF_MB, MAX_UPLOAD_MB } from "./upload-limit";

// What the My uploads page says about an upload's status. The server renders it and the
// page's script (my-uploads-script.ts) repeats it, so both read these tables. All of the
// copy is draft, for the operator to proof.

// Seconds between refreshes (the no-JS meta refresh) and between polls (the script)
// while an upload is in progress.
export const REFRESH_SECONDS = 5;

// The badge text for each status. A rejection code reads "Rejected: <short reason>".
// ARCHITECTURE: over_quota is not a rejection, the day's limit was spent.
export const LABELS: Record<UploadStatus, string> = {
  pending: "Not uploaded yet",
  processing: "Processing",
  live: "Live",
  held_for_review: "Held for review",
  duplicate: "Already in the archive",
  not_ao3: "Rejected: not an AO3 export",
  not_epub: "Rejected: not an EPUB or PDF",
  zip_bomb: "Rejected: file can't be opened safely",
  too_large: "Rejected: too large",
  // opted_out stands for an opt-out and a takedown alike, so the badge says neither.
  opted_out: "Rejected",
  parse_failed: "Failed",
  over_quota: "Daily limit reached",
  work_removed: "Rejected",
  account_banned: "Rejected: account can't upload",
  pdf_unreadable: "Rejected: couldn't read this PDF",
};
// The badge for a status the script doesn't know (one added after the page was served).
export const REJECTED = "Rejected";

// The message under the badge: what happened and what to do next. Nothing here names an
// internal field, a moderator's reason or AO3 as anything but where the file came from.
export const MESSAGES: Record<UploadStatus, string> = {
  pending: "This file hasn't finished uploading. Upload it again from the upload page.",
  processing: "We're reading this file. This page updates by itself.",
  live: "This work is in the archive.",
  held_for_review: "A moderator will check this upload. You don't need to do anything.",
  duplicate: "This work is already in the archive, so nothing was added from your file.",
  not_ao3:
    "This file isn't an AO3 download, so we can't accept it here. Download the work from AO3 as an EPUB and upload that.",
  not_epub:
    "This file isn't a valid EPUB or PDF, so we couldn't read it. Download a fresh copy and try again.",
  zip_bomb: "This file is built in a way we won't open. Download a fresh EPUB and try again.",
  too_large: `This file is too large. We accept EPUBs up to ${MAX_UPLOAD_MB} MB and PDFs up to ${MAX_PDF_MB} MB.`,
  opted_out: "This work can't be added to the archive.",
  parse_failed:
    "We couldn't process this file. Try uploading it again; if it keeps failing, the file may be damaged.",
  over_quota: "You've reached today's daily limit for uploads. Try again later.",
  work_removed: "This work was removed from the archive.",
  account_banned: "This account can no longer upload.",
  pdf_unreadable:
    "We couldn't read this PDF: it may be protected or damaged, or its chapters couldn't be told apart. An EPUB of the work would work.",
};
// For a status the script doesn't know (one added after the page was served).
export const FALLBACK_MESSAGE = "Reload this page to see the latest on this upload.";
// A live or duplicate upload's work may since have been hidden or removed. With no link
// to it the message doesn't say the work is in the archive.
export const UNLINKED: Partial<Record<UploadStatus, string>> = {
  live: "This upload has been processed.",
  duplicate: "Nothing was added from this file.",
};

/** A confirmed `pending` upload waits for ingest, so it counts as in progress. */
export const inProgress = (status: UploadStatus, confirmed: boolean) =>
  status === "processing" || (status === "pending" && confirmed);

// A row's status comes from the database, so one this Worker is a deploy behind on still renders.

/** The badge text for an upload. */
export const badgeLabel = (status: UploadStatus, confirmed: boolean): string =>
  status === "pending" && confirmed
    ? LABELS.processing
    : Object.hasOwn(LABELS, status)
      ? LABELS[status]
      : REJECTED;

/** The message for an upload; `linked` is whether its work is open to read and linked. */
export const messageFor = (status: UploadStatus, confirmed: boolean, linked: boolean): string =>
  status === "pending" && confirmed
    ? MESSAGES.processing
    : (!linked && UNLINKED[status]) ||
      (Object.hasOwn(MESSAGES, status) ? MESSAGES[status] : FALLBACK_MESSAGE);
