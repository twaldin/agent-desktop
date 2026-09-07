/** A captured excerpt, not an instruction to reread a path on the receiving host. */
export interface SelectedTextAttachment {
  id: string;
  text: string;
  source: {
    kind: "file";
    hostId: string;
    path: string;
    /** One-based lines and UTF-16 columns; the end position is exclusive. */
    range: { start: TextSelectionPosition; end: TextSelectionPosition };
  };
}
export interface TextSelectionPosition { line: number; column: number }
export interface FileTextSelection { text: string; range: SelectedTextAttachment["source"]["range"] }

/** Application transport bound, not a Codex/provider capability claim. */
export const MAX_SELECTED_TEXT_SERIALIZED_CHARS = 400_000;

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key)))
    throw new Error("Invalid selected-text snapshot.");
  return value as Record<string, unknown>;
}
function label(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || /[\x00-\x1f\x7f]/.test(value))
    throw new Error("Invalid selected-text source.");
  return value;
}
function position(value: unknown): TextSelectionPosition {
  const point = record(value, ["line", "column"]);
  if (!Number.isSafeInteger(point.line) || (point.line as number) < 1
    || !Number.isSafeInteger(point.column) || (point.column as number) < 1) throw new Error("Invalid selected-text range.");
  return { line: point.line as number, column: point.column as number };
}

/** Snapshot provenance may name another host. It grants no filesystem access. */
export function parseSelectedTextAttachments(value: unknown): SelectedTextAttachment[] {
  if (!Array.isArray(value)) throw new Error("Invalid selected-text snapshots.");
  const ids = new Set<string>();
  let length = 2;
  const result: SelectedTextAttachment[] = [];
  for (const raw of value) {
    const item = record(raw, ["id", "text", "source"]), source = record(item.source, ["kind", "hostId", "path", "range"]);
    const id = label(item.id, 200), hostId = label(source.hostId, 200), path = label(source.path, 16_384);
    if (ids.has(id)) throw new Error("Selected-text identities must be distinct.");
    ids.add(id);
    if (source.kind !== "file" || !path.startsWith("/") || path.endsWith("/") || path.split("/").some(part => part === "." || part === ".."))
      throw new Error("An absolute selected-text source path is required.");
    if (typeof item.text !== "string" || !item.text.trim() || item.text.includes("\0")) throw new Error("Select some text to add to chat.");
    if (item.text.length > MAX_SELECTED_TEXT_SERIALIZED_CHARS) throw new Error("Selected excerpts exceed the app's 400,000-character snapshot limit. Remove an excerpt before sending.");
    const range = record(source.range, ["start", "end"]), start = position(range.start), end = position(range.end);
    if (end.line < start.line || end.line === start.line && end.column <= start.column) throw new Error("Invalid selected-text range.");
    const lines = item.text.split(/\r\n|\r|\n/);
    if (end.line - start.line !== lines.length - 1
      || end.column !== (lines.length === 1 ? start.column : 1) + lines.at(-1)!.length)
      throw new Error("The selected-text range does not describe its snapshot.");
    const snapshot: SelectedTextAttachment = { id, text: item.text, source: { kind: "file", hostId, path, range: { start, end } } };
    length += JSON.stringify(snapshot).length + (result.length ? 1 : 0);
    if (length > MAX_SELECTED_TEXT_SERIALIZED_CHARS) throw new Error("Selected excerpts exceed the app's 400,000-character snapshot limit. Remove an excerpt before sending.");
    result.push(snapshot);
  }
  return result;
}

export function sameSelectedTextAttachments(left?: readonly SelectedTextAttachment[], right?: readonly SelectedTextAttachment[]): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]!;
    return item.id === other.id && item.text === other.text && item.source.kind === other.source.kind
      && item.source.hostId === other.source.hostId && item.source.path === other.source.path
      && item.source.range.start.line === other.source.range.start.line && item.source.range.start.column === other.source.range.start.column
      && item.source.range.end.line === other.source.range.end.line && item.source.range.end.column === other.source.range.end.column;
  });
}

/** Offsets are UTF-16 boundaries into the original buffer, including unsaved edits. */
export function fileTextSelection(value: string, from: number, to: number): FileTextSelection | undefined {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > value.length) return;
  // A CRLF is one line boundary; no valid editor position sits inside it.
  if (value[from - 1] === "\r" && value[from] === "\n" || value[to - 1] === "\r" && value[to] === "\n") return;
  const text = value.slice(from, to);
  if (!text.trim()) return;
  const at = (offset: number): TextSelectionPosition => {
    let line = 1, start = 0;
    const newline = /\r\n|\r|\n/g;
    for (let match; (match = newline.exec(value)) && match.index + match[0].length <= offset;) { line++; start = match.index + match[0].length; }
    return { line, column: offset - start + 1 };
  };
  return { text, range: { start: at(from), end: at(to) } };
}
