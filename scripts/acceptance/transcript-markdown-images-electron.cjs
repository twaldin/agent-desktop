const { app, BrowserWindow, ipcMain, protocol, session } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const output = process.argv[2];
const launch = JSON.parse(fs.readFileSync(path.join(output, "launch.json"), "utf8"));
const { WorkspaceImageGrants } = require(path.join(output, "workspace-image.cjs"));
const { saveWorkspaceCopy, workspaceCopyOutcome, workspaceCopySource } = require(path.join(output, "workspace-save-copy.cjs"));
const grants = new WorkspaceImageGrants();
const acquisitions = [], imageCalls = [], releases = [], downloads = [], active = new Set(), remoteRequests = [];
app.setPath("userData", launch.profile);
app.commandLine.appendSwitch("disable-renderer-backgrounding");
protocol.registerSchemesAsPrivileged([{ scheme: "agent-workspace-image", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
ipcMain.on("desktop:window-state:read", event => { event.returnValue = null; });

app.whenReady().then(async () => {
  protocol.handle("agent-workspace-image", request => grants.response(request.url, request.signal));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://example.invalid/*", "https://example.invalid/*"] }, (details, callback) => { remoteRequests.push(details.url); callback({ cancel: true }); });
  const win = new BrowserWindow({ width: 1440, height: 1000, show: false, useContentSize: true, webPreferences: { preload: path.join(output, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const allowed = new Set([launch.firstPath, launch.secondPath, launch.missingPath]);
  const source = (target, signal) => {
    const transport = workspaceCopySource(launch.connection, target, false, signal);
    return { ...transport, query: query => { imageCalls.push({ target, type: query.type, path: query.path, offset: query.offset }); return transport.query(query); } };
  };
  ipcMain.handle("desktop:workspace-image-acquire", (event, target, name, hostId) => {
    if (event.sender !== win.webContents || hostId !== launch.hostId || !target || !allowed.has(target.filePath) || path.basename(target.filePath) !== name) throw new Error("Wrong transcript image owner");
    const lease = grants.acquire({ senderId: event.sender.id, target, path: name, hostId, source: signal => source(target, signal) });
    acquisitions.push({ id: lease.id, target, name, hostId }); active.add(lease.id); return lease;
  });
  ipcMain.handle("desktop:workspace-image-release", (event, id) => {
    if (event.sender !== win.webContents) throw new Error("Wrong image release sender");
    const released = grants.release(id, event.sender.id); if (released) { active.delete(id); releases.push(id); } return released;
  });
  ipcMain.handle("desktop:workspace-save-copy", (event, target, name, hostId) => workspaceCopyOutcome(async () => {
    if (event.sender !== win.webContents || hostId !== launch.hostId || !allowed.has(target?.filePath) || path.basename(target.filePath) !== name) throw new Error("Wrong transcript download owner");
    const destination = path.join(launch.downloads, name);
    const result = await saveWorkspaceCopy({ target, path: name, hostId }, { choose: async defaultName => { downloads.push({ target, name, hostId, defaultName, destination }); return destination; }, source: async () => source(target) });
    return result;
  }));
  const js = code => win.webContents.executeJavaScript(code), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const checks = [], captures = [], consoleMessages = [], rendererGone = [];
  win.webContents.on("console-message", (...args) => consoleMessages.push(args.slice(1).map(String).join(" | ")));
  win.webContents.on("render-process-gone", (_event, details) => rendererGone.push(details));
  const wait = async code => { for (let i = 0; i < 1000; i++) { if (await js(code)) return; await sleep(25); } throw new Error("Condition failed: " + code); };
  const click = async (selector, label) => { const point = await js(`window.target(${JSON.stringify(selector)},${JSON.stringify(label)})`); for (const type of ["mouseMove", "mouseDown", "mouseUp"]) win.webContents.sendInputEvent({ type, ...(type === "mouseMove" ? {} : { button: "left", clickCount: 1 }), ...point }); await sleep(100); };
  const key = async keyCode => { for (const type of ["keyDown", "keyUp"]) win.webContents.sendInputEvent({ type, keyCode }); await sleep(100); };
  const capture = async name => { await sleep(120); const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(output, `${name}.png`), image.toPNG()); fs.writeFileSync(path.join(output, `${name}.ax.json`), JSON.stringify(await win.webContents.debugger.sendCommand("Accessibility.getFullAXTree"), null, 2)); captures.push({ name, raster: image.getSize(), contentBounds: win.getContentBounds(), windowBounds: win.getBounds(), zoomFactor: win.webContents.getZoomFactor(), state: await js("window.state()"), transport: { acquisitions: acquisitions.length, releases: releases.length, active: active.size, imageCalls: imageCalls.length } }); };
  let step = "load";
  try {
    win.webContents.debugger.attach("1.3");
    await win.loadFile(path.join(output, "web/index.html"), { query: { hostId: launch.hostId, firstPath: launch.firstPath, secondPath: launch.secondPath, missingPath: launch.missingPath } }); win.webContents.focus();
    await wait("window.state?.().thumbnails.length===5&&window.state().thumbnails.every(item=>item.loaded)&&window.state().unavailable.length===3&&window.state().thumbnails.find(item=>item.label==='Absolute local')?.rect.width===200");
    let state = await js("window.state()");
    const wide = state.thumbnails.find(item => item.label === "Absolute local");
    if (!wide || wide.title !== "First title" || !state.thumbnails.some(item => item.label === "Repeated absolute" && item.title === "Repeated title") || !state.thumbnails.some(item => item.label === "File localhost") || !state.thumbnails.some(item => item.label === "Sandbox absolute") || !state.thumbnails.some(item => item.label === "Embedded data")) throw new Error("Expected decoded transcript thumbnails are absent: " + JSON.stringify(state));
    if (!state.unavailable.some(item => item.text.includes("Missing local")) || !state.unavailable.some(item => item.text.includes("Relative unavailable")) || !state.unavailable.some(item => item.text.includes("Remote unavailable")) || remoteRequests.length) throw new Error("Unavailable or remote image policy differs: " + JSON.stringify({ state, remoteRequests }));
    if (state.viewport.width !== 1440 || state.viewport.height !== 1000 || state.viewport.dpr !== 2 || win.webContents.getZoomFactor() !== 1 || wide.rect.width > 200 || wide.rect.width < 190 || state.presentation.imageMaxWidth !== "200px" || state.presentation.theme !== "dark") throw new Error("Transcript image geometry or theme differs: " + JSON.stringify({ wide, viewport: state.viewport, presentation: state.presentation }));
    if (acquisitions.some(item => !allowed.has(item.target.filePath)) || imageCalls.some(call => path.basename(call.target.filePath) !== call.path)) throw new Error("Image transport exceeded exact standalone authority");
    await capture("00-thumbnails-and-fallbacks");
    checks.push("Actual MarkdownText renders absolute, file://localhost, sandbox:, repeated and embedded-data thumbnails; missing, relative and remote references use fallbacks, with no remote request, exact standalone image targets, and a decoded wide thumbnail capped at 200px in the 1440x1000 DPR2 fixture");

    step = "modal-gallery";
    await click(".transcript-markdown-image", "Absolute local");
    await wait("window.state().dialog?.previewAlt==='Absolute local'&&window.state().dialog.previewLoaded&&window.state().dialog.next&&window.state().dialog.previous&&window.state().dialog.download");
    await key("Right"); await wait("window.state().dialog?.previewAlt==='Repeated absolute'&&window.state().dialog.previewLoaded");
    await key("Left"); await wait("window.state().dialog?.previewAlt==='Absolute local'&&window.state().dialog.previewLoaded");
    await click('[aria-label="Zoom in"]'); await wait("window.state().dialog?.transform.includes('scale(1.25)')");
    await key("0"); await wait("window.state().dialog?.transform.includes('scale(1)')");
    await capture("01-modal-gallery-keyboard-zoom");
    checks.push("A real pointer opens the modal; ArrowRight reaches the repeated identical source by trigger identity, ArrowLeft returns, Zoom in changes scale, and 0 resets it");

    step = "download-focus";
    await click('[aria-label="Download image"]');
    for (let i = 0; !fs.existsSync(path.join(launch.downloads, path.basename(launch.firstPath))) && i < 300; i++) await sleep(20);
    const downloaded = path.join(launch.downloads, path.basename(launch.firstPath));
    if (!fs.existsSync(downloaded) || crypto.createHash("sha256").update(fs.readFileSync(downloaded)).digest("hex") !== launch.hashes.first) throw new Error("Controlled native save-copy output differs");
    await key("Escape"); await wait("!window.state().dialog&&window.state().focused==='Absolute local'");
    checks.push("Production save-copy writes exact source bytes through a controlled native chooser; Escape closes the modal and restores focus to its thumbnail");

    step = "offline-reconnect";
    const stableKey = state.ownerKey, acquireBeforeOffline = acquisitions.length, releaseBeforeOffline = releases.length, callsBeforeOffline = imageCalls.length;
    await js("window.connection(false)"); await wait(`!window.state().connected&&window.state().ownerKey===${JSON.stringify(stableKey)}&&window.state().thumbnails.length===5&&window.state().thumbnails.every(item=>item.loaded)`); await sleep(200);
    if (acquisitions.length !== acquireBeforeOffline || releases.length !== releaseBeforeOffline || imageCalls.length !== callsBeforeOffline) throw new Error("Disconnect replaced decoded images or touched transport");
    await capture("02-offline-decoded-retained");
    await js("window.connection(true)"); await wait(`window.state().connected&&window.state().ownerKey!==${JSON.stringify(stableKey)}&&window.state().thumbnails.length===5&&window.state().thumbnails.every(item=>item.loaded)`);
    for (let i = 0; acquisitions.length <= acquireBeforeOffline && i < 300; i++) await sleep(20);
    if (acquisitions.length <= acquireBeforeOffline || releases.length <= releaseBeforeOffline) throw new Error("Reconnect did not replace and reacquire image sources");
    checks.push("Disconnect keeps the stable image owner key and decoded thumbnails without transport; reconnect changes the key, releases prior grants and reacquires local sources");

    step = "replace-unmount";
    const acquireBeforeReplace = acquisitions.length, releaseBeforeReplace = releases.length;
    const ownerBeforeReplace = await js("window.state().ownerKey");
    await js("window.replaceOwner()"); await wait(`window.state().ownerKey!==${JSON.stringify(ownerBeforeReplace)}`);
    for (let i = 0; (acquisitions.length <= acquireBeforeReplace || releases.length <= releaseBeforeReplace) && i < 300; i++) await sleep(20);
    if (acquisitions.length <= acquireBeforeReplace || releases.length <= releaseBeforeReplace) throw new Error("Owner replacement did not dispose and reacquire grants");
    const releaseBeforeFault = releases.length;
    await click(".transcript-markdown-image", "File localhost"); await wait("window.state().dialog?.previewAlt==='File localhost'&&window.state().dialog.previewLoaded");
    await js("window.failThumbnail('File localhost')"); await wait("!window.state().dialog&&window.state().unavailable.some(item=>item.text.includes('File localhost'))");
    for (let i = 0; releases.length < releaseBeforeFault + 2 && i < 300; i++) await sleep(20);
    if (releases.length < releaseBeforeFault + 2) throw new Error("Injected thumbnail failure did not release thumbnail and preview grants");
    checks.push("A deterministic labeled thumbnail failure while its modal is open closes the preview and releases both thumbnail and preview grants");
    await js("window.mounted(false)"); await wait("!window.state().mounted");
    for (let i = 0; active.size && i < 300; i++) await sleep(20);
    if (active.size) throw new Error("Transcript unmount retained image grants");
    const acquireBeforeRemount = acquisitions.length;
    await js("window.mounted(true)"); await wait("window.state().mounted&&window.state().thumbnails.length===5&&window.state().thumbnails.every(item=>item.loaded)");
    for (let i = 0; acquisitions.length <= acquireBeforeRemount && i < 300; i++) await sleep(20);
    if (acquisitions.length <= acquireBeforeRemount) throw new Error("Transcript remount did not reacquire local images");
    await js("window.mounted(false)"); await wait("!window.state().mounted");
    for (let i = 0; active.size && i < 300; i++) await sleep(20);
    if (active.size) throw new Error("Final transcript unmount retained image grants");
    checks.push("Owner-key replacement disposes and reacquires sources; unmount releases all grants, remount reacquires them, and final unmount releases them again");

    const native = await (await fetch(launch.connection.origin + "/v1/state", { headers: { Authorization: `Bearer ${launch.connection.token}` } })).json();
    const fileHashes = { first: crypto.createHash("sha256").update(fs.readFileSync(launch.firstPath)).digest("hex"), second: crypto.createHash("sha256").update(fs.readFileSync(launch.secondPath)).digest("hex"), downloaded: crypto.createHash("sha256").update(fs.readFileSync(downloaded)).digest("hex") };
    state = await js("window.state()");
    if (native.projects?.length || native.sessions?.length || native.drafts?.length || fileHashes.first !== launch.hashes.first || fileHashes.second !== launch.hashes.second || state.runtimeErrors.length || rendererGone.length || remoteRequests.length || active.size) throw new Error("Final isolation or preservation proof failed: " + JSON.stringify({ native, fileHashes, state, rendererGone, remoteRequests, active: active.size }));
    const geometry = { requestedContent: { width: 1440, height: 1000 }, devicePixelRatio: state.viewport.dpr, zoomFactor: win.webContents.getZoomFactor(), contentBounds: win.getContentBounds(), windowBounds: win.getBounds(), captureRaster: captures[0].raster };
    fs.writeFileSync(path.join(output, "geometry.json"), JSON.stringify(geometry, null, 2));
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: true, checks, captures, geometry, acquisitions, releases, imageCalls, downloads, remoteRequests, activeLeases: active.size, fileHashes, host: { projects: native.projects.length, sessions: native.sessions.length, drafts: native.drafts.length, providerWorker: "no-provider-worker", isolatedAgentConfig: "extensions: []" }, fixtureRoutingNotFullApp: true, hidden: true, consoleMessages, rendererGone, scope: "Actual MarkdownText, TranscriptMarkdownImage, createTranscriptImageResolver, WorkspaceImageGrants and WorkspaceSaveCopy modules in hidden Electron against a real authenticated disposable host. Fixture context and IPC routing, not full App or installed main integration; Chromium pointer/keyboard, capturePage and AX, not native-window pixel parity. No OS clipboard/dialog, prompts, providers, Work or Codex control." }, null, 2));
    grants.releaseSender(win.webContents.id); app.exit(0);
  } catch (error) {
    await capture("failure").catch(() => {});
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ passed: false, step, error: String(error), checks, captures, acquisitions, releases, imageCalls, downloads, remoteRequests, activeLeases: active.size, state: await js("window.state()").catch(() => null), consoleMessages, rendererGone }, null, 2));
    grants.releaseSender(win.webContents.id); app.exit(1);
  }
}).catch(error => { console.error(error); app.exit(1); });
