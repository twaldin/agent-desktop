import { createRoot } from "react-dom/client";
import type { DesktopBridge } from "../../packages/shared/src/protocol";
import type { NativeQueuedMessageMutation } from "../../packages/shared/src/queued-messages";
import { QueuedMessages } from "../../apps/desktop/src/renderer/QueuedMessages";
import "../../apps/desktop/src/renderer/styles.css";

declare global { interface Window { __QUEUE_NATIVE__: { origin: string; token: string; hostId: string; sessionId: string }; queueNativeInvalidate(): void; queueNativeState(): unknown } }
const owner = window.__QUEUE_NATIVE__;
const listeners = new Set<(event: { hostId: string; sessionId: string }) => void>();
let reads = 0, mutations = 0, invalidations = 0;
const headers = (json = false) => ({ Authorization: `Bearer ${owner.token}`, "X-Agent-Queue-Host-Id": owner.hostId,
  ...(json ? { "Content-Type": "application/json" } : {}) });
async function request(mutation?: NativeQueuedMessageMutation) {
  const response = await fetch(`${owner.origin}/v1/sessions/${encodeURIComponent(owner.sessionId)}/queued-messages`, {
    method: mutation ? "POST" : "GET", headers: headers(Boolean(mutation)), ...(mutation ? { body: JSON.stringify(mutation) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result?.error?.message ?? `Queue request failed (${response.status})`);
  return result;
}
const bridge = {
  getQueuedMessages: async (sessionId: string, hostId: string) => {
    if (sessionId !== owner.sessionId || hostId !== owner.hostId) throw new Error("Fixture owner mismatch");
    reads++; return request();
  },
  mutateQueuedMessages: async (sessionId: string, mutation: NativeQueuedMessageMutation, hostId: string) => {
    if (sessionId !== owner.sessionId || hostId !== owner.hostId) throw new Error("Fixture owner mismatch");
    mutations++; return request(mutation);
  },
  subscribeQueuedMessages: (listener: (event: { hostId: string; sessionId: string }) => void) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  },
} as DesktopBridge;
createRoot(document.getElementById("root")!).render(<QueuedMessages bridge={bridge} hostId={owner.hostId} sessionId={owner.sessionId} connected archived={false}/>);
window.queueNativeInvalidate = () => { invalidations++; for (const listener of listeners) listener({ hostId: owner.hostId, sessionId: owner.sessionId }); };
window.queueNativeState = () => ({ reads, mutations, invalidations, rows: [...document.querySelectorAll<HTMLElement>(".queued-message")].map(row => ({
  id: row.dataset.queueId, text: row.querySelector(".queued-message-text")?.textContent,
  lane: row.querySelector(".queued-message-marker")?.getAttribute("aria-label"),
  actions: [...row.querySelectorAll<HTMLButtonElement>("button")].map(button => ({ label: button.ariaLabel, disabled: button.disabled })),
})), busy: document.querySelector(".queued-messages")?.getAttribute("aria-busy"), alert: document.querySelector("[role=alert]")?.textContent });
