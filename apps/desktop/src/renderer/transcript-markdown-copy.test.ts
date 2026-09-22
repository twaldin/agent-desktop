import { describe, expect, test } from "bun:test";
import { transcriptMarkdownSelection } from "./transcript-markdown-copy";

type Attrs = Record<string, string>;
class T {
  nodeType = 3; childNodes: never[] = []; parent?: E;
  constructor(readonly nodeValue: string) {}
  get textContent() { return this.nodeValue; }
}
class E {
  nodeType: number; parent?: E;
  constructor(readonly localName: string, readonly childNodes: Array<E | T> = [], private attrs: Attrs = {}, fragment = false) {
    this.nodeType = fragment ? 11 : 1; for (const child of childNodes) child.parent = this;
  }
  get textContent(): string { return this.childNodes.map(child => child.textContent).join(""); }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  contains(node: E | T) { for (let current: E | T | undefined = node; current; current = current.parent) if (current === this) return true; return false; }
}
const text = (value: string) => new T(value);
const element = (name: string, children: Array<E | T> = [], attrs: Attrs = {}) => new E(name, children, attrs);
const fragment = (...children: Array<E | T>) => new E("fragment", children, {}, true);
function selection(root: E, copied: E, start: E | T, end: E | T, intersects = true): Selection {
  return { rangeCount: 1, isCollapsed: false, getRangeAt: () => ({
    startContainer: start, endContainer: end, cloneContents: () => copied,
    intersectsNode: (node: unknown) => intersects && (node as E).getAttribute?.("data-markdown-copy") === "code-block",
  }) } as unknown as Selection;
}

describe("broad transcript Markdown selection", () => {
  test("copies paragraph-code-paragraph with exact selected code and no toolbar state", () => {
    const before = element("p", [text("Before")]), source = text("  const x = '<ok>';\nnext");
    const block = element("div", [
      element("div", [text("JavaScript"), element("button", [text("Copy code")])], { "data-markdown-copy": "exclude" }),
      element("pre", [element("code", [element("span", [source], { class: "hljs-keyword" })])]),
    ], { "data-markdown-copy": "code-block" });
    const after = element("p", [text("After")]), root = element("div", [before, block, after]);
    const copied = fragment(element("p", [text("Before")]), element("div", [
      element("div", [text("JavaScript Copy code")], { "data-markdown-copy": "exclude" }),
      element("pre", [element("code", [element("span", [text("  const x = '<ok>';\nnext")])])]),
    ], { "data-markdown-copy": "code-block" }), element("p", [text("After")]));
    expect(transcriptMarkdownSelection(root as unknown as HTMLElement, selection(root, copied, before.childNodes[0]!, after.childNodes[0]!))).toEqual({
      plainText: "Before\n  const x = '<ok>';\nnext\nAfter",
      htmlText: '<p>Before</p><pre dir="ltr"><code>  const x = \'&lt;ok&gt;\';\nnext</code></pre><p>After</p>',
    });
  });

  test("preserves list and table plain-text structure while sanitizing active content", () => {
    const block = element("div", [element("pre", [element("code", [text("x")])])], { "data-markdown-copy": "code-block" });
    const root = element("div", [block]), copied = fragment(
      element("ol", [element("li", [text("first")]), element("li", [text("second"), element("ul", [element("li", [text("nested")])])], { value: "4" })], { start: "3" }),
      element("table", [element("tbody", [element("tr", [element("th", [text("Name")]), element("th", [text("Value")])]), element("tr", [element("td", [text("a")]), element("td", [text("2")])])])]),
      element("div", [element("a", [text("unsafe")], { href: "javascript:run()" }), element("img", [], { src: "agent-workspace-image://secret", alt: "Chart" }), element("script", [text("run()")])]),
      element("div", [element("pre", [element("code", [text("x")])])], { "data-markdown-copy": "code-block" }),
    );
    const payload = transcriptMarkdownSelection(root as unknown as HTMLElement, selection(root, copied, block, block));
    expect(payload?.plainText).toBe("3. first\n4. second\n   - nested\nName\tValue\na\t2unsafeChart\nx");
    expect(payload?.htmlText).toContain('<a>unsafe</a>Chart');
    expect(payload?.htmlText).not.toContain("javascript:"); expect(payload?.htmlText).not.toContain("agent-workspace-image"); expect(payload?.htmlText).not.toContain("run()");
  });

  test("safe unknown wrappers do not reintroduce nested hidden labels", () => {
    const block=element("div",[element("pre",[element("code",[text("x")])])],{"data-markdown-copy":"code-block"});
    const root=element("div",[block]);
    const copied=fragment(element("div",[element("pre",[element("code",[text("x")])])],{"data-markdown-copy":"code-block"}),element("section",[element("h2",[text("Footnotes")],{class:"sr-only"}),element("p",[text("detail")])]));
    const payload=transcriptMarkdownSelection(root as unknown as HTMLElement,selection(root,copied,block,block));
    expect(payload?.htmlText).not.toContain("Footnotes"); expect(payload?.plainText).not.toContain("Footnotes");
    expect(payload?.htmlText).toContain("<p>detail</p>");
  });
  test("a selected diagram copies its source instead of preview labels or active SVG", () => {
    const source = '```mermaid\nflowchart LR\nA["<script>never()</script>"] --> B\n```';
    const diagram = () => element("div", [
      element("button", [text("Copy mermaid")], { "data-markdown-copy": "exclude" }),
      element("img", [], { src: "data:image/svg+xml,<svg/>", alt: "Mermaid diagram" }),
    ], { "data-markdown-copy": "code-block", "data-markdown-copy-text": source });
    const before = element("p", [text("Before")]), after = element("p", [text("After")]);
    const root = element("div", [before, diagram(), after]);
    const copied = fragment(element("p", [text("Before")]), diagram(), element("p", [text("After")]));
    expect(transcriptMarkdownSelection(root as unknown as HTMLElement, selection(root, copied, before, after))).toEqual({
      plainText: `Before\n${source}\nAfter`,
      htmlText: '<p>Before</p><pre dir="ltr"><code>```mermaid\nflowchart LR\nA["&lt;script&gt;never()&lt;/script&gt;"] --&gt; B\n```</code></pre><p>After</p>',
    });
  });
  test("declines collapsed, outside, and selections without code", () => {
    const paragraph = element("p", [text("only text")]), root = element("div", [paragraph]), copied = fragment(element("p", [text("only text")]));
    const plain = selection(root, copied, paragraph, paragraph, false);
    expect(transcriptMarkdownSelection(root as unknown as HTMLElement, plain)).toBeUndefined();
    expect(transcriptMarkdownSelection(root as unknown as HTMLElement, { ...plain, isCollapsed: true } as Selection)).toBeUndefined();
    const outside = element("p", [text("outside")]);
    expect(transcriptMarkdownSelection(root as unknown as HTMLElement, selection(root, copied, paragraph, outside))).toBeUndefined();
  });
});
