import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownText } from "../../apps/desktop/src/renderer/MarkdownText";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const long = "SupercalifragilisticexpialidociousUnbrokenTranscriptColumnValue";
const firstOriginal = `| Name | Detail | Glyph |
| :--- | ---: | :---: |
| Alpha \\| Beta | **bold** & <span onclick="steal()">raw</span> | 東京 🧪 |
| Unsafe | [script](javascript:alert(1)) | ${long} |
| Extra | \`code\` | λ |`;
const firstUpdated = firstOriginal.replace("東京 🧪", "Zürich Δ updated");
const second = `| Key | Value |
| --- | --- |
| other | Deuxième naïve résumé |
| count | 2 |`;
const runtimeErrors: string[] = [], clipboardCalls: Array<{ api: string; payload?: Record<string, string>; text?: string }> = [];
let clipboardMode: "multi" | "fallback" | "failure" | "pending" = "multi", releasePending: (() => void) | undefined;
const controlledClipboard: { write?: (items: ClipboardItem[]) => Promise<void>; writeText(text: string): Promise<void> } = {
  async write(items) {
    if (clipboardMode === "failure") throw new Error("Injected clipboard write failure");
    const payload: Record<string, string> = {};
    for (const item of items) for (const type of item.types) payload[type] = await (await item.getType(type)).text();
    clipboardCalls.push({ api: "write", payload });
    if (clipboardMode === "pending") await new Promise<void>(resolve => { releasePending = resolve; });
  },
  async writeText(text) {
    if (clipboardMode === "failure") throw new Error("Injected clipboard text failure");
    clipboardCalls.push({ api: "writeText", text });
  },
};
Object.defineProperty(navigator, "clipboard", { configurable: true, value: controlledClipboard });
window.addEventListener("error", event => runtimeErrors.push(`${event.message}\n${event.error?.stack ?? ""}`));
window.addEventListener("unhandledrejection", event => runtimeErrors.push(String(event.reason?.stack ?? event.reason)));
let setWide: (value: boolean) => void, updateFirst: (updated: boolean) => void;

function Fixture() {
  const [wide, changeWide] = useState(false), [first, setFirst] = useState(firstOriginal);
  setWide = changeWide; updateFirst = updated => setFirst(updated ? firstUpdated : firstOriginal);
  return <main className="transcript-scroll transcript-tables-fixture" aria-label="Transcript tables fixture">
    <section aria-label="First transcript block"><MarkdownText text={`Before first.\n\n${first}\n\nAfter first.`} blockKey="transcript-table-first" allowWideBlocks={wide}/></section>
    <section aria-label="Second transcript block"><MarkdownText text={`Before second.\n\n${second}\n\nAfter second.`} blockKey="transcript-table-second" allowWideBlocks={wide}/></section>
    <button className="fixture-focus" type="button">Fixture focus</button>
  </main>;
}

document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture/>);
const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter(node => node.getClientRects().length);
const rect = (node: Element | undefined) => node instanceof HTMLElement ? node.getBoundingClientRect().toJSON() : undefined;
Object.assign(window, {
  clipboardMode(mode: "multi" | "fallback" | "failure" | "pending") {
    clipboardMode = mode;
    if (mode === "fallback") controlledClipboard.write = undefined;
    else controlledClipboard.write = async items => {
      if (clipboardMode === "failure") throw new Error("Injected clipboard write failure");
      const payload: Record<string, string> = {};
      for (const item of items) for (const type of item.types) payload[type] = await (await item.getType(type)).text();
      clipboardCalls.push({ api: "write", payload });
      if (clipboardMode === "pending") await new Promise<void>(resolve => { releasePending = resolve; });
    };
  },
  updateFirst: (updated = true) => updateFirst(updated),
  resolveClipboard: () => { releasePending?.(); releasePending = undefined; },
  wide: (value: boolean) => setWide(value),
  target(selector: string, label?: string, index = 0) { const nodes = visible(selector).filter(node => label === undefined || node.textContent?.trim() === label || node.getAttribute("aria-label") === label); const node = nodes[index]; if (!node) throw new Error(`Missing ${selector} ${label ?? ""} ${index}`); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; },
  state() {
    const regions = visible('[role="region"][aria-label="Markdown table"]'), dialog = visible('dialog[aria-label="Table preview"]')[0];
    return { body: document.body.innerText, tables: regions.map((region, index) => ({ index, text: region.querySelector("table")?.innerText, rect: rect(region), clientWidth: region.clientWidth, scrollWidth: region.scrollWidth, rows: region.querySelectorAll("tr").length, cells: region.querySelectorAll("th,td").length })),
      copyButtons: visible('button[aria-label="Copy table"]').length, expandButtons: visible('button[aria-label="Expand table"]').length, menuCount: visible('[role="menu"]').length,
      dialog: dialog && { label: dialog.getAttribute("aria-label"), rect: rect(dialog), text: dialog.innerText, tables: dialog.querySelectorAll("table").length, actionsInsideTable: dialog.querySelector("table")?.querySelectorAll("button").length },
      clipboardCalls: [...clipboardCalls], focused: document.activeElement instanceof HTMLElement ? document.activeElement.getAttribute("aria-label") || document.activeElement.innerText : undefined,
      overflow: { documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, viewportWidth: innerWidth }, runtimeErrors: [...runtimeErrors], viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale },
      firstOriginal, firstUpdated, second };
  },
});
