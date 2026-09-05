import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownText, TranscriptMarkdownContext, highlightCode, HIGHLIGHT_LIMIT } from "./MarkdownText";
import { MarkdownViewState, markdownScope } from "./markdown-state";
import { fileLocation, resolveTranscriptLink, type TranscriptLinkActions } from "./transcript-links";
const actions: TranscriptLinkActions = { cwd: "/home/owner/project", openFile: () => {}, openExternal: async () => {} };
const render = (text: string, key = "message-1:block:0", views = new MarkdownViewState()) => renderToStaticMarkup(<TranscriptMarkdownContext value={{ actions, views }}><MarkdownText text={text} blockKey={key}/></TranscriptMarkdownContext>);
const codeText = (html: string) => html.match(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/)?.[1]?.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#x27;", "'");

describe("CommonMark/GFM production renderer contracts", () => {
  test("renders semantic headings, paragraphs, emphasis, nested lists, tasks, quotes, rules and aligned tables", () => {
    const html = render("# Title\n\nA **strong** and *emphasized* paragraph with `inline` and ~~removed~~.\n\n1. First\n   - Nested\n2. Second\n\n- [x] Finished\n- [ ] Pending\n\n> Quote\n\n---\n\n| Left | Right |\n| :--- | ---: |\n| A | B |\n");
    for (const part of ["<h1>Title</h1>", "<strong>strong</strong>", "<em>emphasized</em>", "<code>inline</code>", "<del>removed</del>", "<ol>", "<ul>", "Nested", 'type="checkbox"', "disabled=", "checked=", "<blockquote>", "<hr/>", "<table>", "<thead>", "<tbody>", 'style="text-align:right"']) expect(html).toContain(part);
    expect(html).toContain('role="region" aria-label="Markdown table" tabindex="0"');
  });
  test("real grammars highlight explicit languages and aliases, unknown/oversized blocks remain plain", () => {
    const js = render('```js\nconst message = "hello"; // comment\n```');
    expect(js).toContain('data-highlighted="true"'); expect(js).toContain("hljs-keyword"); expect(js).toContain("hljs-string"); expect(js).toContain("hljs-comment");
    expect(codeText(js)).toBe('const message = "hello"; // comment');
    expect(render("```not-a-language\nconst unchanged = 7\n```")).toContain("not-a-language · plain text");
    expect(highlightCode("x".repeat(HIGHLIGHT_LIMIT + 1), "javascript")).toMatchObject({ kind: "plain", reason: "Large block displayed without highlighting" });
    expect(highlightCode("print('ok')", "python").kind).toBe("highlighted");
    expect(highlightCode("plain <text>", "").kind).toBe("plain");
  });
  test("tilde, longer, indented, incomplete fences and missing final newline preserve parsed code", () => {
    for (const [source, expected] of [
      ["~~~text\na\n~~~", "a"], ["````text\n``` inside\n````", "``` inside"],
      ["    indented\n    code", "indented\ncode"], ["```text\npartial", "partial"],
      ["```text\na\n\n```", "a\n"], ["```text\na\r\nb\r\n```", "a\r\nb"],
    ]) expect(codeText(render(source))).toBe(expected);
    expect(render("```text\n\n```")).toContain('<pre tabindex="0" aria-label="text code"><code></code></pre>');
  });
  test("stream growth and closure retain code identity and wrap choice independently per block", () => {
    const views = new MarkdownViewState(), key = "native-message:block:0";
    const first = render("Before\n\n```text\na", key, views), identity = first.match(/data-code-key="([^"]+)"/)?.[1];
    expect(identity).toBeDefined(); views.setWrapped(identity!, true);
    const partial = render("Before\n\n```text\na longer", key, views), complete = render("Before\n\n```text\na longer\n```", key, views);
    expect(partial).toContain(`data-code-key="${identity}"`); expect(complete).toContain(`data-code-key="${identity}"`);
    expect(partial).toContain('aria-pressed="true"'); expect(complete).toContain('<pre class="wrapped"');
    expect(codeText(complete)).toBe("a longer");
    expect(render("```text\nother\n```", "other-message:block:0", views)).toContain('aria-pressed="false"');
    expect(render("Before\n\n```text\na longer\n```", key, views)).toContain('aria-pressed="true"'); // Same-view reconnect/remount.
  });
  test("HTML is inert literal text, unsafe links have no URL action, and images load no resource", () => {
    const html = render('<script>window.fixture=true</script>\n\n[unsafe](javascript:alert%281%29) [data](data:text/html,test) [credentials](https://user:pass@example.com/)\n\n![Description](https://example.com/tracker.png)');
    expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>"); expect(html).not.toContain("href=");
    expect(html).not.toContain("<img"); expect(html).not.toContain("<link"); expect(html).not.toContain("tracker.png");
    expect(html).toContain("Image: Description"); expect(html).toContain("attachments are not available");
  });
  test("owner file links are app actions, external autolinks are sanitized, and unavailable schemes are readable", () => {
    const html = render("[File](/home/owner/project/src/a.ts:12) [relative](src/b.ts#L3C2) https://example.com/path\n\n[mail](mailto:person@example.com) [outside](/etc/passwd)");
    expect(html.match(/class="markdown-file-link"/g)).toHaveLength(2);
    expect(html).toContain("Open src/a.ts:12 on the session’s host"); expect(html).not.toContain('href="/home');
    expect(html).toContain('href="https://example.com/path" rel="noreferrer noopener"');
    expect(html).not.toContain('href="mailto:'); expect(html).not.toContain('href="/etc');
    expect(html).toContain("outside the session’s workspace");
  });
  test("footnote IDs and accessibility descriptions are scoped to each message", () => {
    const source = "A note[^a].\n\n[^a]: Its definition.", a = render(source, "a:block:0"), b = render(source, "b:block:0");
    const aScope = markdownScope("a:block:0"), bScope = markdownScope("b:block:0");
    expect(a).toContain(`id="${aScope}fn-a"`); expect(a).toContain(`href="#${aScope}fn-a"`);
    expect(a).toContain(`id="${aScope}footnote-label"`); expect(a).toContain(`aria-describedby="${aScope}footnote-label"`);
    expect(b).toContain(`id="${bScope}fn-a"`); expect(b).not.toContain(aScope);
    expect(resolveTranscriptLink("#message-fn-%C3%A9")).toEqual({ kind: "fragment", id: "message-fn-%C3%A9" });
  });
  test("Unicode, RTL, long words, literal markup and malformed Markdown remain readable", () => {
    const text = "مرحبا **שלום** 👩🏽‍💻\n\n" + "long".repeat(1000) + "\n\n[unfinished](\n\n`literal <tag>`\n\nline  \nbreak";
    const html = render(text);
    expect(html).toContain('dir="auto"'); expect(html).toContain("مرحبا"); expect(html).toContain("<strong>שלום</strong>"); expect(html).toContain("👩🏽‍💻");
    expect(html).toContain("long".repeat(1000)); expect(html).toContain("[unfinished]("); expect(html).toContain("literal &lt;tag&gt;"); expect(html).toContain("<br/>");
  });
});

