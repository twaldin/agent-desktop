const { app, BrowserWindow, clipboard } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { createSurfaceGuard } = require('./surface-guard.cjs');
const [output, fixture, repository] = process.argv.slice(2);
if (process.env.HOME !== fixture || process.env.AGENT_DESKTOP_PROFILE_DIR !== join(fixture, 'profile') || process.env.CONVERSATION_MARKDOWN_CLIPBOARD_BOUNDARY !== 'controlled-api')
  throw new Error('An isolated profile and explicit controlled-api clipboard boundary are required.');
// No flavor of the real system clipboard is read, written, cleared or preserved.
// These guards are installed before production main loads. Only the renderer's
// known disposable writeText payloads enter the controlled sink below.
for (const name of Object.getOwnPropertyNames(clipboard)) if (typeof clipboard[name] === 'function') Object.defineProperty(clipboard, name, {
  value: () => { throw new Error('OS clipboard access forbidden in controlled-api acceptance: ' + name); }, configurable: false, writable: false,
});
const { connection, sessions, projected, hashes } = JSON.parse(readFileSync(join(fixture, 'ready.json'), 'utf8'));
writeFileSync(join(output, 'native-seed.json'), JSON.stringify({ sessions, projected, hashes }, null, 2));
const conditions = JSON.parse(readFileSync(join(output, 'surface-conditions.json'), 'utf8'));
const originalFetch = globalThis.fetch, mutations = [], inputs = [], captures = [], checks = [], errors = [];
let ownedWindow, transcriptGate;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== '127.0.0.1') throw new Error('Outbound network forbidden in Markdown acceptance.');
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  if (body?.command) mutations.push(body.command.type);
  const gate = transcriptGate;
  if (gate && url.pathname === `/v1/sessions/${gate.sessionId}/messages`) {
    gate.started++;
    if (gate.mode === 'refuse') throw new Error('Controlled transcript transport refusal');
    await new Promise(resolve => gate.waiters.push(resolve));
  }
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
  const copyButton = `[...document.querySelectorAll('.action-menu button')].find(node=>node.textContent==='Copy as Markdown')`;
  const stateExpression = `(() => {const selected=document.querySelector('.session-row[aria-current="page"]'),copy=${copyButton};return {owner:selected&&{hostId:selected.dataset.hostId,sessionId:selected.dataset.sessionId},copy:copy&&{disabled:copy.disabled,title:copy.title},feedback:[...document.querySelectorAll('[role="status"],[role="alert"]')].filter(node=>node.getClientRects().length&&node.textContent.includes('conversation as Markdown')).map(node=>({role:node.getAttribute('role'),text:node.textContent})),menu:!!document.querySelector('.action-menu'),commandMenu:!!document.querySelector('.command-menu'),viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio}};})()`;
  const click = async (selector, text) => {
    await surface.check('before-target-scroll:' + selector);
    const position = await evaluate(`(() => {const node=[...document.querySelectorAll(${JSON.stringify(selector)})].find(node=>node.getClientRects().length&&(!${JSON.stringify(text)}||node.textContent.trim()===${JSON.stringify(text)}));if(!node||node.disabled)throw Error('Missing or disabled actual Markdown control');node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    await surface.check('pointer-batch:' + selector);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, ...position, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
    inputs.push({ type: 'pointer', selector, text, position }); await delay(100);
  };
  const key = async (keyCode, modifiers = []) => {
    await surface.check('key-batch:' + keyCode);
    for (const type of ['keyDown', 'keyUp']) window.webContents.sendInputEvent({ type, keyCode, modifiers });
    inputs.push({ type: 'key', keyCode, modifiers }); await delay(100);
  };
  const capture = async label => {
    const before = await evaluate(stateExpression);
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const proof = await surface.capture(label, join(output, label + '.png'));
    const state = await evaluate(stateExpression);
    if (JSON.stringify(before) !== JSON.stringify(state)) throw new Error('Copy presentation changed during native capture: ' + label);
    captures.push({ label, proof, state });
  };
  const menu = () => click('button[aria-label="Conversation actions"]');
  const navigate = async index => {
    await click(`button[data-session-id="${sessions[index].id}"][data-host-id="${connection.hostId}"]`);
    await wait(`document.querySelector('.session-row[aria-current="page"]')?.dataset.sessionId===${JSON.stringify(sessions[index].id)}`, 'actual owning session selected');
  };
  const ready = async () => { await menu(); await wait(`!!(${copyButton})&&!(${copyButton}).disabled`, 'host-owned transcript ready for Copy as Markdown'); };
  const sink = () => evaluate('window.__conversationMarkdownSink.observations()');
  const mode = value => evaluate(`window.__conversationMarkdownSink.mode=${JSON.stringify(value)}`);
  const fulfilled = count => wait(`window.__conversationMarkdownSink.observations().filter(item=>item.outcome==='fulfilled').length===${count}`, 'controlled writeText fulfilled');
  const checkPayload = (value, index) => {
    if (index === 1) { if (value !== '# Markdown alternate\n\n> Different native conversation.\n') throw new Error('Copied the wrong alternate native transcript.'); return; }
    const literals = ['# Markdown source\n', '> **Markdown fixture user**', '>   keepWhitespace();  ', '## Literal assistant\n\n[relative](./retained.txt) and `inline`.', 'Tool call: ` read `', '"path": "retained.txt"', 'Tool result: ` read ` — Failed', 'middle omitted', 'shown line is partial', '3 of 20 lines recorded', 'artifact://1234', '`````text\n```\n  recorded tool preview  \n````\n`````', 'Recorded final answer.', 'Recorded visible response error.'];
    for (const literal of literals) if (!value.includes(literal)) throw new Error('Native Markdown payload lost recorded meaning: ' + literal);
    if (/EXCLUDED_/.test(value)) throw new Error('Hidden reasoning or provider metadata escaped into Markdown.');
    const ordered = ['> **Markdown fixture user**', '## Literal assistant', 'Tool call:', 'Tool result:', 'Recorded final answer.'].map(text => value.indexOf(text));
    if (ordered.some((position, index) => index > 0 && position <= ordered[index - 1])) throw new Error('Native transcript order changed.');
  };
  let passed = false, error;
  try {
    await evaluate(`(() => {
      const observations=[],pending=[];const sink={mode:'fulfill',observations:()=>observations.map(({value,outcome})=>({value,outcome})),settle(outcome){const request=pending.shift();if(!request)throw Error('No deferred clipboard request');request.record.outcome=outcome;if(outcome==='fulfilled')request.resolve();else request.reject(new DOMException('Controlled clipboard refusal','NotAllowedError'));}};
      const forbidden=()=>{throw Error('Alternate clipboard access forbidden in controlled-api acceptance');};
      const target=Object.freeze({writeText(value){if(typeof value!=='string')throw TypeError('writeText needs text');const record={value,outcome:'pending'};observations.push(record);if(sink.mode==='defer')return new Promise((resolve,reject)=>pending.push({record,resolve,reject}));if(sink.mode==='refuse'){record.outcome='rejected';return Promise.reject(new DOMException('Controlled clipboard refusal','NotAllowedError'));}record.outcome='fulfilled';return Promise.resolve();},read:forbidden,readText:forbidden,write:forbidden});
      Object.defineProperty(navigator,'clipboard',{value:target,configurable:false});
      const originalExec=document.execCommand.bind(document);document.execCommand=(command,...args)=>{if(['copy','cut','paste'].includes(command.toLowerCase()))return forbidden();return originalExec(command,...args);};
      for(const event of ['copy','cut','paste'])document.addEventListener(event,event=>{event.preventDefault();event.stopImmediatePropagation();},true);
      Object.defineProperty(window,'__conversationMarkdownSink',{value:sink,configurable:false});
    })()`);
    await surface.prepare();
    await wait(`document.querySelector('.session-row[aria-current="page"]')?.dataset.sessionId===${JSON.stringify(sessions[0].id)}`, 'restored source conversation');
    const before = await http('/v1/state');
    const sourceDrafts = value => value.drafts.filter(draft => sessions.some(session => draft.id === 'session:' + session.id));
    const beforeDrafts = sourceDrafts(before);
    await ready(); await capture('01-native-copy-menu');
    await click('.action-menu button', 'Copy as Markdown'); await fulfilled(1);
    await wait(`(${stateExpression}).feedback.some(item=>item.text==='Copied conversation as Markdown')`, 'visible fulfilled-only copy status');
    checkPayload((await sink())[0].value, 0); await capture('02-pointer-copy-fulfilled');
    await mode('refuse'); await ready(); await click('.action-menu button', 'Copy as Markdown');
    await wait(`(${stateExpression}).feedback.some(item=>item.role==='alert'&&item.text.includes('Controlled clipboard refusal'))`, 'honest scoped clipboard refusal');
    await capture('03-clipboard-refusal');
    if ((await sink()).length !== 2 || (await sink())[1].outcome !== 'rejected') throw new Error('Clipboard refusal was not observed.');
    await mode('defer'); await ready(); await click('.action-menu button', 'Copy as Markdown');
    await wait(`(${stateExpression}).feedback.some(item=>item.text.includes('Copying conversation'))`, 'pending clipboard status');
    await navigate(1); await menu();
    await wait(`(${copyButton})?.disabled===true`, 'no overlapping clipboard attempt on another conversation');
    await capture('04-late-copy-owner-changed');
    await menu(); await key('Y', ['meta', 'shift']);
    if ((await sink()).length !== 3) throw new Error('A second clipboard write overlapped the retained attempt.');
    await evaluate(`window.__conversationMarkdownSink.settle('fulfilled')`); await fulfilled(2);
    if ((await evaluate(stateExpression)).feedback.length) throw new Error('Late source copy announced success on the alternate conversation.');
    checkPayload((await sink())[2].value, 0); checks.push('late source fulfillment retained original payload and did not announce alternate copied');
    await mode('fulfill'); await key('Y', ['meta', 'shift']); await fulfilled(3);
    checkPayload((await sink())[3].value, 1); await capture('05-real-keymap-copy');
    await navigate(0); await ready(); await menu();
    await key('K', ['meta']); await wait(`!!document.querySelector('[cmdk-input]')`, 'real command menu');
    await surface.check('command-menu-query'); window.webContents.insertText('Copy as Markdown');
    inputs.push({ type: 'insertText', value: 'Copy as Markdown', target: 'actual command menu' });
    await wait(`!!document.querySelector('[data-value="command:copyConversationMarkdown"]')`, 'installed central command owner');
    await capture('06-command-menu-owner'); await key('ENTER'); await fulfilled(4);
    checkPayload((await sink())[4].value, 0);
    // Hold actual host reads, never replace their transcript response with a fake array.
    transcriptGate = { sessionId: sessions[0].id, mode: 'hold', started: 0, waiters: [] };
    await menu(); await click('.action-menu button', 'Refresh transcript'); await menu();
    await wait(`(${copyButton})?.disabled===true`, 'refresh loading remains unavailable');
    if (!transcriptGate.started) throw new Error('The actual host transcript request was not held.');
    await capture('07-native-read-loading'); await menu(); await key('Y', ['meta', 'shift']);
    if ((await sink()).length !== 5) throw new Error('Loading transcript reached clipboard.');
    const held = transcriptGate; transcriptGate = undefined; for (const release of held.waiters) release();
    await ready(); await menu();
    transcriptGate = { sessionId: sessions[0].id, mode: 'refuse', started: 0, waiters: [] };
    await menu(); await click('.action-menu button', 'Refresh transcript');
    await wait(`document.body.textContent.includes('Controlled transcript transport refusal')`, 'actual transcript transport error surfaced');
    await menu(); await wait(`(${copyButton})?.disabled===true`, 'failed read remains unavailable');
    await capture('08-native-read-refused'); await menu(); await key('Y', ['meta', 'shift']);
    if ((await sink()).length !== 5) throw new Error('Failed transcript reached clipboard.');
    transcriptGate = undefined;
    await menu(); await click('.action-menu button', 'Refresh transcript'); await ready(); await menu();
    transcriptGate = { sessionId: sessions[1].id, mode: 'hold', started: 0, waiters: [] };
    await navigate(1); await menu(); await wait(`(${copyButton})?.disabled===true`, 'new owner cannot copy preceding snapshot');
    await capture('09-new-owner-awaiting-native-read'); await menu();
    await navigate(0); await ready(); await menu();
    const lateRead = transcriptGate; transcriptGate = undefined; for (const release of lateRead.waiters) release();
    await delay(150); await key('Y', ['meta', 'shift']); await fulfilled(5);
    checkPayload((await sink())[5].value, 0); checks.push('late alternate read did not replace source owner snapshot');
    await navigate(2); await menu(); await wait(`(${copyButton})?.disabled===true&&(${copyButton}).title.includes('no messages')`, 'empty native transcript is unavailable');
    await capture('10-empty-native-conversation'); await menu(); await key('Y', ['meta', 'shift']);
    if ((await sink()).length !== 6) throw new Error('Empty conversation reached clipboard.');
    await navigate(0);
    await mode('defer'); await ready(); await click('.action-menu button', 'Copy as Markdown');
    await wait(`window.__conversationMarkdownSink.observations().length===7`, 'second retained clipboard attempt');
    await navigate(1); await evaluate(`window.__conversationMarkdownSink.settle('rejected')`);
    await wait(`window.__conversationMarkdownSink.observations()[6]?.outcome==='rejected'`, 'late source clipboard rejection');
    if ((await evaluate(stateExpression)).feedback.length) throw new Error('Late source failure appeared on another conversation.');
    checkPayload((await sink())[6].value, 0); await capture('11-late-rejection-owner-changed');
    checks.push('late source rejection did not announce another conversation failed');
    await navigate(0);
    const after = await http('/v1/state');
    if (JSON.stringify(sourceDrafts(after)) !== JSON.stringify(beforeDrafts)) throw new Error('Copy changed source draft content or revisions.');
    for (const [path, expected] of Object.entries(hashes)) if (createHash('sha256').update(readFileSync(path)).digest('hex') !== expected) throw new Error('Copy changed native history or retained source file: ' + path);
    if (mutations.some(type => type.startsWith('session.') || type.startsWith('draft.'))) throw new Error('Copy issued a native session or draft mutation.');
    writeFileSync(join(output, 'native-snapshot-observations.json'), JSON.stringify({ sessions, projected, beforeDrafts, afterDrafts: sourceDrafts(after), hashes }, null, 2));
    checks.push('real native journals, retained file and exact draft revisions unchanged'); passed = true;
  } catch (cause) { error = String(cause); await capture('failure').catch(() => {}); }
  finally {
    if (transcriptGate) for (const release of transcriptGate.waiters) release();
    writeFileSync(join(output, 'result.json'), JSON.stringify({ passed, error, conditions, clipboardBoundary: 'controlled-api-only; no OS clipboard read/write/integration proof', clipboard: await sink().catch(() => []), checks, mutations, inputs, captures, errors,
      source: { main: createHash('sha256').update(readFileSync(join(repository, 'apps/desktop/dist/main.cjs'))).digest('hex'), preload: createHash('sha256').update(readFileSync(join(repository, 'apps/desktop/dist/preload.cjs'))).digest('hex') },
      scope: 'Actual production App pointer/menu/central command/keymap routes over real disposable SessionManager journals and real host projections. Controlled clipboard fulfillment/refusal/deferred completion and transport hold/refusal are explicit boundary evidence, not OS clipboard/provider/tool execution or reference pixel parity.' }, null, 2));
    for (const window of BrowserWindow.getAllWindows()) window.destroy(); app.exit(passed ? 0 : 1);
  }
}
require(join(repository, 'apps/desktop/dist/main.cjs'));
