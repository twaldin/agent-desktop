import type { WorkspaceTarget } from "./workspace";

/** User-facing locations are 1-based UTF-16 columns; ranges are end-exclusive. */
export interface SymbolPosition { line: number; column: number }
export interface SymbolSelection { start: SymbolPosition; end: SymbolPosition; direction: "forward" | "backward" }
export interface SymbolBuffer { path: string; revision: string; text: string }
export interface SymbolDefinitionRequest {
  path: string; revision: string; position: SymbolPosition;
  source: "working-tree" | "historical";
  /** All dirty workspace buffers, never written to the host by this query. */
  buffers: SymbolBuffer[];
}
export interface SymbolDefinition {
  path: string; revision: string; textHash: string; name: string;
  selection: SymbolSelection;
}
export interface SymbolCapability {
  available: boolean; provider: "typescript-7.0.2"; language: string | null;
  reason: string;
}
export type SymbolDefinitionResult =
  | { status: "definitions"; capability: SymbolCapability; definitions: SymbolDefinition[] }
  | { status: "unsupported" | "no-definition" | "stale" | "error"; capability: SymbolCapability; message: string };
export interface SymbolLocation extends SymbolDefinition {
  hostId: string; target: WorkspaceTarget; workspaceIdentity: string; selections: SymbolSelection[];
}
export function symbolLanguage(path: string): string | null {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return extension && ["ts", "tsx", "mts", "cts"].includes(extension) ? "typescript"
    : extension && ["js", "jsx", "mjs", "cjs"].includes(extension) ? "javascript" : null;
}
export function parseSymbolDefinitionRequest(value: unknown): SymbolDefinitionRequest {
  const input = value as SymbolDefinitionRequest;
  const validPath = (path: unknown): path is string => typeof path === "string" && path.length > 0 && path.length <= 4096 && !path.startsWith("/") && !/[\\\0]/.test(path) && !path.split("/").some(part => part === ".." || part === "." || !part);
  const validRevision = (revision: unknown) => typeof revision === "string" && /^[a-f0-9]{64}$/.test(revision);
  if (!input || !validPath(input.path) || !validRevision(input.revision) || !input.position
    || !Number.isSafeInteger(input.position.line) || input.position.line < 1 || !Number.isSafeInteger(input.position.column) || input.position.column < 1
    || !["working-tree", "historical"].includes(input.source) || !Array.isArray(input.buffers) || input.buffers.length > 32)
    throw new Error("An owner-relative file, exact revision, source context and 1-based cursor are required.");
  let bytes = 0; const paths = new Set<string>();
  for (const buffer of input.buffers) {
    if (!buffer || !validPath(buffer.path) || !validRevision(buffer.revision) || typeof buffer.text !== "string" || buffer.text.includes("\0") || paths.has(buffer.path))
      throw new Error("Symbol buffers must be distinct UTF-8 source files with exact base revisions.");
    paths.add(buffer.path); bytes += new TextEncoder().encode(buffer.text).length;
  }
  if (bytes > 2 * 1024 * 1024) throw new Error("Unsaved symbol buffers exceed 2 MiB. Save some files before retrying.");
  return { path: input.path, revision: input.revision, source: input.source, position: { ...input.position }, buffers: input.buffers.map(buffer => ({ ...buffer })) };
}
export function symbolOffset(text: string, point: SymbolPosition): number {
  if (!Number.isSafeInteger(point.line) || !Number.isSafeInteger(point.column) || point.line < 1 || point.column < 1) throw new Error("Symbol locations require positive integer lines and columns.");
  let offset = 0, line = 1;
  for (const row of text.split(/\r\n|\r|\n/)) {
    if (line === point.line) {
      if (point.column < 1 || point.column > row.length + 1) break;
      return offset + point.column - 1;
    }
    offset += row.length;
    offset += text[offset] === "\r" && text[offset + 1] === "\n" ? 2 : 1;
    line++;
  }
  throw new Error("The symbol location is outside this document. Select the symbol again.");
}
export function symbolPosition(text: string, offset: number): SymbolPosition {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new Error("The provider returned an invalid source offset.");
  const rows = text.slice(0, offset).split(/\r\n|\r|\n/);
  return { line: rows.length, column: rows.at(-1)!.length + 1 };
}
