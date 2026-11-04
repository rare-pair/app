import { collapseWhitespace, decodeEntities } from "./entities";
import { EpubError } from "./errors";
import { LIMITS } from "./unzip";

// A small document tree built from HTMLRewriter's token stream. HTMLRewriter is
// used purely as a tokenizer here: its own output is discarded.

export interface ElementNode {
  type: "element";
  tag: string;
  /** Lowercased names, raw (undecoded) values, first occurrence wins. */
  attrs: Record<string, string>;
  children: Node[];
  parent: ElementNode | null;
  /** Path of the epub file this element came from (for resolving links). */
  file: string;
  /** Document-order index across the whole spine; see `numberTree`. */
  pos: number;
  /** `pos` of the last descendant (or own `pos` if none). */
  end: number;
}

export interface TextNode {
  type: "text";
  /** Raw source text, entities not decoded. */
  raw: string;
  parent: ElementNode | null;
  pos: number;
  end: number;
}

export type Node = ElementNode | TextNode;

const VOID = new Set([
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// Opening one of these implicitly closes an open <p>, as in an HTML parser.
const CLOSES_P = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "center",
  "details",
  "div",
  "dl",
  "fieldset",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

/**
 * Epub content documents are XHTML, where `<div/>` is an empty element.
 * HTMLRewriter parses as HTML, where it opens a div, and in this workerd build it
 * exposes no `selfClosing` flag. Rewrite non-void self-closing tags to an
 * explicit pair first. This only shapes the tree: everything still goes
 * through the allowlist serializer afterwards.
 *
 * Raw-text elements end only at their own end tag, and an expansion only ever
 * adds `</x>` for the tag it expands. So a self-closing raw-text tag is removed
 * instead: expanded inside a script's text, `<script/>` would end that script
 * early. The serializer drops all of these elements anyway.
 */
const SELF_CLOSING =
  /<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>=`/]+))?)*)\s*\/>/g;

const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);

export function expandSelfClosing(html: string): string {
  return html.replace(SELF_CLOSING, (whole, tag: string, attrs: string) => {
    const name = tag.toLowerCase();
    if (RAW_TEXT.has(name)) return "";
    return VOID.has(name) ? whole : `<${tag}${attrs}></${tag}>`;
  });
}

function element(tag: string, file: string, parent: ElementNode | null): ElementNode {
  return {
    type: "element",
    tag,
    attrs: Object.create(null),
    children: [],
    parent,
    file,
    pos: 0,
    end: 0,
  };
}

// Deeper documents are rejected. Flattening them instead would move the
// contents of a dropped element (a <form>, say) into an allowed ancestor. Also
// bounds recursion in every tree walk.
export const MAX_DEPTH = 256;

/** Nodes left to allocate; share one across every document of an epub. */
export interface NodeBudget {
  remaining: number;
}

export const nodeBudget = (): NodeBudget => ({ remaining: LIMITS.maxNodes });

/** Parses an HTML/XHTML string into a tree under a synthetic `#root` element. */
export async function parseHtml(
  html: string,
  file = "",
  budget: NodeBudget = nodeBudget(),
): Promise<ElementNode> {
  const root = element("#root", file, null);
  const stack: ElementNode[] = [root];
  const top = (): ElementNode => stack[stack.length - 1]!;

  // Set once the document is rejected; later tokens are skipped. (Throwing from
  // a handler surfaces in workerd as an uncaught exception.)
  // SAFETY: widens the initial null, so TS doesn't read it as null after the handlers have run.
  let failure = null as EpubError | null;
  const spend = (): boolean => {
    if (--budget.remaining >= 0) return true;
    failure = new EpubError("too_large", `More than ${LIMITS.maxNodes} elements and text nodes`);
    return false;
  };
  const appendText = (parent: ElementNode, raw: string): void => {
    const last = parent.children[parent.children.length - 1];
    if (last?.type === "text") last.raw += raw;
    else if (spend()) parent.children.push({ type: "text", raw, parent, pos: 0, end: 0 });
  };

  // Close by node reference, so a mismatched end tag also closes whatever was
  // left open inside it. An end tag for a node no longer open is ignored.
  const close = (node: ElementNode): void => {
    const i = stack.lastIndexOf(node);
    if (i > 0) stack.length = i;
  };

  const rewriter = new HTMLRewriter()
    .on("*", {
      element(el) {
        if (failure) return;
        const tag = el.tagName.toLowerCase();
        if (CLOSES_P.has(tag) && top().tag === "p") stack.pop();
        if (!spend()) return;
        const node = element(tag, file, top());
        for (const [name, value] of el.attributes) {
          const key = name!.toLowerCase();
          if (!(key in node.attrs)) node.attrs[key] = value ?? "";
        }
        top().children.push(node);
        if (VOID.has(tag)) return;
        try {
          el.onEndTag(() => close(node));
        } catch {
          return; // lol-html refuses end-tag handlers on elements that cannot have one.
        }
        if (stack.length >= MAX_DEPTH) {
          failure = new EpubError(
            "parse_failed",
            `Elements nested ${MAX_DEPTH} or more deep in ${file}`,
          );
          return;
        }
        stack.push(node);
      },
    })
    .onDocument({
      text(t) {
        if (!failure && t.text) appendText(top(), t.text);
      },
    });

  // Drain and discard the rewriter's output instead of buffering a copy of it.
  await rewriter
    .transform(new Response(expandSelfClosing(html)))
    .body?.pipeTo(new WritableStream());
  if (failure) throw failure;
  return root;
}

/** Assigns document-order positions. Returns the next free position. */
export function numberTree(node: Node, start: number): number {
  node.pos = start;
  let next = start + 1;
  if (node.type === "element") {
    for (const child of node.children) next = numberTree(child, next);
  }
  node.end = next - 1;
  return next;
}

export function walk(node: Node, visit: (n: Node) => boolean | void): void {
  if (visit(node) === false) return;
  if (node.type === "element") for (const child of node.children) walk(child, visit);
}

export function findAll(root: Node, pred: (el: ElementNode) => boolean): ElementNode[] {
  const out: ElementNode[] = [];
  walk(root, (n) => {
    if (n.type === "element" && pred(n)) out.push(n);
  });
  return out;
}

export function find(root: Node, pred: (el: ElementNode) => boolean): ElementNode | null {
  let found: ElementNode | null = null;
  walk(root, (n) => {
    if (found) return false;
    if (n.type === "element" && pred(n)) {
      found = n;
      return false;
    }
    return true;
  });
  return found;
}

/** Outermost elements matching `pred` (matches nested inside a match are skipped). */
export function findOutermost(root: Node, pred: (el: ElementNode) => boolean): ElementNode[] {
  const out: ElementNode[] = [];
  walk(root, (n) => {
    if (n.type !== "element") return true;
    if (pred(n)) {
      out.push(n);
      return false;
    }
    return true;
  });
  return out;
}

export function hasClass(el: ElementNode, cls: string): boolean {
  const value = el.attrs["class"];
  return value !== undefined && value.split(/\s+/).includes(cls);
}

export function idOf(el: ElementNode): string | undefined {
  return el.attrs["id"];
}

export function isAncestor(ancestor: ElementNode, node: Node): boolean {
  for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

/** A tag name without its namespace prefix: `svg:script` -> `script`. */
export function localName(tag: string): string {
  return tag.slice(tag.lastIndexOf(":") + 1);
}

export const isScriptOrStyle = (el: ElementNode): boolean => {
  const name = localName(el.tag);
  return name === "script" || name === "style";
};

/** Decoded text content. Content of script/style is not text for our purposes. */
export function textContent(node: Node): string {
  if (node.type === "text") return decodeEntities(node.raw);
  if (isScriptOrStyle(node)) return "";
  let s = "";
  for (const child of node.children) s += textContent(child);
  return s;
}

export function cleanText(node: Node): string {
  return collapseWhitespace(textContent(node));
}

/**
 * `cleanText`, or null once the subtree holds more than `maxChars` of raw text
 * or `maxNodes` nodes. For predicates run on every element, where a full
 * `cleanText` would make the scan quadratic in the document size.
 */
export function boundedText(node: Node, maxChars: number, maxNodes = 4 * maxChars): string | null {
  let s = "";
  let nodes = 0;
  const visit = (n: Node): boolean => {
    if (++nodes > maxNodes) return false;
    if (n.type === "text") {
      s += n.raw;
      return s.length <= maxChars;
    }
    if (isScriptOrStyle(n)) return true;
    for (const child of n.children) if (!visit(child)) return false;
    return true;
  };
  return visit(node) ? collapseWhitespace(decodeEntities(s)) : null;
}

/** Source formatting whitespace only (a no-break space is content). */
export function isBlankText(node: Node): boolean {
  return node.type === "text" && /^[ \t\r\n\f]*$/.test(node.raw);
}

/** The next sibling element, skipping whitespace-only text. */
export function nextElementSibling(el: ElementNode): ElementNode | null {
  const siblings = el.parent?.children ?? [];
  for (let i = siblings.indexOf(el) + 1; i < siblings.length; i++) {
    const s = siblings[i]!;
    if (s.type === "element") return s;
    if (!isBlankText(s)) return null;
  }
  return null;
}
