import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";
import { expectAgentNotice } from "./agent-notice";

// Runs with PRELAUNCH off, so `/` is the home page.

describe("24-crawler-and-agent-blocking", () => {
  it("The home page asks agents not to crawl: the home page", async () => {
    const res = await fetchW("/");
    expect(res.status).toBe(200);
    expectAgentNotice(await res.text(), '<form role="search"');
  });
});
