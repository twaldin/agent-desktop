const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const output = process.argv[2];
const launch = JSON.parse(fs.readFileSync(path.join(output, "launch.json"), "utf8"));
app.setPath("userData", launch.profile);
app.commandLine.appendSwitch("disable-renderer-backgrounding");

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 1000, show: false, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const js = source => win.webContents.executeJavaScript(source);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const checks = [], captures = [], consoleMessages = [], rendererGone = [];
  win.webContents.on("console-message", (...args) => consoleMessages.push(args.slice(1).map(String).join(" | ")));
  win.webContents.on("render-process-gone", (_event, details) => rendererGone.push(details));
  const wait = async source => { for (let i = 0; i < 1000; i++) { if (await js(source)) return; await sleep(25); } throw new Error("Condition failed: " + source); };
  const chord = async (keyCode, modifiers = []) => { for (const type of ["keyDown", "keyUp"]) win.webContents.sendInputEvent({ type, keyCode, modifiers }); await sleep(80); };
  const click = async selector => { const point = await js(`window.target(${JSON.stringify(selector)})`); for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, ...(type === "mouseMove" ? {} : { button: "left", clickCount: 1 }), ...point }); await sleep(100); };
  const replace = async text => { const focused = await js("(()=>{const editor=window.editor();if(!editor)return false;editor.focus();return editor.getRootNode().activeElement===editor})()"); if (!focused) throw new Error("Source editor focus failed"); await chord("a", ["meta"]); await win.webContents.insertText(text); await sleep(100); };
  const hostFile = () => js("window.request('/test/file',{})");
  const hostState = () => js("window.request('/test/state',{})");
  const capture = async name => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG());
    fs.writeFileSync(path.join(output, `${name}.ax.json`), JSON.stringify(await win.webContents.debugger.sendCommand("Accessibility.getFullAXTree"), null, 2));
    captures.push({ name, raster: image.getSize(), contentBounds: win.getContentBounds(), windowBounds: win.getBounds(), rendererZoomFactor: win.webContents.getZoomFactor(), state: await js("window.state()") });
  };
  let step = "load";
  try {
    win.webContents.debugger.attach("1.3");
    await win.loadFile(path.join(output, "web/index.html"), { query: { endpoint: launch.endpoint, target: JSON.stringify(launch.target), hostId: launch.hostId, filePath: launch.filePath, fileName: launch.fileName } });
    win.webContents.focus();
    await wait("typeof window.state==='function'&&document.querySelector('.composer-inline-file')");
    let state = await js("window.state()");
    const beforePointer = await hostState();
    if (beforePointer.calls.some(call => call.query === "file.read") || state.ui.panelLabel !== undefined || state.standalonePath !== undefined) throw new Error("Standalone panel or read existed before composer activation: " + JSON.stringify({ state, beforePointer }));
    if (state.viewport.width !== 1440 || state.viewport.height !== 1000 || state.viewport.dpr !== 2 || win.webContents.getZoomFactor() !== 1) throw new Error("Capture geometry differs: " + JSON.stringify(state.viewport));
    await capture("00-composer-only");

    step = "composer-pointer";
    await click(".composer-inline-file");
    await wait("window.state().activations.length===1&&window.state().restored&&window.state().text!==undefined&&window.editor()");
    state = await js("window.state()");
    if (state.activations[0].opened.absolutePath !== launch.filePath || JSON.stringify(state.mountedTarget) !== JSON.stringify(launch.target) || state.standalonePath !== launch.filePath || state.opened !== undefined || state.text !== launch.initialText) throw new Error("Composer pointer did not mount the exact standalone target: " + JSON.stringify(state));
    if (state.ui.panelLabel !== "File" || state.ui.directoryBrowser || state.ui.fileTree || state.ui.workspaceTabs || state.ui.review || /(?:^|\n)(?:Changes|Worktrees)(?:\n|$)/.test(state.body)) throw new Error("Standalone surface exposed project, file-tree, or Git UI: " + JSON.stringify(state.ui));
    await capture("01-pointer-opened-standalone");
    checks.push("No file read or panel exists initially; a real Electron pointer click on production ComposerEditor resolves through wholeFileOpenTarget, creates the exact absolute WorkspaceTarget, and mounts production WorkspaceState and WorkspacePanel without directory, file-tree, Changes, Worktrees, or Git UI");

    step = "cached-unsaved-restore";
    await js("window.connection(false)");
    await wait("!window.state().connected");
    const edited = launch.initialText + "export const cachedUnsaved = true;\n";
    await replace(edited);
    await wait(`window.state().dirty&&window.state().text===${JSON.stringify(edited)}`);
    await sleep(250);
    if ((await hostFile()).text !== launch.initialText) throw new Error("Offline edit reached host bytes");
    const callsBeforeReload = (await hostState()).calls.length;
    const reloaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
    win.reload();
    await reloaded;
    await wait(`window.state().restored&&window.state().dirty&&window.state().text===${JSON.stringify(edited)}&&window.editor()`);
    state = await js("window.state()");
    const afterDisconnectedReload = await hostState();
    if (state.connected || JSON.stringify(state.mountedTarget) !== JSON.stringify(launch.target) || !state.body.includes("Offline · displaying cached files and status.") || Object.values(state.errors).some(value => typeof value === "string" && value.length) || afterDisconnectedReload.calls.length !== callsBeforeReload) throw new Error("Reload did not preserve a query-free cached offline surface: " + JSON.stringify({ state, callsBeforeReload, afterDisconnectedReload }));
    await capture("02-renderer-reload-cached-unsaved");
    checks.push("A real Chromium renderer reload restores the offline banner and disconnected standalone routing from fixture storage plus the exact dirty buffer from production IndexedDB, with no file-read error, host-byte change, or new workspace query");

    step = "save";
    await js("window.connection(true)");
    await wait("window.state().connected&&window.editor()");
    await js("window.editor().focus()");
    await chord("s", ["meta"]);
    await wait(`window.request('/test/file',{}).then(value=>value.text===${JSON.stringify(edited)}&&!window.state().dirty&&!window.state().pending&&!window.state().busy)`);
    checks.push("Command-S saves the restored buffer through the production WorkspaceState mutation path to the authenticated host");
    await capture("03-saved");

    step = "missing-file";
    await js("window.request('/test/remove',{})");
    await js("window.recreateState()");
    await wait(`window.state().restored&&Object.values(window.state().errors).some(value=>typeof value==='string'&&value.length)`);
    state = await js("window.state()");
    if (!Object.values(state.errors).some(value => /exist|file|read|stat/i.test(String(value)))) throw new Error("Missing-file failure was not exposed: " + JSON.stringify(state.errors));
    await capture("04-missing-file-error");
    checks.push("Deleting the disposable target produces a visible production file-read error while the last cached document remains scoped to that file");

    const host = await hostState();
    state = await js("window.state()");
    if (host.projects !== 0 || host.sessions !== 0 || host.drafts !== 0 || host.isolatedAgentConfig !== "extensions: []" || host.providerWorker !== "no-provider-worker" || host.rejected.length || host.calls.some(call => call.command && (call.command !== "workspace.mutate" || call.action !== "file.write")) || state.runtimeErrors.length || rendererGone.length) throw new Error("Final isolation proof failed: " + JSON.stringify({ host, state, rendererGone }));
    const geometry = { requestedContent: { width: 1440, height: 1000 }, devicePixelRatio: state.viewport.dpr, zoomFactor: win.webContents.getZoomFactor(), contentBounds: win.getContentBounds(), windowBounds: win.getBounds(), captureRaster: captures[0].raster };
    fs.writeFileSync(path.join(output, "geometry.json"), JSON.stringify(geometry, null, 2));
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: true, checks, captures, geometry, host, hidden: true, authenticatedDisposableHost: true, actualProductionWorkspacePanel: true, actualProductionWorkspaceState: true, actualProductionComposerEditor: true, fixtureRoutingNotFullApp: true, nativeOsPixelParity: false, consoleMessages, rendererGone, scope: "Fixture routing from a production ComposerEditor pointer into a standalone absolute-file WorkspaceTarget, followed by production WorkspacePanel/WorkspaceState read, native edit, real renderer reload with IndexedDB recovery, explicit save, missing-file error, and project/Git UI exclusion in hidden Electron against a real authenticated disposable host with empty catalogs. This does not exercise full App routing. Chromium capturePage and AX only; no OS clipboard, dialogs, Work, Codex, installed-app, or native-window parity claim." }, null, 2));
    app.exit(0);
  } catch (error) {
    await capture("failure").catch(() => {});
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: false, step, error: String(error), checks, captures, state: await js("window.state()").catch(() => null), host: await hostState().catch(() => null), consoleMessages, rendererGone }, null, 2));
    app.exit(1);
  }
});
