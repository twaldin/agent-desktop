import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TranscriptMarkdownContext } from "./MarkdownText";
import { resolveTranscriptFileReference, TranscriptFileReference } from "./TranscriptFileReference";

describe("native transcript file references", () => {
  test("explicit transcript routing preserves literal absolute filename characters without cwd", () => {
    const path = "/remote/📁/name:12#fragment?literal%20 file.ts";
    expect(resolveTranscriptFileReference(path, undefined, true)).toEqual({file:{path}});
    expect(resolveTranscriptFileReference(path, "/another/project", true)).toEqual({file:{path}});
    expect(resolveTranscriptFileReference("../name:12#fragment?literal%20 file.ts", "/remote/project", true)).toEqual({file:{path:"/remote/name:12#fragment?literal%20 file.ts"}});
    expect(resolveTranscriptFileReference("relative.ts", undefined, true)).toHaveProperty("error");
    const html = renderToStaticMarkup(<TranscriptMarkdownContext value={{actions:{openFile:()=>{}}}}><TranscriptFileReference path={path}/></TranscriptMarkdownContext>);
    expect(html).toContain('class="transcript-file-reference"');
    expect(html).not.toContain('unavailable'); expect(html).not.toContain('href=');
  });
  test("keeps native punctuation literal while resolving within the owner workspace", () => {
    expect(resolveTranscriptFileReference("src/name:12#fragment?literal%20 file.ts", "/remote/project")).toEqual({ file: { path: "src/name:12#fragment?literal%20 file.ts" } });
    expect(resolveTranscriptFileReference("/remote/project/src/a:b#c", "/remote/project")).toEqual({ file: { path: "src/a:b#c" } });
    expect(resolveTranscriptFileReference("../secret", "/remote/project")).toEqual({ error: "This file reference is outside the owning workspace." });
    expect(resolveTranscriptFileReference("src/a.ts", undefined)).toEqual({ error: "This file reference has no owning workspace." });
  });

  test("renders an owner-scoped native button without an href or source reread", () => {
    const html = renderToStaticMarkup(<TranscriptMarkdownContext value={{ actions: { cwd: "/remote/project", openFile: () => {} } }}><TranscriptFileReference path="src/name:12#fragment?literal%20 file.ts" label="name:12#fragment?literal%20 file.ts"/></TranscriptMarkdownContext>);
    expect(html).toContain('class="transcript-file-reference"');
    expect(html).toContain('title="src/name:12#fragment?literal%20 file.ts"');
    expect(html).toContain("name:12#fragment?literal%20 file.ts");
    expect(html).not.toContain("href=");
  });
});
