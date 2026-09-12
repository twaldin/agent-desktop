import { McpAppWindowChannels } from "../../../apps/desktop/src/main/mcp-app-window-channels";
import { runMcpFlow } from "./mcp-flow";
import { requestSessionMcp } from "../../../apps/desktop/src/main/session-mcp-transport";
import { requestSessionMcpApp } from "../../../apps/desktop/src/main/session-mcp-app-transport";
import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeTerminalResult, requestHost } from '../../../apps/desktop/src/main/host-transport';
import { requestVersionedCommand } from '../../../apps/desktop/src/main/command-endpoints';
import { requestTerminalCreate, requestTerminalCreationCapabilities, requestTerminalCreationStatus } from '../../../apps/desktop/src/main/terminal-create-transport';
import { requestBtw } from '../../../apps/desktop/src/main/btw-transport';
import { WindowStateStore } from '../../../apps/desktop/src/main/window-state';
import { createDockState } from '../../../apps/desktop/src/renderer/dock-state';
import { defaultWindowView } from '../../../apps/desktop/src/window-state';

const [output, fixture] = process.argv.slice(2) as [string, string];
const connection = JSON.parse(readFileSync(join(fixture, 'connection.json'), 'utf8'));
const context = JSON.parse(readFileSync(join(fixture, 'context.json'), 'utf8'));
app.setPath('userData', join(fixture, 'electron'));
const store = new WindowStateStore(join(fixture, 'window'), 'open-panel');
if (!store.bootstrap().state) { const result = store.saveView({ ...defaultWindowView(), route: { hostId: connection.hostId, sessionId: context.sessionId }, workspaceOpen: true, dock: { tabs: [], state: { ...createDockState(), right: { tabIds: [], open: true } } } }); if (result.error) throw new Error(result.error); }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
await app.whenReady(); Menu.setApplicationMenu(null);
const window = new BrowserWindow({ show: false, width: 1250, height: 950, webPreferences: { preload: join(output, 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
window.setContentSize(1250, 950);
const calls: unknown[] = [], errors: unknown[] = [], inputs: unknown[] = [], captures: unknown[] = [];
window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
let online = true;
let mcpDocument: McpAppWindowChannels | undefined;
const mcpDrains: Promise<void>[] = [];
const retireMcpDocument = () => { const owner = mcpDocument; mcpDocument = undefined; if (owner) { const drain = owner.retire(); mcpDrains.push(drain); void drain.catch(() => {}); } };
window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) retireMcpDocument(); });
const setConnected = (value: boolean) => { online = value; window.webContents.send('panel-event', { type: 'connection', hostId: connection.hostId, connected: value }); };
const http = (path: string, body?: unknown) => requestHost(connection, path, body);
ipcMain.handle('panel-call', async (_event, method: string, args: any[] = []) => {
  calls.push({ method, args });
  const hostIndex: Record<string, number> = { getSessionMcp: 1, sessionMcpApp: 2, respondInteraction: 3, getNativeTerminalCapabilities: 0, getTerminalCreationCapabilities: 0, nativeTerminalQuery: 1, nativeTerminalAction: 1, writeNativeTerminal: 1, createNativeTerminal: 1, observeTerminalCreation: 1, getState: 0, getComposerCatalog: 2, getMessages: 1, getInteractions: 1, getSessionControls: 1, getBtw: 1, workspaceQuery: 2, command: 1 };
  const requestedHost = args[hostIndex[method] ?? -1];
  if (requestedHost !== undefined && requestedHost !== connection.hostId) throw new Error('The fixture cannot route to a foreign host.');
  switch (method) {
    case 'features': return { terminal: context.terminal, mcp: context.mcp };
    case 'getSessionMcp': if (!online) throw new Error('Disposable host transport is offline.'); return requestSessionMcp(connection, args[0]);
    case 'sessionMcpApp': {
      if (!online) throw new Error('Disposable host transport is offline.');
      if (!mcpDocument) {
        const owner = new McpAppWindowChannels({ current: () => mcpDocument === owner,
          connect: async () => connection, request: requestSessionMcpApp });
        mcpDocument = owner;
      }
      return mcpDocument.dispatch(args[0], args[2], args[1]);
    }
    case 'openExternal': throw new Error('The fixture requires external-link cancellation; no external browser is launched.');
    case 'getNativeTerminalCapabilities': return nativeTerminalResult(() => http('/v2/terminals/capabilities'));
    case 'nativeTerminalQuery': return nativeTerminalResult(() => http('/v2/terminals/query', args[0]));
    case 'nativeTerminalAction': return nativeTerminalResult(() => http('/v2/terminals/action', args[0]));
    case 'writeNativeTerminal': return nativeTerminalResult(() => http('/v2/terminals/input', args[0]));
    case 'getTerminalCreationCapabilities': return nativeTerminalResult(() => requestTerminalCreationCapabilities(connection));
    case 'createNativeTerminal': return nativeTerminalResult(() => requestTerminalCreate(connection, args[0]));
    case 'observeTerminalCreation': return nativeTerminalResult(() => requestTerminalCreationStatus(connection, args[0]));
    case 'bootstrap': return store.bootstrap();
    case 'save': return store.saveView(args[0]);
    case 'getState': if (!online) throw new Error('Disposable host transport is offline.'); return http('/v1/state');
    case 'getHosts': return http('/v1/peers');
    case 'getPreferences': return http('/v1/preferences');
    case 'getTheme': return http('/v1/theme');
    case 'getComposerCatalog': return http('/v1/models/composer', { target: args[0], refresh: args[1] });
    case 'getMessages': return http(`/v1/sessions/${encodeURIComponent(args[0])}/messages`);
    case 'respondInteraction': return http(`/v1/sessions/${encodeURIComponent(args[0])}/interactions`, { interactionId: args[1], response: args[2] });
    case 'getInteractions': return http(`/v1/sessions/${encodeURIComponent(args[0])}/interactions`);
    case 'getSessionControls': return http(`/v1/sessions/${encodeURIComponent(args[0])}/controls`);
    case 'getBtw': return requestBtw(connection, args[0]);
    case 'workspaceQuery': return http('/v1/workspace/query', { target: args[0], query: args[1] });
    case 'command': return requestVersionedCommand(http, args[0]);
    default: throw new Error(`Unsupported fixture bridge method ${method}`);
  }
});
const socket = new WebSocket(connection.origin.replace('http:', 'ws:') + '/v1/events?after=0', ['agent-desktop', connection.token]);
socket.addEventListener('message', event => { if (window.isDestroyed() || !online) return; const frame = JSON.parse(String(event.data)); if (frame.type === 'native-terminal') window.webContents.send('panel-native', { ...frame.event, hostId: connection.hostId }); else window.webContents.send('panel-event', frame); });
const evaluate = (script: string) => window.webContents.executeJavaScript(script, true);
const wait = async (expression: string, label: string) => { const start = Date.now(); while (Date.now() - start < 20_000) { if (await evaluate(expression)) return; await delay(50); } throw new Error(`Timed out: ${label}`); };
const click = async (selector: string, text?: string) => {
  const target = () => evaluate(`panelTarget(${JSON.stringify(selector)},${JSON.stringify(text)})`);
  let p = await target();
  if (context.mcp) {
    let stable = 0;
    for (let i = 0; i < 40 && stable < 3; i++) {
      await delay(100); const next = await target();
      stable = Math.abs(next.x - p.x) < 0.5 && Math.abs(next.y - p.y) < 0.5 ? stable + 1 : 0; p = next;
    }
    if (stable < 3) throw new Error('Pointer target did not settle: ' + selector);
  }
  if (context.mcp) {
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
  } else {
    window.webContents.sendInputEvent({ type: 'mouseMove', ...p }); window.webContents.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 }); window.webContents.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 });
  }
  inputs.push({ type: context.mcp ? 'chromium-pointer' : 'pointer', selector, text, p }); await delay(150);
};
const key = async (keyCode: string, modifiers: NonNullable<Electron.KeyboardInputEvent['modifiers']> = []) => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); inputs.push({ type: 'key', keyCode, modifiers }); await delay(150); };
const capture = async (name: string) => { await delay(250); const state = await evaluate('panelState()'); const image = await window.webContents.capturePage(); writeFileSync(join(output, `${name}.png`), image.toPNG()); captures.push({ name, state, contentBounds: window.getContentBounds(), raster: image.getSize() }); };
let passed = false, error: string | undefined;
try {
  await window.loadFile(join(output, 'web/index.html')); window.webContents.focus();
  await wait('typeof window.panelState === "function"', 'fixture observation helper');
  await wait('panelState().actions.includes("Files") && !panelState().body.includes("Loading conversation")', 'settled empty action list');
  if (context.mcp) {
    await runMcpFlow({ window, evaluate, wait, click, key, capture, store, calls, connection, http, setConnected });
    retireMcpDocument(); await Promise.all(mcpDrains);
    if (errors.length) throw new Error('Renderer errors: ' + JSON.stringify(errors));
    passed = true; return;
  }
  if (context.git) await wait('panelState().actions.includes("Review")', 'Git Review availability');
  const expectedActions = context.git ? ['Review', ...(context.terminal ? ['Terminal'] : []), 'Browser', 'Files', 'Side chat'] : ['Files', 'Side chat', 'Browser', ...(context.terminal ? ['Terminal'] : [])];
  const originalActions = await evaluate('panelState().actions');
  if (JSON.stringify(originalActions) !== JSON.stringify(expectedActions)) throw new Error('Wrong real capability/order: ' + JSON.stringify(originalActions));
  await capture('01-empty');
  const originalGlyphs = await evaluate('panelState().glyphs');
  await click('.dock-empty-panel-label', 'Files');
  await wait('panelState().tabs.some(tab=>tab.label.includes("Open file"))', 'Files tab'); await capture('02-files');
  await click('[aria-label="Open side panel tab"]');
  await wait('panelState().menu.some(label=>label.includes("Browser"))', 'Open panel menu'); await capture('03-menu');
  const menuGlyphs = await evaluate('panelState().glyphs');
  for (const item of originalGlyphs) { const menu = menuGlyphs.find((value: { label: string }) => value.label.trim() === item.label.trim()); if (!menu || menu.svg !== item.svg) throw new Error('Action glyph changed between launcher and Open panel menu: ' + item.label); }
  await key('b'); await key('ENTER');
  await wait('panelState().tabs.some(tab=>tab.label.includes("New tab"))', 'keyboard Browser selection'); await capture('04-browser');
  await wait('panelState().focus.label === "Page address"', 'Browser Enter delegated address focus'); window.webContents.insertText('https://example.invalid/unsent'); await delay(350);
  await wait('panelState().saved.state.dock.tabs.some(tab=>tab.browserNewTab?.draft === "https://example.invalid/unsent")', 'durable unsent Browser draft');
  const beforeHide = store.bootstrap().state!.dock!;
  await click('[aria-label="Toggle side panel"]');
  await wait('panelState().saved.state.dock.state.right.open === false', 'hidden right pane'); await capture('05-hidden');
  await click('[aria-label="Toggle side panel"]');
  await wait('panelState().browserFields.some(field=>field.value === "https://example.invalid/unsent")', 'retained Browser draft'); await capture('06-reopened');
  if (JSON.stringify(store.bootstrap().state!.dock!.tabs) !== JSON.stringify(beforeHide.tabs)) throw new Error('Hide/reopen changed retained tab identities.');
  await click('[aria-label="Open side panel tab"]'); await key('ESCAPE');
  await wait('panelState().menu.length === 0', 'Escape menu dismissal');
  if (await evaluate('panelState().focus.label') !== 'Open side panel tab') throw new Error('Escape did not restore the original trigger focus.');
  await click('[aria-label="Open side panel tab"]'); await key('s'); await key('ENTER');
  await wait('panelState().sideChat.focused', 'Side chat ready and focused');
  window.webContents.insertText('Retain this side question'); await delay(400); await capture('07-side-chat');
  await click('[aria-label="Toggle side panel"]'); await click('[aria-label="Toggle side panel"]');
  await wait('panelState().sideChat.draft === "Retain this side question"', 'retained Side chat draft');
  await capture('08-side-chat-reopened');
  if (context.git) {
    await click('[aria-label="Open side panel tab"]'); await key('r'); await key('ENTER');
    await wait('panelState().tabs.some(tab=>tab.label.includes("Review"))', 'Review opened');
    await click('[aria-label="Open side panel tab"]');
    if ((await evaluate('panelState().menu')).some((label: string) => label.includes('Review'))) throw new Error('Existing Review was offered twice.');
    await capture('09-review-singleton'); await key('ESCAPE');
    await click('[data-app-shell-tab-strip-controller="right"] .dock-menu summary');
    await click('[data-app-shell-tab-strip-controller="right"] .dock-menu button', 'Move to bottom dock');
    await wait('panelState().saved.state.dock.state.bottom.tabIds.some(id=>id.endsWith(":review"))', 'Review moved to Bottom');
    await click('[aria-label="Open side panel tab"]');
    if ((await evaluate('panelState().menu')).some((label: string) => label.includes('Review'))) throw new Error('Bottom Review was offered again in right panel.');
    await capture('09b-review-bottom-singleton'); await key('ESCAPE');
    await click('[aria-label="Close Review tab"]');
    await click('[aria-label="Open side panel tab"]');
    await wait('panelState().menu.some(label=>label.includes("Review"))', 'Review restored after close'); await key('ESCAPE');
  }
  if (context.terminal) {
    await click('[aria-label="Open side panel tab"]'); await key('t'); await key('ENTER');
    await wait('[...document.querySelectorAll(".terminal-view-footer button")].some(button => button.textContent === "Use this panel’s size" && !button.disabled)', 'real PTY viewport ready');
    const terminalTabs = store.bootstrap().state!.dock!.tabs.filter(tab => tab.kind === 'terminal');
    if (terminalTabs.length !== 1) throw new Error('Terminal selection did not create exactly one original dock descriptor.');
    await capture('terminal-01-ready');
    await click('.native-terminal-grid');
    const commandText = "printf 'OPEN_%s\\n' PANEL_PTY_COMPLETE; pwd";
    for (const character of commandText) { window.webContents.sendInputEvent({ type: 'char', keyCode: character }); await delay(5); }
    inputs.push({ type: 'native-character-input', text: commandText }); await key('ENTER');
    await delay(500); await click('.terminal-view-footer button', 'History');
    await wait('[...document.querySelectorAll("pre")].some(node => node.getAttribute("aria-label") === "Captured native screen" && node.textContent.split("\\n").some(line => line.trim() === "OPEN_PANEL_PTY_COMPLETE"))', 'actual native PTY output');
    await capture('terminal-02-output');
    await click('[aria-label="Toggle side panel"]'); await click('[aria-label="Toggle side panel"]');
    await wait('document.querySelector(".dock-native-terminal") !== null', 'original Terminal viewer reopened');
    if (JSON.stringify(store.bootstrap().state!.dock!.tabs.filter(tab => tab.kind === 'terminal')) !== JSON.stringify(terminalTabs)) throw new Error('Terminal hide/reopen replaced the original descriptor.');
    await capture('terminal-03-reopened');
    await click('[aria-label="Terminal actions"]'); await click('.dock-terminal-actions button', 'Stop shell for all viewers');
    await wait('document.querySelector(".dock-terminal-actions")?.textContent?.includes("Forget stopped terminal")', 'actual shell stopped');
    await capture('terminal-04-stopped');
    await click('[data-app-shell-tab-close-button]', `Close ${terminalTabs[0]!.title} tab`);
  }
  const beforeReload = store.bootstrap().state!.dock!.tabs;
  const oldDocument = await evaluate('panelState().documentId');
  const reloaded = new Promise<void>(resolve => window.webContents.once('did-finish-load', () => resolve()));
  window.reload(); await reloaded;
  await wait('typeof window.panelState === "function"', 'reloaded observation helper');
  await wait('panelState().tabs.some(tab=>tab.label.includes("Side chat"))', 'actual window-store reload');
  if (await evaluate('panelState().documentId') === oldDocument) throw new Error('The document did not reload.');
  if (JSON.stringify(store.bootstrap().state!.dock!.tabs) !== JSON.stringify(beforeReload)) throw new Error('Reload changed original dock descriptors.');
  await capture('10-window-reloaded');
  await click('.nav-action span', 'New chat');
  await wait('panelState().saved.state.route.sessionId === null', 'projectless New chat');
  const oldIds = store.bootstrap().state!.dock!.tabs.map(tab => tab.id);
  if ((await evaluate('panelState().menu')).length) throw new Error('Old menu remained open after navigation.');
  await capture('11-projectless-retained');
  for (const id of oldIds) {
    const tab = store.bootstrap().state!.dock!.tabs.find(tab => tab.id === id);
    if (tab) await click('[data-app-shell-tab-close-button]', `Close ${tab.title} tab`);
  }
  await click('[aria-label="Toggle side panel"]');
  await wait('panelState().body.includes("No tabs are available for this chat")', 'actual empty unavailable catalogue');
  if ((await evaluate('panelState().actions')).length) throw new Error('Unsupported projectless actions were invented.');
  await capture('12-empty-unavailable');
  if (errors.length) throw new Error('Renderer reported errors: ' + JSON.stringify(errors));
  passed = true;
} catch (cause) { error = String(cause); await capture('failure').catch(() => {}); }
finally { writeFileSync(join(output, 'result.json'), JSON.stringify({ passed, error, errors, inputs, captures, calls, stored: store.bootstrap(), scope: 'Actual App and Electron inputs with an isolated authenticated host and real WindowStateStore; acceptance IPC adapter, no external provider or native browser acquisition.' }, null, 2)); socket.close(); app.exit(passed ? 0 : 1); }

}
void run().catch(error => { console.error(error); app.exit(1); });
