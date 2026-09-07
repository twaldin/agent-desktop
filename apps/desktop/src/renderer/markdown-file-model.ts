/** A preview parser, never a serializer. Unsupported YAML stays visible as source. */
export interface MarkdownMetadata { end: number; entries: { key: string; value: string | string[] }[] }
export const normalizeMarkdown = (text: string) => text.replace(/\r\n?|\n/g, "\n");
export function markdownTextChange(before: string, after: string): {from:number;to:number;insert:string} {
  let from = 0, end = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  while (end < before.length - from && end < after.length - from && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  return {from,to:before.length-end,insert:after.slice(from,after.length-end)};
}

/** Rich-mode metadata is a read-only card. Its hidden source is editable only in source mode. */
export function protectMarkdownPrefix(changes: {from:number;to:number;insert:string}[], end: number) {
  return changes.flatMap(change => {
    if (change.from >= end) return [change];
    if (change.to <= end) return change.from === change.to && change.insert ? [{from:end,to:end,insert:change.insert}] : [];
    return [{...change,from:end}];
  });
}

export function markdownMetadata(text: string): MarkdownMetadata | undefined {
  const lines = text.split("\n");
  if (!/^-{3,}$/.test(lines[0]?.trim() ?? "")) return;
  const close = lines.findIndex((line, index) => index > 0 && /^-{3,}$/.test(line.trim()));
  if (close < 0) return;
  const entries: MarkdownMetadata["entries"] = [];
  function scalar(value: string): string | undefined {
    value = value.trim();
    if (value.startsWith('"')) { try { const result = JSON.parse(value); return typeof result === "string" ? result : undefined; } catch { return; } }
    if (value.startsWith("'")) return /^'(?:[^']|'')*'$/.test(value) ? value.slice(1,-1).replace(/''/g,"'") : undefined;
    if (/[\[\]{}]|:\s|^[|>&*!%@`]/.test(value)) return;
    return value.replace(/\s+#.*$/, "");
  }
  for (const line of lines.slice(1, close)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      const last = entries.at(-1), value = scalar(item[1]!);
      if (!last || !Array.isArray(last.value) || value === undefined) return;
      last.value.push(value); continue;
    }
    const pair = /^([\w.-]+):(?:\s+(.*)|\s*)$/.exec(line);
    if (!pair || entries.some(entry => entry.key === pair[1])) return;
    const raw = (pair[2] ?? "").trim();
    let value: string | string[] | undefined;
    if (!raw) value = [];
    else if (raw.startsWith("[") && raw.endsWith("]")) {
      // Quoted commas and nested YAML need a real parser; keep those headers visible.
      const parts = raw.slice(1,-1).trim() ? raw.slice(1,-1).split(",").map(scalar) : [];
      if (parts.some(part => part === undefined)) return;
      value = parts as string[];
    } else value = scalar(raw);
    if (value === undefined) return;
    entries.push({ key: pair[1]!, value });
  }
  if (!entries.length) return;
  return { end: lines.slice(0, close + 1).reduce((length, line) => length + line.length + 1, 0) - (close === lines.length - 1 ? 1 : 0), entries };
}

/** Map normalized CodeMirror changes onto original bytes, retaining untouched line endings. */
export function applyMarkdownChanges(raw: string, changes: { from: number; to: number; insert: string }[]): string {
  const offsets = [0];
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === "\r" && raw[index + 1] === "\n") index++;
    offsets.push(index + 1);
  }
  const separator = /\r\n|\r|\n/.exec(raw)?.[0] ?? "\n";
  let output = "", previous = 0;
  for (const change of changes) {
    output += raw.slice(previous, offsets[change.from]) + normalizeMarkdown(change.insert).replace(/\n/g, separator);
    previous = offsets[change.to]!;
  }
  return output + raw.slice(previous);
}
