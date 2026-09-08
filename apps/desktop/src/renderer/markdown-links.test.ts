import { expect, test } from "bun:test";
import { resolveMarkdownLink } from "./markdown-links";
import { fileLocation } from "./transcript-links";

const link = (href: string) => resolveMarkdownLink(href, "docs/guide.md", "/owner/project");
test("Markdown links resolve from their current file and preserve source locations", () => {
  expect(link("./details.md#L2C3-L4")).toEqual({ kind: "file", file: { path: "docs/details.md", line: 2, column: 3, endLine: 4 } });
  expect(link("../src/main.ts:3:2–5:7")).toEqual({ kind: "file", file: { path: "src/main.ts", line: 3, column: 2, endLine: 5 } });
  expect(link("details.md#heading")).toEqual({ kind: "file", file: { path: "docs/details.md" } });
  expect(link("details.md?raw=1")).toEqual({ kind: "file", file: { path: "docs/details.md" } });
  expect(link("#heading")).toEqual({ kind: "fragment", id: "heading" });
  expect(link("#L2")).toEqual({ kind: "fragment", id: "L2" });
});
test("owning-host absolute paths and local file URIs retain literal filename bytes", () => {
  for (const href of ["file:///owner/project/docs/a%20b.md#L2", "file://localhost/owner/project/docs/a%20b.md:2", "/owner/project/docs/a%20b.md:2", "sandbox:/owner/project/docs/a%20b.md#L2"])
    expect(link(href)).toEqual({ kind: "file", file: { path: "docs/a b.md", line: 2 } });
  expect(link("a%23b%3Fc%3A2.md")).toEqual({ kind: "file", file: { path: "docs/a#b?c:2.md" } });
});
test("file links cannot change the workspace owner or escape its lexical boundary", () => {
  for (const href of ["../../private.txt", "%2e%2e/%2e%2e/private.txt", "file:///other/secret.md", "file://another-host/owner/project/a.md", "//another-host/path", "javascript:alert(1)", "data:text/html,hello", "bad%ZZ.md", "details.md#L0", "details.md:4-2", "details.md:9007199254740992"])
    expect(link(href).kind).toBe("unavailable");
  expect(resolveMarkdownLink("a.md", "../foreign.md", "/owner/project").kind).toBe("unavailable");
});
test("external URLs keep their queries and do not become file locations", () => {
  expect(link("https://example.com:8443/a?q=1#heading")).toEqual({ kind: "external", url: "https://example.com:8443/a?q=1#heading" });
  expect(link("http://127.0.0.1:1234/test").kind).toBe("external");
  expect(link("https://user:secret@example.com/").kind).toBe("unavailable");
});
test("line ranges select exact mixed-newline/UTF-16 offsets without truncating the end line", () => {
  const text = "first\r\n😀 second\rthird\nfourth";
  const result = fileLocation(text, 2, 4, 3);
  expect(result).toEqual({ start: 10, end: 22 });
  if (!("error" in result)) expect(text.slice(result.start, result.end)).toBe("second\rthird");
  expect(fileLocation(text, 3, undefined, 2)).toHaveProperty("error");
  expect(fileLocation(text, 2, 99, 3)).toHaveProperty("error");
  expect(fileLocation(text, 2, undefined, 5)).toHaveProperty("error");
  expect(fileLocation(text, 2, 4)).toEqual({ start: 10, end: 10 });
});


test("standalone files resolve parent and absolute links into explicit host file identities", () => {
  expect(resolveMarkdownLink("../assets/diagram.png", "project/docs/readme.md", "/")).toEqual({kind:"file",file:{path:"project/assets/diagram.png"}});
  expect(resolveMarkdownLink("/other/report.md#L3", "project/docs/readme.md", "/")).toEqual({kind:"file",file:{path:"other/report.md",line:3}});
  expect(resolveMarkdownLink("file://elsewhere/secret", "project/docs/readme.md", "/").kind).toBe("unavailable");
});
