import { createRoot } from "react-dom/client";
import { App } from "../../../apps/desktop/src/renderer/App";
import { defaultWindowView } from "../../../apps/desktop/src/window-state";
import { createDockState } from "../../../apps/desktop/src/renderer/dock-state";
import type { DesktopBridge, DesktopEvent } from "@agent-desktop/shared";
import "../../../apps/desktop/src/renderer/styles.css";
import "../../../apps/desktop/src/renderer/theme.css";

declare global {
  interface Window {
    defaultModelSettingsConnection: { origin: string; token: string; hostId: string };
    defaultModelSettingsContext: { projectId: string; sessionId: string };
  }
}
const documentId = crypto.randomUUID(),
  connection = window.defaultModelSettingsConnection,
  request = async (path: string, body?: unknown) => { const response = await fetch(connection.origin + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${connection.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!response.ok) throw new Error(await response.text()); return response.json(); },
  api = { call: async (method: string, args: any[] = []) => { switch (method) { case "getState": return request("/v1/state"); case "getHosts": return request("/v1/peers"); case "getPreferences": return request("/v1/preferences"); case "getTheme": return request("/v1/theme"); case "getComposerCatalog": return request("/v1/models/composer", { target: args[0], refresh: args[1] }); case "getMessages": return request(`/v1/sessions/${encodeURIComponent(args[0])}/messages`); case "getInteractions": return request(`/v1/sessions/${encodeURIComponent(args[0])}/interactions`); case "getSessionControls": return request(`/v1/sessions/${encodeURIComponent(args[0])}/controls`); case "workspaceQuery": return request("/v1/workspace/query", { target: args[0], query: args[1] }); case "getBtw": return request(`/v1/sessions/${encodeURIComponent(args[0])}/btw`); case "getComposerActions": return request("/v1/composer/actions", { target: args[0], refresh: args[1] }); case "getComposerCompletions": return request("/v1/composer/completions", args[0]); case "getSettingsCatalog": return request("/v1/settings/catalog"); case "getSettings": return request("/v1/settings/read", { target: args[0] }); case "setSetting": return request("/v1/settings/mutate", { mutation: args[0], target: args[1] }); case "getModelCapabilities": return request("/v1/models/capabilities", { target: args[0], refresh: args[1] }); case "getModelDefinitions": return request("/v1/models/definitions"); case "getSshHosts": return { revision: "fixture", hosts: [], warnings: [] }; case "getProviders": return request("/v1/accounts/providers"); case "getAccounts": case "getLogins": return []; case "getSessionAccounts": return request(`/v1/sessions/${encodeURIComponent(args[0])}/accounts`); default: return undefined; } }, subscribe: (listener: (event: DesktopEvent) => void) => { const socket = new WebSocket(connection.origin.replace("http:", "ws:") + "/v1/events?after=0", ["agent-desktop", connection.token]); socket.onmessage = event => listener({ ...JSON.parse(String(event.data)), hostId: connection.hostId } as DesktopEvent); socket.onopen = () => listener({ hostId: connection.hostId, sequence: 0, type: "connection", connected: true } as DesktopEvent); return () => socket.close(); } };
let saved = { state: { ...defaultWindowView(), settingsOpen: true, settingsPage: "omp", route: { hostId: window.defaultModelSettingsConnection.hostId, sessionId: window.defaultModelSettingsContext.sessionId }, workspaceOpen: false, dock: { tabs: [], state: { ...createDockState(), right: { tabIds: [], open: false } } } } } as any;
window.agentDesktopWindow = {
  initial: saved,
  save: (value) => {
    const serializable = JSON.parse(JSON.stringify(value));
    saved = { state: serializable };
    return {};
  },
};
const bridge: Partial<DesktopBridge> = {
  getProviders: host => api.call("getProviders", [host]),
  getAccounts: (provider, host) => api.call("getAccounts", [provider, host]),
  getLogins: host => api.call("getLogins", [host]),
  getSessionAccounts: (id, host) => api.call("getSessionAccounts", [id, host]),
  accountAction: (action, host) => api.call("accountAction", [action, host]),
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
  getSettingsCatalog: host => api.call("getSettingsCatalog", [host]),
  getSettings: (target, host) => api.call("getSettings", [target, host]),
  setSetting: (mutation, target, host) => api.call("setSetting", [mutation, target, host]),
  getModelCapabilities: (target, refresh, host) => api.call("getModelCapabilities", [target, refresh, host]),
  getModelDefinitions: (host) => api.call("getModelDefinitions", [host]),
  getSshHosts: host => api.call("getSshHosts", [host]),
  openExternal: async (url) => api.call("openExternal", [url]),
};
window.agentDesktop = bridge as DesktopBridge;
createRoot(document.getElementById("root")!).render(<App />);
const visible = (node: Element) => {
  const r = node.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && !node.closest("[inert]");
};
Object.assign(window, {
  defaultModelSettingsAppTarget(selector: string, text?: string) {
    const node = [...document.querySelectorAll<HTMLElement>(selector)].find(
      (node) =>
        visible(node) &&
        (text === undefined ||
          node.textContent?.trim() === text ||
          node.querySelector(".model-picker-name")?.textContent?.trim() === text ||
          node.getAttribute("aria-label") === text),
    );
    if (!node)
      return { found: false as const, error: `Missing visible target ${selector} ${text ?? ""}` };
    node.scrollIntoView({ block: "nearest" });
    const r = node.getBoundingClientRect();
    return { found: true as const, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  },
  defaultModelSettingsAppState() {
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
