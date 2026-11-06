import { describe, expect, it } from "vitest";
import { fetchW } from "./helpers";

describe("20-site-chrome-and-legal: cards before launch", () => {
  it("Before launch, the coming-soon page carries the site card", async () => {
    const html = await (await fetchW("/")).text();
    const get = (name: string) =>
      html.match(new RegExp(`<meta\\s+(?:property|name)="${name}"\\s+content="([^"]*)"`))?.[1];
    expect(get("og:title")).toBe("rarepair");
    expect(get("og:description")).toBe(
      "An unofficial, temporary, community-run reading archive for fanworks.",
    );
    expect(get("twitter:card")).toBe("summary");
  });
});