describe("owner-scoped link and editor location contracts", () => {
  test("resolves relative and absolute POSIX files against the owner cwd, with supported line formats", () => {
    expect(resolveTranscriptLink("src/a.ts:12:3", "/remote/project")).toEqual({ kind: "file", file: { path: "src/a.ts", line: 12, column: 3 } });
    expect(resolveTranscriptLink("/remote/project/My%20File.ts#L4-L8", "/remote/project")).toEqual({ kind: "file", file: { path: "My File.ts", line: 4 } });
    expect(resolveTranscriptLink("src/../file.ts", "/remote/project/")).toEqual({ kind: "file", file: { path: "file.ts" } });
    expect(resolveTranscriptLink("/remote/project/file.ts#L4C2", "/remote/project")).toEqual({ kind: "file", file: { path: "file.ts", line: 4, column: 2 } });
    expect(resolveTranscriptLink("file.ts", undefined).kind).toBe("unavailable");
  });
  test("rejects sibling escapes, encoded traversal/controls, wrong schemes, credentials and ambiguous locations", () => {
    for (const href of ["../secret", "/remote/project-sibling/file.ts", "%2e%2e/secret", "dir/%00file", "file%5cname", "//other-host/path", "file:///remote/project/file", "javascript:alert(1)", "data:text/html,hello", "https://user:password@example.com/", "file.ts:2#L3", "file.ts#L0", "file.ts:9999999999999999999999", "file.ts?raw=true", "%ZZ", ""]) expect(resolveTranscriptLink(href, "/remote/project").kind).toBe("unavailable");
    expect(resolveTranscriptLink("http://example.com").kind).toBe("unavailable");
    expect(resolveTranscriptLink("http://127.0.0.1:8080/path")).toEqual({ kind: "external", url: "http://127.0.0.1:8080/path" });
    expect(resolveTranscriptLink("https://example.com")).toEqual({ kind: "external", url: "https://example.com/" });
  });
  test("file locations preserve actual buffer offsets and expose missing lines/columns", () => {
    expect(fileLocation("a\r\nbb\r\n", 2)).toEqual({ start: 3, end: 5 });
    expect(fileLocation("a\n👩🏽‍💻 text\n", 2, 3)).toEqual({ start: 4, end: 4 });
    expect(fileLocation("a\nbb\n", 3)).toEqual({ start: 5, end: 5 });
    expect(fileLocation("a\nbb", 4)).toEqual({ error: "Line 4 is unavailable; this buffer has 2 lines." });
    expect(fileLocation("a\nbb", 2, 4)).toEqual({ error: "Column 4 is unavailable on line 2." });
  });
});
