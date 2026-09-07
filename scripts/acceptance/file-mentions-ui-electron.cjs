const { app, BrowserWindow } = require("electron"), fs = require("node:fs"), path = require("node:path");
const output = process.argv[2], launch = JSON.parse(fs.readFileSync(path.join(output, "launch.json"), "utf8"));
app.setPath("userData", launch.profile);
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("force-device-scale-factor", "2");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1040, height: 780, show: false, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const js = source => win.webContents.executeJavaScript(source), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), checks = [], captures = [], unexpectedNetwork = [];
  const wait = async source => { for (let i = 0; i < 240; i++) { if (await js(source).catch(() => false)) return; await sleep(25); } throw new Error(`Condition failed: ${source}`); };
  const pointer = async (selector, index = 0) => { const point = await js(`window.target(${JSON.stringify(selector)},${index})`); win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(point.x), y: Math.round(point.y) }); win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(point.x), y: Math.round(point.y), button: "left", clickCount: 1 }); win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(point.x), y: Math.round(point.y), button: "left", clickCount: 1 }); await sleep(100); };
  const capture = async name => { await sleep(80); const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG()); const ax = await win.webContents.debugger.sendCommand("Accessibility.getFullAXTree"); fs.writeFileSync(path.join(output, `${name}.ax.json`), JSON.stringify(ax, null, 2)); captures.push({ name, raster: image.getSize(), bounds: win.getBounds(), state: await js("window.state()") }); };
  let step = "load";
  try {
    win.webContents.debugger.attach("1.3");
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => { unexpectedNetwork.push(details.url); callback({}); });
    await win.loadFile(path.join(output, "web/index.html")); win.webContents.focus();
    await wait("Boolean(window.state().message) && document.querySelectorAll('.transcript-file-snapshot').length === window.state().expected.files.length");
    let state = await js("window.state()");
    if (!state.message || state.message.messageId !== launch.expected.messageId || state.message.nativeId !== launch.expected.nativeId) throw new Error("Native fileMention identity did not render from recorded history");
    if (state.refs.length !== launch.expected.files.length || state.refs.some((ref, index) => ref.text !== launch.expected.files[index].path || ref.disabled !== !launch.expected.files[index].actionPath || ref.tag !== (launch.expected.files[index].actionPath ? "BUTTON" : "SPAN"))) throw new Error("Rendered native file reference DOM does not match the recorded paths or owner boundary");
    await capture("01-observed-file-mentions-initial"); checks.push("Production TranscriptFileMentions renders every recorded native file reference without a user-message association");
    step = "toggle"; await pointer(".transcript-file-snapshot-toggle", 0); await wait("window.state().bodies.length === 1"); state = await js("window.state()");
    if (state.bodies[0] !== launch.expected.files[0].content) throw new Error("Expanded snapshot DOM text differs from the exact recorded native content");
    await capture("02-observed-file-mentions-expanded"); checks.push("Real pointer toggle exposes the exact recorded snapshot text");
    const openIndex = launch.expected.files.findIndex(file => Boolean(file.actionPath));
    if (openIndex < 0) throw new Error("Recorded fixture has no owner-scoped file reference for controlled callback verification");
    step = "open"; await pointer(".transcript-file-reference", openIndex); await wait("window.state().calls.length === 1"); state = await js("window.state()");
    if (state.calls[0].path !== launch.expected.files[openIndex].actionPath) throw new Error("Literal filename callback did not preserve the recorded path boundary");
    checks.push("Reference activation reaches only the controlled owner callback boundary");
    step = "rejected-open"; await js("window.rejectNextOpen()"); await pointer(".transcript-file-reference", openIndex); await wait("Boolean(document.querySelector('.transcript-file-reference-error'))"); await capture("03-observed-file-mentions-open-failure"); checks.push("A rejected controlled open is exposed in the production reference row");
    const outsideIndex = launch.expected.files.findIndex(file => !file.actionPath);
    if (outsideIndex >= 0) { const callCount = state.calls.length; await pointer(".transcript-file-reference", outsideIndex); state = await js("window.state()"); if (!state.refs[outsideIndex].disabled || state.calls.length !== callCount) throw new Error("Recorded unowned or outside reference exposed an action"); checks.push("Recorded unowned or outside file reference remains non-actionable"); }
    state = await js("window.state()");
    if (state.errors.length) throw new Error(`Renderer errors: ${JSON.stringify(state.errors)}`);
    if (unexpectedNetwork.length) throw new Error(`Unexpected non-file network requests: ${JSON.stringify(unexpectedNetwork)}`);
    const observed = captures.find(capture => capture.name === "01-observed-file-mentions-initial")?.state;
    fs.writeFileSync(path.join(output, "observed-baseline.json"), JSON.stringify({ componentComposition: true, source: "Production TranscriptFileMentions, TranscriptFileReference, and transcript styles rendered from recorded native history.", limitations: "Controlled callback boundary only; no host-open, main-process, App, macOS, image-preview, or pixel-parity claim.", environment: { zoomFactor: win.webContents.getZoomFactor(), devicePixelRatio: observed?.viewport?.dpr, theme: observed?.theme, computed: observed?.computed }, network: { unexpectedNonFileRequests: unexpectedNetwork }, checks, captures }, null, 2));
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: true, checks, captures, network: { unexpectedNonFileRequests: unexpectedNetwork }, scope: "Component composition only: production TranscriptFileMentions and TranscriptFileReference in hidden Electron, using recorded native history. The open action is a controlled callback boundary; no host-open/main/App/macOS/image/pixel-parity claim." }, null, 2)); app.exit(0);
  } catch (error) { await capture("failure").catch(() => {}); fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: false, step, error: String(error), checks, captures, state: await js("window.state()").catch(() => null) }, null, 2)); app.exit(1); }
});
