import { TranscriptReadingPositions, TranscriptViewport, type TranscriptReadingPosition } from "../../apps/desktop/src/renderer/transcript-scroll";
import { transcriptHookAcceptance } from "./transcript-hook-browser";
import { transcriptMarkdownAcceptance } from "./transcript-markdown-browser";

// Deterministic content fixture in a real Electron DOM, not provider/UI-parity evidence.
const settle = async () => { for (let frame = 0; frame < 5; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
const near = (actual: number, expected: number, label: string) => { if (Math.abs(actual - expected) > 1.1) throw new Error(`${label}: expected ${expected}, received ${actual}`); };
const requireValue = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };

Object.assign(globalThis, { runTranscriptScrollAcceptance: async () => {
  const viewport = document.querySelector<HTMLElement>(".transcript-scroll")!, content = document.querySelector<HTMLElement>(".transcript")!;
  const checks: string[] = [];
  for (let i = 0; i < 90; i++) {
    const row = document.createElement("article"); row.dataset.messageId = `native-message-${i}`;
    for (let j = 0; j < 4; j++) { const p = document.createElement("p"); p.textContent = `Message ${i}, paragraph ${j}. ` + "Real layout wraps these words when the viewport changes. Unicode λ 🦀 is retained. ".repeat(5); row.append(p); }
    const button = document.createElement("button"); button.textContent = `Disclosure ${i}`; row.append(button); content.append(row);
  }
  let position: TranscriptReadingPosition | undefined;
  const positions = new TranscriptReadingPositions(sessionStorage);
  let controller = new TranscriptViewport(viewport, content, positions.get("host-a:session-a"), value => { position = value; positions.set("host-a:session-a", value); });
  const bottom = () => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
  const anchor = () => {
    const saved = position?.anchor; requireValue(saved, "Reading anchor must exist");
    let element: Element = [...content.querySelectorAll<HTMLElement>("[data-message-id]")].find(row => row.dataset.messageId === saved!.messageId)!;
    for (const index of saved!.path) element = element.children[index]!;
    return element;
  };
  const offset = () => anchor().getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  await settle(); near(bottom(), 0, "First opening follows latest"); checks.push("initial latest");
  viewport.scrollTop = content.children[34]!.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop + 53;
  await settle(); requireValue(position?.following === false, "Scrolling away stops following");
  let savedOffset = offset(), savedId = position!.anchor!.messageId;
  const readingNode = anchor().firstChild!; const selection = getSelection()!; const range = document.createRange(); range.setStart(readingNode, 0); range.setEnd(readingNode, 12); selection.removeAllRanges(); selection.addRange(range);
  const selectedText = selection.toString();
  content.lastElementChild!.append(document.createTextNode("Streaming text below the reading position. ".repeat(40)));
  await settle(); near(offset(), savedOffset, "Appending below preserves reading offset"); requireValue(selection.toString() === selectedText, "Selection survives append"); checks.push("stream below reader and selection");
  const growing = document.createElement("pre"); growing.textContent = "Expanded actual DOM tool output\n".repeat(20); content.children[5]!.append(growing);
  await settle(); near(offset(), savedOffset, "Expanding above preserves reading offset"); checks.push("expansion above reader");
  viewport.style.width = "450px";
  await settle(); requireValue(position!.anchor!.messageId === savedId, "Resize preserves the native message identity"); near(offset(), savedOffset, "Width change preserves paragraph offset"); checks.push("panel width and paragraph reflow");
  content.style.fontSize = "19px";
  await settle(); near(offset(), savedOffset, "Font change preserves paragraph offset"); checks.push("theme font change");
  viewport.style.height = "270px";
  await settle(); near(offset(), savedOffset, "Dock height change preserves reading position"); checks.push("terminal dock height");
  controller.latest(); await settle(); near(bottom(), 0, "Return to latest"); requireValue(position?.following, "Latest resumes following");
  content.lastElementChild!.append(document.createTextNode("Live growth while following. ".repeat(80)));
  await settle(); near(bottom(), 0, "Streaming remains followed"); checks.push("return to latest and streamed growth");
  viewport.scrollTop = content.children[20]!.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop + 29;
  await settle(); savedOffset = offset(); savedId = position!.anchor!.messageId; controller.dispose(); positions.flush();
  // A different selected session can have a completely different length/position.
  const rows = [...content.children]; content.replaceChildren();
  const other = document.createElement("article"); other.dataset.messageId = "other-native-message"; other.style.height = "2200px"; content.append(other);
  controller = new TranscriptViewport(viewport, content, undefined, value => positions.set("host-b:session-b", value)); await settle(); near(bottom(), 0, "Independent session opens at latest"); controller.dispose();
  content.replaceChildren(...rows);
  const restored = new TranscriptReadingPositions(sessionStorage);
  controller = new TranscriptViewport(viewport, content, restored.get("host-a:session-a"), value => { position = value; positions.set("host-a:session-a", value); });
  await settle(); requireValue(position!.anchor!.messageId === savedId, "Session return preserves identity"); near(offset(), savedOffset, "Session return restores position"); checks.push("navigation and window-local reload persistence");
  content.replaceChildren(); await settle(); content.replaceChildren(...rows); await settle();
  requireValue(position!.anchor!.messageId === savedId, "Empty reconnect keeps reading identity"); near(offset(), savedOffset, "Reconnect restores anchor"); checks.push("empty cache/live transition");
  const input = document.createElement("button"); input.textContent = "Focused native control"; anchor().append(input); input.focus({ preventScroll: true });
  growing.textContent += "Another tool output line\n".repeat(10); await settle(); requireValue(document.activeElement === input, "Layout correction preserves focus"); near(offset(), savedOffset, "Focused reading anchor remains stable"); checks.push("focus survives output expansion");
  const beforeWheel = viewport.scrollTop;
  viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 80, bubbles: true }));
  content.lastElementChild!.append(document.createTextNode("Same-frame stream while the reader scrolls. ".repeat(30)));
  viewport.scrollTop = beforeWheel + 80;
  await settle(); near(viewport.scrollTop, beforeWheel + 80, "User scroll survives same-frame stream geometry change"); checks.push("input wins over same-frame streaming resize");
  viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight - 150;
  await settle(); requireValue(!position!.following, "Near-end reader stops following"); savedId = position!.anchor!.messageId;
  content.style.fontSize = "10px"; await settle();
  requireValue(!position!.following, "Browser scroll clamping after a font shrink must not enable following");
  requireValue(position!.anchor!.messageId === savedId, "Browser clamping retains the original reading anchor"); checks.push("font shrink near end preserves reading mode");
  controller.dispose(); positions.flush();
  const hook = await transcriptHookAcceptance();
  const markdown = await transcriptMarkdownAcceptance();
  return { passed: true, checks, hook, markdown, electron: navigator.userAgent, source: "Actual production TranscriptViewport in deterministic Electron DOM fixture; not installed-app or provider acceptance" };
} });
