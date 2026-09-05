import { createRoot } from "react-dom/client";
import { ReviewPanel } from "../../apps/desktop/src/renderer/ReviewPanel";
import type { WorkspaceState } from "../../apps/desktop/src/renderer/workspace-state";
import "../../apps/desktop/src/renderer/styles.css";
import "../../apps/desktop/src/renderer/theme.css";

const patch = ["diff --git a/sample.ts b/sample.ts", "index 1111111..2222222 100644", "--- a/sample.ts", "+++ b/sample.ts", "@@ -1 +1 @@", "-const old = 1;", "+const next = 2;"].join("\n");
const calls: unknown[] = [], listeners = new Set<() => void>(), checks: string[] = [], runtimeErrors: string[] = [];
addEventListener("error", event => runtimeErrors.push(event.message));
addEventListener("unhandledrejection", event => runtimeErrors.push(String(event.reason)));
const data = {
  connected: true, restored: true, busy: false, loading: new Set<string>(), errors: {}, diffSelection: { staged: false },
  diff: { patch, binary: false, path: undefined },
  status: { branch: "main", upstream: undefined, ahead: 0, behind: 0, revision: "review-fixture", entries: [{ path: "sample.ts", indexStatus: ".", worktreeStatus: "M", kind: "file" }] },
  commitMessage: "", subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
  showDiff(path: string | undefined, staged: boolean) { this.diffSelection = { path, staged }; calls.push({ type: "git.diff", path, staged }); for (const listener of listeners) listener(); return Promise.resolve(); },
  loadGit() { calls.push({ type: "git.status" }); return Promise.resolve(); },
  mutate(action: unknown) { calls.push(action); return Promise.resolve(); },
  setCommitMessage(value: string) { this.commitMessage = value; for (const listener of listeners) listener(); },
} as unknown as WorkspaceState;

createRoot(document.getElementById("root")!).render(<ReviewPanel data={data} disabled={false} onEdit={path => calls.push({ type: "file.open", path })}/>);
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const wait = async (read: () => unknown, label: string) => { const start = performance.now(); while (performance.now() - start < 8_000) { if (read()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error(`Timed out: ${label}`); };
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);

Object.assign(window, {
  reviewUIProgress: () => ({ checks, calls, runtimeErrors, alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent) }),
  runReviewUIAcceptance: async () => {
    await wait(() => document.querySelector(".review-panel") && document.querySelector<HTMLElement>("diffs-container") && document.querySelector<HTMLElement>("diffs-container")!.getBoundingClientRect().height > 0, "Pierre review panel content");
    assert(document.body.textContent?.includes("+1") && document.body.textContent?.includes("−1"), "real hunk totals");
    assert(button("Switch to split diff"), "unified split toggle"); checks.push("real ReviewPanel mounts a Pierre FileDiff with unified totals");
    button("Switch to split diff")!.click(); await wait(() => button("Switch to unified diff"), "split control state");
    assert(document.querySelector("diffs-container")?.shadowRoot, "Pierre shadow renderer"); checks.push("split/unified interaction updates the actual Pierre renderer");
    const source = document.querySelector<HTMLSelectElement>("[aria-label='Review source']")!; source.value = "staged"; source.dispatchEvent(new Event("change", { bubbles: true })); await settle();
    assert(calls.some(call => JSON.stringify(call) === JSON.stringify({ type: "git.diff", path: undefined, staged: true })), "staged source action");
    document.querySelector<HTMLSelectElement>("[aria-label='Review source']")!.value = "unstaged"; document.querySelector<HTMLSelectElement>("[aria-label='Review source']")!.dispatchEvent(new Event("change", { bubbles: true })); await settle();
    button("Stage all")!.click(); assert(calls.some(call => typeof call === "object" && call !== null && (call as { type?: string }).type === "git.stage"), "stage mutation"); checks.push("source and compact stage actions call controlled Git operations");
    data.status!.entries.push({ path: "staged.ts", indexStatus: "M", worktreeStatus: ".", kind: "file" }); for (const listener of listeners) listener(); await settle();
    button("Commit")!.click(); await wait(() => document.querySelector<HTMLDialogElement>(".review-commit-dialog")?.open, "commit dialog");
    const message = document.querySelector<HTMLTextAreaElement>("[aria-label='Commit message']")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(message, "Controlled review commit"); message.dispatchEvent(new InputEvent("input", { bubbles: true })); await settle();
    document.querySelector<HTMLDialogElement>(".review-commit-dialog")!.querySelector<HTMLButtonElement>('button[type="submit"]')!.click(); await wait(() => calls.some(call => typeof call === "object" && call !== null && (call as { type?: string }).type === "git.commit"), "commit mutation"); checks.push("compact commit dialog uses the staged revision in a controlled Git mutation");
    return { passed: true, checks, calls };
  },
  reviewUIGeometry: async () => {
    await document.fonts.ready; await settle();
    const panel = document.querySelector<HTMLElement>(".review-panel")!.getBoundingClientRect(), toolbar = document.querySelector<HTMLElement>(".review-toolbar")!.getBoundingClientRect(), diff = document.querySelector<HTMLElement>("diffs-container")!.getBoundingClientRect();
    return { panel: { width: panel.width, height: panel.height }, toolbar: { width: toolbar.width, height: toolbar.height }, diff: { width: diff.width, height: diff.height }, fitting: toolbar.width <= panel.width && diff.width <= panel.width && toolbar.height > 0 && diff.height > 0 };
  },
});
