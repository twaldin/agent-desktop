import type { WorkspaceQueryResult } from "@agent-desktop/shared";
export interface WorkspaceFileLink { path: string; line?: number; column?: number; endLine?: number }
export interface WorkspaceFileRequest extends WorkspaceFileLink { id: string }
export interface TranscriptLinkActions {
  /** POSIX cwd of this session on its owning host, never the viewing machine. */
  cwd?: string;
  /** Changes when the owner or connection changes; invalidates pending menu reads. */
  ownerKey?: string;
  fileOpenOptions?(file: WorkspaceFileLink): Promise<Extract<WorkspaceQueryResult, { type: "file.open-options" }>>;
  saveFileCopy?(file: WorkspaceFileLink): Promise<void>;
  openFileOnHost?(file: WorkspaceFileLink, targetId?: string): Promise<void>;
  openFile?(file: WorkspaceFileLink): Promise<void> | void;
  openExternal?(url: string): Promise<void>;
}
export type TranscriptLink =
  | { kind: "external"; url: string }
  | { kind: "fragment"; id: string }
  | { kind: "file"; file: WorkspaceFileLink }
  | { kind: "unavailable"; reason: string };
const unavailable = (reason: string): TranscriptLink => ({ kind: "unavailable", reason });
function absolutePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) { if (!part || part === ".") continue; if (part === "..") parts.pop(); else parts.push(part); }
  return `/${parts.join("/")}`;
}
/** Classify before opening. The owner host independently enforces its realpath boundary. */
export function resolveTranscriptLink(href: string, cwd?: string): TranscriptLink {
  if (!href || href.length > 32_768 || /[\x00-\x20\x7f\\]/.test(href)) return unavailable("This link has an unsupported URL or path.");
  if (href.startsWith("#")) {
    try { const id = href.slice(1), decoded = decodeURIComponent(id); return id && !/[\x00-\x1f\x7f]/.test(decoded) ? { kind: "fragment", id } : unavailable("This message anchor is invalid."); }
    catch { return unavailable("This message anchor has invalid encoding."); }
  }
  if (/^https?:/i.test(href)) {
    try {
      const url = new URL(href);
      if (url.username || url.password) return unavailable("Links containing embedded credentials cannot be opened.");
      if (url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return { kind: "external", url: url.href };
      return unavailable("The desktop browser opener supports HTTPS and local HTTP links.");
    } catch { return unavailable("This browser link is invalid."); }
  }
  if (href.startsWith("//")) return unavailable("Protocol-relative links are unsupported; use an explicit HTTPS URL.");
  let path = href, line: number | undefined, column: number | undefined;
  const fragmentIndex = path.indexOf("#");
  if (fragmentIndex >= 0) {
    const position = /^L([1-9]\d*)(?:C([1-9]\d*))?(?:-L[1-9]\d*)?$/.exec(path.slice(fragmentIndex + 1));
    if (!position) return unavailable("File links support #Lline or #LlineCcolumn locations.");
    line = Number(position[1]); column = position[2] ? Number(position[2]) : undefined; path = path.slice(0, fragmentIndex);
  }
  const suffix = /:([1-9]\d*)(?::([1-9]\d*))?$/.exec(path);
  if (suffix) { if (line !== undefined) return unavailable("This file link has two different location formats."); line = Number(suffix[1]); column = suffix[2] ? Number(suffix[2]) : undefined; path = path.slice(0, suffix.index); }
  if (line !== undefined && !Number.isSafeInteger(line) || column !== undefined && !Number.isSafeInteger(column)) return unavailable("This file location is out of range.");
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.includes("?")) return unavailable("This link type is not supported by the desktop.");
  try { path = decodeURIComponent(path); } catch { return unavailable("This file path has invalid encoding."); }
  if (!path || /[\x00-\x1f\x7f\\]/.test(path)) return unavailable("This file path is invalid.");
  if (!cwd?.startsWith("/")) return unavailable("This message has no owning workspace for file links.");
  const root = absolutePath(cwd), resolved = absolutePath(path.startsWith("/") ? path : `${root}/${path}`);
  if (resolved === root || root !== "/" && !resolved.startsWith(`${root}/`)) return unavailable("This file link is outside the session’s workspace.");
  return { kind: "file", file: { path: resolved.slice(root === "/" ? 1 : root.length + 1), ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) } };
}
/** Source selection offsets; line and optional UTF-16 column are one based. */
export function fileLocation(text: string, line: number, column?: number, endLine?: number): { start: number; end: number } | { error: string } {
  const lines = text.split(/\r\n|\r|\n/);
  if (!Number.isSafeInteger(line) || line < 1 || line > lines.length) return { error: `Line ${line} is unavailable; this buffer has ${lines.length} lines.` };
  if (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < line || endLine > lines.length)) return { error: `End line ${endLine} is unavailable in this buffer.` };
  const row = lines[line - 1]!;
  let start = 0, currentLine = 1;
  for (const newline of text.matchAll(/\r\n|\r|\n/g)) {
    if (currentLine++ === line) break;
    start = newline.index + newline[0].length;
  }
  if (column !== undefined) {
    if (!Number.isSafeInteger(column) || column < 1 || column > row.length + 1) return { error: `Column ${column} is unavailable on line ${line}.` };
    if (endLine === undefined) return { start: start + column - 1, end: start + column - 1 };
  }
  const lastLine = endLine ?? line;
  const end = lastLine === line ? start + row.length : (fileLocation(text, lastLine) as { start: number; end: number }).end;
  return { start: start + (column === undefined ? 0 : column - 1), end };
}
