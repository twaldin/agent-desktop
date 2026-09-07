/** Convert Pierre/CodeMirror zero-based line + UTF-16 column to a raw-buffer offset. */
export function rawOffsetAt(raw: string, point: { line: number; character: number }): number {
  const lines = raw.split(/\r\n|\r|\n/);
  let offset = 0;
  for (let line = 0; line < point.line; line++) offset += lines[line]!.length + (raw.slice(offset + lines[line]!.length, offset + lines[line]!.length + 2) === "\r\n" ? 2 : 1);
  return offset + point.character;
}

