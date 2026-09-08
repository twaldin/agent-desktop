import { expect,test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FileTypeIcon } from "./FileTypeIcon";
import { fileIconKind } from "./file-icon-kind";

test("file icon identity follows literal basename before MIME and preserves special names",()=>{
  expect(fileIconKind("/repo/SKILL.MD","image/png")).toBe("skill");
  expect(fileIconKind("src/component.TSX")).toBe("react");
  expect(fileIconKind("C:\\repo\\index.TS")).toBe("typescript");
  expect(fileIconKind("Dockerfile")).toBe("terminal");
  expect(fileIconKind("/repo/.gitignore")).toBe("document");
  expect(fileIconKind("/repo/unknown.xyz","text/plain")).toBe("document");
  expect(fileIconKind("folder/","application/pdf")).toBe("folder");
  expect(fileIconKind("thing.constructor")).toBe("file");
  expect(fileIconKind("thing.__proto__")).toBe("file");
});

test("pinned MIME fallback preserves lookup semantics and explicit unknown MIME",()=>{
  expect(fileIconKind("image.avif")).toBe("image");
  expect(fileIconKind("notes.txt")).toBe("document");
  expect(fileIconKind("notes.txt","application/octet-stream")).toBe("file");
  expect(fileIconKind("notes.txt","")).toBe("file");
  expect(fileIconKind(undefined,"application/pdf")).toBe("pdf");
  expect(fileIconKind("file.UNKNOWN","IMAGE/PNG")).toBe("file");
  expect(fileIconKind("avif")).toBe("image");
  expect(fileIconKind("dir/avif")).toBe("file");
  expect(fileIconKind("notes.txt?literal")).toBe("file");
  expect(fileIconKind("notes.txt#literal")).toBe("file");
});

test("repeated office glyphs have local gradient identities and decorative accessible treatment",()=>{
  const html=renderToStaticMarkup(<><FileTypeIcon path="first.docx"/><FileTypeIcon path="second.docx"/></>);
  const ids=[...html.matchAll(/ id="([^"]+)"/g)].map(match=>match[1]);
  const refs=[...html.matchAll(/url\(#([^\)]+)\)/g)].map(match=>match[1]);
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids).size).toBe(ids.length);
  expect(refs.every(id=>ids.includes(id))).toBe(true);
  expect(html.match(/aria-hidden="true"/g)?.length).toBe(2);
  expect(html).not.toContain("<script");
});
