import {sanitizedMarkdownHtml} from "./transcript-markdown-copy";

/** Produce inert clipboard HTML without copying renderer state or action controls. */
export function sanitizedTableHtml(table: HTMLTableElement): string {
  if (table?.nodeType !== 1 || table.localName.toLowerCase() !== "table") throw new Error("A rendered table is required for copying.");
  return sanitizedMarkdownHtml(table);
}

/** Copy exact source Markdown plus a safe rich-table representation when supported. */
export async function copyTranscriptTable(table: HTMLTableElement, markdownSource: string): Promise<void> {
  if (typeof markdownSource !== "string") throw new Error("Table Markdown is unavailable.");
  const clipboard = navigator.clipboard;
  if (typeof clipboard?.write === "function" && typeof ClipboardItem === "function") {
    await clipboard.write([new ClipboardItem({
      "text/plain": new Blob([markdownSource], { type: "text/plain" }),
      "text/html": new Blob([sanitizedTableHtml(table)], { type: "text/html" }),
    })]);
    return;
  }
  if (typeof clipboard?.writeText !== "function") throw new Error("Clipboard writing is unavailable.");
  await clipboard.writeText(markdownSource);
}
