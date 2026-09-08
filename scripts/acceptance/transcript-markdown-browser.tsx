import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MarkdownText, TranscriptMarkdownContext } from "../../apps/desktop/src/renderer/MarkdownText";
import { MarkdownViewState } from "../../apps/desktop/src/renderer/markdown-state";
import type { WorkspaceFileLink } from "../../apps/desktop/src/renderer/transcript-links";

const settle = async () => { for (let frame = 0; frame < 4; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
const check = (value: unknown, label: string) => { if (!value) throw new Error(`Markdown DOM: ${label}`); };
function point(root: HTMLElement, position: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let offset = position;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) { if (offset <= node.textContent!.length) return { node, offset }; offset -= node.textContent!.length; }
  throw new Error("Fixture selection offset is unavailable");
}
/** Controlled content in actual React + Electron DOM. Clipboard success is native;
 * the rejection test deliberately injects a DOMException and is labeled as such.
 * This is not installed-app/provider or physical remote-host evidence.
 */
export async function transcriptMarkdownAcceptance() {
  const container = document.createElement("div"); container.style.cssText = "width:420px;--font-size:14px;--line-height:1.5;--spacing-scale:1;--spacing-xs:4px;--spacing-sm:8px;--spacing-md:12px;--panel-padding:14px;--code-font:monospace;--code-font-size:12px;--code-font-weight:400;--code-line-height:1.65;--small-font-size:11px;--border-width:1px;--border:#555;--radius-small:6px;--radius-large:12px";
  document.body.append(container); const root = createRoot(container), views = new MarkdownViewState(), files: WorkspaceFileLink[] = [], external: string[] = [], checks: string[] = [];
  const actions = { cwd: "/owning/remote/project", openFile: (file: WorkspaceFileLink) => { files.push(file); }, openExternal: async (url: string) => { external.push(url); } };
  const paint = (text: string, secondary?: string) => flushSync(() => root.render(<TranscriptMarkdownContext value={{ actions, views }}><MarkdownText blockKey="fixture-owner:message:block:0" text={text}/>{secondary && <MarkdownText blockKey="other-owner:message:block:0" text={secondary}/>}</TranscriptMarkdownContext>));
  let clipboardBefore: string | undefined;
  let nativeClipboardDeferred = false, clipboardChanged = false;
  try {
    paint("```js\nfunction rea"); await settle();
    const block = container.querySelector<HTMLElement>(".markdown-code-block")!, code = block.querySelector<HTMLElement>("code")!, pre = block.querySelector<HTMLElement>("pre")!, wrap = block.querySelector<HTMLButtonElement>('[aria-label="Wrap code lines"]')!;
    pre.focus({ preventScroll: true }); const anchor = point(code, 12), focus = point(code, 9);
    getSelection()!.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset); check(getSelection()!.toString() === "rea", "initial backward selection");
    const finalCode = `function read() {\n  return "${"x".repeat(220)}";\n}`;
    paint("```js\n" + finalCode); await settle();
    check(container.querySelector("code") === code, "code DOM identity survives token reclassification");
    check(getSelection()!.toString() === "rea", "selection survives partial-stream syntax reclassification"); check(document.activeElement === pre, "stream update preserves code focus"); checks.push("partial stream code identity, selection and focus");
    check(getComputedStyle(pre).whiteSpace === "pre", "production Markdown CSS is loaded"); check(pre.scrollWidth > pre.clientWidth, "unwrapped long code actually scrolls horizontally");
    wrap.click(); await settle(); check(wrap.getAttribute("aria-pressed") === "true" && getComputedStyle(pre).whiteSpace === "pre-wrap", "wrap control updates real layout");
    check(pre.scrollWidth <= pre.clientWidth + 2, "wrapped long line fits the code viewport");
    paint("```js\n" + finalCode + "\n```"); await settle(); check(container.querySelector("code") === code && pre.classList.contains("wrapped"), "closing fence preserves DOM and wrap preference"); checks.push("copy-free wrap, horizontal scrolling and completed-fence transition");
    try { clipboardBefore = await navigator.clipboard.readText(); }
    catch (cause) {
      if (!document.hasFocus() && cause instanceof DOMException && cause.name === "NotAllowedError") nativeClipboardDeferred = true;
      else throw cause;
    }
    const copy = block.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!; copy.click(); await settle();
    if (nativeClipboardDeferred) { check(copy.textContent?.includes("Copy failed"), "actual unfocused Clipboard API rejection is visible"); checks.push("actual unfocused clipboard rejection UI; native success/readback deferred"); }
    else { check(copy.textContent === "Copied", "native clipboard success status"); clipboardChanged = true; check(await navigator.clipboard.readText() === finalCode, "native clipboard exact parsed code readback"); checks.push("actual Clipboard API copy and exact readback"); }
    const clipboard = navigator.clipboard, previousOwn = Object.getOwnPropertyDescriptor(clipboard, "writeText");
    let injectedRejections = 0;
    try {
      Object.defineProperty(clipboard, "writeText", { configurable: true, value: async () => { injectedRejections++; throw new DOMException("Explicit fixture permission rejection", "NotAllowedError"); } });
      copy.click(); await settle(); check(injectedRejections === 1 && copy.textContent?.includes("Copy failed"), "clipboard API rejection is visible and retryable");
    } finally { if (previousOwn) Object.defineProperty(clipboard, "writeText", previousOwn); else delete (clipboard as unknown as { writeText?: unknown }).writeText; }
    copy.click(); await settle(); check(nativeClipboardDeferred ? copy.textContent?.includes("Copy failed") : copy.textContent === "Copied", "copy retries through the restored native API"); checks.push(nativeClipboardDeferred ? "injected clipboard rejection and native denied retry while unfocused" : "injected clipboard rejection and native successful retry");
    const note = "Note[^a].\n\n[^a]: Scoped footnote.";
    paint(note + "\n\n[File](src/example.ts#L3C2) [Missing](missing.txt) [Outside](/etc/passwd) [Unsafe](javascript:alert%281%29) [Web](https://example.com/) [Missing anchor](#not-present)", note); await settle();
    const reference = container.querySelector<HTMLAnchorElement>("a[data-footnote-ref]")!, ownMarkdown = reference.closest(".transcript-markdown")!;
    reference.click(); await settle(); check(ownMarkdown.contains(document.activeElement) && document.activeElement?.tagName === "LI", "footnote navigation focuses its owning message target"); checks.push("scoped duplicate footnotes and keyboard focus");
    const file = container.querySelector<HTMLButtonElement>(".transcript-file-reference")!; file.click(); await settle(); check(JSON.stringify(files[0]) === JSON.stringify({ path: "src/example.ts", line: 3, column: 2 }), "file callback receives owner-relative path and exact position");
    const web = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(a => a.textContent === "Web")!; web.click(); await settle(); check(external[0] === "https://example.com/", "external URL goes through supplied desktop opener");
    check(!container.querySelector('a[href^="javascript:"]') && ![...container.querySelectorAll("button")].some(button => button.textContent === "Outside"), "unsafe/outside links do not become executable actions");
    const missing = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(a => a.textContent === "Missing anchor")!; missing.click(); await settle(); check(container.textContent?.includes("This anchor is unavailable"), "missing anchor reports actual failure"); checks.push("file/external dispatch, unavailable link boundaries and missing-anchor error");
    return { passed: true, checks, clipboard: { nativeCopyAndReadbackVerified: !nativeClipboardDeferred, actualUnfocusedRejectionVerified: nativeClipboardDeferred, injectedRejectionVerified: injectedRejections === 1, ...(nativeClipboardDeferred ? { deferred: "Native clipboard success/readback requires a focused installed window; the hidden document returned NotAllowedError." } : {}) }, userAgent: navigator.userAgent, source: "Production MarkdownText in a controlled Electron DOM fixture; native clipboard capability/results recorded explicitly, injected clipboard rejection labeled, link callbacks recorded without external navigation. Installed provider/file-panel acceptance remains separate." };
  } finally { if (clipboardChanged && clipboardBefore !== undefined) await navigator.clipboard.writeText(clipboardBefore); flushSync(() => root.unmount()); container.remove(); }
}
