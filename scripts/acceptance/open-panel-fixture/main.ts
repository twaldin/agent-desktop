import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestHost } from '../../../apps/desktop/src/main/host-transport';
import { requestVersionedCommand } from '../../../apps/desktop/src/main/command-endpoints';
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
const http = (path: string, body?: unknown) => requestHost(connection, path, body);
ipcMain.handle('panel-call', async (_event, method: string, args: any[] = []) => {
  calls.push({ method, args });
  const hostIndex: Record<string, number> = { getState: 0, getComposerCatalog: 2, getMessages: 1, getInteractions: 1, getSessionControls: 1, getBtw: 1, workspaceQuery: 2, command: 1 };
  const requestedHost = args[hostIndex[method] ?? -1];
  if (requestedHost !== undefined && requestedHost !== connection.hostId) throw new Error('The fixture cannot route to a foreign host.');
  switch (method) {
    case 'bootstrap': return store.bootstrap();
    case 'save': return store.saveView(args[0]);
    case 'getState': return http('/v1/state');
    case 'getHosts': return http('/v1/peers');
    case 'getPreferences': return http('/v1/preferences');
    case 'getTheme': return http('/v1/theme');
    case 'getComposerCatalog': return http('/v1/models/composer', { target: args[0], refresh: args[1] });
    case 'getMessages': return http(`/v1/sessions/${encodeURIComponent(args[0])}/messages`);
    case 'getInteractions': return http(`/v1/sessions/${encodeURIComponent(args[0])}/interactions`);
    case 'getSessionControls': return http(`/v1/sessions/${encodeURIComponent(args[0])}/controls`);
    case 'getBtw': return requestBtw(connection, args[0]);
    case 'workspaceQuery': return http('/v1/workspace/query', { target: args[0], query: args[1] });
    case 'command': return requestVersionedCommand(http, args[0]);
    default: throw new Error(`Unsupported fixture bridge method ${method}`);
  }
});
const socket = new WebSocket(connection.origin.replace('http:', 'ws:') + '/v1/events?after=0', ['agent-desktop', connection.token]);
socket.addEventListener('message', event => { if (!window.isDestroyed()) window.webContents.send('panel-event', JSON.parse(String(event.data))); });
const evaluate = (script: string) => window.webContents.executeJavaScript(script, true);
const wait = async (expression: string, label: string) => { const start = Date.now(); while (Date.now() - start < 20_000) { if (await evaluate(expression)) return; await delay(50); } throw new Error(`Timed out: ${label}`); };
const click = async (selector: string, text?: string) => { const p = await evaluate(`panelTarget(${JSON.stringify(selector)},${JSON.stringify(text)})`); window.webContents.sendInputEvent({ type: 'mouseMove', ...p }); window.webContents.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 }); window.webContents.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 }); inputs.push({ type: 'pointer', selector, text, p }); await delay(150); };
const key = async (keyCode: string, modifiers: NonNullable<Electron.KeyboardInputEvent['modifiers']> = []) => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); inputs.push({ type: 'key', keyCode, modifiers }); await delay(150); };
const capture = async (name: string) => { await delay(250); const state = await evaluate('panelState()'); const image = await window.webContents.capturePage(); writeFileSync(join(output, `${name}.png`), image.toPNG()); captures.push({ name, state, contentBounds: window.getContentBounds(), raster: image.getSize() }); };
let passed = false, error: string | undefined;
try {
  await window.loadFile(join(output, 'web/index.html')); window.webContents.focus();
  await wait('panelState().actions.includes("Files") && !panelState().body.includes("Loading conversation")', 'settled empty action list');
  if (context.git) await wait('panelState().actions.includes("Review")', 'Git Review availability');
  const expectedActions = context.git ? ['Review', 'Browser', 'Files', 'Side chat'] : ['Files', 'Side chat', 'Browser'];
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
  await click('[aria-label="Page address"]'); window.webContents.insertText('https://example.invalid/unsent'); await delay(350);
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
  const beforeReload = store.bootstrap().state!.dock!.tabs;
  const oldDocument = await evaluate('panelState().documentId');
  const reloaded = new Promise<void>(resolve => window.webContents.once('did-finish-load', () => resolve()));
  window.reload(); await reloaded;
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
