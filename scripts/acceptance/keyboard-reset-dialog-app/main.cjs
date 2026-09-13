const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { createSurfaceGuard } = require('./surface-guard.cjs');
const [output, fixture, repository] = process.argv.slice(2);
if (process.env.HOME !== fixture || process.env.AGENT_DESKTOP_PROFILE_DIR !== join(fixture, 'profile')) throw new Error('An isolated reset-dialog profile is required.');
const { connection, seed } = JSON.parse(readFileSync(join(fixture, 'ready.json'), 'utf8'));
const conditions = JSON.parse(readFileSync(join(output, 'surface-conditions.json'), 'utf8'));
const originalFetch = globalThis.fetch, mutations = [], inputs = [], captures = [], failures = [], errors = [];
let ownedWindow;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== '127.0.0.1') throw new Error('Outbound network forbidden in reset-dialog acceptance.');
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  if (body?.command?.type === 'preferences.keymap.mutate') mutations.push(body);
  return originalFetch(input, init);
};
const http = async path => {
  const response = await originalFetch(connection.origin + path, { headers: { Authorization: `Bearer ${connection.token}` } });
  const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.on('browser-window-created', (_event, window) => {
  if (ownedWindow) return; ownedWindow = window;
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).hostname !== '127.0.0.1' }));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  window.webContents.once('did-finish-load', () => void exercise(window));
});
async function exercise(window) {
  const surface = createSurfaceGuard({ window, output, fixture, conditions, http });
  const evaluate = expression => window.webContents.executeJavaScript(expression, true);
  const wait = async (expression, label) => { const deadline = Date.now() + 20_000; while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(50); } throw new Error('Timed out: ' + label); };
  const opener = `.keyboard-shortcuts-header button`;
  const stateExpression = `(() => {const dialog=document.querySelector('.shortcut-reset-dialog'),box=dialog?.getBoundingClientRect(),style=dialog&&getComputedStyle(dialog),active=document.activeElement;return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},open:dialog?.open,modal:dialog?.matches(':modal'),box:box&&{x:box.x,y:box.y,width:box.width,height:box.height,right:box.right,bottom:box.bottom},margins:style&&{top:style.marginTop,right:style.marginRight,bottom:style.marginBottom,left:style.marginLeft},insets:style&&{top:style.top,right:style.right,bottom:style.bottom,left:style.left,position:style.position},focus:{tag:active?.tagName,role:active?.getAttribute('role'),label:active?.getAttribute('aria-label'),text:active?.textContent},openerFocused:active===document.querySelector('.keyboard-shortcuts-header button')};})()`;
  const click = async (selector, text) => {
    await surface.check('before-target-scroll:' + selector);
    const position = await evaluate(`(() => {const node=[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.getClientRects().length&&(!${JSON.stringify(text)}||node.textContent.trim()===${JSON.stringify(text)}));if(!node)throw Error('Missing actual reset control');node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    await surface.check('pointer-batch:' + selector);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, ...position, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
    inputs.push({ type: 'pointer', selector, text, position }); await delay(100);
  };
  const key = async keyCode => {
    await surface.check('key-batch:' + keyCode);
    for (const type of ['keyDown', 'keyUp']) window.webContents.sendInputEvent({ type, keyCode });
    inputs.push({ type: 'key', keyCode }); await delay(100);
  };
  const capture = async label => {
    const before = await evaluate(stateExpression);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const proof = await surface.capture(label, join(output, label + '.png'));
    const state = await evaluate(stateExpression), record = { label, proof, before, state };
    if (before.open !== state.open || before.modal !== state.modal || JSON.stringify(before.box) !== JSON.stringify(state.box)) throw new Error('Reset presentation changed during capture.');
    if (state.open) {
      if (!state.modal || !state.box || state.box.width <= 0 || state.box.height <= 0) throw new Error('The real modal dialog is not visible.');
      record.centerDeltaPixels = { x: ((state.box.x + state.box.width / 2) - state.viewport.width / 2) * state.viewport.dpr,
        y: ((state.box.y + state.box.height / 2) - state.viewport.height / 2) * state.viewport.dpr };
      // One physical pixel permits only layout rounding; unchanged across RED/GREEN.
      record.centered = Math.abs(record.centerDeltaPixels.x) <= 1 && Math.abs(record.centerDeltaPixels.y) <= 1;
      if (!record.centered) failures.push({ label, contract: 'Reset confirmation is centered in the actual viewport.', centerDeltaPixels: record.centerDeltaPixels });
    }
    captures.push(record);
  };
  let passed = false, error;
  try {
    await surface.prepare();
    await wait(`!![...document.querySelectorAll(${JSON.stringify(opener)})].find(node=>node.textContent==='Reset all to defaults'&&!node.disabled)`, 'real seeded keymap and reset opener');
    const initial = (await http('/v2/preferences')).records.find(record => record.key === 'general.commandKeymap');
    if (JSON.stringify(initial) !== JSON.stringify(seed.record)) throw new Error('The actual keymap no longer matches the disposable command11 seed.');
    await capture('01-settings-before-reset');
    await click(opener, 'Reset all to defaults');
    await wait(`document.querySelector('.shortcut-reset-dialog')?.open===true`, 'actual showModal confirmation');
    await capture('02-reset-open-cancel');
    await click('.shortcut-reset-dialog button[type="button"]', 'Cancel');
    await wait(`!document.querySelector('.shortcut-reset-dialog')?.open && (${stateExpression}).openerFocused`, 'Cancel closes and restores the real opener');
    const afterCancel = (await http('/v2/preferences')).records.find(record => record.key === 'general.commandKeymap');
    if (JSON.stringify(afterCancel) !== JSON.stringify(initial)) throw new Error('Cancel changed the real keymap or its revision.');
    await capture('03-cancel-retained-state');
    await click(opener, 'Reset all to defaults');
    await wait(`document.querySelector('.shortcut-reset-dialog')?.open===true`, 'second actual confirmation');
    await capture('04-reset-open-escape');
    await key('ESCAPE');
    await wait(`!document.querySelector('.shortcut-reset-dialog')?.open && (${stateExpression}).openerFocused`, 'Escape closes and restores the real opener');
    const afterEscape = (await http('/v2/preferences')).records.find(record => record.key === 'general.commandKeymap');
    if (JSON.stringify(afterEscape) !== JSON.stringify(initial) || mutations.length !== 0) throw new Error('Opening/cancelling the dialog mutated the real keymap.');
    await capture('05-escape-retained-state');
    writeFileSync(join(output, 'keymap-observations.json'), JSON.stringify({ seed: seed.record, initial, afterCancel, afterEscape }, null, 2));
    passed = failures.length === 0;
  } catch (cause) { error = String(cause); await capture('failure').catch(() => {}); }
  finally {
    writeFileSync(join(output, 'result.json'), JSON.stringify({ passed, error, failures, conditions, mutations, inputs, captures, errors,
      source: { main: createHash('sha256').update(readFileSync(join(repository, 'apps/desktop/dist/main.cjs'))).digest('hex'), preload: createHash('sha256').update(readFileSync(join(repository, 'apps/desktop/dist/preload.cjs'))).digest('hex') },
      scope: 'Actual production App with its full stylesheet cascade, real command11 seed and unchanged modal behavior. Centering plus Cancel/Escape state/focus are observed. Native surface/isolation checks qualify each original PNG separately; reference pixel conditions remain unmatched. No CSS injection, personal keymap, provider or reset confirmation is used.' }, null, 2));
    for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.exit(passed ? 0 : 1);
  }
}
require(join(repository, 'apps/desktop/dist/main.cjs'));
