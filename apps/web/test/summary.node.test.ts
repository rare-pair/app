import { describe, expect, it } from "vitest";
import { tidySummary, withoutLinks } from "../src/summary";

// The inputs are the sanitizer's canonical output: tags in lower case, `<` and `>`
// escaped in text and attributes, so no attribute value holds a raw `<` or `>`.
describe("Summary headings and stray list items", () => {
  it.each([1, 2, 3, 4, 5, 6])("A summary's h%i becomes bold text, not a heading", (n) => {
    expect(tidySummary(`<h${n}>Notes</h${n}>`)).toBe(
      '<div class="summary-heading"><strong>Notes</strong></div>',
    );
  });

  it("A heading with attributes and inline markup keeps its content", () => {
    expect(tidySummary('<h1 lang="fr" title="x">A <em>big</em> one</h1><p>Text</p>')).toBe(
      '<div class="summary-heading"><strong>A <em>big</em> one</strong></div><p>Text</p>',
    );
  });

  it("A heading with a block child is closed in order", () => {
    expect(tidySummary("<h2><p>One</p></h2>")).toBe(
      '<div class="summary-heading"><strong><p>One</p></strong></div>',
    );
  });

  it("A list item outside any list becomes a div", () => {
    expect(tidySummary("<li>One</li><li>Two</li>")).toBe("<div>One</div><div>Two</div>");
  });

  it("A list item in a list is untouched", () => {
    const html = "<ul><li>One</li><li>Two<ol><li>Deep</li></ol></li></ul>";
    expect(tidySummary(html)).toBe(html);
  });

  it("A list inside a stray list item keeps its own items", () => {
    expect(tidySummary("<li>A<ul><li>B</li></ul></li>")).toBe("<div>A<ul><li>B</li></ul></div>");
  });

  it("Text that spells a tag is untouched", () => {
    const html = "<p>&lt;h1&gt;no&lt;/h1&gt; &lt;li&gt;</p>";
    expect(tidySummary(html)).toBe(html);
  });

  it("Tags that only start like a heading or a list item are untouched", () => {
    const html = '<hr><p>a</p><link rel="x"><ol><li>x</li></ol>';
    expect(tidySummary(html)).toBe(html);
  });

  it("Plain paragraphs come back verbatim", () => {
    const html = "<p>One <em>two</em></p>\n<p>Three</p>";
    expect(tidySummary(html)).toBe(html);
  });

  it("Rewriting twice changes nothing more", () => {
    const once = tidySummary("<h1>A</h1><li>b</li><ul><li>c</li></ul>");
    expect(tidySummary(once)).toBe(once);
  });

  it("A stray closing tag does not break what follows", () => {
    expect(tidySummary("</li><ul><li>x</li></ul>")).toBe("</li><ul><li>x</li></ul>");
  });
});

describe("Links in a card summary", () => {
  it("A link becomes its text", () => {
    expect(withoutLinks('<p>See <a href="https://elsewhere.example/">more</a> here</p>')).toBe(
      "<p>See more here</p>",
    );
  });

  it("A link around an image leaves the image and its alt", () => {
    expect(withoutLinks('<a href="/x"><img src="/i.png" alt="A cat"></a>')).toBe(
      '<img src="/i.png" alt="A cat">',
    );
  });

  it("Text that spells a link is untouched", () => {
    const html = "<p>&lt;a href=&quot;x&quot;&gt;y&lt;/a&gt;</p>";
    expect(withoutLinks(html)).toBe(html);
  });

  it("Tags that only start with a are untouched", () => {
    const html = '<abbr title="x">y</abbr><p>z</p>';
    expect(withoutLinks(html)).toBe(html);
  });
});
