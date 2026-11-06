import { describe, expect, it } from "vitest";
import { expectAgentNotice } from "./agent-notice";
import { fetchW } from "./helpers";

// Runs in the "prelaunch" project, so `/` is the coming-soon page.

describe("24-crawler-and-agent-blocking", () => {
  it.each(["/", "/about", "/privacy"])(
    "Every page asks agents not to crawl, before launch: %s",
    async (path) => {
      const res = await fetchW(path);
      expect(res.status).toBe(200);
      expectAgentNotice(await res.text());
    },
  );
});
