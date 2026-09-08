const { app, BrowserWindow, ipcMain } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const output = process.argv[2];
const launch = JSON.parse(fs.readFileSync(path.join(output, "launch.json"), "utf8"));
const { saveWorkspaceCopy, workspaceCopyOutcome, workspaceCopySource } = require(path.join(output, "workspace-save-copy.cjs"));
const copies = [], copyQueries = [];
app.setPath("userData", launch.profile);
app.commandLine.appendSwitch("disable-renderer-backgrounding");
ipcMain.on("desktop:window-state:read", event => { event.returnValue = null; });

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 1000, show: false, useContentSize: true, webPreferences: { preload: path.join(output, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const allowed = new Set(Object.values(launch.paths));
  ipcMain.handle("desktop:workspace-save-copy", (event, target, name, hostId) => workspaceCopyOutcome(async () => {
    if (event.sender !== win.webContents || hostId !== launch.hostId || !allowed.has(target?.filePath) || path.basename(target.filePath) !== name) throw new Error("Wrong transcript save-copy owner");
    const destination = path.join(launch.downloads, `copy-${name}`);
    const result = await saveWorkspaceCopy({ target, path: name, hostId }, { choose: async defaultName => { copies.push({ target, name, hostId, defaultName, destination }); return destination; }, source: async () => {
      const transport = workspaceCopySource(launch.connection, target, false);
      return { ...transport, query: query => { copyQueries.push({ target, type: query.type, path: query.path, offset: query.offset }); return transport.query(query); } };
    }});
    return result;
  }));
  const js = source => win.webContents.executeJavaScript(source), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const checks = [], captures = [], consoleMessages = [], rendererGone = [];
  let selectionProbe;
  win.webContents.on("console-message", (...args) => consoleMessages.push(args.slice(1).map(String).join(" | ")));
  win.webContents.on("render-process-gone", (_event, details) => rendererGone.push(details));
  const wait = async source => { for (let i = 0; i < 1000; i++) { if (await js(source)) return; await sleep(25); } throw new Error("Condition failed: " + source); };
  const point = (selector, label) => js(`window.target(${JSON.stringify(selector)},${JSON.stringify(label)})`);
  const click = async (selector, label) => { const p = await point(selector, label); win.webContents.sendInputEvent({ type: "mouseMove", ...p }); win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...p }); win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...p }); await sleep(120); };
  const doubleClick = async (selector, label) => { const p = await point(selector, label); win.webContents.sendInputEvent({ type: "mouseMove", ...p }); for (const count of [1, 2]) { win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: count, ...p }); win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: count, ...p }); await sleep(80); } await sleep(150); };
  const contextClick = async (selector, label) => { const p = await point(selector, label); win.webContents.sendInputEvent({ type: "mouseMove", ...p }); win.webContents.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, ...p }); win.webContents.sendInputEvent({ type: "mouseUp", button: "right", clickCount: 1, ...p }); await sleep(150); };
  const chord = async (keyCode, modifiers = []) => { for (const type of ["keyDown", "keyUp"]) win.webContents.sendInputEvent({ type, keyCode, modifiers }); await sleep(80); };
  const replace = async text => { const focused = await js("(()=>{const editor=window.editor();if(!editor)return false;editor.focus();return editor.getRootNode().activeElement===editor})()"); if (!focused) throw new Error("Source editor focus failed"); await chord("a", ["meta"]); await win.webContents.insertText(text); await sleep(160); };
  const hostState = () => js("window.request('/test/state',{})");
  const capture = async name => { await sleep(100); const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG()); fs.writeFileSync(path.join(output, `${name}.ax.json`), JSON.stringify(await win.webContents.debugger.sendCommand("Accessibility.getFullAXTree"), null, 2)); captures.push({ name, raster: image.getSize(), contentBounds: win.getContentBounds(), windowBounds: win.getBounds(), zoomFactor: win.webContents.getZoomFactor(), state: await js("window.state()") }); };
  let step = "load";
  try {
    win.webContents.debugger.attach("1.3");
    await win.loadFile(path.join(output, "web/index.html"), { query: { endpoint: launch.endpoint, hostId: launch.hostId, ordinaryPath: launch.paths.ordinary, literalPath: launch.paths.literal, missingPath: launch.paths.missing } });
    win.webContents.focus();
    await wait("window.state?.().references.length===3");
    let state = await js("window.state()"), host = await hostState();
    if (state.tabs.length || host.calls.some(call => call.query === "file.read") || state.viewport.width !== 1440 || state.viewport.height !== 1000 || state.viewport.dpr !== 2 || win.webContents.getZoomFactor() !== 1) throw new Error("Initial transcript or geometry differs: " + JSON.stringify({ state, host }));
    if (!state.references.some(item => item.text === "Native literal special path" && item.title === launch.paths.literal)) throw new Error("Native literal path was reparsed: " + JSON.stringify(state.references));
    await capture("00-no-cwd-transcript-references");
    checks.push("Actual MarkdownText and TranscriptFileReference render no-cwd absolute paths as file controls; the native path retains literal spaces, #, ?, %, colon and Unicode, with no file read before activation");

    step = "markdown-pointer-location";
    await click("[data-file-reference]", "Markdown absolute at line 2 column 7");
    await wait(`window.state().restored&&window.state().text===${JSON.stringify(launch.texts.ordinary)}&&window.state().activeLine&&(window.state().activeLine.selectionLine===2||window.state().activeLine.marked.includes(2))`);
    state = await js("window.state()");
    if (state.standalonePath !== launch.paths.ordinary || JSON.stringify(state.mountedTarget) !== JSON.stringify({ filePath: launch.paths.ordinary }) || state.tabs.length !== 1 || !state.tabs[0].preview || state.opened[0].path !== launch.paths.ordinary || state.opened[0].line !== 2 || state.opened[0].column !== 7 || state.ui.fileTree || state.ui.workspaceTabs || state.ui.review || Math.abs(state.layout.dockSlot.width - 518.4) > 2 || Math.abs(state.layout.panel.width - state.layout.dockSlot.width) > 2 || state.layout.editor.width < 500) throw new Error("Absolute Markdown pointer routing or production dock-slot geometry differs: " + JSON.stringify(state));
    await capture("01-markdown-absolute-location-preview");
    const probedText = launch.texts.ordinary.replace("const bravo", "const §bravo");
    await win.webContents.insertText("§");
    await wait(`window.state().text===${JSON.stringify(probedText)}&&window.state().dirty`);
    selectionProbe = { requested: { line: 2, column: 7 }, observedInsertion: "const §bravo", text: await js("window.state().text") };
    await chord("z", ["meta"]); await wait(`window.state().text===${JSON.stringify(launch.texts.ordinary)}&&!window.state().dirty`);
    checks.push("A real pointer routes the absolute Markdown link with #L2C7 through the exact standalone WorkspaceState, basename request and production dock; WorkspacePanel reads real content and initially remains a preview without project, file-tree or Git UI. A real insertion lands before 'bravo' at one-based line 2 column 7, then Undo restores the clean bytes");

    step = "controlled-save-copy";
    await contextClick("[data-file-reference]", "Markdown absolute at line 2 column 7");
    await wait("window.state().menu===1");
    await click('[role="menuitem"]', "Save as…");
    const copied = path.join(launch.downloads, `copy-${launch.names.ordinary}`);
    for (let i = 0; !fs.existsSync(copied) && i < 300; i++) await sleep(20);
    if (!fs.existsSync(copied) || fs.readFileSync(copied, "utf8") !== launch.texts.ordinary || copies.length !== 1 || !copyQueries.some(item => item.type === "file.copy-info") || copyQueries.some(item => item.path !== launch.names.ordinary)) throw new Error("Controlled save-copy differs: " + JSON.stringify({ copies, copyQueries }));
    checks.push("Save as uses routedTranscriptHostFileActions and production WorkspaceSaveCopy with a controlled chooser, exact standalone owner and basename transport; copied bytes match the host file");

    step = "native-double-click-pin";
    await doubleClick("[data-file-reference]", "Native literal special path");
    await wait(`window.state().restored&&window.state().standalonePath===${JSON.stringify(launch.paths.literal)}&&window.state().text===${JSON.stringify(launch.texts.literal)}&&window.state().tabs.some(tab=>tab.title===${JSON.stringify(launch.names.literal)}&&!tab.preview)`);
    state = await js("window.state()");
    if (!state.opened.some(item => item.path === launch.paths.literal && item.preview === false)) throw new Error("Native double-click did not pin exact literal path: " + JSON.stringify(state.opened));
    await capture("02-native-literal-double-click-pinned");
    checks.push("A real double-click on the native literal reference opens its exact standalone bytes and pins the production file tab");

    step = "missing-file";
    await click("[data-file-reference]", "Missing absolute");
    await wait("window.state().restored&&Object.values(window.state().errors).some(value=>typeof value==='string'&&value.length)");
    state = await js("window.state()");
    if (state.standalonePath !== launch.paths.missing || !Object.values(state.errors).some(value => /exist|file|read|stat/i.test(String(value)))) throw new Error("Missing file fallback differs: " + JSON.stringify(state));
    await capture("03-missing-file-error");
    checks.push("An absent absolute transcript file opens only its scoped standalone panel and exposes the production host read failure");

    step = "offline-dirty-recovery";
    await click("[data-file-reference]", "Markdown absolute at line 2 column 7");
    await wait(`window.state().restored&&window.state().standalonePath===${JSON.stringify(launch.paths.ordinary)}&&window.state().text===${JSON.stringify(launch.texts.ordinary)}&&window.editor()`);
    await js("window.connection(false)"); await wait("window.state().connected===false");
    const edited = launch.texts.ordinary + "export const offlineRecovered = true;\n";
    await replace(edited); await wait(`window.state().dirty&&window.state().text===${JSON.stringify(edited)}`); await sleep(300);
    const callsBeforeRecreate = (await hostState()).calls.length;
    await js("window.recreateCurrent()");
    await wait(`window.state().connected===false&&window.state().restored&&window.state().dirty&&window.state().text===${JSON.stringify(edited)}&&window.editor()`);
    await sleep(150); state = await js("window.state()"); host = await hostState();
    if (!state.body.includes("Offline · displaying cached files and status.") || Object.values(state.errors).some(value => typeof value === "string" && value.length) || host.calls.length !== callsBeforeRecreate || fs.readFileSync(launch.paths.ordinary, "utf8") !== launch.texts.ordinary) throw new Error("Offline dirty recovery differs: " + JSON.stringify({ state, callsBeforeRecreate, host }));
    const openedBeforeOfflineClick = state.opened.length;
    await click("[data-file-reference]", "Markdown absolute at line 2 column 7");
    await wait(`window.state().opened.length===${openedBeforeOfflineClick + 1}&&window.state().dirty&&window.state().text===${JSON.stringify(edited)}`);
    await sleep(150); state = await js("window.state()"); host = await hostState();
    if (Object.values(state.errors).some(value => typeof value === "string" && value.length) || host.calls.length !== callsBeforeRecreate) throw new Error("Offline transcript reactivation queried or damaged the cached buffer: " + JSON.stringify({ state, callsBeforeRecreate, host }));
    await capture("04-offline-dirty-recreated-state");
    checks.push("After disconnect, a real source edit stays off-host; replacing the routed WorkspaceState in the same renderer restores the exact dirty buffer from production IndexedDB without a query or file-read error. A subsequent real offline transcript click retains that buffer and exact dock target without host I/O");

    const hashes = { ordinary: crypto.createHash("sha256").update(fs.readFileSync(launch.paths.ordinary)).digest("hex"), literal: crypto.createHash("sha256").update(fs.readFileSync(launch.paths.literal)).digest("hex"), copy: crypto.createHash("sha256").update(fs.readFileSync(copied)).digest("hex"), expectedOrdinary: crypto.createHash("sha256").update(launch.texts.ordinary).digest("hex"), expectedLiteral: crypto.createHash("sha256").update(launch.texts.literal).digest("hex") };
    state = await js("window.state()"); host = await hostState();
    if (host.projects !== 0 || host.sessions !== 0 || host.drafts !== 0 || host.rejected.length || host.launches.length || copies.length !== 1 || state.runtimeErrors.length || rendererGone.length || hashes.ordinary !== hashes.copy || hashes.ordinary !== hashes.expectedOrdinary || hashes.literal !== hashes.expectedLiteral) throw new Error("Final isolation proof failed: " + JSON.stringify({ host, state, hashes, copies, rendererGone }));
    const geometry = { requestedContent: { width: 1440, height: 1000 }, devicePixelRatio: state.viewport.dpr, zoomFactor: win.webContents.getZoomFactor(), contentBounds: win.getContentBounds(), windowBounds: win.getBounds(), captureRaster: captures[0].raster };
    fs.writeFileSync(path.join(output, "geometry.json"), JSON.stringify(geometry, null, 2));
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: true, checks, captures, geometry, host, copies, copyQueries, selectionProbe, fileHashes: hashes, hidden: true, authenticatedDisposableHost: true, actualProductionMarkdownText: true, actualProductionTranscriptFileReference: true, actualProductionWorkspacePanel: true, actualProductionWorkspaceState: true, actualProductionDock: true, fixtureContextNotFullApp: true, nativeOsPixelParity: false, consoleMessages, rendererGone, scope: "Fixture context using actual transcript file controls and production standalone routing helpers, dock, WorkspaceState, WorkspacePanel, editor and WorkspaceSaveCopy in hidden Electron against a real authenticated disposable host. It does not run full App or installed main integration. Offline recovery replaces the routed WorkspaceState within the same renderer; it is not a full renderer restart. Chromium pointer/keyboard, capturePage and AX only; no OS clipboard/dialog, external app, modifier launch, prompt, provider, Work or Codex control." }, null, 2));
    app.exit(0);
  } catch (error) {
    await capture("failure").catch(() => {});
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: false, step, error: String(error), checks, captures, state: await js("window.state()").catch(() => null), host: await hostState().catch(() => null), copies, copyQueries, consoleMessages, rendererGone }, null, 2));
    app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
