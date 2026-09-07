const { app, BrowserWindow } = require("electron"), fs = require("node:fs"), path = require("node:path");
const output = process.argv[2], launch = JSON.parse(fs.readFileSync(path.join(output, "launch.json"), "utf8"));
app.setPath("userData", launch.profile); app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 1000, show: false, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const js = source => win.webContents.executeJavaScript(source), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const captures = [], checks = [], consoleMessages = [], rendererGone = [];
  win.webContents.on("console-message", (...args) => consoleMessages.push(args.slice(1).map(String).join(" | ")));
  win.webContents.on("render-process-gone", (_event, details) => rendererGone.push(details));
  const wait = async source => { for (let i = 0; i < 800; i++) { if (await js(source)) return; await sleep(25); } throw new Error("Condition failed: " + source); };
  const click = async (selector, label) => { const point = await js(`window.target(${JSON.stringify(selector)},${JSON.stringify(label)})`); for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, ...(type === "mouseMove" ? {} : { button: "left", clickCount: 1 }), ...point }); await sleep(100); };
  const chord = async (keyCode, modifiers = []) => { const normalized = ({ ArrowDown: "Down", ArrowUp: "Up" })[keyCode] ?? keyCode; for (const type of ["keyDown", "keyUp"]) win.webContents.sendInputEvent({ type, keyCode: normalized, modifiers }); await sleep(80); };
  const replace = async (label, value) => { const focused = await js(`(()=>{const node=window.editor(${JSON.stringify(label)});if(!node)return false;node.focus();return node.getRootNode().activeElement===node})()`); if (!focused) throw new Error("Editor focus failed: " + label); await chord("a", ["meta"]); await win.webContents.insertText(value); await sleep(120); };
  const capture = async name => { await sleep(100); const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG()); captures.push({ name, raster: image.getSize(), frame: win.getBounds(), rendererZoomFactor: win.webContents.getZoomFactor(), state: await js("window.state()") }); };
  const hostFile = file => js(`window.request('/test/file',{file:${JSON.stringify(file)}})`);
  let step = "load";
  try {
    await win.loadFile(path.join(output, "web/index.html"), { query: { endpoint: launch.endpoint, target: JSON.stringify(launch.target), hostId: launch.hostId } }); win.webContents.focus();
    step = "open-two"; await js(`window.openFile('first.ts')`); await wait(`window.state().ready&&window.editor('Edit first.ts')&&window.state().tabs.length===1`); await capture("00-first-file-dock");
    const firstEdit = launch.files["first.ts"] + "const firstDockEdit = true;\n"; await replace("Edit first.ts", firstEdit); await wait(`window.state().documents['first.ts']?.dirty&&window.state().documents['first.ts'].text===${JSON.stringify(firstEdit)}`);
    await js(`window.openFile('second.ts')`); await wait(`window.editor('Edit second.ts')&&window.state().tabs.length===2`);
    const secondEdit = launch.files["second.ts"] + "export const secondDockEdit = true;\n"; await replace("Edit second.ts", secondEdit); await wait(`window.state().documents['second.ts']?.dirty&&window.state().documents['second.ts'].text===${JSON.stringify(secondEdit)}`);
    checks.push("Two real file dock tabs retain independent dirty editor buffers");

    step = "exact-saves"; await click('[data-dock-tab-id]', "first.ts"); await wait(`window.editor('Edit first.ts')`); await js(`window.editor('Edit first.ts').focus()`); await chord("s", ["meta"]);
    await wait(`window.request('/test/file',{file:'first.ts'}).then(value=>value.text===${JSON.stringify(firstEdit)}&&window.state().documents['first.ts']&&!window.state().documents['first.ts'].dirty)`);
    if ((await hostFile("second.ts")).text !== launch.files["second.ts"] || !await js(`window.state().documents['second.ts'].dirty`)) throw new Error("Saving first.ts changed or cleared second.ts");
    await click('[data-dock-tab-id]', "second.ts"); await wait(`window.editor('Edit second.ts')`); await js(`window.editor('Edit second.ts').focus()`); await chord("s", ["meta"]);
    await wait(`window.request('/test/file',{file:'second.ts'}).then(value=>value.text===${JSON.stringify(secondEdit)}&&window.state().documents['second.ts']&&!window.state().documents['second.ts'].dirty)`);
    checks.push("Native Command-S writes only the active file tab's exact host path");

    step = "reactivate-reopen"; await js(`window.openFile('first.ts')`); await wait(`window.editor('Edit first.ts')&&window.state().tabs.length===2`);
    const cached = firstEdit + "const cachedAfterClose = true;\n"; await replace("Edit first.ts", cached); await wait(`window.state().documents['first.ts'].dirty`);
    await click('[aria-label="Close first.ts tab"]'); await wait(`window.state().tabs.length===1&&!window.editor('Edit first.ts')`);
    await js(`window.openFile('first.ts')`); await wait(`window.editor('Edit first.ts')?.textContent.includes('cachedAfterClose')&&window.state().tabs.length===2&&window.state().documents['first.ts'].text===${JSON.stringify(cached)}&&window.state().documents['first.ts'].dirty`);
    checks.push("Opening an existing file reactivates one tab; close and reopen restore its cached dirty text");

    step = "breadcrumbs"; const genericDirectory = await js(`window.state().directory`); await click('.workspace-file-breadcrumbs [data-breadcrumb-index="0"]'); await wait(`document.querySelector('.workspace-file-picker')&&document.activeElement===document.querySelector('.workspace-file-picker')`);
    const layout = await js(`window.state()`); if (layout.headerRect.height !== 48 || layout.pickerRect.width !== 384 || layout.pickerRect.height !== 320 || layout.breadcrumbFont.family !== layout.bodyFont.family) throw new Error("Dedicated file header/picker typography or geometry differs: " + JSON.stringify(layout)); await capture("01-root-breadcrumb-picker");
    await chord("Escape"); await wait(`!document.querySelector('.workspace-file-picker')&&document.activeElement?.matches('.workspace-file-breadcrumbs [data-breadcrumb-index="0"]')`);
    await click('.workspace-file-breadcrumbs [data-breadcrumb-index="0"]'); await wait(`document.querySelector('.workspace-file-picker')`); await click('.workspace-file-picker [role="menuitem"]', "empty"); await wait(`window.state().picker==='This folder is empty.'`); await capture("02-empty-folder-picker"); await chord("Escape");
    await click('.workspace-file-breadcrumbs [data-breadcrumb-index="0"]'); await wait(`document.querySelector('.workspace-file-picker')`); await click('.workspace-file-picker [role="menuitem"]', "nested"); await wait(`window.state().picker?.includes('nested.ts')`); await click('.workspace-file-picker [role="menuitem"]', "nested.ts");
    await wait(`window.editor('Edit nested/nested.ts')&&window.state().tabs.length===3`); await capture("03-nested-file-from-breadcrumb");
    if (await js(`window.state().directory!==${JSON.stringify(genericDirectory)}`)) throw new Error("Breadcrumb navigation changed the generic Files directory selection");
    checks.push("Root breadcrumb supports Escape focus restoration, empty-folder state, loaded-folder navigation and real file selection");

    step = "move-hide-show"; await click('[data-dock-tab-id]', "nested.ts"); await chord("ArrowDown", ["control"]);
    await wait(`window.state().dock.state.bottom.tabIds.some(id=>window.state().tabs.find(tab=>tab.id===id)?.path==='nested/nested.ts')&&window.editor('Edit nested/nested.ts')?.textContent.includes('unchanged')`);
    if (!await js(`window.state().tabs.find(tab=>tab.path==='nested/nested.ts')?.path==='nested/nested.ts'`)) throw new Error("Moved tab lost its file path");
    await capture("04-file-moved-to-bottom-dock");
    await click('.dock-slot-bottom .dock-menu summary'); await click('.dock-slot-bottom .dock-menu button', "Hide panel"); await wait(`!window.state().dock.state.bottom.open&&!window.editor('Edit nested/nested.ts')`);
    await click('.fixture-actions button', "Show bottom dock"); await wait(`window.state().dock.state.bottom.open&&window.editor('Edit nested/nested.ts')`);
    await js(`window.editor('Edit nested/nested.ts').focus()`); await wait(`window.state().editorFocused`); await capture("05-bottom-dock-restored-focus");
    checks.push("DockPanel keyboard move preserves file identity; hide/show restores the same editor and accepts focus");

    const proxy = await js(`window.request('/test/state',{})`);
    if (proxy.workspaceWrites !== 2) throw new Error(`Expected two file.write commands, received ${proxy.workspaceWrites}`);
    if (proxy.calls.some(call => call.route !== "/v1/workspace/query" && call.route !== "/v1/commands" || call.command && call.command !== "workspace.mutate" || call.action && call.action !== "file.write")) throw new Error("Proxy observed a non-workspace read/write call");
    if ((await hostFile("first.ts")).text !== firstEdit || (await hostFile("second.ts")).text !== secondEdit) throw new Error("Final saved host targets differ");
    if ((await hostFile("nested/nested.ts")).text !== launch.files["nested/nested.ts"]) throw new Error("Breadcrumb navigation wrote nested file bytes");
    const finalRenderer = await js(`window.state()`); if (finalRenderer.runtimeErrors.length || finalRenderer.dockErrors.length || rendererGone.length) throw new Error("Renderer/dock errors were recorded: " + JSON.stringify(finalRenderer));
    checks.push("Exactly two durable workspace file writes occurred; navigation, tab state and dirty caching issued no session/provider/OS actions");
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: true, captures, checks, hidden: true, rendererNativeHostHarness: true, nativeWindowPhysicalPixelParity: false, proxy, consoleMessages, rendererGone }, null, 2)); app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(output, "failure.png"), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: false, step, error: String(error), captures, checks, state: await js("window.state()").catch(() => null), consoleMessages, rendererGone }, null, 2)); app.exit(1);
  }
});
