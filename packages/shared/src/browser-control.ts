import { validBrowserFrameTarget } from './browser-frame';
import type { BrowserFrameTarget } from './browser';

export interface BrowserDocumentContext { documentId: string; width: number; height: number; scrollX: number; scrollY: number }
export type BrowserModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';
export type BrowserHumanAction =
  | { type: 'navigate'; url: string } | { type: 'reload' | 'back' | 'forward' }
  | { type: 'click'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clickCount?: 1 | 2 | 3 }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string; modifiers?: BrowserModifier[] };
export interface BrowserControlRequest {
  requestId: string; controlEpoch: string; capturedAt: number; target: BrowserFrameTarget;
  context: BrowserDocumentContext; action: BrowserHumanAction;
}
export interface BrowserControlReceipt {
  protocolVersion: 1; hostId: string; sessionId: string; requestId: string;
  workerPid: number; name: string; targetId: string; outcome: 'completed' | 'rejected' | 'unknown';
  message?: string; context?: BrowserDocumentContext; url?: string; title?: string;
}
export const BROWSER_CONTROL_MAX_AGE_MS = 60_000;
const finite = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const identity = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(v);
export function parseBrowserDocumentContext(v: unknown): BrowserDocumentContext {
  if (!v || typeof v !== 'object') throw new Error('Missing browser document context.');
  const c = v as BrowserDocumentContext;
  if (typeof c.documentId !== 'string' || !c.documentId || c.documentId.length > 200 || c.documentId.includes('\0')
    || !finite(c.width, 1, 16384) || !finite(c.height, 1, 16384) || c.width * c.height > 32_000_000
    || !finite(c.scrollX, -1e9, 1e9) || !finite(c.scrollY, -1e9, 1e9)) throw new Error('Invalid browser document context.');
  return { documentId: c.documentId, width: c.width, height: c.height, scrollX: c.scrollX, scrollY: c.scrollY };
}
export function parseBrowserHumanAction(v: unknown, context: BrowserDocumentContext): BrowserHumanAction {
  if (!v || typeof v !== 'object') throw new Error('Missing browser action.');
  const a = v as BrowserHumanAction;
  switch (a.type) {
    case 'navigate': {
      if (typeof a.url !== 'string' || a.url.length > 8192 || /[\u0000-\u0020]/.test(a.url)) throw new Error('Invalid page address.');
      const url = new URL(a.url);
      if (!['http:', 'https:'].includes(url.protocol) && a.url !== 'about:blank') throw new Error('This address requires an unsupported browser operation.');
      return { type: a.type, url: a.url };
    }
    case 'back': case 'forward': case 'reload': return { type: a.type };
    case 'click': case 'wheel': {
      if (!finite(a.x, 0, context.width) || !finite(a.y, 0, context.height) || a.x === context.width || a.y === context.height) throw new Error('Pointer is outside the captured browser viewport.');
      if (a.type === 'wheel') {
        if (!finite(a.deltaX, -10000, 10000) || !finite(a.deltaY, -10000, 10000)) throw new Error('Invalid browser scroll.');
        return { type: a.type, x: a.x, y: a.y, deltaX: a.deltaX, deltaY: a.deltaY };
      }
      if (a.button !== undefined && !['left', 'middle', 'right'].includes(a.button)
        || a.clickCount !== undefined && ![1, 2, 3].includes(a.clickCount)) throw new Error('Invalid browser click.');
      return { type: a.type, x: a.x, y: a.y, ...(a.button ? { button: a.button } : {}), ...(a.clickCount ? { clickCount: a.clickCount } : {}) };
    }
    case 'text':
      if (typeof a.text !== 'string' || !a.text || a.text.length > 16384 || a.text.includes('\0')) throw new Error('Invalid browser text input.');
      return { type: a.type, text: a.text };
    case 'key': {
      const known = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
      if (typeof a.key !== 'string' || !(known.includes(a.key) || /^[ -~]$/.test(a.key))
        || a.modifiers !== undefined && (!Array.isArray(a.modifiers) || a.modifiers.length > 4 || new Set(a.modifiers).size !== a.modifiers.length || a.modifiers.some(m => !['Alt', 'Control', 'Meta', 'Shift'].includes(m)))) throw new Error('Unsupported browser key.');
      return { type: a.type, key: a.key, ...(a.modifiers ? { modifiers: [...a.modifiers] } : {}) };
    }
    default: throw new Error('Unsupported browser action.');
  }
}
export function parseBrowserControlRequest(v: unknown): BrowserControlRequest {
  if (!v || typeof v !== 'object') throw new Error('Missing browser action request.');
  const r = v as BrowserControlRequest;
  if (!identity(r.requestId) || !identity(r.controlEpoch) || !Number.isSafeInteger(r.capturedAt) || r.capturedAt <= 0 || !validBrowserFrameTarget(r.target)) throw new Error('Invalid browser action identity.');
  const context = parseBrowserDocumentContext(r.context);
  return { requestId: r.requestId, controlEpoch: r.controlEpoch, capturedAt: r.capturedAt,
    target: { workerPid: r.target.workerPid, name: r.target.name, targetId: r.target.targetId }, context, action: parseBrowserHumanAction(r.action, context) };
}
