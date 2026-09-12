import { createRoot } from 'react-dom/client';
import { App } from '../../../apps/desktop/src/renderer/App';
import type { DesktopBridge, DesktopEvent } from '@agent-desktop/shared';
import '../../../apps/desktop/src/renderer/styles.css';
import '../../../apps/desktop/src/renderer/theme.css';

declare global { interface Window { composerFlowFixture: { call(method: string, args?: unknown[]): Promise<any>; subscribe(listener: (event: DesktopEvent) => void): () => void } } }
const documentId = crypto.randomUUID();
const api = window.composerFlowFixture;
let saved = await api.call('bootstrap');
window.agentDesktopWindow = { initial: saved, save: async value => { const result = await api.call('save', [value]); if (!result.error) saved = { state: structuredClone(value) }; return result; } };
// Optional APIs stay absent. This fixture never turns a missing capability into
// an async throwing function, and all listed host reads reach the real host.
const bridge: Partial<DesktopBridge> = {
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
  getComposerActions: (target, refresh, host) => api.call('getComposerActions', [target, refresh, host]),
  getComposerCompletions: (query, host) => api.call('getComposerCompletions', [query, host]),
};
window.agentDesktop = bridge as DesktopBridge;
createRoot(document.getElementById('root')!).render(<App/>);
const visible = (node: Element) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !node.closest('[inert]'); };
Object.assign(window, {
  composerFlowTarget(selector: string, text?: string) { const node = [...document.querySelectorAll<HTMLElement>(selector)].find(node => visible(node) && (text === undefined || node.textContent?.trim() === text || node.getAttribute('aria-label') === text)); if (!node) throw new Error(`Missing visible target ${selector} ${text ?? ''}`); node.scrollIntoView({ block: 'nearest' }); const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; },
  composerFlowGeometry() {
    const prompt = document.querySelector<HTMLElement>('#prompt')!, popup = document.querySelector<HTMLElement>('.composer-autocomplete')!;
    const text = document.createTreeWalker(prompt, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 1);
    const caret = range.getBoundingClientRect(), box = popup.getBoundingClientRect();
    return { caret: {left: caret.left, top: caret.top, bottom: caret.bottom}, popup: {left: box.left, top: box.top, bottom: box.bottom, width: box.width}, viewport: {width: innerWidth, height: innerHeight}, rowHeight: popup.querySelector('[role="option"]')?.getBoundingClientRect().height };
  },
  composerFlowState() { const prompt = document.querySelector<HTMLElement>('#prompt'); return { documentId, saved, selection: {anchor: getSelection()?.anchorOffset, focus: getSelection()?.focusOffset, text: getSelection()?.toString(), content: getSelection()?.rangeCount ? getSelection()!.getRangeAt(0).cloneContents().textContent : undefined}, prompt: { text: prompt?.textContent, disabled: prompt?.getAttribute('aria-disabled'), expanded: prompt?.getAttribute('aria-expanded'), focus: document.activeElement === prompt, mentions: [...(prompt?.querySelectorAll('[data-file-id]') ?? [])].map(node => ({label:node.textContent, hostId:node.getAttribute('data-agent-desktop-host'), path:node.getAttribute('at-mention-path'), id:node.getAttribute('data-file-id')})) }, options: [...document.querySelectorAll<HTMLElement>('.composer-autocomplete [role="option"]')].map(node => ({ text: node.textContent, selected: node.getAttribute('aria-selected'), disabled: node.getAttribute('aria-disabled') })), popup: document.querySelector('.composer-autocomplete')?.textContent, body: document.body.innerText, alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent) }; },
});
