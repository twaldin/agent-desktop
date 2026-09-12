import { createRoot } from 'react-dom/client';
import { App } from '../../../apps/desktop/src/renderer/App';
import type { DesktopBridge, DesktopEvent, NativeTerminalInvalidation } from '@agent-desktop/shared';
import '../../../apps/desktop/src/renderer/styles.css';
import '../../../apps/desktop/src/renderer/theme.css';

declare global { interface Window { panelFixture: { call(method: string, args?: unknown[]): Promise<any>; subscribe(listener: (event: DesktopEvent) => void): () => void; subscribeNative(listener: (event: NativeTerminalInvalidation & { hostId: string }) => void): () => void } } }
const documentId = crypto.randomUUID();
const api = window.panelFixture;
let saved = await api.call('bootstrap');
const features = await api.call('features');
window.agentDesktopWindow = { initial: saved, save: async value => { const result = await api.call('save', [value]); if (!result.error) saved = { state: structuredClone(value) }; return result; } };
// Optional APIs stay absent. This fixture never turns a missing capability into
// an async throwing function, and all listed host reads reach the real host.
const bridge: Partial<DesktopBridge> = {
  ...(features.terminal ? {
    getNativeTerminalCapabilities: (host?: string) => api.call('getNativeTerminalCapabilities', [host]),
    nativeTerminalQuery: (query: unknown, host?: string) => api.call('nativeTerminalQuery', [query, host]),
    nativeTerminalAction: (action: unknown, host?: string) => api.call('nativeTerminalAction', [action, host]),
    writeNativeTerminal: (input: unknown, host?: string) => api.call('writeNativeTerminal', [input, host]),
    getTerminalCreationCapabilities: (host: string) => api.call('getTerminalCreationCapabilities', [host]),
    createNativeTerminal: (request: unknown, host: string) => api.call('createNativeTerminal', [request, host]),
    observeTerminalCreation: (request: unknown, host: string) => api.call('observeTerminalCreation', [request, host]),
    subscribeNativeTerminals: (listener: (event: NativeTerminalInvalidation & { hostId: string }) => void) => api.subscribeNative(listener),
  } : {}),
  subscribe: listener => api.subscribe(listener),
  getState: host => api.call('getState', [host]), getHosts: () => api.call('getHosts'),
  getPreferences: () => api.call('getPreferences'), getTheme: () => api.call('getTheme'),
  getLocalFonts: async () => [], getThemeBackground: async () => null, applyWindowTheme: async () => {},
  getComposerCatalog: (target, refresh, host) => api.call('getComposerCatalog', [target, refresh, host]),
  getMessages: (id, host) => api.call('getMessages', [id, host]),
  getInteractions: (id, host) => api.call('getInteractions', [id, host]),
  getSessionControls: (id, host) => api.call('getSessionControls', [id, host]),
  workspaceQuery: (target, query, host) => api.call('workspaceQuery', [target, query, host]),
  command: (envelope, host) => api.call('command', [envelope, host]),
  getBtw: (id, host) => api.call('getBtw', [id, host]),
};
window.agentDesktop = bridge as DesktopBridge;
createRoot(document.getElementById('root')!).render(<App/>);
const visible = (node: Element) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !node.closest('[inert]'); };
Object.assign(window, {
  panelTarget(selector: string, text?: string) { const node = [...document.querySelectorAll<HTMLElement>(selector)].find(node => visible(node) && (text === undefined || node.textContent?.trim() === text || node.getAttribute('aria-label') === text)); if (!node) throw new Error(`Missing visible target ${selector} ${text ?? ''}`); node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); const left = Math.max(0, r.left), right = Math.min(innerWidth, r.right), top = Math.max(0, r.top), bottom = Math.min(innerHeight, r.bottom); if (right <= left || bottom <= top) throw new Error("Target is outside the viewport."); return { x: (left + right) / 2, y: (top + bottom) / 2 }; },
  panelState() { return { documentId, saved, sideChat: { draft: document.querySelector<HTMLTextAreaElement>('[aria-label="Side chat prompt"]')?.value, focused: document.activeElement?.getAttribute("aria-label") === "Side chat prompt" }, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, actions: [...document.querySelectorAll('.dock-empty-panel-label')].filter(visible).map(node => node.textContent), menu: [...document.querySelectorAll('[role="menuitem"]')].filter(visible).map(node => node.textContent), glyphs: [...document.querySelectorAll('.dock-empty-panel-list button, [role="menuitem"]')].filter(visible).map(node => ({ label: node.textContent, svg: node.querySelector('svg')?.innerHTML })), tabs: [...document.querySelectorAll('[role="tab"]')].filter(visible).map(node => ({ label: node.textContent, selected: node.getAttribute('aria-selected') })), focus: { label: document.activeElement?.getAttribute('aria-label'), tag: document.activeElement?.tagName }, body: document.body.innerText, alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent), browserFields: [...document.querySelectorAll('input')].filter(visible).map(node => ({ label: node.getAttribute('aria-label'), placeholder: node.placeholder, value: node.value })) }; },
});
