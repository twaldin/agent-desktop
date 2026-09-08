const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path");
const output = process.argv[2], launch = JSON.parse(fs.readFileSync(path.join(output, "launch.json"), "utf8"));
app.setPath("userData", launch.profile); app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 460, height: 700, show: false, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const js = source => win.webContents.executeJavaScript(source), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const checks = [], captures = [], consoleMessages = [], rendererGone = [];
  win.webContents.on("console-message", (...args) => consoleMessages.push(args.slice(1).map(String).join(" | ")));
  win.webContents.on("render-process-gone", (_event, details) => rendererGone.push(details));
  const wait = async source => { for (let i = 0; i < 800; i++) { if (await js(source)) return; await sleep(25); } throw new Error("Condition failed: " + source); };
  const click = async (selector, label, index = 0) => { const point = await js(`window.target(${JSON.stringify(selector)},${JSON.stringify(label)},${index})`); for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, ...point, ...(type === "mouseMove" ? {} : { button: "left", clickCount: 1 }) }); await sleep(120); };
  const key = async keyCode => { for (const type of ["keyDown", "keyUp"]) win.webContents.sendInputEvent({ type, keyCode }); await sleep(100); };
  const capture = async name => { await sleep(100); const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG()); fs.writeFileSync(path.join(output, `${name}.ax.json`), JSON.stringify(await win.webContents.debugger.sendCommand("Accessibility.getFullAXTree"), null, 2)); captures.push({ name, raster: image.getSize(), contentBounds: win.getContentBounds(), windowBounds: win.getBounds(), zoomFactor: win.webContents.getZoomFactor(), state: await js("window.state()") }); };
  let step = "load";
  try {
    win.webContents.debugger.attach("1.3"); await win.loadFile(path.join(output, "web/index.html")); win.webContents.focus();
    await wait("window.state?.().tables.length===2&&window.state().copyButtons===2");
    let state = await js("window.state()");
    if (state.expandButtons !== 0 || state.menuCount || state.tables[0].rows !== 4 || state.tables[1].rows !== 3 || state.overflow.documentWidth > 460 || state.overflow.bodyWidth > 460 || state.tables[0].scrollWidth <= state.tables[0].clientWidth || state.viewport.dpr !== 2) throw new Error("Narrow transcript table layout differs: " + JSON.stringify(state));
    await capture("00-narrow-two-tables");
    checks.push("Two actual MarkdownText tables remain independently scrollable in a 460px viewport without page-wide overflow; Copy is present, Expand is omitted when allowWideBlocks is false, and no table menu is invented");

    step = "multi-format-copy";
    await click('button[aria-label="Copy table"]', "Copy table", 0); await wait("window.state().clipboardCalls.length===1"); state = await js("window.state()");
    const multi = state.clipboardCalls[0], html = multi.payload?.["text/html"];
    const sanitized = await js(`(()=>{const html=window.state().clipboardCalls[0].payload['text/html'];const doc=new DOMParser().parseFromString(html,'text/html');return {tableCount:doc.querySelectorAll('table').length,malicious:doc.querySelectorAll('script,style,[onclick],[onerror],[onload],[href^="javascript:"]').length,buttons:doc.querySelectorAll('button').length,text:doc.body.textContent}})()`);
    if (multi.api !== "write" || multi.payload?.["text/plain"] !== state.firstOriginal || !html || sanitized.tableCount !== 1 || sanitized.malicious || sanitized.buttons || !sanitized.text.includes("Alpha | Beta") || !sanitized.text.includes("東京 🧪") || sanitized.text.includes("Deuxième") || /Copy table|Expand table/.test(html)) throw new Error("Multi-format table copy differs: " + JSON.stringify({ multi, sanitized }));
    checks.push("A real pointer copies only the first table as exact original Markdown in text/plain and one sanitized table in text/html; escaped pipe and Unicode survive, the second table and action controls are absent, and parsed HTML has no script or event/JavaScript attributes");

    step = "fallback-and-failure";
    await js("window.clipboardMode('fallback')"); await click('button[aria-label="Copy table"]', "Copy table", 0); await wait("window.state().clipboardCalls.length===2"); state = await js("window.state()");
    if (state.clipboardCalls[1].api !== "writeText" || state.clipboardCalls[1].text !== state.second) throw new Error("writeText fallback did not preserve the second table source");
    await sleep(2100);
    await js("window.clipboardMode('failure')"); await click('button[aria-label="Copy table"]', "Copy table", 0); await wait("Boolean(document.querySelector('button[aria-label=\"Copy failed · retry\"]'))");
    if ((await js("window.state().clipboardCalls.length")) !== 2) throw new Error("Rejected ClipboardItem write silently downgraded or recorded success");
    checks.push("When multi-format APIs are absent, Copy falls back to writeText with exact second-table Markdown; an injected ClipboardItem rejection reports Copy failed without silently downgrading or touching the OS clipboard");
    await js("window.clipboardMode('pending')"); await click('button[aria-label="Copy failed · retry"]', "Copy failed · retry", 0); await wait("window.state().clipboardCalls.length===3");
    await js("window.updateFirst(true)"); await wait("window.state().body.includes('Zürich Δ updated')&&!/Copy failed/i.test(window.state().body)"); await js("window.resolveClipboard()"); await sleep(150);
    if (await js("Boolean(document.querySelector('[aria-label=Copied]'))")) throw new Error("A completed stale copy marked the updated table Copied");
    checks.push("Changing the table source while a ClipboardItem write is pending resets its status; resolving the old write does not mark the updated table Copied");

    step = "expand-close-focus";
    win.setContentSize(1440, 1000); await js("window.wide(true)"); await wait("window.state().viewport.width===1440&&window.state().expandButtons===2");
    await click('button[aria-label="Expand table"]', "Expand table", 0); await wait("window.state().dialog?.label==='Table preview'&&window.state().dialog.tables===1"); state = await js("window.state()");
    if (state.dialog.actionsInsideTable || state.dialog.rect.width < 1400 || state.dialog.rect.height < 960 || !state.dialog.text.includes("Zürich Δ updated") || state.dialog.text.includes("Deuxième")) throw new Error("Fullscreen table preview differs: " + JSON.stringify(state.dialog));
    await capture("01-expanded-first-table");
    await js("window.updateFirst(false)"); await wait("window.state().dialog?.text.includes('東京 🧪')&&!window.state().dialog.text.includes('Zürich Δ updated')");
    await capture("02-expanded-live-update");
    await click('button[aria-label="Close table preview"]', "Close table preview"); await wait("!window.state().dialog&&window.state().focused==='Expand table'");
    checks.push("Expand opens only the selected table in a viewport-sized production dialog; a live MarkdownText content update replaces the dialog content, and pointer Close restores focus to its originating Expand button");

    step = "escape-focus";
    await click('button[aria-label="Expand table"]', "Expand table", 0); await wait("window.state().dialog"); await key("Escape"); await wait("!window.state().dialog&&window.state().focused==='Expand table'"); await capture("03-escape-restored-focus");
    checks.push("A real Escape key closes the expanded table and restores focus to the original trigger");
    state = await js("window.state()");
    if (state.runtimeErrors.length || rendererGone.length || state.menuCount || state.overflow.documentWidth > 1440) throw new Error("Final transcript-table isolation failed: " + JSON.stringify({ state, rendererGone }));
    const geometry = { initialContent: { width: 460, height: 700 }, expandedContent: { width: 1440, height: 1000 }, devicePixelRatio: state.viewport.dpr, zoomFactor: win.webContents.getZoomFactor(), finalContentBounds: win.getContentBounds(), finalWindowBounds: win.getBounds(), captureRasters: captures.map(item => ({ name: item.name, ...item.raster })) };
    fs.writeFileSync(path.join(output, "geometry.json"), JSON.stringify(geometry, null, 2));
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: true, checks, captures, geometry, clipboardCalls: state.clipboardCalls, sanitizedHtmlEvidence: sanitized, hidden: true, actualProductionMarkdownText: true, fixtureClipboardBoundary: true, fixtureContextNotFullApp: true, installedIntegrationClaim: false, nativeOsPixelParity: false, consoleMessages, rendererGone, scope: "Actual MarkdownText table actions in hidden Electron with real pointer and keyboard input, Chromium capturePage and Accessibility tree. Clipboard APIs are controlled at the fixture boundary; no OS clipboard, host, provider, Work, native action, installed integration, full App or native-window pixel parity claim." }, null, 2)); app.exit(0);
  } catch (error) {
    await capture("failure").catch(() => {}); fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: false, step, error: String(error), checks, captures, state: await js("window.state()").catch(() => null), consoleMessages, rendererGone }, null, 2)); app.exit(1);
  }
});
