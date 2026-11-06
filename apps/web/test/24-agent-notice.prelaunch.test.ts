import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";
import { expectAgentNotice } from "./agent-notice";

// Runs in the "prelaunch" project, so `/` is the coming-soon page.

describe("24-crawler-and-agent-blocking", () => {
  it("The home page asks agents not to crawl: the coming-soon page", async () => {
    const res = await fetchW("/");
    expect(res.status).toBe(200);
    expectAgentNotice(await res.text(), "<p>A temporary, community-run reading archive");
  });
});
