const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const out = process.argv[2];
app.setPath('userData', path.join(out, 'profile'));
const base = { source: 'builtin', disabledInSettings: false, loginSupported: true, visibleInNativeLoginList: true, storesCredentialsAs: 'fixture-native', pasteCodeFlow: true, apiKeyStorageSupported: true, transportMayAuthenticateWithoutKey: false, configured: true, storedCredentialCount: 0, storedApiKeyConfigured: false, disabledCredentialCount: 0, modelCount: 1 };
const providers = [{ ...base, id: 'fixture-native', name: 'Fixture native provider', available: true }, { ...base, id: 'native-unavailable', name: 'Unavailable native provider', available: false, configured: false }];
const states = new Map(['fixture-host', 'other-host'].map(host => [host, { accounts: [], logins: [], active: false }]));
const calls = [], opened = [], checkpoints = [], consoleErrors = [];
let failRefresh = false, failLogin = false, sequence = 0, holdNext = false, held;
const selection = state => ({ sessionId: 'session', providerId: 'fixture-native', selection: { model: { provider: 'fixture-native', id: 'fixture-model' }, revision: 'fixture-selection' }, accounts: state.accounts.map(item => ({ ...item, active: state.active })) });
async function respond(method, args) {
  const host = method === 'getAccounts' || method === 'getSessionAccounts' || method === 'accountAction' ? args[1] : args[0];
  calls.push({ method, host, action: method === 'accountAction' ? args[0].type : undefined });
  if (method === 'openExternal') { opened.push(args[0]); return; }
  const state = states.get(host); if (!state) throw Error('Unknown fixture host');
  if (method === 'getProviders') { if (failRefresh) throw Error('fixture refresh failure'); return { credentialLocation: { mode: 'local' }, providers, sessionSelectionConnected: true, extensionProviderCoverage: 'registered-in-this-process-only' }; }
  if (method === 'getAccounts') return structuredClone(state.accounts);
  if (method === 'getLogins') return structuredClone(state.logins);
  if (method === 'getSessionAccounts') return selection(state);
  if (method !== 'accountAction') throw Error('Unexpected fixture method '+method);
  const action = args[0]; let result;
  if (action.providerId === 'native-unavailable') throw Error('Unavailable action reached provider boundary');
  if (action.type === 'login.start') {
    if (failLogin) throw Error('fixture login failure');
    const login = { loginId: `login-${++sequence}`, providerId: 'fixture-native', status: 'running', startedAt: sequence, updatedAt: sequence, cancellationRequested: false, auth: { url: 'https://fixture.invalid/login', callbackOnOwningHost: true }, prompts: [{ requestId: 'code', kind: 'manual-code', message: 'Paste code', allowEmpty: false, sensitive: true }] };
    state.logins = [login]; result = { login };
  } else if (action.type === 'login.respond') {
    if (action.response.value !== 'fixture-code') throw Error('Incorrect fixture response');
    const login = { ...state.logins[0], status: 'succeeded', prompts: [], identity: { type: 'oauth', email: 'fixture@example.invalid' } };
    state.logins = [login]; state.accounts = [{ credentialId: 1, providerId: 'fixture-native', type: 'oauth', disabled: false, email: 'fixture@example.invalid' }]; result = { login };
  } else if (action.type === 'login.cancel') { const login = { ...state.logins[0], status: 'cancelled', prompts: [] }; state.logins = [login]; result = { login }; }
  else if (action.type === 'session.pin') { state.active = true; result = { selection: selection(state) }; }
  else if (action.type === 'session.release') { state.active = false; result = { selection: selection(state) }; }
  else if (action.type === 'credential.remove') { state.accounts = []; result = {}; }
  else throw Error('Unexpected fixture action '+action.type);
  if (holdNext) { holdNext = false; return await new Promise(resolve => { held = () => { held = undefined; resolve(result); }; }); }
  return result;
}
app.whenReady().then(async () => {
  let win; let exit = 1;
  ipcMain.handle('accounts-fixture', (_event, method, args) => respond(method, args));
  try {
    win = new BrowserWindow({ show: false, width: 1280, height: 1000, webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(out, 'preload.cjs') } });
    win.webContents.on('console-message', event => { if (event.level === 'error') consoleErrors.push(event.message); });
    const run = expression => win.webContents.executeJavaScript(expression, true);
    const wait = async expression => { for (let i = 0; i < 200; i++) { if (await run(expression)) return; await new Promise(resolve => setTimeout(resolve, 15)); } throw Error('Not settled: '+expression+'\n'+await run('document.body.innerText')); };
    const button = text => `[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)})`;
    const click = async (text, selector) => {
      const expression = selector ? `document.querySelector(${JSON.stringify(selector)})` : button(text);
      await wait(`!!(${expression})&&!(${expression}).disabled`);
      const rect = await run(`(()=>{const node=${expression};node.scrollIntoView({block:'center'});return node.getBoundingClientRect().toJSON()})()`);
      for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: Math.round(rect.x+Math.min(15,rect.width/2)), y: Math.round(rect.y+rect.height/2), button: 'left', clickCount: 1 });
    };
    const text = value => `document.body.innerText.includes(${JSON.stringify(value)})`;
    const check = (value, message) => { if (!value) throw Error(message); };
    const checkpoint = async name => { const body = await run('document.body.innerText'); fs.writeFileSync(path.join(out,name+'.txt'),body); fs.writeFileSync(path.join(out,name+'.png'),(await win.webContents.capturePage()).toPNG()); checkpoints.push(name); };
    const idle = async () => { await wait(`!document.body.innerText.includes('Refreshing…')`); await new Promise(resolve => setTimeout(resolve,50)); };
    await win.loadFile(process.argv[3]); win.webContents.focus();
    await wait(text('Fixture native provider')); await idle();
    await click(null, '.provider-row:nth-child(2)'); await wait(text('Native sign-in is unavailable'));
    const actionCount = () => calls.filter(call => call.method === 'accountAction').length;
    const unavailableCount = actionCount();
    check(await run(`${button('Sign-in unavailable')}.disabled`), 'Unavailable login must be disabled');
    await checkpoint('01-unavailable'); check(actionCount() === unavailableCount, 'Unavailable control dispatched');
    await click(null, '.provider-row:nth-child(1)'); await wait(text('Connect an account'));
    await click(null, '.provider-advanced summary'); await wait(`document.querySelector('.provider-advanced').open`); await checkpoint('02-provider-details');
    await click('Sign in'); await wait(text('Paste code')); await idle();
    await click('Open sign-in page'); await wait('true'); check(opened[0] === 'https://fixture.invalid/login','Wrong sign-in URL');
    await run(`document.querySelector('#login-code').focus()`); await win.webContents.insertText('fixture-code');
    await click('Continue'); await wait(text('Account connected')); await wait(text('fixture@example.invalid')); await idle();
    await click(null, '.session-account-choice'); await wait(text('Used by this session')); await idle();
    await click('Release for next native selection'); await wait(`!!document.querySelector('.session-account-choice[aria-pressed="false"]')`); await idle();
    await checkpoint('03-completed-selection');
    await click('Remove'); await wait(text('Remove this saved credential')); const beforeCancel = actionCount(); await click('Cancel');
    await wait(`!${text('Remove this saved credential')}`); check(actionCount() === beforeCancel,'Removal cancel dispatched');
    await click('Remove'); await click('Remove credential'); await wait(text('No saved account entries')); await idle(); await checkpoint('04-removal');
    await click('Sign in'); await wait(text('Paste code')); await idle(); await click('Cancel sign-in'); await wait(text('Sign-in cancelled')); await idle();
    failLogin = true; await click('Sign in'); await wait(text('fixture login failure')); failLogin = false; await checkpoint('05-cancel-error');
    failRefresh = true; await click('Refresh'); await wait(text('fixture refresh failure')); await idle(); failRefresh = false; await click('Refresh'); await wait(`!${text('fixture refresh failure')}`); await idle();
    await checkpoint('06-refresh-retry');
    // Hold a real IPC action reply across a committed connection loss. The backend
    // may finish; the old view must not publish its result or call onChanged.
    holdNext = true; await click('Sign in'); while (!held) await new Promise(resolve => setTimeout(resolve,10));
    const beforeLoss = await run('document.querySelector("#changes").textContent');
    await click(null,'#connection'); await wait(text('disconnected')); held(); await idle();
    check(await run('document.querySelector("#changes").textContent') === beforeLoss,'Stale offline action invoked onChanged');
    check(!await run(text('Paste code')),'Stale offline login was published'); await checkpoint('07-offline-suppression');
    await click(null,'#connection'); await wait(`!${text('disconnected')}`); await idle();
    if (await run(`!!(${button('Cancel sign-in')})`)) { await click('Cancel sign-in'); await wait(text('Sign-in cancelled')); await idle(); }
    holdNext = true; await click('Sign in'); while (!held) await new Promise(resolve => setTimeout(resolve,10));
    const beforeOwner = await run('document.querySelector("#changes").textContent');
    await click(null,'#owner'); await wait(text('Provider credentials on other-host')); await idle(); held(); await idle();
    check(await run('document.querySelector("#changes").textContent') === beforeOwner,'Stale previous-host action invoked onChanged');
    check(!await run(text('Paste code')),'Previous-host login leaked'); await checkpoint('08-host-suppression');
    await run(`document.querySelector('[aria-label="Close settings"]').focus()`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'}); win.webContents.sendInputEvent({type:'char',keyCode:'\r'}); win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
    await wait(`!document.querySelector('[aria-label="Accounts settings"]')`);
    await click('Open Accounts'); await wait(text('Provider credentials on other-host')); await checkpoint('09-keyboard-close-reopen');
    check(consoleErrors.length === 0,'Renderer errors: '+consoleErrors.join('\n'));
    exit = 0;
    fs.writeFileSync(path.join(out,'result.json'), JSON.stringify({passed:true,checkpoints,calls,opened,consoleErrors,limits:'Production AccountsSettings in disposable Electron; deterministic IPC provider responses. No real OAuth, personal credentials, live host or whole-app acceptance.'},null,2));
  } catch (error) { fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:false,error:String(error),checkpoints,calls,opened,consoleErrors},null,2)); }
  finally { if (win && !win.isDestroyed()) win.destroy(); ipcMain.removeHandler('accounts-fixture'); app.exit(exit); }
});
