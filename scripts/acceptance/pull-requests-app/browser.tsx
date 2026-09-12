import { createRoot } from "react-dom/client";
import { App } from "../../../apps/desktop/src/renderer/App";
import type { DesktopBridge, DesktopEvent } from "@agent-desktop/shared";
import "../../../apps/desktop/src/renderer/styles.css";
import "../../../apps/desktop/src/renderer/theme.css";

declare global {
  interface Window {
    pullRequestsAppFixture: {
      save(value: unknown): { error?: string };
      call(method: string, args?: unknown[]): Promise<any>;
      subscribe(listener: (event: DesktopEvent) => void): () => void;
    };
  }
}
const documentId = crypto.randomUUID(),
  api = window.pullRequestsAppFixture;
let saved = await api.call("bootstrap");
window.agentDesktopWindow = {
  initial: saved,
  save: (value) => {
    const result = api.save(value);
    if (!result.error) saved = { state: structuredClone(value) };
    return result;
  },
};
const bridge: Partial<DesktopBridge> = {
  pullRequestWrites: {
    submit: (hostId, input) => api.call("pullRequestWrite", [hostId, "submit", input]),
    status: (hostId, input) => api.call("pullRequestWrite", [hostId, "status", input]),
  },
  pullRequests: {
    read: (hostId, input) => api.call("pullRequests", [hostId, input]),
  },
  subscribe: (listener) => api.subscribe(listener),
  getState: (host) => api.call("getState", [host]),
  getHosts: () => api.call("getHosts"),
  getPreferences: () => api.call("getPreferences"),
  getTheme: () => api.call("getTheme"),
  getLocalFonts: async () => [],
  getThemeBackground: async () => null,
  applyWindowTheme: async () => {},
  getComposerCatalog: (target, refresh, host) =>
    api.call("getComposerCatalog", [target, refresh, host]),
  getMessages: (id, host) => api.call("getMessages", [id, host]),
  getInteractions: (id, host) => api.call("getInteractions", [id, host]),
  getSessionControls: (id, host) => api.call("getSessionControls", [id, host]),
  workspaceQuery: (target, query, host) =>
    api.call("workspaceQuery", [target, query, host]),
  command: (envelope, host) => api.call("command", [envelope, host]),
  getBtw: (id, host) => api.call("getBtw", [id, host]),
  getComposerActions: (target, refresh, host) =>
    api.call("getComposerActions", [target, refresh, host]),
  getComposerCompletions: (query, host) =>
    api.call("getComposerCompletions", [query, host]),
  openExternal: async (url) => api.call("openExternal", [url]),
};
window.agentDesktop = bridge as DesktopBridge;
createRoot(document.getElementById("root")!).render(<App />);
const visible = (node: Element) => {
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && !node.closest("[inert]");
};
Object.assign(window, {
  pullRequestsAppTarget(selector: string, text?: string) {
    const node = [...document.querySelectorAll<HTMLElement>(selector)].find(
      (node) =>
        visible(node) &&
        (text === undefined ||
          node.textContent?.trim() === text ||
          node.getAttribute("aria-label") === text),
    );
    if (!node)
      throw new Error(`Missing visible target ${selector} ${text ?? ""}`);
    node.scrollIntoView({ block: "nearest" });
    const r = node.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  },
  pullRequestsAppState() {
    return {
      documentId,
      saved,
      body: document.body.innerText,
      active: document.activeElement?.getAttribute("aria-label"),
      pullRequests: !!document.querySelector(".pull-requests-page"),
      automations: !!document.querySelector(".automations-page"),
      selected: document.querySelector('.pull-request-row[aria-pressed="true"]')
        ?.textContent,
    };
  },
});
