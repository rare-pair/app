import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { processEpub, type ImageRef } from "../src";
import { ao3Epub, fromBase64, MiB } from "./helpers";

const PNG = fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
);
const SVG = strToU8(
  `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="1"/></svg>`,
);
const FAKE_PNG = strToU8("<html><script>alert(1)</script></html>");
const HUGE_PNG = new Uint8Array(5 * MiB + 1);
HUGE_PNG.set(PNG.subarray(0, 8));

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

const chapter = `<div id="chapters"><h2 class="toc-heading">Pictures</h2><div class="userstuff2">
<p>img-1 <img src="images/ok%20one.png" alt="a &amp; b" class="calibre5"/></p>
<p>img-2 <img src="./images/../images/ok%20one.png" alt="again"/></p>
<p>img-3 <img src="images/vector.svg" alt="svg"/></p>
<p>img-4 <img src="images/fake.png" alt="fake"/></p>
<p>img-5 <img src="images/huge.png" alt="huge"/></p>
<p>img-6 <img src="data:image/png;base64,iVBORw0KGgo=" alt="inline"/></p>
<p>img-7 <img src="images/missing.png" alt="missing"/></p>
</div></div>`;

describe("images", () => {
  it("keeps a valid manifest PNG, rewrites it by hash, and drops everything else", async () => {
    const received: [ImageRef, Uint8Array][] = [];
    const work = await processEpub(
      ao3Epub({
        files: [{ name: "pics_split_001.xhtml", body: chapter }],
        extraManifest: [
          { href: "images/ok%20one.png", mediaType: "image/png", data: PNG },
          { href: "images/vector.svg", mediaType: "image/svg+xml", data: SVG },
          { href: "images/fake.png", mediaType: "image/png", data: FAKE_PNG },
          { href: "images/huge.png", mediaType: "image/png", data: HUGE_PNG },
        ],
      }),
      {
        imageBase: "https://content.example/img/",
        onImage: (ref, bytes) => received.push([ref, bytes]),
      },
    );

    const key = await sha256Hex(PNG);
    expect(work.images).toEqual([
      { key, mediaType: "image/png", size: PNG.length, sourcePath: "images/ok one.png" },
    ]);
    expect(received).toHaveLength(1);
    expect(received[0]![1]).toEqual(PNG);

    const html = work.chapters[0]!.html;
    expect(html).toContain(`img-1 <img src="https://content.example/img/${key}" alt="a &amp; b">`);
    expect(html).toContain(`img-2 <img src="https://content.example/img/${key}" alt="again">`);
    expect(html.match(/<img/g)).toHaveLength(2);
    expect(html).not.toMatch(/svg|fake|huge|data:|missing/);
    for (let i = 1; i <= 7; i++) expect(html).toContain(`img-${i}`);
  });

  const pngSpec = () => ({
    files: [
      {
        name: "pics_split_001.xhtml",
        body: `<div id="chapters"><p>pic <img src="images/p.png" alt="Ren&eacute;e"/></p></div>`,
      },
    ],
    extraManifest: [{ href: "images/p.png", mediaType: "image/png", data: PNG }],
  });
  const withPng = () => ao3Epub(pngSpec());

  it("gives a function imageBase the work's ID", async () => {
    const seen: string[] = [];
    const work = await processEpub(ao3Epub({ workId: 4242, ...pngSpec() }), {
      imageBase: (id) => {
        seen.push(id);
        return `https://content.example/works/${id}/img/`;
      },
    });
    const key = work.images[0]!.key;
    expect(seen).toEqual(["4242"]);
    expect(work.chapters[0]!.html).toContain(`src="https://content.example/works/4242/img/${key}"`);
  });

  it("awaits an async onImage before resolving, and decodes alt text", async () => {
    const done: string[] = [];
    const work = await processEpub(withPng(), {
      onImage: async (ref) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        done.push(ref.key);
      },
    });
    expect(done).toEqual([work.images[0]!.key]);
    expect(work.chapters[0]!.html).toContain(`alt="Renée"`);
  });

  it("passes an onImage failure through unchanged, not as a parse failure", async () => {
    const boom = new Error("upload failed");
    const err = await processEpub(withPng(), { onImage: async () => Promise.reject(boom) }).catch(
      // oxlint-disable-next-line deslop/no-unknown-parameters -- a rejection reason is unknown by contract
      (e: unknown) => e,
    );
    expect(err).toBe(boom);
  });
});
