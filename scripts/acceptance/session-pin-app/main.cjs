const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const [output, root, repository, phase] = process.argv.slice(2);
if (process.env.HOME !== root || process.env.AGENT_DESKTOP_PROFILE_DIR !== join(root, 'profile')) throw new Error('Private session-pin App profile required.');
const { connection, context, generation } = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8'));
const originalFetch = globalThis.fetch, calls = [], checkpoints = [], captures = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function redact(text) {
  return text.replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.session-pin-not-a-signature/g, '[REDACTED_SYNTHETIC_ACCESS]')
    .replace(/session-pin-refresh[^\s"'\\]*/g, '[REDACTED_SYNTHETIC_REFRESH]')
    .replace(/Bearer\s+[^\s"'\\]+/gi, 'Bearer [REDACTED]')
    .split(connection.token).join('[REDACTED_LOCAL_TRANSPORT]');
}
function errorEvidence(error, seen = new Set()) {
  if (!(error instanceof Error)) return { name: 'NonError', message: redact(String(error)) };
  if (seen.has(error)) return { name: error.name, message: '[circular error]' };
  seen.add(error);
  return { name: redact(error.name), message: redact(error.message), stack: error.stack && redact(error.stack),
    ...(error.cause === undefined ? {} : { cause: errorEvidence(error.cause, seen) }),
    ...(error instanceof AggregateError ? { errors: [...error.errors].map(value => errorEvidence(value, seen)) } : {}) };
}
function guardedURL(input) {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  assert(url.protocol === 'http:' && url.hostname === '127.0.0.1', 'Non-loopback App fetch forbidden.'); return url;
}
// Observe real main-process transport, never replace the preload/API/response.
// Headers and credentials are deliberately absent from the evidence projection.
globalThis.fetch = async (input, init) => {
  const url = guardedURL(input), body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  const command = body?.command;
  const call = command?.type === 'session.prompt' ? { path: url.pathname, id: body.id, command, at: Date.now() } : undefined;
  if (call) calls.push(call);
  const response = await originalFetch(input, { ...init, redirect: 'error' });
  if (call) call.result = await response.clone().json();
  return response;
};
async function http(path) {
  const response = await originalFetch(guardedURL(connection.origin + path), { headers: { Authorization: `Bearer ${connection.token}` }, redirect: 'error' });
  assert(response.ok, 'Native evidence read failed: ' + path); return response.json();
}
async function bounded(operation, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await operation(); if (value) return value; await delay(50); }
  throw new Error('Timed out: ' + label);
}
const accounts = id => http(`/v1/sessions/${encodeURIComponent(id)}/accounts`);
const requests = () => existsSync(context.requestsFile) ? readFileSync(context.requestsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
let owningWindow;
app.on('browser-window-created', (_event, window) => {
  if (owningWindow) return; owningWindow = window;
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    try { guardedURL(details.url); callback({ cancel: false }); } catch { callback({ cancel: true }); }
  });
  window.webContents.once('did-finish-load', () => {
    if (phase !== 'manual') void exercise(window);
    else writeFileSync(join(output, 'manual-ready.json'), JSON.stringify({ pid: process.pid, hostPid: connection.pid, hostId: connection.hostId,
      sessionId: context.sessions.original.id, generation, userData: app.getPath('userData'), debugging: join(root, 'profile/DevToolsActivePort') }), { mode: 0o600 });
  });
});
async function exercise(window) {
  const evaluate = expression => window.webContents.executeJavaScript(expression, true);
  const wait = (expression, label) => bounded(() => evaluate(expression), label);
  const state = `({sessionId:document.querySelector('.session-row[aria-current="page"]')?.getAttribute('data-session-id'),draft:document.querySelector('#prompt')?.textContent,body:document.body.innerText})`;
  const target = (selector, label) => `([...document.querySelectorAll(${JSON.stringify(selector)})].find(n=>n.getClientRects().length&&(${label === undefined ? 'true' : `n.textContent.trim()===${JSON.stringify(label)}||n.getAttribute('aria-label')===${JSON.stringify(label)}`})))`;
  async function clickExpression(expression) {
    const point = await evaluate(`(()=>{const n=${expression};if(!n||n.disabled)throw Error('Missing enabled actual App target');n.scrollIntoView({block:'nearest'});const r=n.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);if(!hit||!n.contains(hit))throw Error('Actual App target is obscured');return{x,y};})()`);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) window.webContents.sendInputEvent({ type, ...point, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) });
    await delay(100);
  }
  const click = (selector, label) => clickExpression(target(selector, label));
  async function key(keyCode, modifiers = []) {
    for (const type of ['keyDown', 'keyUp']) window.webContents.sendInputEvent({ type, keyCode, modifiers }); await delay(50);
  }
  async function draft(text) { await click('#prompt'); await key('A', [process.platform === 'darwin' ? 'meta' : 'control']); await window.webContents.insertText(text); await wait(`(${state}).draft===${JSON.stringify(text)}`, 'actual composer text'); }
  async function capture(name) {
    const file = `${phase}-${name}.png`, png = (await window.webContents.capturePage()).toPNG();
    writeFileSync(join(output, file), png);
    captures.push({ file, capturedAt: new Date().toISOString(), state: await evaluate(state),
      bounds: window.getBounds(), contentBounds: window.getContentBounds(), minimumSize: window.getMinimumSize(),
      zoom: { factor: window.webContents.getZoomFactor(), level: window.webContents.getZoomLevel() },
      viewport: await evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,visualScale:visualViewport?.scale,cssZoom:getComputedStyle(document.documentElement).zoom})'),
      pngPixels: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } });
  }
  async function navigate(id) { await click(`.session-row[data-session-id="${id}"]`); await wait(`(${state}).sessionId===${JSON.stringify(id)}`, 'session route'); }
  async function send(text, id, native = true) {
    const start = calls.length; await draft(text); await wait(`!!document.querySelector('.send-button:not(:disabled)')`, 'composer send enabled'); await click('.send-button');
    const call = await bounded(() => calls.slice(start).find(row => row.command.sessionId === id && row.command.text === text && row.result), 'production prompt receipt');
    assert(call.result.ok, 'Native prompt failed: ' + JSON.stringify(call.result));
    assert(call.result.admission?.kind === (native ? 'native-command' : 'user-message'), 'Prompt crossed the native command/user boundary.');
    await wait(`!(${state}).draft`, 'accepted draft cleared');
    if (native) {
      assert(typeof call.result.admission.output === 'string' && call.result.admission.output.length > 0, 'Native command has no factual output.');
      const line = call.result.admission.output.split('\n').find(line => line.trim());
      await wait(`(${state}).body.includes(${JSON.stringify(line)})`, 'native output rendered');
    }
    return call;
  }
  async function showAccounts(id, expected) {
    await click('[aria-label="Model and reasoning effort"]'); await click('[role="menuitem"]', 'Session account');
    await wait(`!!document.querySelector('.session-account-choices button:not(:disabled)')`, 'account view ready');
    await click('.session-account-choices button', 'Refresh accounts');
    await wait(`!document.querySelector('.session-account-choices [role="alert"]')&&!![...document.querySelectorAll('.session-account-choices button:not(:disabled)')].find(n=>n.textContent==='Refresh accounts')`, 'account refresh completed');
    await wait(`!![...document.querySelectorAll('.session-account-choice[aria-pressed="true"]')].find(n=>n.textContent.includes(${JSON.stringify(expected)}))`, 'refreshed native account visible');
    const value = await accounts(id); assert(value.sessionId === id && value.selection.model.provider === context.model.provider && value.selection.model.id === context.model.id, 'Account view crossed session/model ownership.');
    await capture('accounts-' + expected.replace(/[^a-z0-9]+/gi, '-')); await key('ESCAPE'); return value;
  }
  const active = value => value.accounts.find(account => account.active)?.accountId;
  const original = context.sessions.original, independent = context.sessions.independent;
  let passed = false, failure;
  const evidenceErrors = [];
  try {
    await wait(`!!window.agentDesktop&&!!document.querySelector('#prompt')&&(${state}).sessionId===${JSON.stringify(original.id)}`, 'real production App/preload route');
    assert(app.getPath('userData') === join(root, 'profile'), 'App userData escaped fixture.');
    if (process.env.SESSION_PIN_PAUSE_FOR_BROWSER === '1') {
      const resumeFile = join(root, 'browser-resume');
      writeFileSync(join(output, 'browser-pause.json'), JSON.stringify({ pid: process.pid, hostId: connection.hostId,
        sessionId: original.id, phase, resumeFile, debugging: join(root, 'profile/DevToolsActivePort'), deadline: Date.now() + 300_000 }), { mode: 0o600 });
      await bounded(() => existsSync(resumeFile), 'operator released read-only browser observation', 300_000);
      checkpoints.push({ case: 'same-owned-Electron-browser-observation-released', pid: process.pid });
    }
    if (phase === 'cold') {
      assert(generation === 1, 'Cold phase did not restart the host and drain native workers.');
      const restored = await accounts(original.id);
      assert(active(restored) === 'pin-beta', 'Expected pin-beta was not active on the cold-reopened original session.');
      const hostState = await http('/v1/state');
      assert(hostState.sessions.find(row => row.id === original.id)?.sessionFile === original.sessionFile, 'Cold reopen silently changed session identity.');
      await showAccounts(original.id, restored.accounts.find(account => account.active).label ?? 'duplicate@fixture.invalid');
      const before = requests().length;
      await send('SESSION_PIN_APP_COLD_PAYLOAD', original.id, false);
      await bounded(() => requests().length > before, 'cold loopback provider request');
      await bounded(async () => (await http('/v1/state')).sessions.some(row => row.id === original.id && row.status === 'idle'), 'cold assistant finished');
      const request = requests().at(-1);
      assert(request.accountId === 'pin-beta' && JSON.stringify(request.input).includes('SESSION_PIN_APP_COLD_PAYLOAD'), 'Cold assistant used wrong account or payload.');
      checkpoints.push({ case: 'cold-original-session-after-successful-turn', sessionId: original.id, sessionFile: original.sessionFile, restored, request });
      await wait(`!document.querySelector('.stop-button')&&(${state}).body.includes(${JSON.stringify(`Controlled session pin response ${request.sequence}.`)})`, 'cold assistant rendered and idle');
      await capture('restored');
    } else {
      const startRequests = requests().length;
      await send('/session pin', original.id);
      const initial = await accounts(original.id), otherBefore = await accounts(independent.id);
      await send('/session pin 1', original.id);
      assert(active(await accounts(original.id)) === 'pin-alpha', 'Native numeric selector picked wrong account.');
      await send('/session pin active', original.id);
      await send('/session pin   South Research Team', original.id);
      let selected = await accounts(original.id);
      assert(active(selected) === 'pin-beta', 'Native multiword selector lost its remainder.');
      await showAccounts(original.id, selected.accounts.find(account => account.active).label ?? 'duplicate@fixture.invalid');
      await send('/session pin PIN-BETA', original.id);
      const duplicate = await send('/session pin duplicate@fixture.invalid', original.id);
      assert(/match/i.test(duplicate.result.admission.output) && active(await accounts(original.id)) === 'pin-beta', 'Ambiguous identity mutated selection.');
      const unknown = await send('/session pin no-such-fixture-account', original.id);
      assert(/no |not |unknown/i.test(unknown.result.admission.output) && active(await accounts(original.id)) === 'pin-beta', 'Unknown native selector mutated selection.');
      // Intentional stale guard is submitted through the genuine production preload.
      // This is bridge-contract proof, not a fabricated/stale DOM click.
      const stale = await evaluate(`window.agentDesktop.accountAction(${JSON.stringify({ type: 'session.pin', sessionId: original.id, credentialId: initial.accounts[0].credentialId, expectedSelection: initial.selection })},${JSON.stringify(connection.hostId)}).then(()=>({rejected:false}),error=>({rejected:true,message:String(error)}))`);
      assert(stale.rejected && active(await accounts(original.id)) === 'pin-beta', 'Stale native account guard was accepted or changed the choice.');
      const otherAfter = await accounts(independent.id);
      assert(active(otherAfter) === active(otherBefore), 'Original command changed the independent session account.');
      await navigate(independent.id); await send('/session pin pin-alpha', independent.id);
      assert(active(await accounts(original.id)) === 'pin-beta', 'Independent command changed original account.');
      await navigate(original.id);
      const rejectionStart = calls.length; await draft('/session delete'); await click('.send-button');
      const refusal = await bounded(() => calls.slice(rejectionStart).find(row => row.command.text === '/session delete' && row.result), 'pending deletion receipt');
      assert(!refusal.result.ok, 'Pending identity-changing command unexpectedly ran.');
      await wait(`(${state}).draft==='/session delete'`, 'refused draft retained');
      await capture('pending-delete-draft-retained');
      assert(requests().length === startRequests, 'Native commands unexpectedly called a provider.');
      checkpoints.push({ case: 'native-grammar-live-selection-and-owner-refusals', initial, selected, otherBefore, otherAfter, stale, refusal: refusal.result });
      const beforeTurn = readFileSync(original.sessionFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert(!beforeTurn.some(row => row.type === 'credential_pin'), 'Command-only selection was unexpectedly persisted as a credential pin.');
      // A draft model is deliberately not sent: account controls still belong
      // to the current native session model, not the pending composer override.
      await click('[aria-label="Model and reasoning effort"]'); await click('[aria-label="Select model"]');
      const alternate = await evaluate(`([...document.querySelectorAll('button[data-model-index]:not(:disabled)')].find(n=>!n.textContent.includes(${JSON.stringify(context.model.id)})&&!/Follow session|Default/.test(n.textContent)))?.getAttribute('data-model-index')`);
      assert(alternate !== undefined && alternate !== null, 'No alternate draft model available for ownership acceptance.');
      await click(`button[data-model-index="${alternate}"]`);
      await click('[aria-label="Model and reasoning effort"]'); await click('[role="menuitem"]', 'Session account');
      await wait(`document.body.innerText.includes('These accounts belong to the current session model.')`, 'draft/current model ownership explanation');
      const draftOwned = await accounts(original.id);
      assert(draftOwned.selection.model.id === context.model.id && active(draftOwned) === 'pin-beta', 'Draft model changed the native account owner.');
      await capture('draft-model-owner'); await key('ESCAPE');
      await click('[aria-label="Model and reasoning effort"]'); await click('[aria-label="Reset composer selections"]');
      checkpoints.push({ case: 'draft-model-does-not-own-native-accounts', draftOwned });
      const before = requests().length;
      await send('SESSION_PIN_APP_LIVE_PAYLOAD', original.id, false);
      await bounded(() => requests().length > before, 'real loopback assistant request');
      await bounded(async () => (await http('/v1/state')).sessions.some(row => row.id === original.id && row.status === 'idle'), 'successful assistant turn finished');
      const request = requests().at(-1);
      assert(request.accountId === 'pin-beta' && JSON.stringify(request.input).includes('SESSION_PIN_APP_LIVE_PAYLOAD'), 'Live assistant used wrong credential or payload.');
      const journal = readFileSync(original.sessionFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      const served = selected.accounts.find(account => account.accountId === 'pin-beta');
      const hash = createHash('sha256').update([context.model.provider, served.accountId ?? '', served.email ?? '', served.orgId ?? '', served.projectId ?? ''].join('\0')).digest('hex');
      assert(journal.some(row => row.type === 'credential_pin' && row.provider === context.model.provider && row.hash === hash), 'Successful assistant turn did not journal its serving credential pin.');
      assert(journal.some(row => row.message?.role === 'assistant' && !['error', 'aborted'].includes(row.message.stopReason)), 'No successful native assistant output was recorded.');
      await wait(`!document.querySelector('.stop-button')&&(${state}).body.includes(${JSON.stringify(`Controlled session pin response ${request.sequence}.`)})`, 'live assistant rendered and idle');
      checkpoints.push({ case: 'successful-loopback-turn', request }); await capture('successful-turn');
    }
    passed = true;
  } catch (cause) {
    failure = errorEvidence(cause);
    try { await capture('failure'); } catch (error) { evidenceErrors.push({ stage: 'failure-capture', error: errorEvidence(error) }); }
  } finally {
    try {
      writeFileSync(join(output, `${phase}-result.json`), JSON.stringify({ passed, failure, phase, generation, checkpoints, calls, captures, evidenceErrors,
        scope: 'Production App, preload, host and worker; Electron-injected input and capturePage, not physical OS input. Stale guard uses real preload directly. Explicit account refresh/reopen only. No command-only journal pin; successful-turn journal recording plus cold selection with auth cache intact. Cold selection does not isolate journal restoration from cached auth stickiness.' }, null, 2), { mode: 0o600 });
    } catch (error) { passed = false; evidenceErrors.push({ stage: 'result-write', error: errorEvidence(error) }); }
    for (const owned of BrowserWindow.getAllWindows()) {
      try { owned.destroy(); } catch (error) { passed = false; evidenceErrors.push({ stage: 'window-drain', error: errorEvidence(error) }); }
    }
    if (failure || evidenceErrors.length) console.error(JSON.stringify({ failure, evidenceErrors }));
    app.exit(passed ? 0 : 1);
  }
}
require(join(repository, 'apps/desktop/dist/main.cjs'));
