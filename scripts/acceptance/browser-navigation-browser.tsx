import { createRoot } from "react-dom/client";
import { BrowserPanel } from "../../apps/desktop/src/renderer/BrowserPanel";
import type { DesktopBridge } from "@agent-desktop/shared";
import "../../apps/desktop/src/renderer/styles.css";

declare global {
  interface Window {
    browserNavigationBridge: DesktopBridge & { pointer(x: number, y: number): Promise<void> };
    runBrowserNavigationAcceptance(): Promise<unknown>;
  }
}

const root = createRoot(document.getElementById("root")!);
const params = new URLSearchParams(location.search);
const target = { workerPid: Number(params.get("workerPid")), name: params.get("name")!, targetId: params.get("targetId")! };
const hostId = params.get("hostId")!, sessionId = params.get("sessionId")!, origin = params.get("origin")!;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function waitFor(test: () => unknown, label: string) {
  for (let attempt = 0; attempt < 240; attempt++) { if (test()) return; await sleep(25); }
  throw new Error(`Timed out waiting for ${label}`);
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function setAddress(value: string) {
  const input = document.querySelector<HTMLInputElement>('[aria-label="Page address"]')!;
  input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}
async function waitForCurrentHistory(url: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const value = await window.browserNavigationBridge.getBrowserHistory!(sessionId, { requestId: crypto.randomUUID(), target, query: "" }, hostId);
      if (value.entries.some(entry => entry.current && entry.url === url)) return value;
    } catch { /* A native navigation may still own the exact tab. */ }
    await sleep(50);
  }
  throw new Error(`Timed out waiting for native history ${url}`);
}

window.runBrowserNavigationAcceptance = async () => {
  root.render(<BrowserPanel bridge={window.browserNavigationBridge} hostId={hostId} sessionId={sessionId} nativeTarget={target} active />);
  await waitFor(() => document.querySelector<HTMLImageElement>(".browser-viewport img")?.naturalWidth, "initial native frame");
  const input = document.querySelector<HTMLInputElement>('[aria-label="Page address"]')!;
  const initialHistory = await window.browserNavigationBridge.getBrowserHistory!(sessionId, { requestId: crypto.randomUUID(), target, query: "" }, hostId);
  assert(initialHistory.entries.some(entry => entry.current && entry.url === `${origin}/one`), "Direct production history transport did not return the current native entry");
  input.blur(); await sleep(50); const bounds = input.getBoundingClientRect();
  await window.browserNavigationBridge.pointer(Math.round(bounds.left + bounds.width / 2), Math.round(bounds.top + bounds.height / 2));
  input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  try { await waitFor(() => document.querySelector('[role="listbox"][aria-label="Address suggestions"]'), "owner history suggestions"); }
  catch (error) { throw new Error(`${error instanceof Error ? error.message : error}; value=${input.value}; expanded=${input.getAttribute("aria-expanded")}; focused=${document.activeElement === input}`); }
  const initialRows = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].map(row => row.textContent ?? "");
  assert(initialRows.some(row => row.includes("one")), "Native current history entry was not offered");

  setAddress(`${origin}/two`);
  await waitForCurrentHistory(`${origin}/two`);
  await waitFor(() => input.value.endsWith("/two") && !document.querySelector('[aria-label="Stop loading"]'), "navigation to second page");
  const back = document.querySelector<HTMLButtonElement>('[aria-label="Back"]')!;
  assert(!back.disabled, "Back did not enable from native history"); back.click();
  await waitForCurrentHistory(`${origin}/one`);
  await waitFor(() => input.value.endsWith("/one"), "native Back");
  const forward = document.querySelector<HTMLButtonElement>('[aria-label="Forward"]')!;
  assert(!forward.disabled, "Forward did not enable from native history"); forward.click();
  await waitForCurrentHistory(`${origin}/two`);
  await waitFor(() => input.value.endsWith("/two"), "native Forward");

  setAddress(`${origin}/slow`);
  await waitFor(() => document.querySelector<HTMLButtonElement>('[aria-label="Stop loading"]'), "Stop loading control");
  document.querySelector<HTMLButtonElement>('[aria-label="Stop loading"]')!.click();
  await waitFor(() => document.querySelector('[aria-label="Reload page"]') && input.value.endsWith("/two"), "stopped committed page");
  const result = await window.browserNavigationBridge.getBrowserHistory!(sessionId, { requestId: crypto.randomUUID(), target, query: "" }, hostId);
  assert(result.target.targetId === target.targetId && result.entries.some(entry => entry.url === `${origin}/two` && entry.current), "Post-stop history changed owner or current entry");
  root.render(null);
  return { passed: true, initialRows, target, historyRevision: result.revision, historyEntries: result.entries.length,
    scope: "Production BrowserPanel in hidden Electron with controlled DOM focus through authenticated production transports and a real isolated OMP CDP tab; no physical-focus, native search-engine autocomplete, or cmux proof." };
};
