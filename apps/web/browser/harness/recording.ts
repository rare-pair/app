import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page, Video } from "playwright";
import { expect } from "vitest";

/** Over this, `finish` fails: a recording too long to review, and too big to pass around. */
const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
const MAX_NAME_LENGTH = 100;

/**
 * A file name for `testName`: lowercase, each run of anything else a hyphen, cut to a sensible
 * length, with `-2`, `-3` for a name already in `taken`, which it joins.
 */
export function videoName(testName: string, taken: Set<string>): string {
  const base = testName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/^-|-$/g, "");
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

/**
 * Records the pages of the contexts it watches into `dir`, one WebM a page, named for the test
 * that opened it. A page opened outside a test has no recording. Videos hold the viewport only.
 */
export function startRecorder(dir: string, maxBytes = MAX_VIDEO_BYTES) {
  const contexts: BrowserContext[] = [];
  const videos = new Map<Page, { video: Video; testName: string | undefined }>();
  return {
    /** For `browser.newContext`. Without a size Playwright fits the viewport into 800x800. */
    contextOptions: { recordVideo: { dir } },
    watch(context: BrowserContext) {
      contexts.push(context);
      context.on("page", (page) => {
        const video = page.video();
        const testName = expect.getState().currentTestName;
        if (video !== null) videos.set(page, { video, testName });
      });
    },
    /** Leaves `page` out: a step of the harness's own, such as signing in, isn't the journey. */
    drop(page: Page) {
      const recorded = videos.get(page);
      if (recorded !== undefined) recorded.testName = undefined;
    },
    /**
     * Closes the contexts, which finishes their videos, and saves each under its name. Needs
     * the browser still open. Fails, after saving them all, on any file over the limit.
     */
    async finish() {
      await Promise.all(contexts.map((context) => context.close()));
      const taken = new Set<string>();
      const tooBig: string[] = [];
      for (const { video, testName } of videos.values()) {
        if (testName !== undefined) {
          const path = join(dir, `${videoName(testName, taken)}.webm`);
          await video.saveAs(path);
          const { size } = await stat(path);
          if (size > maxBytes) tooBig.push(`${path}: ${size} bytes`);
        }
        await video.delete();
      }
      if (tooBig.length > 0) {
        throw new Error(`Recordings over ${maxBytes} bytes:\n${tooBig.join("\n")}`);
      }
    },
  };
}

/** A recorder when `BROWSER_RECORD` names a folder; otherwise none, and nothing is recorded. */
export const recorderFromEnv = (dir = process.env.BROWSER_RECORD) =>
  dir === undefined || dir === "" ? undefined : startRecorder(dir);
