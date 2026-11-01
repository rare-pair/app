// The entire work on one page: /works/:id/full streams every chapter's sanitized
// fragment from R2, in order, into one page (ARCHITECTURE, Reading). It streams so a
// long work never sits in the isolate's memory: one chunk at a time per reader.

import { createDb, getLiveWork, getWorkAvailability } from "@archive/db";
import { escapeHtml, layoutAround } from "./pages";
import {
  chapterTitle,
  isFragmentKey,
  positiveInt,
  readerBar,
  unavailable,
  type ReaderContext,
} from "./reader";
import { positionScriptTag } from "./position";
import { reviewNotice } from "./review-notice";
import { settingsScriptTag } from "./settings";
import { warningsRedirect } from "./warnings";
import { withheldResponse } from "./withheld";

/** A fragment's bytes, or null when the key is missing. Anything with R2's `get`. */
export interface FragmentSource {
  get(key: string): Promise<{ body: ReadableStream<Uint8Array> } | null>;
}

/** One chapter fragment's body from R2, unread. R7's cache goes in here. */
export const openFragment = async (bucket: FragmentSource, key: string) =>
  (await bucket.get(key))?.body ?? null;

/**
 * A piece of the page: our own markup, a fragment body already opened, or one to open
 * when the reader reaches it.
 */
export type Part =
  | string
  | ReadableStream<Uint8Array>
  | (() => Promise<ReadableStream<Uint8Array> | null>);

/** A chapter row whose fragment isn't in R2: logged by this name, apart from R2 failing. */
export class MissingFragment extends Error {
  override name = "MissingFragment";
}

/** Logs the kind of error only: never its message or the key, which name the work. */
// oxlint-disable-next-line deslop/no-unknown-parameters -- it takes whatever a catch caught, and reads only its name
const logFailure = (error: unknown) =>
  console.error(`Entire work stream: ${error instanceof Error ? error.name : "unknown"}`);

/**
 * The parts as one byte stream, opened one at a time and only as the reader pulls, so a
 * reader who leaves stops the R2 reads. Fragment bytes pass through as they are; only
 * our markup is encoded. A fragment that is missing or fails ends the stream in an
 * error: the 200 is already out, and a truncated page is better than a wrong one.
 */
export function streamParts(parts: Part[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  // Our own copy, so each part is let go once it has been used.
  const queue: (Part | undefined)[] = [...parts];
  let next = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  // Set when the reader leaves, so a pull still waiting on R2 opens nothing more.
  let cancelled = false;
  /** Cancels the open body and any opened ahead that the reader never reached. */
  const release = async () => {
    const open: Promise<void>[] = reader ? [reader.cancel()] : [];
    reader = null;
    for (let i = next; i < queue.length; i++) {
      const part = queue[i];
      if (part instanceof ReadableStream) open.push(part.cancel());
    }
    await Promise.allSettled(open);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Each pull enqueues at least one chunk, or closes.
        for (;;) {
          if (reader) {
            const { done, value } = await reader.read();
            if (cancelled) return;
            if (!done) return controller.enqueue(value);
            reader = null;
          }
          if (next === queue.length) return controller.close();
          const part = queue[next];
          queue[next++] = undefined;
          let body: ReadableStream<Uint8Array> | null;
          if (part instanceof ReadableStream) body = part;
          else if (part instanceof Function) body = await part();
          else return controller.enqueue(encoder.encode(part ?? ""));
          if (cancelled) {
            await body?.cancel();
            return;
          }
          if (!body) throw new MissingFragment();
          reader = body.getReader();
        }
      } catch (error) {
        // A reader who left is not an error.
        if (cancelled) return;
        logFailure(error);
        controller.error(error);
        await release();
      }
    },
    async cancel() {
      cancelled = true;
      await release();
    },
  });
}

export async function showFull(c: ReaderContext) {
  const id = positiveInt(c.req.param("id"));
  if (id === null) return c.notFound();

  // Two sequential queries at most, so one connection. A hidden or removed work answers
  // 451 or 410 here, before anything about its chapters is read.
  const db = createDb({ connectionString: c.env.HYPERDRIVE.connectionString, max: 1 });
  let live;
  let withheld;
  try {
    live = await getLiveWork(db, id);
    if (!live) withheld = await getWorkAvailability(db, id);
  } finally {
    c.executionCtx.waitUntil(db.destroy());
  }
  if (!live) return withheld ? withheldResponse(c, withheld) : c.notFound();
  const gate = warningsRedirect(c, live, `/works/${id}/full`);
  if (gate) return gate;

  // Chapter HTML comes only from fragments the sanitizer wrote, under works/ and this
  // version's own prefix. Every key is checked before anything is read or sent.
  const { chapters, version } = live;
  if (
    chapters.some(
      (ch) => !ch.r2_key.startsWith("works/") || !isFragmentKey(ch.r2_key, id, version.r2_prefix),
    )
  ) {
    return unavailable(c);
  }
  // The first chapter is read before the 200, so R2 being down is a clean 503. A version
  // with no chapters can't be read either.
  const [head, ...rest] = chapters;
  if (!head) return unavailable(c);
  const bucket = c.env.BUCKET;
  const first = await openFragment(bucket, head.r2_key).catch((error: Error) => {
    logFailure(error);
    return null;
  });
  if (!first) return unavailable(c);
  const headers = { "Content-Type": "text/html; charset=UTF-8" };
  // HEAD runs this handler too, and its body is dropped: read nothing more.
  if (c.req.method === "HEAD") {
    await first.cancel();
    return c.body(null, 200, headers);
  }

  const workTitle = live.work.title.trim() || "Untitled work";
  // The settings script comes straight after the bar, not deferred, so the live
  // controls work before a long work has finished streaming.
  const { before, after } = layoutAround(
    `${workTitle}, entire work`,
    "",
    `${readerBar(workTitle, `/works/${id}/full`)}\n${settingsScriptTag(c.get("nonce"), "async")}${positionScriptTag(c.get("nonce"), c.var.session, "async")}`,
  );
  // The fragments are trusted markup only because the sanitizer wrote them; they go in
  // unescaped. The chapter headings' ids stay stable: links may point at them. The
  // markup between two fragments goes out as one part.
  const heading = (ch: { n: number; title: string }) =>
    `<h2 class="chapter-title" id="chapter-${ch.n}">${escapeHtml(chapterTitle(ch))}</h2>\n<article class="chapter">`;
  const parts: Part[] = [`${before}${reviewNotice(version)}${heading(head)}`, first];
  // Each later chapter keeps only its key and the bucket for the life of the stream.
  for (const ch of rest) {
    const key = ch.r2_key;
    parts.push(`</article>\n${heading(ch)}`, () => openFragment(bucket, key));
  }
  parts.push(
    `</article>\n<p class="back"><a href="/works/${id}">Back to the work page</a></p>${after}`,
  );
  return c.body(streamParts(parts), 200, headers);
}
