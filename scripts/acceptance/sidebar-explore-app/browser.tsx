import { createRoot } from "react-dom/client";
import { App } from "../../../apps/desktop/src/renderer/App";
import type { DesktopBridge, DesktopEvent } from "@agent-desktop/shared";
import "../../../apps/desktop/src/renderer/styles.css";
import "../../../apps/desktop/src/renderer/theme.css";

declare global { interface Window { sidebarExploreAppFixture: { save(value: unknown): { error?: string }; call(method: string, args?: unknown[]): Promise<any>; subscribe(listener: (event: DesktopEvent) => void): () => void } } }
const api = window.sidebarExploreAppFixture, documentId = crypto.randomUUID();
const saved = await api.call("bootstrap");
window.agentDesktopWindow = { initial: saved, save: value => api.save(value) };
const bridge: Partial<DesktopBridge> = {
  pullRequests: { read: (host, input) => api.call("pullRequests", [host, input]) },
  automations: { list: (host, query) => api.call("automations", [host, query]), mutate: (host, mutation) => api.call("mutateAutomation", [host, mutation]) },
  subscribe: listener => api.subscribe(listener), getState: host => api.call("getState", [host]), getHosts: () => api.call("getHosts"),
  getPreferences: () => api.call("getPreferences"), getPreferencesV2: () => api.call("getPreferencesV2"), getTheme: () => api.call("getTheme"),
  getLocalFonts: async () => [], getThemeBackground: async () => null, applyWindowTheme: async () => {},
  getComposerCatalog: (target, refresh, host) => api.call("getComposerCatalog", [target, refresh, host]),
  getMessages: (id, host) => api.call("getMessages", [id, host]), getInteractions: (id, host) => api.call("getInteractions", [id, host]),
  getSessionControls: (id, host) => api.call("getSessionControls", [id, host]), workspaceQuery: (target, query, host) => api.call("workspaceQuery", [target, query, host]),
  command: (envelope, host) => api.call("command", [envelope, host]), getBtw: (id, host) => api.call("getBtw", [id, host]),
  getComposerActions: (target, refresh, host) => api.call("getComposerActions", [target, refresh, host]), getComposerCompletions: (query, host) => api.call("getComposerCompletions", [query, host]),
  getPlugins: (target, host) => api.call("getPlugins", [target, host]), getMarketplaceCatalog: (target, host) => api.call("getMarketplaceCatalog", [target, host]),
  openExternal: async () => { throw new Error("External navigation is forbidden in this acceptance instance."); },
};
window.agentDesktop = bridge as DesktopBridge;
createRoot(document.getElementById("root")!).render(<App/>);
Object.assign(window, {
  sidebarExploreTarget(selector: string) {
    const element = [...document.querySelectorAll<HTMLElement>(selector)].find(node => node.getBoundingClientRect().width > 0 && !node.closest("[inert]"));
    if (!element) throw new Error(`Missing visible target: ${selector}`);
    element.scrollIntoView({ block: "nearest" }); const r = element.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  },
  sidebarExploreState() {
    return { documentId, active: document.activeElement?.getAttribute("aria-label"), body: document.body.innerText,
      navigation: [...document.querySelectorAll('.sidebar-navigation .nav-action')].map(node => node.textContent?.trim()),
      rows: [...document.querySelectorAll('[data-sidebar-destination]')].map(node => node.getAttribute('data-sidebar-destination')),
      geometry: [...document.querySelectorAll('.sidebar, .sidebar-navigation .nav-action, .organized-session.selected')].map(node => ({ className: node.className, text: node.textContent?.trim().slice(0,80), rect: node.getBoundingClientRect().toJSON() })),
      customization: !!document.querySelector('.sidebar-customization'),
    };
  },
});
