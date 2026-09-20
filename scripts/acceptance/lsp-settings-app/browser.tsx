import { createRoot } from "react-dom/client";
import { StrictMode } from "react";
import { App } from "../../../apps/desktop/src/renderer/App";
import type { DesktopBridge, DesktopEvent } from "@agent-desktop/shared";
import "../../../apps/desktop/src/renderer/styles.css";
import "../../../apps/desktop/src/renderer/theme.css";

declare global {
  interface Window {
    lspSettingsAppFixture: {
      save(value: unknown): { error?: string };
      call(method: string, args?: unknown[]): Promise<any>;
      subscribe(listener: (event: DesktopEvent) => void): () => void;
    };
  }
}
const documentId = crypto.randomUUID(),
  api = window.lspSettingsAppFixture;
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
  subscribe: (listener) => api.subscribe(listener),
  getSettingsCatalog: host => api.call("getSettingsCatalog",[host]),
  getSettings: (target,host) => api.call("getSettings",[target,host]),
  getLspConfiguration: (target,host) => api.call("getLspConfiguration",[target,host]),
  mutateLspConfiguration: (target,mutation,host) => api.call("mutateLspConfiguration",[target,mutation,host]),
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
  getSessionUsage: (id, host, mode, commandId) =>
    api.call("getSessionUsage", [id, host, mode, commandId]),
  getBtw: (id, host) => api.call("getBtw", [id, host]),
  getComposerActions: (target, refresh, host) =>
    api.call("getComposerActions", [target, refresh, host]),
  getComposerCompletions: (query, host) =>
    api.call("getComposerCompletions", [query, host]),
  openExternal: async (url) => api.call("openExternal", [url]),
};
window.agentDesktop = bridge as DesktopBridge;
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
