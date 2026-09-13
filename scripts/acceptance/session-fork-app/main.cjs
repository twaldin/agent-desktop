const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { createSurfaceGuard } = require('./surface-guard.cjs');
const [output, fixture, repository] = process.argv.slice(2);
if (process.env.HOME !== fixture || process.env.AGENT_DESKTOP_PROFILE_DIR !== join(fixture, 'profile')) throw new Error('An isolated Fork App profile is required.');
const { connection, context } = JSON.parse(readFileSync(join(fixture, 'ready.json'), 'utf8'));
const conditions = JSON.parse(readFileSync(join(output, 'surface-conditions.json'), 'utf8'));
const originalFetch = globalThis.fetch;
const calls = [], inputs = [], captures = [], errors = [], checkpoints = [];
let mainWindow, surface, reloadAfterFork = false, dropped;
// The production IPC/transport/host runs unchanged. This single fault drops a
// real completed acknowledgement and reloads the actual renderer document.
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== '127.0.0.1') throw new Error('Outbound network forbidden in Fork App acceptance.');
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  const fork = body?.command?.type === 'session.fork' || body?.command?.type === 'session.fork.resume';
  if (fork) calls.push({ path: url.pathname, envelope: body });
  const response = await originalFetch(input, init);
  if (fork && reloadAfterFork) {
    reloadAfterFork = false;
    const result = await response.clone().json();
    if (!response.ok || !result.ok) throw new Error('The controlled lost acknowledgement did not follow a successful real fork: ' + JSON.stringify(result));
    dropped = { envelope: body, result };
    await surface.check('before-renderer-reload');
    mainWindow.webContents.reload();
    throw new Error('Controlled acknowledgement loss after real Fork completion.');
  }
  return response;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const http = async path => {
  const response = await originalFetch(connection.origin + path, { headers: { Authorization: `Bearer ${connection.token}` } });
  const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value;
};
const sourceFile = file => { const value = resolve(file); if (!value.startsWith(fixture + '/')) throw new Error('Evidence path escaped the disposable fixture.'); return value; };
app.on('browser-window-created', (_event, window) => {
  if (mainWindow) return;
  mainWindow = window;
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => callback({ cancel: new URL(details.url).hostname !== '127.0.0.1' }));
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  window.webContents.once('did-finish-load', () => void exercise(window));
});
async function exercise(window) {
  const evaluate = expression => window.webContents.executeJavaScript(expression, true);
  surface = createSurfaceGuard({ window, output, fixture, conditions, http });
  const stateExpression = `(() => { const p=document.querySelector('#prompt');return {sessionId:document.querySelector('.session-row[aria-current="page"]')?.getAttribute('data-session-id'),text:p?.textContent,files:p?.querySelectorAll('[data-file-id]').length??0,focus:document.activeElement===p,body:document.body.innerText,menu:[...document.querySelectorAll('.session-fork-menu [role="menuitem"],.session-fork-menu [role="option"]')].map(n=>({label:n.querySelector('.completion-label')?.textContent,disabled:n.disabled||n.getAttribute('aria-disabled')==='true',selected:n.getAttribute('aria-selected')})),innerWidth,innerHeight,dpr:devicePixelRatio};})()`;
  const wait = async (expression, label) => { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { try { if (await evaluate(expression)) return; } catch (cause) { if (!window.webContents.isLoading()) throw cause; } await delay(50); } throw new Error('Timed out: ' + label); };
  const click = async (selector, label) => {
    await surface.check('before-target-scroll:' + selector);
    const position = await evaluate(`(() => {const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&(!${JSON.stringify(label)}||n.textContent.trim()===${JSON.stringify(label)}||n.getAttribute('aria-label')===${JSON.stringify(label)}));if(!n)throw Error('Missing Fork target');n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    await surface.check('pointer-batch:' + selector);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
      window.webContents.sendInputEvent({ type, ...position, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
    }
    inputs.push({ type: 'pointer', selector, label, position }); await delay(100);
  };
  const key = async (keyCode, modifiers = []) => {
    await surface.check('key-batch:' + keyCode);
    for (const type of ['keyDown', 'keyUp']) window.webContents.sendInputEvent({ type, keyCode, modifiers });
    inputs.push({ type: 'key', keyCode, modifiers }); await delay(100);
  };
  const insertText = async text => { await surface.check('insert-text'); await window.webContents.insertText(text); inputs.push({ type: 'text', text }); };
  const capture = async label => {
    const proof = await surface.capture(label, join(output, label + '.png'));
    captures.push({ label, state: await evaluate(stateExpression), proof });
  };
  const chooseHeaderFork = async () => { await click('[aria-label="Conversation actions"]'); await wait(`!![...document.querySelectorAll('.action-menu button')].find(n=>n.textContent==='Fork chat'&&!n.disabled)`, 'eligible thread Fork'); await click('.action-menu button', 'Fork chat'); await wait(`document.querySelector('.session-fork-menu')!==null`, 'Fork destination menu'); };
  const navigate = async id => { await click(`.session-row[data-session-id="${id}"]`); await wait(`(${stateExpression}).sessionId===${JSON.stringify(id)} && document.querySelector('#prompt')!==null`, 'actual source navigation'); };
  let passed = false, failure;
  try {
    await surface.prepare();
    await wait(`(${stateExpression}).sessionId===${JSON.stringify(context.sourceId)} && (${stateExpression}).files===1 && !(${stateExpression}).body.includes('Loading conversation')`, 'real production App source and attachment');
    const before = await http('/v1/state'), parent = before.sessions.find(s => s.id === context.sourceId), parentDraft = before.drafts.find(d => d.id === 'session:' + context.sourceId);
    const originalBytes = readFileSync(sourceFile(parent.sessionFile));
    const originalMessages = await http(`/v1/sessions/${context.sourceId}/messages`);
    await capture('01-original-draft');
    await click('#prompt'); await key('K', ['meta']);
    await wait(`document.querySelector('.command-menu input')!==null`, 'actual application command menu');
    await insertText('Fork chat');
    await wait(`!![...document.querySelectorAll('.command-menu [cmdk-item]')].find(n=>n.textContent.includes('Fork chat'))`, 'forkThread command owner');
    await key('ENTER'); await wait(`(${stateExpression}).menu.length===2`, 'command-owned Fork destinations');
    const localMenu = await evaluate(stateExpression);
    if (localMenu.menu[0].label !== 'Fork chat' || localMenu.menu[1].label !== 'Fork chat in new worktree') throw new Error('Wrong pinned local/new-worktree ordering.');
    await capture('02-current-workspace-destinations'); await key('ENTER');
    await wait(`!!(${stateExpression}).sessionId && (${stateExpression}).sessionId!==${JSON.stringify(context.sourceId)} && (${stateExpression}).text==='' && (${stateExpression}).files===0`, 'real bound local child with empty composer');
    const localId = (await evaluate(stateExpression)).sessionId;
    let current = await http('/v1/state'); const local = current.sessions.find(s => s.id === localId);
    if (local.cwd !== parent.cwd || local.sessionFile === parent.sessionFile) throw new Error('The local fork did not retain cwd with a distinct native file.');
    if (JSON.stringify(current.drafts.find(d => d.id === parentDraft.id)) !== JSON.stringify(parentDraft)) throw new Error('Fork changed the source draft or selections.');
    if (!readFileSync(sourceFile(parent.sessionFile)).equals(originalBytes)) throw new Error('Fork changed the retained native source.');
    const localMessages = await http(`/v1/sessions/${localId}/messages`);
    const history = value => value.map(({ nativeId, role, text, blocks }) => ({ nativeId, role, text, blocks }));
    if (JSON.stringify(history(localMessages)) !== JSON.stringify(history(originalMessages))) throw new Error('The local child lost retained native history.');
    if (readFileSync(sourceFile(local.sessionFile.replace(/\.jsonl$/, '') + '/fork-proof.txt'), 'utf8') !== 'Native artifact retained across Fork\n') throw new Error('The native artifact was not copied.');
    checkpoints.push('forkThread through the actual command owner; real local child; full source draft/attachment/history/artifact preservation');
    await capture('03-local-child-empty'); await click('#prompt'); await insertText('Later child draft stays here');
    const savedDeadline = Date.now() + 10_000;
    do { current = await http('/v1/state'); if (current.drafts.find(d => d.id === 'session:' + localId)?.text === 'Later child draft stays here') break; await delay(50); } while (Date.now() < savedDeadline);
    if (current.drafts.find(d => d.id === 'session:' + localId)?.text !== 'Later child draft stays here') throw new Error('The real child draft was not saved.');
    await navigate(context.sourceId); await chooseHeaderFork(); await key('DOWN'); await capture('04-new-worktree-selected'); await key('ENTER');
    await wait(`!!(${stateExpression}).sessionId && !${JSON.stringify([context.sourceId, localId])}.includes((${stateExpression}).sessionId) && (${stateExpression}).text===''`, 'real new-worktree child');
    const worktreeId = (await evaluate(stateExpression)).sessionId;
    current = await http('/v1/state'); const worktree = current.sessions.find(s => s.id === worktreeId);
    if (worktree.cwd === parent.cwd || readFileSync(sourceFile(join(worktree.cwd, 'tracked.txt')), 'utf8') !== context.tracked || readFileSync(sourceFile(join(worktree.cwd, 'untracked.txt')), 'utf8') !== context.untracked) throw new Error('The real worktree did not capture the source working tree.');
    if (JSON.stringify(current.drafts.find(d => d.id === parentDraft.id)) !== JSON.stringify(parentDraft) || current.drafts.find(d => d.id === 'session:' + localId)?.text !== 'Later child draft stays here') throw new Error('A later fork overwrote an existing draft.');
    checkpoints.push('Actual new-worktree destination retains dirty tracked/untracked source and existing child draft'); await capture('05-worktree-child-empty');
    await click('#prompt'); await insertText('/fork');
    await wait(`!![...document.querySelectorAll('.composer-autocomplete .completion-label')].find(n=>n.textContent==='Fork chat')`, 'host-owned builtin /fork');
    await key('ENTER'); await wait(`(${stateExpression}).menu[0]?.label==='Fork chat in same worktree'`, 'same-worktree slash submenu');
    await key('UP'); await wait(`(${stateExpression}).menu[1]?.selected==='true'`, 'slash submenu wrap');
    await key('DOWN'); await wait(`(${stateExpression}).menu[0]?.selected==='true' && (${stateExpression}).focus`, 'slash submenu focus retained');
    await capture('06-same-worktree-slash'); await key('ESCAPE');
    await wait(`!document.querySelector('.session-fork-menu') && (${stateExpression}).text==='/fork'`, 'Escape retains source query');
    checkpoints.push('Pinned same-worktree labels, wrapping, composer focus and query-only dismissal without native identity command');
    await chooseHeaderFork();
    const beforeDrop = calls.length; reloadAfterFork = true; await key('ENTER');
    await wait(`!![...document.querySelectorAll('.session-fork-status button')].find(n=>n.textContent==='Open forked chat')`, 'renderer restart recovers the actual durable binding');
    if (!dropped || calls.length !== beforeDrop + 1) throw new Error('Lost acknowledgement replayed the Fork effect.');
    await capture('07-read-only-recovery'); await click('.session-fork-status button', 'Open forked chat');
    await wait(`(${stateExpression}).sessionId===${JSON.stringify(dropped.result.value.session.id)} && (${stateExpression}).text===''`, 'recovered real child navigation');
    current = await http('/v1/state');
    if (current.sessions.find(s => s.id === dropped.result.value.session.id)?.cwd !== worktree.cwd || current.drafts.find(d => d.id === 'session:' + worktreeId)?.text !== '/fork') throw new Error('Same-worktree fork changed cwd or consumed the source query.');
    if (calls.some(call => call.path !== '/v16/commands' || !['session.fork', 'session.fork.resume'].includes(call.envelope.command.type))) throw new Error('Fork bypassed command16.');
    checkpoints.push('Real acknowledgement loss plus actual renderer reload; read-only receipt recovery, no replay, same-worktree child and source query retained');
    await navigate(context.standaloneId); await chooseHeaderFork();
    if ((await evaluate(stateExpression)).menu.length !== 1) throw new Error('An ineligible projectless worktree choice was fabricated.');
    await capture('08-projectless-local-only'); await key('ESCAPE');
    if (!readFileSync(sourceFile(parent.sessionFile)).equals(originalBytes)) throw new Error('A later Fork mutated the original native source.');
    writeFileSync(join(output, 'native-source-before.jsonl'), originalBytes);
    writeFileSync(join(output, 'native-source-after.jsonl'), readFileSync(sourceFile(parent.sessionFile)));
    writeFileSync(join(output, 'bound-state.json'), JSON.stringify(current, null, 2));
    checkpoints.push('Real projectless eligibility omits worktree; retained original native file remains byte-identical');
    passed = true;
  } catch (cause) { failure = String(cause); await capture('failure').catch(() => {}); }
  finally {
    writeFileSync(join(output, 'result.json'), JSON.stringify({ passed, failure, checkpoints, calls, inputs, captures, errors, dropped,
      source: { main: createHash('sha256').update(readFileSync(join(repository, 'apps/desktop/dist/main.cjs'))).digest('hex'), preload: createHash('sha256').update(readFileSync(join(repository, 'apps/desktop/dist/preload.cjs'))).digest('hex') },
      conditions, scope: 'Actual production App/main/preload/versioned transport and real no-provider native host. Required per-action prerequisites are owned CG/AX/display/viewport/DPR/zoom/theme/yabai state and zero actual discovered peers. Native window-ID PNG qualifications are recorded separately; a failed condition refuses subsequent input/capture. Reference conditions remain unmatched; no pixel-parity or physical cross-device claim.' }, null, 2));
    for (const owned of BrowserWindow.getAllWindows()) owned.destroy(); app.exit(passed ? 0 : 1);
  }
}
// The application path points at an isolated package whose dist link is the
// already-built production desktop. No acceptance bridge or UI is substituted.
require(join(repository, 'apps/desktop/dist/main.cjs'));
