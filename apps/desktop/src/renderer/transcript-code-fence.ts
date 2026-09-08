/** mdast/hast code positions exclude container prefixes on the opening line.
 * The parsed body line count distinguishes an actual closing fence from a fence
 * that the Markdown parser kept as code (short, indented or in a nested block).
 */
export function codeFenceOpen(raw: string, body: string): boolean {
  const lines = raw.split(/\r\n|\n|\r/), opening = /^ {0,3}(`{3,}|~{3,})/.exec(lines[0] ?? "");
  if (!opening) return false; // Indented code has no fence lifecycle.
  const marker = opening[1]!, last = lines.at(-1) ?? "";
  const closing = /^[\t >]*(`+|~+)[\t ]*$/.exec(last);
  if (lines.length < 2 || !closing || closing[1]![0] !== marker[0] || closing[1]!.length < marker.length) return true;
  const bodyLines = body === "" ? 0 : body.split(/\r\n|\n|\r/).length;
  return !(lines.length === bodyLines + 2 || body === "" && lines.length === 3);
}
