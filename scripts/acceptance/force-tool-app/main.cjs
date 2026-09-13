const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { createSurfaceGuard } = require('./surface-guard.cjs');
const executeFile = require('node:util').promisify(require('node:child_process').execFile);
const [output, fixture, repository] = process.argv.slice(2);
if (process.env.HOME !== fixture || process.env.AGENT_DESKTOP_PROFILE_DIR !== join(fixture, 'profile')) throw new Error('Private force profile required.');
const { connection, context } = JSON.parse(readFileSync(join(fixture, 'ready.json'), 'utf8'));
const conditions = JSON.parse(readFileSync(join(output, 'surface-conditions.json'), 'utf8'));
const originalFetch = globalThis.fetch, calls = [], inputs = [], captures = [], errors = [], checkpoints = [];
let mainWindow, surface, dropCancel = false, dropped, holdNextArm = false;
const PARTIAL_PROMPT = 'Read the owned file after the controlled interrupt boundary.';
const safeURL = input => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Non-loopback fetch forbidden in force App acceptance.');
  return url;
};
// Real transport is observed. The only transport fault drops one already-real
// cancellation acknowledgement, after its command has durably completed.
globalThis.fetch = async (input, init) => {
  const url = safeURL(input), body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  const call = { path: url.pathname, search: url.search, body, time: Date.now() }; calls.push(call);
  if (holdNextArm && body?.command?.type === 'session.prompt' && body.command.text === '/force read ' + PARTIAL_PROMPT) {
    holdNextArm = false;
    writeFileSync(join(fixture, 'arm-next.json'), JSON.stringify({ commandId: body.id }), { flag: 'wx' });
  }
  const response = await originalFetch(input, { ...init, redirect: 'error' });
  if (body?.command || url.pathname === '/v1/composer/actions') call.result = await response.clone().json();
  if (dropCancel && body?.command?.type === 'session.force.cancel') {
    dropCancel = false;
    if (!response.ok || !call.result?.ok) throw new Error('Lost cancellation acknowledgement requires real successful cancellation.');
    dropped = { envelope: body, result: call.result };
    await surface.check('before-cancel-ack-loss-renderer-reload');
    mainWindow.webContents.reload();
    throw new Error('Controlled acknowledgement loss after real native cancellation.');
  }
  return response;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const http = async (path, body) => {
  safeURL(connection.origin + path);
  const response = await originalFetch(connection.origin + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${connection.token}`, 'X-Agent-Force-Tool-Host-Id': connection.hostId, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value;
};
const assert = (value, message) => { if (!value) throw new Error(message); };
const bounded = async (operation, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await operation(); if (result) return result; await delay(50); }
  throw new Error('Timed out: ' + label);
};
const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));
const nativeRead = async (id, commandId) => {
  const value = await http(`/v1/sessions/${encodeURIComponent(id)}/force-tool${commandId ? '?commandId=' + encodeURIComponent(commandId) : ''}`);
  assert(value.protocolVersion === 1 && value.hostId === connection.hostId && value.sessionId === id, 'Force read crossed owner or schema boundary.');
  return value;
};
const promptCalls = id => calls.filter(call => call.body?.command?.type === 'session.prompt' && (!id || call.body.command.sessionId === id));
const providerCount = () => readdirSync(join(fixture, 'provider')).filter(name => /^request-\d+\.json$/.test(name)).length;
const effects = () => existsSync(join(fixture, 'custom-effects.jsonl')) ? readFileSync(join(fixture, 'custom-effects.jsonl'), 'utf8').trim().split('\n').filter(Boolean) : [];
app.on('browser-window-created', (_event, window) => {
  if (mainWindow) return; mainWindow = window;
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    try { safeURL(details.url); callback({ cancel: false }); } catch { callback({ cancel: true }); }
  });
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  window.webContents.once('did-finish-load', () => void exercise(window));
});
async function exercise(window) {
  const evaluate = expression => window.webContents.executeJavaScript(expression, true);
  surface = createSurfaceGuard({ window, output, fixture, conditions, http });
  const stateExpression = `({sessionId:document.querySelector('.session-row[aria-current="page"]')?.getAttribute('data-session-id'),text:document.querySelector('#prompt')?.textContent,body:document.body.innerText,focus:document.activeElement?.id,panel:!!document.querySelector('.force-tool-panel')})`;
  const wait = async (expression, label) => { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { try { if (await evaluate(expression)) return; } catch (cause) { if (!window.webContents.isLoading()) throw cause; } await delay(50); } throw new Error('Timed out: ' + label); };
  const click = async (selector, label, receiptEvent = 'click') => {
    await surface.check('before-target-scroll:' + selector);
    await evaluate(`(() => {const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&(!${JSON.stringify(label)}||n.textContent.trim()===${JSON.stringify(label)}||n.getAttribute('aria-label')===${JSON.stringify(label)}));if(!n)throw Error('Missing force target');n.scrollIntoView({block:'nearest'});})()`);
    await surface.check('pointer-batch:' + selector);
    // Re-resolve after the awaited native surface check: model metadata can
    // change composer height while the check is running.
    const position = await evaluate(`(() => {const n=[...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&(!${JSON.stringify(label)}||n.textContent.trim()===${JSON.stringify(label)}||n.getAttribute('aria-label')===${JSON.stringify(label)}));if(!n)throw Error('Missing force target after surface check');n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);if(!hit||!n.contains(hit))throw Error('Native pointer center no longer owns the requested target');window.__forceAcceptanceClick=undefined;n.addEventListener(${JSON.stringify(receiptEvent)},event=>{window.__forceAcceptanceClick={trusted:event.isTrusted,target:event.composedPath().includes(n),eventType:event.type};},{once:true});return{x,y};})()`);
    const operation = { type: 'pointer', selector, label, position, receiptEvent };
    inputs.push(operation);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
      window.webContents.sendInputEvent({ type, ...position, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
    }
    await delay(100);
    const receipt = await evaluate(`(() => {const value=window.__forceAcceptanceClick;delete window.__forceAcceptanceClick;return value;})()`);
    operation.receipt = receipt;
    assert(receipt?.trusted && receipt.target && receipt.eventType === receiptEvent, `Native pointer ${receiptEvent} did not reach the current requested target.`);
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
  const navigate = async id => {
    await click(`.session-row[data-session-id="${id}"]`);
    await wait(`(${stateExpression}).sessionId===${JSON.stringify(id)} && !!document.querySelector('#prompt') && !(${stateExpression}).body.includes('Loading conversation')`, 'owning conversation');
  };
  const openPanel = async () => {
    if (!(await evaluate(stateExpression)).panel) await click('.force-tool-control > button');
    await wait(`!!document.querySelector('.force-tool-panel') && document.querySelector('.force-tool-refresh')?.textContent.includes('Current native state')`, 'current native force state');
  };
  const closePanel = async () => { if ((await evaluate(stateExpression)).panel) await click('[aria-label="Close force tool"]'); };
  const replaceText = async (selector, text) => { await click(selector); await key('A', ['meta']); await insertText(text); };
  const send = async () => { await wait(`!!document.querySelector('.send-button:not(:disabled)')`, 'send enabled'); await click('.send-button'); };
  // Native macOS select menus need OS key events and an explicit commit. Keep
  // this single batch external/async so Electron can service accessibility and
  // menu events. The helper never activates an app or assigns a DOM value.
  const chooseNativeTool = async optionIndex => {
    assert(Number.isSafeInteger(optionIndex) && optionIndex > 0 && optionIndex <= 16384, 'Invalid native select option index.');
    await surface.check('system-events-native-select:before');
    const before = await evaluate(`(() => {const s=document.querySelector('.force-tool-panel select');return {focused:!!s&&document.activeElement===s,disabled:s?.disabled,value:s?.value,options:s?[...s.options].filter(o=>!o.disabled).map(o=>o.value):[]}})()`);
    assert(before.focused && !before.disabled && before.options[optionIndex] === 'read', 'The enabled native read select does not own keyboard focus.');
    const operation = { type: 'native-select', method: 'System Events key code via async execFile /usr/bin/osascript',
      pid: process.pid, optionIndex, keyCodes: [49, 115, ...Array(optionIndex).fill(125), 36], before, startedAt: Date.now() };
    inputs.push(operation);
    const script = `on ownedKey(targetPID, nativeCode)
  tell application "System Events"
    set targets to every application process whose unix id is targetPID
    if (count of targets) is not 1 then error "Owned Electron PID is absent or ambiguous."
    set ownedProcess to item 1 of targets
    if frontmost of ownedProcess is not true then error "Owned Electron PID is no longer frontmost."
    tell ownedProcess to key code nativeCode
  end tell
  delay 0.08
end ownedKey
on run argv
  set targetPID to item 1 of argv as integer
  set downCount to item 2 of argv as integer
  my ownedKey(targetPID, 49)
  my ownedKey(targetPID, 115)
  repeat downCount times
    my ownedKey(targetPID, 125)
  end repeat
  my ownedKey(targetPID, 36)
  return "Owned native select key batch completed."
end run`;
    try {
      const result = await executeFile('/usr/bin/osascript', ['-e', script, String(process.pid), String(optionIndex)], { encoding: 'utf8', timeout: 5000 });
      operation.stdout = result.stdout; operation.stderr = result.stderr;
      await surface.check('system-events-native-select:after');
      await wait(`document.querySelector('.force-tool-panel select')?.value==='read'`, 'OS native select committed read');
      operation.after = await evaluate(`(() => {const s=document.querySelector('.force-tool-panel select');return {focused:document.activeElement===s,value:s?.value}})()`);
      operation.completedAt = Date.now();
    } catch (cause) {
      operation.failure = { message: String(cause), code: cause.code, signal: cause.signal, killed: cause.killed,
        stdout: cause.stdout ?? operation.stdout, stderr: cause.stderr ?? operation.stderr, time: Date.now() };
      throw cause;
    }
  };
  let dismissalChecked = false;
  const prepare = async (id, prompt) => {
    const before = promptCalls().length, requests = providerCount(), native = (await nativeRead(id)).value;
    assert(native?.canArm && ['supported', 'degraded'].includes(native.availability.state), 'Real native model/tool route is unavailable: ' + JSON.stringify(native));
    assert(native.model.provider === context.model.provider && native.model.id === context.model.id, 'Wrong owning native model.');
    await openPanel();
    if (await evaluate(`!![...document.querySelectorAll('.force-tool-panel button')].find(n=>n.textContent==='Use current composer text')`)) await click('.force-tool-panel button', 'Use current composer text');
    // Native keyboard selection, never assigning DOM value or calling React.
    const option = await evaluate(`(() => {const s=document.querySelector('.force-tool-panel select');return [...s.options].filter(o=>!o.disabled).findIndex(o=>o.value==='read')})()`);
    assert(option > 0, 'Native read is absent or unavailable in the rendered registry.');
    // Opening the panel focuses the select; Tab traversal handles already-open panels.
    await key('ESCAPE'); await openPanel();
    await chooseNativeTool(option);
    await replaceText('.force-tool-panel textarea', prompt);
    if (!dismissalChecked) {
      await click('#prompt', undefined, 'pointerdown');
      await wait(`!document.querySelector('.force-tool-panel') && document.activeElement===document.querySelector('#prompt')`, 'outside composer pointer dismisses force without stealing focus');
      await openPanel();
      assert(await evaluate(`document.querySelector('.force-tool-panel textarea')?.value===${JSON.stringify(prompt)}`), 'Outside dismissal discarded the optional prompt.');
      await key('ESCAPE');
      await wait(`!document.querySelector('.force-tool-panel') && document.activeElement===document.querySelector('.force-tool-control > button')`, 'Escape dismisses force and restores trigger focus');
      await openPanel();
      assert(await evaluate(`document.querySelector('.force-tool-panel textarea')?.value===${JSON.stringify(prompt)}`), 'Escape discarded the optional prompt.');
      await capture('01-panel-dismissal-prompt-retained');
      checkpoints.push('Actual outside composer click dismisses without focus theft; Escape restores trigger; optional prompt survives both and no force/model command is sent.');
      dismissalChecked = true;
    }
    if (await evaluate(`!![...document.querySelectorAll('.force-tool-panel button')].find(n=>n.textContent==='Review refreshed selection')`)) await click('.force-tool-panel button', 'Review refreshed selection');
    await wait(`!![...document.querySelectorAll('.force-tool-panel button')].find(n=>n.textContent==='Add to composer'&&!n.disabled)`, 'draft insertion enabled');
    await click('.force-tool-panel button', 'Add to composer');
    await wait(`(${stateExpression}).text===${JSON.stringify('/force read' + (prompt ? ' ' + prompt : ''))}`, 'native syntax inserted without sending');
    assert(promptCalls().length === before && providerCount() === requests, 'Picker dispatched instead of preparing the draft.');
    return native;
  };
  const completedPrompt = async id => bounded(() => Promise.resolve(promptCalls(id).findLast(call => call.result)), 'real command result');
  const cancelPending = async id => {
    await openPanel(); await click('.force-tool-panel button', 'Refresh');
    await wait(`!!document.querySelector('[aria-label="Remove pending force for read"]:not(:disabled)')`, 'native pending directive can cancel');
    await click('[aria-label="Remove pending force for read"]');
    await bounded(async () => (await nativeRead(id)).value?.directives.length === 0, 'actual queue removed');
  };
  const finishRead = async (id, first, label) => {
    const request = await bounded(() => existsSync(join(fixture, 'provider', `request-${first}.json`)) && readJSON(join(fixture, 'provider', `request-${first}.json`)), 'native named HTTP request');
    assert(request.body.tool_choice?.type === 'function' && request.body.tool_choice.function?.name === 'read', 'Native HTTP builder did not request named read.');
    assert(request.body.tools.some(tool => tool.function?.name === 'read'), 'Native request omitted read schema.');
    const inFlight = await nativeRead(id);
    assert(inFlight.value?.directives.length === 1 && inFlight.value.directives[0].phase === 'tool-in-flight', 'Named request did not own the real in-flight queue phase.');
    await openPanel(); await click('.force-tool-panel button', 'Refresh');
    await wait(`(${stateExpression}).body.includes('Tool request in progress')`, 'actual App in-flight tool phase');
    await capture(label + '-named-request');
    writeFileSync(join(fixture, 'provider', `release-${first}`), 'release actual HTTP tool response');
    const final = await bounded(() => existsSync(join(fixture, 'provider', `request-${first + 1}.json`)) && readJSON(join(fixture, 'provider', `request-${first + 1}.json`)), 'native final HTTP request');
    assert(final.body.tool_choice === 'none', 'Native final request did not map none.');
    assert(final.body.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes(context.nonce)), 'No real read result reached final request.');
    const finalFlight = await nativeRead(id);
    assert(finalFlight.value?.directives.length === 1 && finalFlight.value.directives[0].phase === 'final-response-in-flight', 'Final none request lost its actual queue phase.');
    await click('.force-tool-panel button', 'Refresh');
    await wait(`(${stateExpression}).body.includes('Final response in progress')`, 'actual App final response phase');
    await capture(label + '-none-final');
    writeFileSync(join(fixture, 'provider', `release-${first + 1}`), 'release actual HTTP final response');
    await bounded(async () => (await nativeRead(id)).value?.directives.length === 0, 'real native queue consumed');
    await bounded(async () => (await http('/v1/state')).sessions.find(session => session.id === id)?.status === 'idle', 'session settled');
    const messages = await http(`/v1/sessions/${id}/messages`);
    assert(JSON.stringify(messages).includes(context.nonce), 'Real native history omitted executed read content.');
    writeFileSync(join(output, label + '-messages.json'), JSON.stringify(messages, null, 2));
    writeFileSync(join(output, label + '-queue-phases.json'), JSON.stringify({ named: inFlight, final: finalFlight, settled: await nativeRead(id) }, null, 2));
    await click('.force-tool-panel button', 'Refresh');
    await wait(`!document.querySelector('.force-tool-queue')`, 'actual App empty native queue');
    await capture(label + '-complete'); await closePanel();
  };
  let passed = false, failure;
  try {
    await surface.prepare();
    await wait(`(${stateExpression}).sessionId===${JSON.stringify(context.sourceId)} && !!document.querySelector('#prompt')`, 'production App owning fixture session');
    const host = await http('/v1/state');
    assert(host.forceTool?.version === 1 && host.forceTool.commandVersion === 18, 'Coherent native force host capability is missing.');
    const id = context.sourceId, optional = 'Read the owned force proof file and report its contents.';
    const initial = await prepare(id, optional); await capture('01-picker-draft-only'); await send();
    const call = await completedPrompt(id);
    assert(call.path === '/v18/commands' && call.body.commandVersion === 18 && call.body.command.forceTool?.epoch === initial.epoch
      && call.body.command.forceTool.expectedRevision === initial.revision && call.body.command.forceTool.toolName === 'read' && !call.body.command.forceRecovery, 'Prepared App submission lost its v18 native guard.');
    assert(call.result.ok && call.result.forceToolReceipt?.arm === 'armed' && call.result.forceToolReceipt.prompt === 'recorded', 'Actual command did not prove armed and user-message admission.');
    await finishRead(id, 1, '01');
    const accepted = await nativeRead(id, call.body.id);
    assert(accepted.receipt?.state === 'succeeded' && accepted.receipt.forceToolReceipt?.prompt === 'recorded', 'Native delivered journal did not retain admitted prompt.');
    checkpoints.push('1: Actual picker, draft-only insertion, v18 guarded submission, worker/native named read, real file nonce, none final request and empty queue.');

    const cancelId = context.sessions.cancel.id;
    await navigate(cancelId); await prepare(cancelId, ''); await send();
    const armed = await completedPrompt(cancelId);
    assert(armed.result.ok && armed.result.forceToolReceipt?.prompt === 'not-requested', 'Arm-only native receipt missing.');
    await bounded(async () => (await nativeRead(cancelId)).value?.directives[0]?.phase === 'pending-tool', 'arm-only queue');
    const countBeforeCancel = providerCount(); dropCancel = true; await cancelPending(cancelId);
    await wait(`!![...document.querySelectorAll('.inline-error button')].find(n=>n.textContent==='Check original operation')`, 'durable cancellation identity after reload');
    assert(dropped?.result.value.type === 'session.force.cancel', 'Lost acknowledgement was not real cancellation.');
    await capture('02-cancel-ack-lost-after-reload');
    await click('.inline-error button', 'Check original operation');
    await wait(`![...document.querySelectorAll('.inline-error button')].some(n=>n.textContent==='Check original operation')`, 'same cancellation reconciled');
    const cancels = calls.filter(item => item.body?.command?.type === 'session.force.cancel' && item.body.command.sessionId === cancelId);
    assert(cancels.length === 2 && cancels.every(item => item.body.id === dropped.envelope.id), 'Cancellation reconciliation created a new command identity.');
    assert(providerCount() === countBeforeCancel && (await nativeRead(cancelId)).value.directives.length === 0, 'Cancellation sent a model request or recreated native force.');
    checkpoints.push('2: Arm-only pending sequence, actual native cancellation, dropped completed ack, real renderer reload and same-ID durable reconciliation without rearm.');

    await closePanel(); await click('#prompt', undefined, 'pointerdown'); await key('N', ['meta']);
    await wait(`!(${stateExpression}).sessionId && !!document.querySelector('#prompt')`, 'actual new conversation draft');
    await click('[aria-label="Model and reasoning effort"]'); await click('[aria-label="Select model"]');
    await click('[aria-label="Search models"]'); await insertText('Controlled force HTTP fixture');
    await wait(`!!document.querySelector('.composer-selection-options [role="menuitemradio"]:not(:disabled)')`, 'fixture model available in actual native catalog');
    await click('.composer-selection-options [role="menuitemradio"]');
    await replaceText('#prompt', '/force read');
    const beforeNew = calls.length; await send();
    const raw = await bounded(() => Promise.resolve(calls.slice(beforeNew).find(item => item.body?.command?.type === 'session.prompt' && item.result)), 'new conversation native raw force');
    const createIndex = calls.findIndex((item, index) => index >= beforeNew && item.body?.command?.type === 'session.create');
    const rawIndex = calls.indexOf(raw), newId = raw.body.command.sessionId;
    const liveCatalog = calls.slice(createIndex + 1, rawIndex).find(item => item.path === '/v1/composer/actions' && item.body?.target?.sessionId === newId);
    assert(createIndex >= beforeNew && liveCatalog && raw.path === '/v18/commands' && !raw.body.command.forceTool && !raw.body.command.forceRecovery, 'Raw new-chat path did not create then resolve live native catalog before unguarded v18 submission.');
    const builtin = liveCatalog.result?.commands?.find(command => command.name === 'force' && command.source.kind === 'builtin');
    assert(builtin && ['executable', 'partial'].includes(builtin.availability) && raw.result.ok, 'New native force was not the actual catalog winner.');
    await wait(`(${stateExpression}).sessionId===${JSON.stringify(newId)}`, 'actual newly created conversation navigation');
    await cancelPending(newId); await closePanel();
    checkpoints.push('3: Actual new-chat raw syntax creates a session, resolves its real command winner, submits v18 without inventing a picker guard, and cancels its native pending queue.');

    const customId = context.sessions.custom.id;
    await navigate(customId); await prepare(customId, '/force-fixture-effect'); await send();
    const custom = await completedPrompt(customId);
    assert(!custom.result.ok && custom.result.error.code === 'OUTCOME_UNKNOWN' && custom.result.forceToolReceipt?.arm === 'armed'
      && custom.result.forceToolReceipt.prompt === 'unknown' && effects().length === 1, 'Optional native custom effect was not classified unknown after one real dispatch.');
    await openPanel();
    await wait(`!!document.querySelector('.force-tool-recovery button:disabled')`, 'unknown optional command cannot recover');
    await capture('04-custom-unknown-no-recovery'); await closePanel();
    // Existing pending-send action reuses its durable ID; no new optional command.
    await send();
    await bounded(() => Promise.resolve(promptCalls(customId).length === 2 && promptCalls(customId)[1].result), 'original unknown command check');
    assert(promptCalls(customId).every(item => item.body.id === custom.body.id) && effects().length === 1 && providerCount() === 2,
      'Unknown optional command replayed side effects or dispatched a provider.');
    await cancelPending(customId); await closePanel();
    checkpoints.push('4: Real optional custom native command effect occurs once, returns no user message, remains unknown, disables recovery, and same-ID check cannot replay it.');

    const partialId = context.sessions.partial.id;
    await navigate(partialId); await prepare(partialId, PARTIAL_PROMPT); holdNextArm = true; await send();
    const held = await bounded(() => existsSync(join(fixture, 'arm-held.json')) && readJSON(join(fixture, 'arm-held.json')), 'actual arm-history flush hold');
    assert(held.originalFlushCompleted && held.receipt.arm === 'armed', 'Partial hold did not observe real flushed arm history.');
    const beforeInterrupt = await nativeRead(partialId);
    assert(beforeInterrupt.value?.directives.some(item => item.id === held.receipt.directiveId && item.phase === 'pending-tool'), 'Actual pending native directive absent at flush hold.');
    const interruptEnvelope = { id: require('node:crypto').randomUUID(), commandVersion: 18, command: { type: 'session.interrupt', sessionId: partialId } };
    // No fabricated abort/error: the real host interrupt must acknowledge while
    // the original durable flush continuation is still held. If it cannot, fail.
    const interrupt = await Promise.race([http('/v18/commands', interruptEnvelope), delay(15_000).then(() => { throw Error('Missing hook: real session.interrupt cannot acknowledge while post-flush continuation is held.'); })]);
    assert(interrupt.ok && !existsSync(join(fixture, 'arm-released.json')), 'Interrupt was not acknowledged before releasing native continuation.');
    writeFileSync(join(output, '05-interrupt-boundary.json'), JSON.stringify({ held, beforeInterrupt, interruptEnvelope, interrupt, acknowledgedAt: Date.now() }, null, 2));
    writeFileSync(join(fixture, 'arm-release'), 'release only after real interrupt acknowledged');
    const partial = await completedPrompt(partialId);
    assert(partial.body.id === held.commandId && !partial.result.ok && partial.result.error.code !== 'OUTCOME_UNKNOWN'
      && partial.result.forceToolReceipt?.arm === 'armed' && partial.result.forceToolReceipt.prompt === 'not-recorded',
      'Missing hook: the real post-flush interrupt did not prove known pre-entry partial admission; no recovery attempted.');
    const originalReceipt = await nativeRead(partialId, held.commandId);
    assert(originalReceipt.receipt?.state === 'failed' && originalReceipt.receipt.forceToolReceipt?.prompt === 'not-recorded', 'Delivered original journal lost its actual known partial receipt.');
    const editedDraft = 'Newer composer edits remain after recovering the earlier prompt.';
    await replaceText('#prompt', editedDraft); await openPanel();
    await wait(`!!document.querySelector('.force-tool-recovery button:not(:disabled)')`, 'legitimate native partial recovery eligibility');
    await capture('05-known-partial-edited-draft');
    await click('.force-tool-recovery button', 'Send remaining prompt');
    const recovery = await bounded(() => Promise.resolve(promptCalls(partialId).find(item => item.body.command.forceRecovery && item.result)), 'real guarded remaining prompt');
    assert(recovery.body.id !== held.commandId && recovery.path === '/v18/commands' && recovery.body.command.text === PARTIAL_PROMPT
      && recovery.body.command.forceRecovery.epoch === held.receipt.epoch && recovery.body.command.forceRecovery.directiveId === held.receipt.directiveId
      && !recovery.body.command.forceTool && !recovery.body.command.draft, 'Recovery lost original directive or rearmed/rebound current composer.');
    for (const key of ['model', 'thinkingLevel', 'approvalMode']) assert(JSON.stringify(recovery.body.command[key]) === JSON.stringify(partial.body.command[key]), 'Recovery changed original ' + key + '.');
    assert(recovery.result.ok && recovery.result.admission?.kind === 'user-message' && recovery.result.admission.entryId, 'Recovery lacked an actual admitted user receipt.');
    await finishRead(partialId, 3, '05');
    assert((await evaluate(stateExpression)).text === editedDraft, 'Recovery cleared current composer edits.');
    assert(!await evaluate(`[...document.querySelectorAll('.composer-region > .inline-error[role="alert"]')].some(node=>node.textContent.includes('optional prompt was not recorded'))`),
      'Successful recovery left the original force admission banner visible.');
    const current = await http('/v1/state');
    assert(current.drafts.find(draft => draft.id === 'session:' + partialId)?.text === editedDraft, 'Recovered prompt overwrote persisted current draft.');
    assert(providerCount() === 4 && effects().length === 1, 'Unexpected provider request or repeated custom effect.');
    checkpoints.push('5: Original arm-history flush held, real interrupt acknowledged, original ownership fence proves pre-entry failure; real journal/queue allow guarded recovery, read then none executes, newer edits and original model/thinking/approval remain.');
    const aliasId = context.sessions.alias.id;
    await navigate(aliasId); await replaceText('#prompt', '/force-fixture-shadow'); await send();
    const shadowSetup = await completedPrompt(aliasId);
    assert(shadowSetup.result.ok && shadowSetup.result.admission?.kind === 'native-command'
      && shadowSetup.result.admission.command === 'force-fixture-shadow', 'Real native session command did not register the canonical collision.');
    const shadowState = await nativeRead(aliasId);
    const registrations = readFileSync(join(fixture, 'alias-shadow-registrations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert(registrations.length === 1 && registrations[0].nativeSessionId === shadowState.value?.nativeSessionId,
      'Canonical collision was not registered in this actual isolated native session.');
    assert(shadowState.value?.availability.state === 'unsupported' && !shadowState.value.canArm
      && shadowState.value.directives.length === 0, 'Canonical picker did not truthfully refuse its real extension collision.');
    await openPanel();
    await wait(`!!document.querySelector('.force-tool-unsupported') && !!document.querySelector('.force-tool-primary:disabled')`, 'actual canonical picker shows unavailable');
    await capture('06-canonical-shadow-picker-unavailable'); await closePanel();
    const aliasPrompt = 'Read the owned file through the native inline alias.';
    await replaceText('#prompt', '/force:read ' + aliasPrompt);
    const beforeAlias = calls.length; await send();
    const alias = await bounded(() => Promise.resolve(calls.slice(beforeAlias).find(item => item.body?.command?.type === 'session.prompt'
      && item.body.command.sessionId === aliasId && item.result)), 'actual inline alias arm-history optional prompt');
    const aliasCatalog = calls.slice(beforeAlias, calls.indexOf(alias)).find(item => item.path === '/v1/composer/actions' && item.body?.target?.sessionId === aliasId);
    const shadowedBuiltin = aliasCatalog?.result?.commands?.find(command => command.name === 'force' && command.source.kind === 'builtin');
    const canonicalOwner = aliasCatalog?.result?.commands?.find(command => command.name === 'force' && command.source.kind === 'extension');
    assert(shadowedBuiltin?.availability === 'shadowed' && canonicalOwner && canonicalOwner.availability !== 'shadowed',
      'The actual alias submission catalog did not preserve canonical extension precedence.');
    assert(alias.path === '/v18/commands' && alias.body.commandVersion === 18 && !alias.body.command.forceTool && !alias.body.command.forceRecovery
      && alias.result.ok && alias.result.forceToolReceipt?.toolName === 'read' && alias.result.forceToolReceipt.arm === 'armed'
      && alias.result.forceToolReceipt.prompt === 'recorded' && alias.result.admission?.kind === 'user-message',
      'Real inline alias did not survive native arm/history await/ordinary prompt admission with its builtin receipt.');
    assert(!existsSync(join(fixture, 'canonical-force-effects.jsonl')), 'Inline alias called the canonical extension handler.');
    await finishRead(aliasId, 5, '06');
    const aliasReceipt = await nativeRead(aliasId, alias.body.id);
    assert(aliasReceipt.receipt?.state === 'succeeded' && aliasReceipt.receipt.forceToolReceipt?.prompt === 'recorded'
      && aliasReceipt.value?.availability.state === 'unsupported' && !aliasReceipt.value.canArm,
      'Alias completion lost its durable builtin receipt or incorrectly unshadowed the canonical picker.');
    assert(!existsSync(join(fixture, 'canonical-force-effects.jsonl')) && effects().length === 1 && providerCount() === 6,
      'Alias invoked canonical/custom side effects or changed the expected actual read/none request count.');
    writeFileSync(join(output, '06-alias-ownership.json'), JSON.stringify({ registrations, shadowState, aliasCatalog, alias, aliasReceipt }, null, 2));
    checkpoints.push('6: Real session-local extension shadows canonical force; actual picker is unavailable, raw /force:read still reaches builtin through native history await and optional prompt, read/none executes, canonical extension handler remains uncalled.');
    passed = true;
  } catch (cause) { failure = String(cause); await capture('failure').catch(() => {}); }
  finally {
    // Preserve raw private evidence before fixture deletion, without connection/token.
    for (const directory of ['provider']) {
      mkdirSync(join(output, directory), { recursive: true });
      for (const file of readdirSync(join(fixture, directory))) copyFileSync(join(fixture, directory, file), join(output, directory, file));
    }
    for (const file of ['arm-held.json', 'arm-claimed.json', 'arm-released.json', 'custom-effects.jsonl', 'alias-shadow-registrations.jsonl', 'canonical-force-effects.jsonl'])
      if (existsSync(join(fixture, file))) copyFileSync(join(fixture, file), join(output, file));
    for (const [name, session] of Object.entries(context.sessions)) if (existsSync(session.sessionFile)) {
      assert(resolve(session.sessionFile).startsWith(resolve(fixture) + '/'), 'Native evidence escaped fixture.');
      copyFileSync(session.sessionFile, join(output, 'native-' + name + '.jsonl'));
    }
    writeFileSync(join(fixture, 'arm-release'), 'cleanup only');
    for (let index = 1; index <= providerCount(); index++) writeFileSync(join(fixture, 'provider', `release-${index}`), 'cleanup only');
    writeFileSync(join(output, 'result.json'), JSON.stringify({ passed, failure, checkpoints, calls, inputs, captures, errors, dropped, conditions,
      scope: 'Production App/main/preload/transport/host/worker and actual pinned native queue/read tool. Auth-free controlled loopback HTTP chat-completions fixture, not vendor/provider, reference parity, installed app, cross-device or independent review evidence. Case5 scheduling hook only delays continuation after original durable flush; no fabricated queue, journal, user receipt, command result or dispatch side effect.' }, null, 2));
    for (const owned of BrowserWindow.getAllWindows()) owned.destroy(); app.exit(passed ? 0 : 1);
  }
}
require(join(repository, 'apps/desktop/dist/main.cjs'));
