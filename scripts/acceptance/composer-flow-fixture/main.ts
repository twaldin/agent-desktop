import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestHost } from '../../../apps/desktop/src/main/host-transport';
import { requestVersionedCommand } from '../../../apps/desktop/src/main/command-endpoints';
import { requestComposerActions, requestComposerCompletions } from '../../../apps/desktop/src/main/composer-actions-transport';
import { requestBtw } from '../../../apps/desktop/src/main/btw-transport';
import { WindowStateStore } from '../../../apps/desktop/src/main/window-state';
import { createDockState } from '../../../apps/desktop/src/renderer/dock-state';
import { defaultWindowView } from '../../../apps/desktop/src/window-state';

const [output, fixture] = process.argv.slice(2) as [string, string];
const connection = JSON.parse(readFileSync(join(fixture, 'connection.json'), 'utf8'));
const context = JSON.parse(readFileSync(join(fixture, 'context.json'), 'utf8'));
app.setPath('userData', join(fixture, 'electron'));
const store = new WindowStateStore(join(fixture, 'window'), 'composer-flow');
if (!store.bootstrap().state) { const result = store.saveView({ ...defaultWindowView(), route: { hostId: connection.hostId, sessionId: context.sessionId }, workspaceOpen: false, dock: { tabs: [], state: { ...createDockState(), right: { tabIds: [], open: false } } } }); if (result.error) throw new Error(result.error); }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
await app.whenReady(); Menu.setApplicationMenu(null);
const window = new BrowserWindow({ show: false, width: 1250, height: 950, webPreferences: { preload: join(output, 'preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
window.setContentSize(1250, 950);
let releaseCompletions: (() => void) | undefined;
const calls: unknown[] = [], errors: unknown[] = [], inputs: unknown[] = [], captures: unknown[] = [];
window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
const http = (path: string, body?: unknown) => requestHost(connection, path, body);
ipcMain.handle('composer-flow-call', async (_event, method: string, args: any[] = []) => {
  calls.push({ method, args });
  const hostIndex: Record<string, number> = { getState: 0, getComposerCatalog: 2, getMessages: 1, getInteractions: 1, getSessionControls: 1, getBtw: 1, workspaceQuery: 2, command: 1, getComposerActions: 2, getComposerCompletions: 1 };
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
    case 'getComposerActions': { const value = await requestComposerActions(connection, args[0], args[1]); calls.push({ method: 'composer-actions-result', value }); return value; }
    case 'getComposerCompletions': if (args[0].query === 'held') await new Promise<void>(resolve => { releaseCompletions = resolve; }); return requestComposerCompletions(connection, args[0]);
    case 'getBtw': return requestBtw(connection, args[0]);
    case 'workspaceQuery': return http('/v1/workspace/query', { target: args[0], query: args[1] });
    case 'command': return requestVersionedCommand(http, args[0]);
    default: throw new Error(`Unsupported fixture bridge method ${method}`);
  }
});
const connectEvents = () => {
  const next = new WebSocket(connection.origin.replace('http:', 'ws:') + '/v1/events?after=0', ['agent-desktop', connection.token]);
  const emit = (event: unknown) => { if (!window.isDestroyed()) window.webContents.send('composer-flow-event', event); };
  next.addEventListener('message', event => emit(JSON.parse(String(event.data))));
  next.addEventListener('open', () => emit({hostId: connection.hostId, sequence: 0, type: 'connection', connected: true}));
  next.addEventListener('close', () => emit({hostId: connection.hostId, sequence: 0, type: 'connection', connected: false}));
  return next;
};
let socket = connectEvents();
const evaluate = (script: string) => window.webContents.executeJavaScript(script, true);
const wait = async (expression: string, label: string) => { const start = Date.now(); while (Date.now() - start < 20_000) { if (await evaluate(expression)) return; await delay(50); } throw new Error(`Timed out: ${label}`); };
const click = async (selector: string, text?: string) => { const p = await evaluate(`composerFlowTarget(${JSON.stringify(selector)},${JSON.stringify(text)})`); window.webContents.sendInputEvent({ type: 'mouseMove', ...p }); window.webContents.sendInputEvent({ type: 'mouseDown', ...p, button: 'left', clickCount: 1 }); window.webContents.sendInputEvent({ type: 'mouseUp', ...p, button: 'left', clickCount: 1 }); inputs.push({ type: 'pointer', selector, text, p }); await delay(150); };
const key = async (keyCode: string, modifiers: NonNullable<Electron.KeyboardInputEvent['modifiers']> = []) => { window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); inputs.push({ type: 'key', keyCode, modifiers }); await delay(150); };
const capture = async (name: string) => { await delay(250); const state = await evaluate('composerFlowState()'); const image = await window.webContents.capturePage(); writeFileSync(join(output, `${name}.png`), image.toPNG()); captures.push({ name, state, contentBounds: window.getContentBounds(), raster: image.getSize() }); };
let passed = false, error: string | undefined;
const checkpoints: string[] = [];
const type = async (text: string) => { await click('#prompt'); const previous = await evaluate('composerFlowState().prompt.text'); if (previous) { window.webContents.selectAll(); await wait('composerFlowState().selection.content === ' + JSON.stringify(previous), 'original text selected before replacement'); } await window.webContents.insertText(text); await wait('composerFlowState().prompt.text === ' + JSON.stringify(text), 'native text inserted'); await delay(200); };
try {
  await window.loadFile(join(output, 'web/index.html')); window.webContents.focus();
  await wait('composerFlowState().prompt.disabled === "false" && !composerFlowState().body.includes("Loading conversation")', 'actual App native session ready');
  await type('/flow'); await wait('composerFlowState().options.some(o=>o.text.includes("flow-check"))', 'loaded native extension'); await capture('01-native-command');
  const geometry = await evaluate('composerFlowGeometry()');
  const expectedWidth = Math.min(360, Math.max(geometry.viewport.width - 24, 0));
  if (Math.abs(geometry.popup.width - expectedWidth) > 1 || Math.abs(geometry.popup.left - Math.max(12, Math.min(geometry.caret.left, geometry.viewport.width - expectedWidth - 12))) > 1 || Math.abs(geometry.popup.bottom - (geometry.caret.top - 8)) > 2 || geometry.rowHeight !== 30) throw new Error('Completion popup does not follow the pinned caret width, inset, gap, and row geometry: ' + JSON.stringify(geometry));
  calls.push({method: 'native-caret-geometry', value: geometry});
  checkpoints.push('Actual composer popup uses the pinned caret anchor and Electron row geometry');
  await key('n', ['control']); await wait('composerFlowState().options.find(o=>o.selected==="true")?.text.includes("flow-info")', 'Control N selects next native command');
  await key('p', ['control']); await wait('composerFlowState().options.find(o=>o.selected==="true")?.text.includes("flow-check")', 'Control P selects previous native command');
  await key('UP'); await wait('composerFlowState().options.find(o=>o.selected==="true")?.text.includes("flow-info")', 'Arrow Up wraps to last available item');
  await key('DOWN'); await wait('composerFlowState().options.find(o=>o.selected==="true")?.text.includes("flow-check")', 'Arrow Down wraps to first available item');
  if (!(await evaluate('composerFlowState().prompt.focus'))) throw new Error('Menu navigation moved focus away from the composer.');
  checkpoints.push('Native keyboard navigation wraps while preserving composer focus');
  await key('TAB'); await wait('composerFlowState().prompt.text === "/flow-check "', 'Tab completes without dispatch');
  if (calls.some((c: any) => c.method === 'command' && c.args[0]?.command?.type === 'session.prompt')) throw new Error('Completion dispatched a prompt.');
  await type('/flow-check ex');
  await wait('composerFlowState().options.some(o=>o.text.includes("Selected native argument"))', 'actual native argument callback');
  await key('TAB'); await wait('composerFlowState().prompt.text === "/flow-check selected ex"', 'native argument inserted');
  checkpoints.push('Actual native extension discovery and argument callback, Tab completion without prompt dispatch');
  await type('$flow'); await wait('composerFlowState().options.some(o=>o.text.includes("flow-review"))', 'native skill discovery'); await capture('02-native-skill');
  await key('TAB'); await wait('composerFlowState().prompt.text === "/skill:flow-review "', 'native skill syntax inserted');
  checkpoints.push('Actual pinned skill discovery inserts native invocation without dispatch');
  await type('$flow'); await wait('composerFlowState().options.some(o=>o.text.includes("flow-review"))', 'skill restored for deliberate pointer selection');
  await click('.composer-autocomplete [role="option"]');
  await wait('composerFlowState().prompt.text === "/skill:flow-review " && !composerFlowState().popup', 'pointer completes the same native skill without dispatch');
  if (!await evaluate('composerFlowState().prompt.focus')) throw new Error('Pointer selection lost composer focus.');
  checkpoints.push('Pointer selection completes native skills and returns input focus');
  await type('Read @file'); await wait('composerFlowState().options.some(o=>o.text.includes("file with spaces"))', 'native owner file completion'); await capture('03-native-file');
  await key('ENTER'); await wait('!composerFlowState().prompt.text.includes("@file") && !composerFlowState().popup', 'file reference inserted');
  const files = await evaluate('composerFlowState().prompt.mentions');
  if (files.length !== 1 || !files[0].id) throw new Error('File completion did not create one inline file.');
  let savedFile: any; const fileDeadline = Date.now() + 10_000;
  while (!savedFile && Date.now() < fileDeadline) { const state: any = await http('/v1/state'); savedFile = state.drafts.find((draft: any) => draft.id === 'session:' + context.sessionId)?.wholeFileAttachments?.find((file: any) => file.id === files[0].id); if (!savedFile) await delay(50); }
  if (savedFile?.source.hostId !== connection.hostId || savedFile?.source.path !== join(fixture, 'project', 'file with spaces.txt') || savedFile?.textOffset !== 5) throw new Error('Saved file completion lost its original owner/path/position.');
  calls.push({ method: 'persisted-file-observation', value: savedFile });
  checkpoints.push('Native filename lookup inserts original owner file reference');
  await type('/flow-check throw'); await wait('composerFlowState().popup?.includes("Controlled argument lookup failure")', 'native argument error visible'); await capture('04-argument-error');
  checkpoints.push('Native callback failure remains visible without fabricated suggestions');
  await type('/flow-check held');
  const heldDeadline = Date.now() + 10_000; while (!releaseCompletions && Date.now() < heldDeadline) await delay(50);
  if (!releaseCompletions) throw new Error('The completion request never reached its controlled transport gate.');
  const beforeHeldCommands = calls.filter((call: any) => call.method === 'command' && call.args[0]?.command?.type === 'session.prompt').length;
  await key('ENTER');
  if (calls.filter((call: any) => call.method === 'command' && call.args[0]?.command?.type === 'session.prompt').length !== beforeHeldCommands) throw new Error('Loading completion dispatched a native prompt.');
  releaseCompletions(); releaseCompletions = undefined;
  await wait('composerFlowState().options.some(o=>o.text.includes("Selected native argument"))', 'held completion settles');
  checkpoints.push('Held native completion owns Enter without dispatching incomplete input');
  await type('/unmatched-flow-xyz'); await wait('composerFlowState().popup === "No results"', 'empty results visible'); await key('ESCAPE');
  await wait('!composerFlowState().popup && composerFlowState().prompt.focus', 'Escape closes only the empty popup');
  checkpoints.push('Empty result state and Escape preserve input and focus');
  await type('/flow'); socket.close(); await wait('composerFlowState().popup?.includes("offline")', 'actual event transport loss');
  if (!(await evaluate('composerFlowState().options.every(o=>o.disabled==="true")'))) throw new Error('Offline native suggestions remained selectable.');
  await key('ENTER'); if (await evaluate('composerFlowState().prompt.text') !== '/flow') throw new Error('Offline completion changed the draft.');
  socket = connectEvents(); await wait('composerFlowState().options.some(o=>o.disabled==="false")', 'explicit original host reconnect');
  checkpoints.push('Actual socket close disables cached native completions; reconnect restores the same owner');
  await type('/flow-check exact-once'); await key('ESCAPE'); await key('ENTER');
  await wait('!composerFlowState().prompt.text', 'real native command admitted and draft consumed');
  const receipt = readFileSync(join(fixture, 'project', 'command-receipts.txt'), 'utf8');
  if (receipt !== 'exact-once\n') throw new Error('Wrong native handler effect: ' + receipt);
  checkpoints.push('Explicit send dispatches the original native command once to the owning worker'); await capture('05-native-dispatched');
  passed = true;
} catch (cause) { error = String(cause); await capture('failure').catch(() => {}); }
finally {
  writeFileSync(join(output, 'result.json'), JSON.stringify({ passed, error, checkpoints, calls, errors, inputs, captures, scope: 'Actual production App, authenticated host/native OMP discovery and custom command dispatch through an explicit acceptance IPC adapter. No external provider, reference runtime or physical remote proof.' }, null, 2));
  releaseCompletions?.(); socket.close(); window.destroy(); app.exit(passed ? 0 : 1);
}
}
void run().catch(error => { console.error(error); app.exit(1); });
