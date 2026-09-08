import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MarkdownText } from "../../apps/desktop/src/renderer/MarkdownText";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const firstOriginal = `const greeting = "東京 🧪";
const veryLongIdentifierWithoutBreaks = "SupercalifragilisticexpialidociousTranscriptCodeBlockOverflowValue";
// italic comment
console.log(greeting);`;
const firstUpdated = `${firstOriginal}\nconsole.log("streamed Δ");`;
const secondOriginal = `value = "café"
print(value)`;
const secondAppended = `${secondOriginal}\nresult = value.upper()`;
const calls: Array<{ text: string; state: "completed" | "pending" }> = [], selectionCopies: Array<{ plain: string; html: string; prevented: boolean }> = [], runtimeErrors: string[] = [];
const highlightPhases: Array<{ key?: string; highlighted?: string; text?: string }> = [];
let clipboardMode: "success" | "failure" | "pending" = "success", resolvePending: (() => void) | undefined;
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { async writeText(text: string) {
  if (clipboardMode === "failure") throw new Error("Injected code clipboard failure");
  const call = { text, state: clipboardMode === "pending" ? "pending" as const : "completed" as const }; calls.push(call);
  if (clipboardMode === "pending") { await new Promise<void>(resolve => { resolvePending = resolve; }); call.state = "completed"; }
} } });
window.addEventListener("error", event => runtimeErrors.push(`${event.message}\n${event.error?.stack ?? ""}`));
window.addEventListener("unhandledrejection", event => runtimeErrors.push(String(event.reason?.stack ?? event.reason)));
let appendSecond: () => void, closeSecond: () => void, updateFirst: (updated: boolean) => void, setStreaming: (streaming: boolean) => void;

function Fixture() {
  const [first, setFirst] = useState(firstOriginal), [second, setSecond] = useState(secondOriginal), [closed, setClosed] = useState(false), [streaming, stream] = useState(true);
  appendSecond = () => setSecond(secondAppended); closeSecond = () => setClosed(true); updateFirst = updated => setFirst(updated ? firstUpdated : firstOriginal); setStreaming = stream;
  const markdown = `Before code.\n\n\`\`\`js\n${first}\n\`\`\`\n\nBetween blocks.\n\n\`\`\`MyDSL\nentity Café { value: 7 }\n\`\`\`\n\n\`\`\`py\n${second}${closed ? "\n```\n\nAfter code." : ""}`;
  return <main className="transcript-scroll transcript-code-blocks-fixture" aria-label="Transcript code blocks fixture"><MarkdownText text={markdown} blockKey="transcript-code-blocks" allowWideBlocks streaming={streaming}/></main>;
}

