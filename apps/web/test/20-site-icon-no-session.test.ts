import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/env";
import app from "../src/index";
import { BASE } from "./helpers";

/** A Hyperdrive whose connection string leads nowhere: a session lookup through it throws. */
const unreachable: Hyperdrive = {
  ...env.HYPERDRIVE,
  connectionString: "postgresql://nobody:nobody@127.0.0.1:1/none",
};

async function fetchWith(path: string, bindings: Partial<Bindings>) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(new URL(path, BASE), { redirect: "manual" }),
    { ...env, ...bindings },
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("20-site-chrome-and-legal", () => {
  it("The icon costs no session lookup", async () => {
    const page = await fetchWith("/about", {});
    const href = (await page.text()).match(/<link rel="icon"[^>]*href="([^"]+)"/)?.[1] ?? "";
    expect(href).not.toBe("");
    const res = await fetchWith(href, { HYPERDRIVE: unreachable });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
  });
});
