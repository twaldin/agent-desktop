const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, mkdirSync, realpathSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { createSurfaceGuard } = require('./surface-guard.cjs');
const [output, fixture, repository] = process.argv.slice(2);
if (process.env.HOME !== fixture || process.env.AGENT_DESKTOP_PROFILE_DIR !== join(fixture, 'profile')) throw new Error('Private Plan profile required.');
const { connection, context } = JSON.parse(readFileSync(join(fixture, 'ready.json'), 'utf8'));
const conditions = JSON.parse(readFileSync(join(output, 'surface-conditions.json'), 'utf8'));
const originalFetch = globalThis.fetch, calls = [], inputs = [], captures = [], errors = [], checkpoints = [], targetFailures = [];
let mainWindow, surface;
const safeURL = input => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Non-loopback fetch forbidden in Plan App acceptance.');
  return url;
};
// Observe production transport only. No command, response, receipt or bridge is replaced.
globalThis.fetch = async (input, init) => {
  const url = safeURL(input), body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  const call = { path: url.pathname, search: url.search, body, time: Date.now() }; calls.push(call);
  const response = await originalFetch(input, { ...init, redirect: 'error' });
  if (body?.command || /\/plan$/.test(url.pathname)) call.result = await response.clone().json();
  return response;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (value, message) => { if (!value) throw new Error(message); };
const http = async path => {
  safeURL(connection.origin + path);
  const response = await originalFetch(connection.origin + path, { redirect: 'error', headers: {
    Authorization: `Bearer ${connection.token}`, 'X-Agent-Plan-Host-Id': connection.hostId,
  } });
  const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value;
};
const bounded = async (operation, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await operation(); if (result) return result; await delay(50); }
  throw new Error('Timed out: ' + label);
};
const nativeRead = async (id, commandId) => {
  const value = await http(`/v1/sessions/${encodeURIComponent(id)}/plan${commandId ? '?commandId=' + encodeURIComponent(commandId) : ''}`);
  assert(value.protocolVersion === 1 && value.hostId === connection.hostId && value.sessionId === id, 'Plan read crossed owner or schema boundary.'); return value;
};
const commandCalls = type => calls.filter(call => call.body?.command?.type === type);
const providerCount = () => readdirSync(join(fixture, 'provider')).filter(name => /^request-\d+\.json$/.test(name)).length;
const marker = name => `PLAN_CASE:${name}:${context.nonce}`;
const ownedFile = file => { const actual = realpathSync(file); assert(actual.startsWith(realpathSync(fixture) + '/'), 'Evidence escaped the disposable fixture.'); return actual; };
const journal = file => readFileSync(ownedFile(file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
function artifacts(directory = join(fixture, 'agent'), result = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), 'Unexpected native evidence symlink.');
    if (entry.isDirectory()) artifacts(path, result);
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push({ path: ownedFile(path), content: readFileSync(path, 'utf8') });
  }
  return result;
}
// CG/AX can publish the original window before yabai registers that same ID.
// This read-only readiness fence precedes the unmodified shared surface guard.
async function awaitOriginalWindowRegistration(window) {
  const pid = process.pid, deadline = Date.now() + 10_000;
  const receipt = { pid, attempts: [], started: new Date().toISOString(), ready: false };
  let windowId;
  const timeout = () => { const remaining = deadline - Date.now(); assert(remaining > 0, 'Original window registration timed out.'); return Math.min(remaining, 5000); };
  const native = async () => {
    assert(!window.isDestroyed(), 'Original Electron window was destroyed during registration.');
    const observation = JSON.parse((await execute(join(output, 'native-geometry'), [String(pid)], { encoding: 'utf8', timeout: timeout() })).stdout);
    assert(observation.pid === pid && observation.cgWindows?.length === 1, 'Cannot bind one original CG window to the owning process.');
    const cg = observation.cgWindows[0];
    assert(cg.pid === pid && Number.isSafeInteger(cg.id) && cg.id > 0, 'Native window identity is invalid.');
    if (windowId === undefined) { windowId = cg.id; receipt.windowId = windowId; receipt.initialNative = observation; }
    assert(cg.id === windowId, 'Original native window identity changed while waiting for yabai.');
    return observation;
  };
  try {
    await native();
    let daemons;
    try { daemons = (await execute('/usr/bin/pgrep', ['-x', 'yabai'], { encoding: 'utf8', timeout: timeout() })).stdout.trim().split(/\s+/); }
    catch (cause) {
      if (cause.code !== 1 || String(cause.stderr ?? '').trim() || String(cause.stdout ?? '').trim()) throw cause;
      receipt.daemons = []; receipt.ready = true; receipt.outcome = 'No running yabai; shared guard verifies independently.';
      return receipt;
    }
    assert(daemons.length > 0 && daemons.every(id => /^[1-9][0-9]*$/.test(id)), 'Cannot identify running yabai process.');
    receipt.daemons = daemons;
    while (true) {
      const observation = await native(), attempt = { time: new Date().toISOString(), native: observation }; receipt.attempts.push(attempt);
      let response;
      try { response = await execute('yabai', ['-m', 'query', '--windows', '--window', String(windowId)], { encoding: 'utf8', timeout: timeout() }); }
      catch (cause) {
        attempt.error = { message: String(cause), code: cause.code, signal: cause.signal, stdout: String(cause.stdout ?? ''), stderr: String(cause.stderr ?? '') };
        // Only the observed daemon registration miss for this exact ID retries.
        if (cause.code !== 1 || cause.signal || attempt.error.stdout.trim() || attempt.error.stderr.trim() !== `could not locate window with the specified id '${windowId}'.`) throw cause;
        const remaining = deadline - Date.now(); assert(remaining > 0, 'Original window registration timed out.');
        await delay(Math.min(100, remaining)); continue;
      }
      attempt.stdout = response.stdout; attempt.stderr = response.stderr;
      assert(!response.stderr.trim(), 'Unexpected yabai registration query diagnostics.');
      const managed = JSON.parse(response.stdout); attempt.window = managed;
      assert(managed.id === windowId && managed.pid === pid, 'Registered yabai window does not match the original owned identity.');
      receipt.finalNative = await native(); receipt.ready = true; receipt.outcome = 'Original CG window registered with exact yabai PID and ID.';
      return receipt;
    }
  } catch (cause) {
    receipt.failure = { message: String(cause), code: cause.code, signal: cause.signal, stdout: String(cause.stdout ?? ''), stderr: String(cause.stderr ?? '') };
    throw cause;
  } finally { receipt.finished = new Date().toISOString(); writeFileSync(join(output, 'window-registration.json'), JSON.stringify(receipt, null, 2)); }
}
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
  const stateExpression = `({sessionId:document.querySelector('.session-row[aria-current="page"]')?.getAttribute('data-session-id'),text:document.querySelector('#prompt')?.textContent,body:document.body.innerText,planOpen:!!document.querySelector('.native-plan-dialog[open]')})`;
  const wait = async (expression, label) => bounded(async () => {
    try { return await evaluate(expression); } catch (cause) { if (!window.webContents.isLoading()) throw cause; }
  }, label);
  const target = (selector, label) => `([...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&(!${JSON.stringify(label)}||n.textContent.trim()===${JSON.stringify(label)}||n.getAttribute('aria-label')===${JSON.stringify(label)})))`;
  const visibleReviewExpression = `(() => {const d=document.querySelector('.native-plan-dialog[open]'),b=d?.querySelector('.plan-review-body:not([hidden])');return !!(d&&b&&d.getClientRects().length&&b.getClientRects().length);})()`;
  // Only opening the review can be satisfied by the App auto-opening it during
  // a surface await. Other guarded pointer operations retain strict hit tests.
  const clickTarget = async (expression, label, receiptEvent = 'click', openingReview = false) => {
    try {
      await surface.check('before-target-scroll:' + label);
      const alreadyOpen = await evaluate(`(() => {if(${openingReview}&&${visibleReviewExpression})return true;const n=${expression};if(!n)throw Error('Missing Plan target: '+${JSON.stringify(label)});n.scrollIntoView({block:'nearest'});return false;})()`);
      if (alreadyOpen) return;
      await surface.check('pointer-batch:' + label);
      const position = await evaluate(`(() => {if(${openingReview}&&${visibleReviewExpression})return {reviewAlreadyOpen:true};const n=${expression};if(!n)throw Error('Missing Plan target after surface check');const r=n.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),root=n.getRootNode(),hit=root.elementFromPoint?.(x,y)||document.elementFromPoint(x,y);if(!hit||!n.contains(hit))throw Error('Pointer target is obscured');window.__planAcceptanceClick=undefined;n.addEventListener(${JSON.stringify(receiptEvent)},event=>{window.__planAcceptanceClick={trusted:event.isTrusted,target:event.composedPath().includes(n),eventType:event.type};},{once:true});return{x,y};})()`);
      if (position.reviewAlreadyOpen) return;
      const operation = { method: 'Electron sendInputEvent', type: 'pointer', label, position, receiptEvent }; inputs.push(operation);
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, ...position, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
      await delay(100);
      operation.receipt = await evaluate(`(() => {const v=window.__planAcceptanceClick;delete window.__planAcceptanceClick;return v;})()`);
      assert(operation.receipt?.trusted && operation.receipt.target && operation.receipt.eventType === receiptEvent, 'Pointer did not reach the intended actual App target.');
    } catch (cause) {
      const diagnostic = { label, expression, receiptEvent, openingReview, error: String(cause), time: Date.now() };
      try {
        diagnostic.target = await evaluate(`(() => {const describe=n=>n?({tag:n.tagName,id:n.id,className:typeof n.className==='string'?n.className:undefined,label:n.getAttribute('aria-label'),text:n.textContent?.trim().slice(0,160),rect:n.getBoundingClientRect().toJSON()}):null,n=${expression},r=n?.getBoundingClientRect(),x=r?Math.round(r.x+r.width/2):0,y=r?Math.round(r.y+r.height/2):0;return {intended:describe(n),hit:describe(n?.getRootNode().elementFromPoint?.(x,y)||document.elementFromPoint(x,y)),active:describe(document.activeElement),dialog:describe(document.querySelector('.native-plan-dialog[open]')),reviewVisible:${visibleReviewExpression}};})()`);
      } catch (inspectionError) { diagnostic.inspectionError = String(inspectionError); }
      targetFailures.push(diagnostic);
      writeFileSync(join(output, 'target-failures.json'), JSON.stringify(targetFailures, null, 2));
      throw new Error('Guarded Plan target failed: ' + JSON.stringify(diagnostic), { cause });
    }
  };
  const click = (selector, label, receiptEvent) => clickTarget(target(selector, label), label ?? selector, receiptEvent);
  const key = async (keyCode, modifiers = []) => {
    await surface.check('key-batch:' + keyCode);
    for (const type of ['keyDown', 'keyUp']) window.webContents.sendInputEvent({ type, keyCode, modifiers });
    inputs.push({ method: 'Electron sendInputEvent', type: 'key', keyCode, modifiers }); await delay(100);
  };
  const insertText = async text => { await surface.check('insert-text'); await window.webContents.insertText(text); inputs.push({ method: 'Electron insertText', type: 'text', text }); };
  const replaceText = async (selector, text) => { await click(selector, undefined, 'pointerdown'); await key('A', ['meta']); await insertText(text); };
  const capture = async label => { const proof = await surface.capture(label, join(output, label + '.png')); captures.push({ label, state: await evaluate(stateExpression), proof }); };
  const hide = async () => { if ((await evaluate(stateExpression)).planOpen) await click('[aria-label="Hide Plan panel"]'); };
  const navigate = async id => { await hide(); await click(`.session-row[data-session-id="${id}"]`); await wait(`(${stateExpression}).sessionId===${JSON.stringify(id)}&&!!document.querySelector('#prompt')`, 'selected owning conversation'); };
  const idle = id => bounded(async () => (await http('/v1/state')).sessions.find(session => session.id === id && session.status === 'idle'), 'native host idle');
  const completed = (type, start, id) => bounded(async () => calls.slice(start).find(call => call.body?.command?.type === type && call.body.command.sessionId === id && call.result), 'actual command result: ' + type);
  const review = id => bounded(async () => { const response = await nativeRead(id); return response.value?.review?.status === 'ready' && !response.value.busyReason ? response : null; }, 'actual native ready review');
  const openReview = async () => {
    await clickTarget(target('.plan-composer-controls button', 'Review plan'), 'Review plan', 'click', true);
    await wait(visibleReviewExpression, 'actual Plan review dialog');
  };
  const mutation = async (id, action, label) => {
    const start = calls.length; await click('.plan-review-panel button', label);
    const call = await completed('session.plan.mutate', start, id);
    assert(call.path === '/v19/commands' && call.body.commandVersion === 19 && call.body.command.mutation.action === action, 'Plan mutation did not use the exact production v19 command path.');
    assert(call.result.ok && call.result.value?.type === 'session.plan.mutate', 'Actual native Plan mutation failed: ' + JSON.stringify(call.result));
    const receipt = call.result.value.receipt;
    assert(receipt.commandId === call.body.id && receipt.reviewId === call.body.command.reviewId && receipt.reviewRevision === call.body.command.reviewRevision, 'Native decision receipt lost its captured review owner.');
    return call;
  };
  const proveProposal = async name => {
    const session = context.sessions[name], id = session.id;
    const current = await bounded(async () => { const value = (await nativeRead(id)).value; return value?.mode === 'active' && value.canToggle ? value : null; }, 'native startup Plan mode');
    assert(current.ticket.nativeSessionId === id, 'Loaded native Plan identity differs from its session.');
    await replaceText('#prompt', `${marker(name)}\nPrepare a plan using the owned local plan artifact and propose it for review.`);
    const start = calls.length; await wait(`!!document.querySelector('.send-button:not(:disabled)')`, 'actual send enabled'); await click('.send-button');
    const sent = await completed('session.prompt', start, id);
    assert(sent.result.ok && sent.result.admission?.kind === 'user-message', 'Initial Plan prompt lacks actual native user admission.');
    const response = await review(id); await idle(id); await openReview();
    await surface.check('proposal-metrics:' + name);
    const ui = await evaluate(`(() => {const dialog=document.querySelector('.native-plan-dialog[open]'),primary=dialog?.querySelector('.plan-review-primary');if(!dialog||!primary)throw Error('Missing actual Plan dialog or primary button for metrics');const style=getComputedStyle(primary),dialogStyle=getComputedStyle(dialog);return {dialogRect:dialog.getBoundingClientRect().toJSON(),dialogComputed:{width:dialogStyle.width,padding:dialogStyle.padding},primary:{rect:primary.getBoundingClientRect().toJSON(),color:style.color,backgroundColor:style.backgroundColor,appSurface:style.getPropertyValue('--app-surface').trim(),text:style.getPropertyValue('--text').trim()},viewport:{width:innerWidth,height:innerHeight}};})()`);
    writeFileSync(join(output, `proposal-${name}-ui.json`), JSON.stringify(ui, null, 2));
    assert(ui.primary.color !== ui.primary.backgroundColor, 'Actual Plan primary button has identical foreground/background colors: ' + JSON.stringify(ui.primary));
    const rows = journal(session.sessionFile), nativeCalls = rows.flatMap(row => Array.isArray(row.message?.content) ? row.message.content : []);
    for (const path of ['local://plan.md', 'xd://propose']) {
      const call = nativeCalls.find(part => part.type === 'toolCall' && part.name === 'write' && part.arguments?.path === path);
      assert(call, 'Actual native journal lacks write tool call for ' + path);
      assert(rows.some(row => row.message?.role === 'toolResult' && row.message.toolCallId === call.id && row.message.isError !== true), 'Native write tool result failed for ' + path);
    }
    const files = artifacts().filter(file => file.content.includes(marker(name)));
    assert(files.length && files.some(file => file.content === response.value.review.content), 'Real native proposal content is absent from its local artifact.');
    writeFileSync(join(output, `proposal-${name}.json`), JSON.stringify({ response, files, sent, ui }, null, 2));
    return response;
  };
  const confirmedDestination = async call => {
    const value = call.result.value, receipt = value.receipt, session = value.session;
    assert(receipt.transition === 'new-session' && session?.id === receipt.destinationSessionId && session.hostId === connection.hostId, 'Fresh result has no committed native destination identity.');
    await bounded(async () => (await http('/v1/state')).sessions.some(row => row.id === session.id && row.sessionFile === session.sessionFile), 'actual host catalog destination');
    await wait(`(${stateExpression}).sessionId===${JSON.stringify(session.id)}`, 'actual App route followed committed destination');
    return session;
  };
  let passed = false, failure;
  try {
    await wait(`!!document.querySelector('#prompt') && (${stateExpression}).sessionId===${JSON.stringify(context.sourceId)}`, 'production App loaded the fixture route');
    const initialHost = await http('/v1/state'); assert(initialHost.plan?.version === 1 && initialHost.plan.commandVersion === 19, 'Native Plan capability is not advertised by this build.');
    const registered = await awaitOriginalWindowRegistration(window);
    // A direct binary launch can leave the candidate application inactive even
    // when its window is visible. Activate this owned app once during acquisition;
    // later focus loss still fails the shared guard without reacquisition.
    writeFileSync(join(output, 'initial-activation-request.json'), JSON.stringify({ pid: process.pid, windowId: registered.windowId,
      method: 'Electron app.focus({steal:true}) once before shared acquisition', time: new Date().toISOString() }, null, 2));
    app.focus({ steal: true });
    await surface.prepare();
    const acquired = JSON.parse(readFileSync(join(output, 'surface-acquisition.json'), 'utf8'));
    assert(acquired.pid === registered.pid && acquired.windowId === registered.windowId, 'Shared surface guard acquired a different native window after registration.');
    const keepId = context.sessions.keep.id;
    await bounded(async () => (await nativeRead(keepId)).value?.mode === 'active', 'real native startup mode active');
    const initialRequests = providerCount();
    for (const [from, to] of [['active', 'paused'], ['paused', 'off'], ['off', 'active']]) {
      await wait(`!![...document.querySelectorAll('.plan-composer-controls button')].find(n=>n.textContent.trim()===${JSON.stringify('Plan · ' + from)}&&!n.disabled)`, 'native Plan toggle ready');
      const start = calls.length; await click('.plan-composer-controls button', 'Plan · ' + from);
      const call = await completed('session.plan.control', start, keepId);
      assert(call.body.commandVersion === 19 && call.result.ok, 'Actual Plan toggle failed.');
      await bounded(async () => (await nativeRead(keepId)).value?.mode === to, 'native mode ' + to);
    }
    assert(providerCount() === initialRequests, 'Mode-only toggles dispatched a provider prompt.');
    await proveProposal('keep'); await capture('01-native-proposal'); checkpoints.push({ case: 1, passed: true, behavior: 'Actual startup active, pause/off/enter controls, user prompt and native write/propose tool results produce an owned Plan review.' });

    const edited = `# Plan\n\n${marker('keep')}\n\nEDITED_NATIVE_PLAN:${context.nonce}\n\n- Preserve the owning session and report completion.\n`;
    await click('.plan-review-panel button', 'Edit Markdown');
    const editor = `([...document.querySelectorAll('.plan-review-editor diffs-container')].flatMap(n=>[...(n.shadowRoot?.querySelectorAll('[contenteditable="true"]')||[])]).find(n=>n.getClientRects().length))`;
    await wait(`!!${editor}`, 'actual Pierre editable surface'); await clickTarget(editor, 'Pierre Plan Markdown', 'pointerdown');
    await key('A', ['meta']); await insertText(edited);
    await wait(`!![...document.querySelectorAll('.plan-review-panel button')].find(n=>n.textContent==='Save edits'&&!n.disabled)`, 'native plan save enabled');
    const saved = await mutation(keepId, 'edit', 'Save edits');
    assert(saved.body.command.mutation.content === edited && saved.result.value.receipt.artifact === 'written', 'Embedded editor did not submit the actual edited text.');
    await bounded(async () => (await nativeRead(keepId)).value?.review?.content === edited, 'native edited review content');
    assert(artifacts().some(file => file.content === edited), 'Edited Plan text was not written to its actual local artifact.');
    await click('.plan-review-panel button', 'Preview'); await capture('02-edited-native-artifact'); checkpoints.push({ case: 2, passed: true, behavior: 'Pierre keyboard editing, actual v19 save, native file content and refreshed Markdown preview.' });

    await hide(); const keepDraft = `UNSENT_KEEP:${context.nonce}`; await replaceText('#prompt', keepDraft); await openReview();
    const keep = await mutation(keepId, 'approve', 'Approve · keep context');
    assert(keep.result.value.receipt.execution === 'entered' && keep.result.value.receipt.transition === 'unchanged', 'Keep approval did not admit native execution in the original session.');
    await idle(keepId);
    assert(journal(context.sessions.keep.sessionFile).some(row => row.message?.role === 'developer' && row.message.synthetic === true && row.message.attribution === 'agent' && JSON.stringify(row.message.content).includes(context.nonce)), 'No actual native synthetic developer approval message was recorded.');
    assert((await evaluate(stateExpression)).text === keepDraft, 'Keep approval consumed the unsent composer draft.');
    await capture('03-keep-native-admission'); checkpoints.push({ case: 3, passed: true, behavior: 'Keep approval records actual native developer admission, unchanged identity and retained composer draft.' });

    await navigate(context.sessions.fresh.id); await proveProposal('fresh'); await hide(); const freshDraft = `UNSENT_FRESH:${context.nonce}`; await replaceText('#prompt', freshDraft); await openReview();
    const fresh = await mutation(context.sessions.fresh.id, 'approve', 'Approve · new context'), destination = await confirmedDestination(fresh);
    assert(fresh.result.value.receipt.execution === 'entered', 'Fresh approval did not admit its native Plan input.'); await idle(destination.id);
    assert(journal(destination.sessionFile).some(row => row.message?.role === 'developer' && row.message.synthetic === true && row.message.attribution === 'agent' && JSON.stringify(row.message.content).includes(marker('fresh'))), 'Fresh native destination lacks its approved developer message.');
    const stateAfterFresh = await http('/v1/state'); assert(stateAfterFresh.drafts.some(draft => draft.id === 'session:' + context.sessions.fresh.id && draft.text === freshDraft), 'Fresh navigation consumed the original composer draft.');
    writeFileSync(join(output, 'fresh-destination.json'), JSON.stringify({ fresh, destination }, null, 2)); await capture('04-fresh-catalog-route'); checkpoints.push({ case: 4, passed: true, behavior: 'Fresh approval creates and binds the real new native session, records approval admission, follows actual catalog route and retains the original unsent draft.' });

    await navigate(context.sessions.refine.id); await proveProposal('refine');
    const feedback = `PLAN_REFINE:refine:${context.nonce}`; await replaceText('.plan-review-refinement textarea', feedback);
    const refined = await mutation(context.sessions.refine.id, 'refine', 'Refine plan');
    assert(refined.result.value.receipt.execution === 'entered', 'Refinement input was not admitted.');
    await review(context.sessions.refine.id); await idle(context.sessions.refine.id);
    assert(journal(context.sessions.refine.sessionFile).some(row => row.message?.role === 'user' && row.message.synthetic !== true && row.message.attribution === 'user' && JSON.stringify(row.message.content).includes(feedback)), 'Refinement was not recorded as the actual native user message.');
    assert((await nativeRead(context.sessions.refine.id)).value.review.content.includes('Updated after actual native refinement input.'), 'Refinement did not produce its real updated Plan artifact.');
    await openReview(); await capture('05-native-refinement'); checkpoints.push({ case: 5, passed: true, behavior: 'Actual user refinement admission leads to native rewritten artifact and new proposal.' });

    await navigate(context.sessions.save.id); await proveProposal('save');
    const destinationPath = join(context.projectPath, `saved-plan-${context.nonce}.md`), originalContent = (await nativeRead(context.sessions.save.id)).value.review.content;
    await click('.plan-review-save summary'); await replaceText('.plan-review-save input', destinationPath);
    const beforeSave = providerCount(), save = await mutation(context.sessions.save.id, 'save', 'Save plan and start new session'), savedSession = await confirmedDestination(save);
    assert(save.result.value.receipt.artifact === 'written' && save.result.value.receipt.savedDestination === destinationPath && save.result.value.receipt.execution === 'not-requested', 'Native save receipt invented or omitted its real effects.');
    assert(readFileSync(ownedFile(destinationPath), 'utf8') === originalContent, 'Native Save wrote different Plan content.');
    await idle(savedSession.id); assert(providerCount() === beforeSave, 'Save-only transition executed a provider prompt.');
    copyFileSync(destinationPath, join(output, 'saved-native-plan.md')); writeFileSync(join(output, 'save-destination.json'), JSON.stringify({ save, savedSession }, null, 2));
    await capture('06-save-new-session-no-execution'); checkpoints.push({ case: 6, passed: true, behavior: 'Native Save writes the requested owning-host file and follows its committed new session without execution.' });
    assert(!existsSync(join(fixture, 'provider/failures.jsonl')), 'Controlled provider observed an unexpected native request.');
    passed = true;
  } catch (cause) { failure = String(cause); await capture('failure').catch(() => {}); }
  finally {
    try {
      mkdirSync(join(output, 'provider'), { recursive: true });
      for (const file of readdirSync(join(fixture, 'provider'))) copyFileSync(join(fixture, 'provider', file), join(output, 'provider', file));
      writeFileSync(join(output, 'observed-native-artifacts.json'), JSON.stringify(artifacts(), null, 2));
      const state = await http('/v1/state'); writeFileSync(join(output, 'final-host-state.json'), JSON.stringify(state, null, 2));
      for (const session of state.sessions) if (existsSync(session.sessionFile)) copyFileSync(ownedFile(session.sessionFile), join(output, `native-${session.id}.jsonl`));
    } catch (cause) { passed = false; errors.push('Evidence capture failed: ' + String(cause)); }
    writeFileSync(join(output, 'result.json'), JSON.stringify({ passed, failure, checkpoints, calls, inputs, captures, errors, targetFailures, conditions,
      scope: 'Six production App/host/worker/native happy paths with auth-free controlled loopback HTTP. Real write local://plan.md and xd://propose tools, native artifacts/journal and v19 commands. Electron-injected pointer/key/text input, not all-OS or human-operated physical acceptance. No vendor/provider, reference, installed-build or independent-review claim.',
      unimplemented: ['Compact approval', 'Empty-feedback Continue planning', 'Unknown/transport-loss and no-entry explicit execution retry', 'Multi-model execution role selection', 'Native command aliases/shadow collisions', 'Physical cross-device acceptance'] }, null, 2));
    for (const owned of BrowserWindow.getAllWindows()) owned.destroy(); app.exit(passed ? 0 : 1);
  }
}
require(join(repository, 'apps/desktop/dist/main.cjs'));