document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Fixture/>);
new MutationObserver(records => { for (const record of records) for (const node of [...record.addedNodes, record.target]) { const element = node instanceof Element ? node.closest<HTMLElement>(".markdown-code-block") ?? node.querySelector?.<HTMLElement>(".markdown-code-block") : undefined; if (element) highlightPhases.push({ key: element.dataset.codeKey, highlighted: element.dataset.highlighted, text: element.textContent ?? undefined }); } }).observe(document.getElementById("root")!, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-highlighted"] });
const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].filter(node => node.getClientRects().length);
const pointAt = (root: Element, absoluteOffset: number) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let remaining = absoluteOffset, node: Text | null = null;
  while (walker.nextNode()) { const candidate = walker.currentNode as Text; if (remaining <= candidate.data.length) { node = candidate; break; } remaining -= candidate.data.length; }
  if (!node) throw new Error(`Text offset ${absoluteOffset} is unavailable`);
  const range = document.createRange(); range.setStart(node, remaining); range.collapse(true); const box = range.getBoundingClientRect(); return { x: box.x, y: box.y + box.height / 2 };
};
Object.assign(window, {
  appendSecond: () => appendSecond(), closeSecond: () => closeSecond(), updateFirst: (updated = true) => updateFirst(updated), streaming: (value: boolean) => setStreaming(value),
  clipboardMode(mode: "success" | "failure" | "pending") { clipboardMode = mode; }, resolveClipboard() { resolvePending?.(); resolvePending = undefined; },
  copySelection(index: number) { const pre = visible(".markdown-code-block pre")[index]; if (!pre) throw new Error(`Missing pre ${index}`); const data = new DataTransfer(); const event = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }); const result = pre.dispatchEvent(event); const copy = { plain: data.getData("text/plain"), html: data.getData("text/html"), prevented: !result || event.defaultPrevented }; selectionCopies.push(copy); return copy; },
  copyTranscriptRange() { const markdown = document.querySelector<HTMLElement>(".transcript-markdown")!, before = [...markdown.querySelectorAll("p")].find(node => node.textContent === "Before code.")!, after = [...markdown.querySelectorAll("p")].find(node => node.textContent === "Between blocks.")!; const range = document.createRange(); range.setStart(before.firstChild!, 0); range.setEnd(after.firstChild!, after.firstChild!.textContent!.length); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); const data = new DataTransfer(); const event = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }); const result = markdown.dispatchEvent(event); return { selected: selection.toString(), plain: data.getData("text/plain"), html: data.getData("text/html"), prevented: !result || event.defaultPrevented }; },
  theme(value: "dark" | "light") { document.documentElement.dataset.theme = value; }, customString(value?: string) { if (value) document.documentElement.style.setProperty("--syntax-string", value); else document.documentElement.style.removeProperty("--syntax-string"); },
  selectionPoints(index: number, needle: string) { const code = visible(".markdown-code-block pre code")[index]; if (!code) throw new Error(`Missing code ${index}`); const start = code.textContent!.indexOf(needle); if (start < 0) throw new Error(`Missing needle ${needle}`); return { start: pointAt(code, start), end: pointAt(code, start + needle.length) }; },
  target(selector: string, label?: string, index = 0) { const node = visible(selector).filter(node => label === undefined || node.textContent?.trim() === label || node.getAttribute("aria-label") === label)[index]; if (!node) throw new Error(`Missing ${selector} ${label ?? ""} ${index}`); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; },
  state() {
    const selection = getSelection();
    return { body: document.body.innerText, blocks: visible(".markdown-code-block").map((block, index) => { const pre = block.querySelector<HTMLElement>("pre")!, code = pre.querySelector("code")!; return { index, key: block.dataset.codeKey, highlighted: block.dataset.highlighted, language: block.querySelector(".markdown-code-language")?.textContent, text: code.textContent, spans: code.querySelectorAll("span").length, wrapped: pre.classList.contains("wrapped"), clientWidth: pre.clientWidth, scrollWidth: pre.scrollWidth, whiteSpace: getComputedStyle(pre).whiteSpace, overflowWrap: getComputedStyle(pre).overflowWrap, rect: pre.getBoundingClientRect().toJSON(), buttons: [...block.querySelectorAll<HTMLButtonElement>("button")].map(button => ({ label: button.ariaLabel, pressed: button.ariaPressed, busy: button.ariaBusy, disabled: button.disabled, inert: Boolean(button.closest("[inert]")), text: button.innerText })) }; }),
      selection: { text: selection?.toString(), anchorBlock: selection?.anchorNode instanceof Node ? (selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode.parentElement)?.closest<HTMLElement>(".markdown-code-block")?.dataset.codeKey : undefined },
      clipboardCalls: calls.map(call => ({ ...call })), selectionCopies: [...selectionCopies], highlightPhases: [...highlightPhases], runtimeErrors: [...runtimeErrors], menuCount: visible('[role="menu"]').length, dialogCount: visible("dialog").length,
      presentation: (() => { const block = visible(".markdown-code-block")[0], toolbar = block?.querySelector<HTMLElement>(".markdown-code-toolbar"), pre = block?.querySelector<HTMLElement>("pre"), string = block?.querySelector<HTMLElement>(".hljs-string"), keyword = block?.querySelector<HTMLElement>(".hljs-keyword"), comment = block?.querySelector<HTMLElement>(".hljs-comment"); return { theme: document.documentElement.dataset.theme, radius: block && getComputedStyle(block).borderRadius, surface: block && getComputedStyle(block).backgroundColor, labelSize: toolbar && getComputedStyle(toolbar).fontSize, codeSize: pre && getComputedStyle(pre).fontSize, codeLineHeight: pre && getComputedStyle(pre).lineHeight, string: string && getComputedStyle(string).color, keyword: keyword && getComputedStyle(keyword).color, comment: comment && getComputedStyle(comment).color, commentStyle: comment && getComputedStyle(comment).fontStyle }; })(),
      overflow: { documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, viewportWidth: innerWidth }, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale }, firstOriginal, firstUpdated, secondOriginal, secondAppended };
  },
});
