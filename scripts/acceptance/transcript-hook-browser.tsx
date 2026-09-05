import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { DesktopBridge, TranscriptMessage } from "../../packages/shared/src/protocol";
import { useTranscript } from "../../apps/desktop/src/renderer/desktop-state";
import { offlineCache } from "../../apps/desktop/src/renderer/offline-cache";

/** Real React/IndexedDB with a controlled transport fixture. No provider/host claim. */
export async function transcriptHookAcceptance() {
  const checks: string[] = [];
  const requireValue = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
  const requests: { host?: string; session: string; resolve: (messages: TranscriptMessage[]) => void }[] = [];
  const bridge = { getMessages: (session: string, host?: string) => new Promise<TranscriptMessage[]>(resolve => requests.push({ host, session, resolve })), subscribe: () => () => {} } as unknown as DesktopBridge;
  const rendered: { host: string; ids: string[] }[] = [];
  function Probe({ host, connected }: { host: string; connected: boolean }) {
    const value = useTranscript(bridge, "same-session", host, connected, "host-a");
    rendered.push({ host, ids: value.messages.map(message => message.id) });
    return createElement("div", {}, value.messages.map(message => createElement("p", { key: message.id, "data-hook-message": message.id }, message.text)));
  }
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const render = (host: string, connected: boolean) => flushSync(() => root.render(createElement(Probe, { host, connected })));
  const message = (id: string): TranscriptMessage => ({ id, role: "assistant", text: `Native transcript fixture ${id}`, lifecycle: "complete" });
  try {
    render("host-a", true); await settle(); requireValue(requests.length === 1, "Initial host fetch admitted once"); requests[0]!.resolve([message("a-live")]); await settle();
    const initial = container.querySelector('[data-hook-message="a-live"]')!; requireValue(initial, "Initial live row appears");
    const selection = getSelection()!, range = document.createRange(); range.setStart(initial.firstChild!, 0); range.setEnd(initial.firstChild!, 6); selection.removeAllRanges(); selection.addRange(range);
    const before = rendered.length; render("host-a", false); await settle();
    requireValue(container.querySelector('[data-hook-message="a-live"]') === initial, "Disconnect keeps the same DOM row"); requireValue(selection.toString() === "Native", "Disconnect preserves text selection");
    requireValue(rendered.slice(before).every(value => value.ids.includes("a-live")), "Disconnect never renders empty current history"); checks.push("disconnect retains rows and selection");
    render("host-a", true); await settle(); requireValue(requests.length === 2, "Reconnect fetch starts");
    requireValue(container.querySelector('[data-hook-message="a-live"]') === initial, "Pending reconnect keeps the same DOM row"); checks.push("pending reconnect retains rows");
    await offlineCache.write("agent-desktop:transcript:v1:host-b:same-session", JSON.stringify([message("b-cached")]));
    const start = rendered.length; render("host-b", true); await settle();
    requireValue(rendered.slice(start).filter(value => value.host === "host-b").every(value => !value.ids.includes("a-live")), "Navigation never paints another host's history");
    requireValue(container.querySelector('[data-hook-message="b-cached"]'), "New host loads its real IndexedDB cache"); checks.push("same session ID on another host stays isolated");
    requests[1]!.resolve([message("a-late")]); await settle(); requireValue(!container.textContent!.includes("a-late"), "Late previous-host reply is discarded"); checks.push("late previous-host reply");
    requests[2]!.resolve([message("b-live")]); await settle(); requireValue(container.querySelector('[data-hook-message="b-live"]'), "Current host live result replaces cache");
    render("host-b", false); await settle(); requireValue(container.querySelector('[data-hook-message="b-live"]'), "Later disconnect cannot replace live state with stale cache"); checks.push("current live history survives later disconnect");
    await offlineCache.write("agent-desktop:transcript:v1:host-b:same-session", JSON.stringify([message("b-stale-cache")]));
    const write = offlineCache.write;
    try {
      offlineCache.write = async () => { throw new Error("Injected cache write failure"); };
      render("host-b", true); await settle(); requests[3]!.resolve([]); await settle();
      requireValue(!container.querySelector("[data-hook-message]"), "Authoritative empty live history is rendered");
      render("host-b", false); await settle(); requireValue(!container.querySelector("[data-hook-message]"), "Empty live history cannot resurrect stale cache after write failure"); checks.push("authoritative empty history survives cache-write failure and disconnect");
    } finally { offlineCache.write = write; }
    return { checks, source: "Production useTranscript rendered in actual Electron React/IndexedDB; controlled host transport fixture" };
  } finally { root.unmount(); container.remove(); }
}
