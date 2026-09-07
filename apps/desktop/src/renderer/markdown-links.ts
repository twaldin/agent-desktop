import { resolveTranscriptLink, type TranscriptLink } from "./transcript-links";

/** Current-file-relative links; the host still enforces realpath ownership on read. */
export function resolveMarkdownLink(href: string, filePath: string, workspacePath: string): TranscriptLink {
  const fail = (reason: string): TranscriptLink => ({ kind: "unavailable", reason });
  if (!href || href.length > 32_768 || /[\x00-\x1f\x7f\\]/.test(href)) return fail("This Markdown link has an invalid path or URL.");
  const value = href.replace(/`/g, "").trim();
  if (/^https?:/i.test(value)) return resolveTranscriptLink(value);
  if (value.startsWith("#")) return resolveTranscriptLink(value);
  const match = /^(.*?):(\d+)(?::(\d+))?(?:[-–](\d+)(?::(\d+))?)?$/.exec(value)
    ?? /^(.*?)#L(\d+)(?:C(\d+))?(?:-L(\d+)(?:C(\d+))?)?$/.exec(value);
  const line = match?.[2] === undefined ? undefined : Number(match[2]);
  const column = match?.[3] === undefined ? undefined : Number(match[3]);
  const endLine = match?.[4] === undefined ? undefined : Number(match[4]);
  if ([line, column, endLine, match?.[5] === undefined ? undefined : Number(match[5])].some(n => n !== undefined && (!Number.isSafeInteger(n) || n < 1)) || line !== undefined && endLine !== undefined && endLine < line) return fail("This file location is out of range.");
  let path = (match?.[1] ?? value).split(/[?#]/, 1)[0]!;
  if (!path) return fail("This link has no file path.");
  if (path.startsWith("sandbox:")) path = path.slice(8);
  try {
    if (/^file:/i.test(path)) {
      const url = new URL(path);
      if (url.host && url.host !== "localhost") return fail("This file URL does not belong to the selected workspace.");
      path = decodeURIComponent(url.pathname);
    } else {
      if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("//")) return fail("This link type is not supported by the desktop.");
      path = decodeURIComponent(path);
    }
  } catch { return fail("This file path has invalid encoding."); }
  if (!filePath || filePath.startsWith("/") || filePath.includes("\\") || filePath.split("/").includes("..")) return fail("This Markdown file has no valid owning workspace path.");
  const base = filePath.slice(0, filePath.lastIndexOf("/") + 1);
  // Encode literal filename punctuation before passing through the shared location parser.
  const target = resolveTranscriptLink((path.startsWith("/") ? path : base + path).split("/").map(encodeURIComponent).join("/"), workspacePath);
  return target.kind === "file" ? { kind: "file", file: { ...target.file, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }), ...(endLine === undefined ? {} : { endLine }) } } : target;
}
