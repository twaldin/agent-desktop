import { afterEach, describe, expect, test } from "bun:test";
import { copyTranscriptTable, sanitizedTableHtml } from "./transcript-table-copy";

type AttributeMap = Record<string, string>;
class TextNode {
  nodeType = 3; childNodes: never[] = [];
  constructor(readonly nodeValue: string) {}
  get textContent() { return this.nodeValue; }
}
class ElementNode {
  nodeType = 1;
  constructor(readonly localName: string, readonly childNodes: Array<ElementNode | TextNode> = [], private attrs: AttributeMap = {}) {}
  get textContent(): string { return this.childNodes.map(child => child.textContent).join(""); }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  hasAttribute(name: string) { return this.attrs[name] !== undefined; }
}
const text = (value: string) => new TextNode(value);
const element = (name: string, children: Array<ElementNode | TextNode> = [], attrs: AttributeMap = {}) => new ElementNode(name, children, attrs);
const table = (...rows: ElementNode[]) => element("table", [element("tbody", rows)]) as unknown as HTMLTableElement;
const originalNavigator = globalThis.navigator;
const originalClipboardItem = globalThis.ClipboardItem;
afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
  Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: originalClipboardItem });
});

describe("sanitized transcript table HTML", () => {
  test("retains useful table and inline semantics while removing renderer controls and attributes", () => {
    const input = table(element("tr", [
      element("th", [text("Name")], { colspan: "2", class: "runtime", onclick: "bad()" }),
      element("td", [element("strong", [text("A & B")]), element("span", [text(" hidden")], { class: "sr-only" })], { rowspan: "3", style: "color:red" }),
      element("td", [element("button", [text("Open /tmp/report.csv")], { "data-file-reference": "true" })]),
      element("td", [element("span", [text("Copy table")], { "data-markdown-copy": "exclude" })]),
    ]));
    expect(sanitizedTableHtml(input)).toBe('<table><tbody><tr><th colspan="2">Name</th><td rowspan="3"><strong>A &amp; B</strong></td><td>Open /tmp/report.csv</td><td></td></tr></tbody></table>');
  });

  test("does not copy runtime image grants or executable markup", () => {
    const input = table(element("tr", [element("td", [
      element("img", [], { src: "agent-workspace-image://image/private-grant", alt: "Chart" }),
      element("img", [], { src: "https://example.com/public.png", alt: "Public", width: "20", onerror: "bad()" }),
      element("script", [text("bad()")]), element("span", [text("decorative")], { "aria-hidden": "true" }),
    ])]));
    const html = sanitizedTableHtml(input);
    expect(html).toBe('<table><tbody><tr><td>Chart<img src="https://example.com/public.png" alt="Public" width="20"></td></tr></tbody></table>');
    expect(html).not.toContain("private-grant"); expect(html).not.toContain("onerror"); expect(html).not.toContain("bad()");
  });

  test("keeps ordinary HTTPS links but strips active URLs and flattens custom elements", () => {
    const input = table(element("tr", [element("td", [
      element("a", [text("Guide")], {href:"https://docs.example/path",title:"Docs",onclick:"bad()"}),
      element("a", [text(" unsafe")], {href:"javascript:bad()"}),
      element("blockquote", [text("Quote")], {cite:"data:text/html,bad"}),
      element("custom-action", [text("Literal file.csv")], {href:"javascript:bad()"}),
      element("img", [], {src:"data:image/svg+xml,%3Csvg%3E",srcset:"https://example.com/one.png 1x",alt:"Vector"}),
    ])]));
    const html = sanitizedTableHtml(input);
    expect(html).toBe('<table><tbody><tr><td><a href="https://docs.example/path" title="Docs">Guide</a><a> unsafe</a><blockquote>Quote</blockquote>Literal file.csvVector</td></tr></tbody></table>');
    expect(html).not.toContain("javascript:"); expect(html).not.toContain("srcset"); expect(html).not.toContain("custom-action");
  });
});

describe("transcript table clipboard payload", () => {
  test("writes exact source Markdown and sanitized HTML in one clipboard item", async () => {
    const writes: unknown[][] = [];
    class ControlledClipboardItem { constructor(readonly data: Record<string, Blob>) {} }
    Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: ControlledClipboardItem });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { write: async (items: unknown[]) => { writes.push(items); }, writeText: async () => { throw new Error("fallback must not run"); } } } });
    const source = "| File | Value |\n| :--- | ---: |\n| a\\|b.csv | 2 |";
    await copyTranscriptTable(table(element("tr", [element("td", [text("a|b.csv")])])), source);
    const item = writes[0]![0] as ControlledClipboardItem;
    expect(writes).toHaveLength(1);
    expect(await item.data["text/plain"]!.text()).toBe(source);
    expect(await item.data["text/html"]!.text()).toBe("<table><tbody><tr><td>a|b.csv</td></tr></tbody></table>");
  });

  test("uses plain fallback only when multi-format APIs are absent and propagates failures", async () => {
    const copied: string[] = [];
    Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value: string) => { copied.push(value); } } } });
    const input = table(element("tr", [element("td", [text("literal.csv")])]));
    await copyTranscriptTable(input, "| literal.csv |");
    expect(copied).toEqual(["| literal.csv |"]);
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => { throw new Error("permission denied"); } } } });
    await expect(copyTranscriptTable(input, "source")).rejects.toThrow("permission denied");

    class ControlledClipboardItem { constructor(readonly data: Record<string, Blob>) {} }
    let fallbacks = 0;
    Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: ControlledClipboardItem });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: {
      write: async () => { throw new Error("rich clipboard denied"); }, writeText: async () => { fallbacks++; },
    } } });
    await expect(copyTranscriptTable(input, "source")).rejects.toThrow("rich clipboard denied");
    expect(fallbacks).toBe(0);
  });
});
