import type { CSSProperties } from "react";
export interface ExtensionTextRun { text: string; style: CSSProperties }
const palette = ["#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0", "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff"];
function indexedColor(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return;
  if (index < 16) return palette[index];
  if (index >= 232) { const value = 8 + (index - 232) * 10; return `rgb(${value}, ${value}, ${value})`; }
  const value = index - 16, levels = [0, 95, 135, 175, 215, 255];
  return `rgb(${levels[Math.floor(value / 36)]}, ${levels[Math.floor(value / 6) % 6]}, ${levels[value % 6]})`;
}
/** Safe SGR text only: never HTML, cursor operations, OSC actions or links. */
export function extensionTextRuns(input: string): ExtensionTextRun[] {
  const wellFormed = (input as string & { toWellFormed(): string }).toWellFormed(), text = wellFormed === input ? input : wellFormed.replaceAll("\ufffd", "");
  const controls = /(?:\x1b\[|\x9b)([0-?]*)([ -/]*)([@-~])|(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
  let foreground: string | undefined, background: string | undefined, bold = false, italic = false, underline = false, strike = false, inverse = false, faint = false, concealed = false;
  const runs: ExtensionTextRun[] = [];
  const append = (part: string) => {
    if (!part) return;
    runs.push({ text: part, style: { color: inverse ? background ?? "var(--app-bg)" : foreground,
      backgroundColor: inverse ? foreground ?? "var(--text)" : background, fontWeight: bold ? 600 : undefined,
      fontStyle: italic ? "italic" : undefined, textDecorationLine: [underline && "underline", strike && "line-through"].filter(Boolean).join(" ") || undefined,
      visibility: concealed ? "hidden" : undefined, opacity: faint ? 0.65 : undefined } });
  };
  let end = 0;
  for (const match of text.matchAll(controls)) {
    append(text.slice(end, match.index)); end = match.index! + match[0].length;
    if (match[3] !== "m" || match[2] || !/^\d*(;\d*)*$/.test(match[1] ?? "")) continue;
    const codes = (match[1] || "0").split(";").map(value => Number(value || 0));
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code === 0) { foreground = background = undefined; bold = italic = underline = strike = inverse = faint = concealed = false; }
      else if (code === 1) bold = true;
      else if (code === 2) faint = true;
      else if (code === 3 || code === 23) italic = code === 3;
      else if (code === 4 || code === 24) underline = code === 4;
      else if (code === 7 || code === 27) inverse = code === 7;
      else if (code === 8 || code === 28) concealed = code === 8;
      else if (code === 9 || code === 29) strike = code === 9;
      else if (code === 22) bold = faint = false;
      else if (code === 39) foreground = undefined;
      else if (code === 49) background = undefined;
      else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) foreground = palette[code < 90 ? code - 30 : code - 90 + 8];
      else if (code >= 40 && code <= 47 || code >= 100 && code <= 107) background = palette[code < 100 ? code - 40 : code - 100 + 8];
      else if (code === 38 || code === 48) {
        let color: string | undefined;
        if (codes[i + 1] === 5) { color = indexedColor(codes[i + 2]!); i += 2; }
        else if (codes[i + 1] === 2) {
          const rgb = codes.slice(i + 2, i + 5); i += 4;
          if (rgb.length === 3 && rgb.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) color = `rgb(${rgb.join(", ")})`;
        }
        if (color) { if (code === 38) foreground = color; else background = color; }
      }
    }
  }
  append(text.slice(end)); return runs;
}
