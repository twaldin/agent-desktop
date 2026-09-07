const { app, BrowserWindow } = require("electron"), fs = require("node:fs"), path = require("node:path");
const output = process.argv[2], launch = JSON.parse(fs.readFileSync(path.join(output, "launch.json"), "utf8"));
app.setPath("userData", launch.profile);
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("force-device-scale-factor", "2");
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1040, height: 780, show: false, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const js = source => win.webContents.executeJavaScript(source), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), checks = [], captures = [], unexpectedNetwork = [];
  const wait = async source => { for (let i = 0; i < 240; i++) { if (await js(source).catch(() => false)) return; await sleep(25); } throw new Error(`Condition failed: ${source}`); };
  const chord = async keyCode => { win.webContents.sendInputEvent({ type: "keyDown", keyCode }); win.webContents.sendInputEvent({ type: "keyUp", keyCode }); await sleep(100); };
  const hover = async selector => { const point = await js(`window.target(${JSON.stringify(selector)})`); win.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(point.x), y: Math.round(point.y) }); await sleep(140); };
  const capture = async name => { await sleep(80); const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG()); const ax = await win.webContents.debugger.sendCommand("Accessibility.getFullAXTree"); fs.writeFileSync(path.join(output, `${name}.ax.json`), JSON.stringify(ax, null, 2)); captures.push({ name, raster: image.getSize(), bounds: win.getBounds(), state: await js("window.state()") }); };
  let step = "load";
  try {
    win.webContents.debugger.attach("1.3");
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
      unexpectedNetwork.push(details.url);
      callback({});
    });
    await win.loadFile(path.join(output, "web/index.html")); win.webContents.focus();
    await wait("Boolean(window.state().expected?.bindingEntryId) && Boolean(document.querySelector('.transcript-user-attachments .composer-selected-text-chip'))");
    let state = await js("window.state()");
    if (!state.user || state.user.messageId !== launch.expected.userMessageId || state.user.nativeId !== launch.expected.userNativeId || state.userAttachment.chipText !== launch.expected.label) throw new Error("Sent chip did not render the recorded user identity and selection label");
    if (state.userAttachment.buttons.some(button => /remove/i.test(button.ariaLabel || "") || /remove/i.test(button.text || "")) || state.userAttachment.links !== 0) throw new Error("Sent selected-text chip exposed a remove or source action");
    await capture("01-observed-history-initial"); checks.push("Production TranscriptMessages renders the explicit recorded user binding as a non-removable, non-navigable selected-text chip");
    step = "hover"; await hover(".transcript-user-attachments .composer-selected-text-chip"); await wait("Boolean(window.state().preview)"); state = await js("window.state()");
    if (state.preview.width > 320.5 || !state.preview || state.userAttachment.previewText !== launch.expected.attachments.map(attachment => `“${attachment.text}”`).join("")) throw new Error("Hover preview did not preserve the recorded excerpt DOM text or width bound");
    await capture("02-observed-history-hover"); checks.push("Readonly sent chip hover shows the persisted snapshot text and exposes no source action");
    step = "escape"; await js("document.querySelector('.transcript-user-attachments .composer-selected-text-chip').focus()"); await chord("Escape"); await wait("!window.state().preview"); checks.push("Keyboard Escape closes the sent-chip preview");
    step = "reload"; await win.webContents.reload(); await wait("Boolean(window.state().expected?.bindingEntryId) && Boolean(document.querySelector('.transcript-user-attachments .composer-selected-text-chip'))"); state = await js("window.state()");
    if (!state.user || state.user.messageId !== launch.expected.userMessageId || state.user.nativeId !== launch.expected.userNativeId || state.userAttachment.chipText !== launch.expected.label) throw new Error("Reload changed recorded native history projection");
    await capture("03-observed-history-reload"); checks.push("Reload renders the same recorded native binding and snapshot");
    step = "narrow-light"; win.setContentSize(390, 844); await js("document.documentElement.dataset.theme='light'"); await hover(".transcript-user-attachments .composer-selected-text-chip"); await wait("Boolean(window.state().preview)"); state = await js("window.state()");
    if (state.preview.left < 6 || state.preview.right > 384 || state.preview.top < 48 || state.preview.bottom > 838) throw new Error(`Narrow preview escaped collision bounds: ${JSON.stringify(state.preview)}`);
    await capture("04-observed-history-narrow-light-hover"); checks.push("Light-theme narrow hover remains within the source collision bounds");
    if (unexpectedNetwork.length) throw new Error(`Unexpected non-file network requests: ${JSON.stringify(unexpectedNetwork)}`);
    const observed = captures.find(capture => capture.name === "01-observed-history-initial")?.state;
    fs.writeFileSync(path.join(output, "observed-baseline.json"), JSON.stringify({ componentComposition: true, source: "Production TranscriptMessages and ComposerSelectedText rendered from recorded native normalized history.", limitations: "No macOS/main-process/App/pixel-parity claim; no matched frozen selected-text sent-message capture exists.", environment: { zoomFactor: win.webContents.getZoomFactor(), devicePixelRatio: observed?.viewport?.dpr, theme: observed?.theme, computed: observed?.computed }, network: { unexpectedNonFileRequests: unexpectedNetwork }, checks, captures }, null, 2));
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: true, checks, captures, network: { unexpectedNonFileRequests: unexpectedNetwork }, scope: "Component composition only: production TranscriptMessages and styles in hidden Electron, using recorded WorkerRuntime/pinned-SDK normalized history. No provider sends, host launch, macOS/main/App, or pixel-parity claim; no matched frozen state." }, null, 2)); app.exit(0);
  } catch (error) { await capture("failure").catch(() => {}); fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: false, step, error: String(error), checks, captures, state: await js("window.state()").catch(() => null) }, null, 2)); app.exit(1); }
});
