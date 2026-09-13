const { app, BrowserWindow, ipcMain, nativeTheme, screen, session } = require("electron");
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const { createHash } = require("node:crypto");
const { createInterface } = require("node:readline");
const { basename, isAbsolute, join, resolve } = require("node:path");
const { setTimeout: waitForReadiness } = require("node:timers/promises");
const root = resolve(process.argv[2] || ""), repo = resolve(process.argv[3] || "");
if (!process.argv[2] || !process.argv[3] || !basename(root).startsWith("native-history-find-") || process.env.HOME !== root
  || process.env.AGENT_DESKTOP_DATA_DIR !== join(root, "host") || process.env.AGENT_DESKTOP_PROFILE_DIR !== join(root, "desktop")
  || process.env.PI_CODING_AGENT_DIR !== join(root, "agent") || process.env.PI_DISABLE_DOTENV !== "1" || process.env.PATH?.split(":")[0] !== join(root, "bin")
  || process.env.AGENT_DESKTOP_BUN !== join(root, "bin/guarded-bun")) throw new Error("Exact isolated native Find launch environment required.");
const owner = JSON.parse(readFileSync(join(root, "fixture-owner.json"), "utf8"));
if (owner.root !== root || owner.repo !== repo || process.env.NATIVE_FIND_HOST_ENTRY !== owner.hostEntry) throw new Error("Owned fixture mismatch.");
const mode = process.env.NATIVE_FIND_MODE ?? "full";
if (!["full", "capture-sequencing", "live-find"].includes(mode) || owner.mode !== mode) throw new Error("Prepared native Find mode mismatch.");
const inspector = process.env.NATIVE_FIND_INSPECTOR, yabai = process.env.NATIVE_FIND_YABAI;
if (!inspector || !isAbsolute(inspector) || !yabai || !isAbsolute(yabai)) throw new Error("Main must supply verified absolute native inspector and yabai paths.");
const sha = value => createHash("sha256").update(value).digest("hex");
const stableTheme = renderer => JSON.stringify({ root: renderer.theme.root, body: renderer.theme.body, fontTokens: renderer.fontTokens, source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors });
if (sha(readFileSync(join(root, "bin/tailscale"))) !== owner.tailscaleSha256) throw new Error("Private refusing tailscale executable changed.");
if (inspector !== owner.helperHashes.inspector.path || yabai !== owner.helperHashes.yabai.path
  || sha(readFileSync(inspector)) !== owner.helperHashes.inspector.sha256 || sha(readFileSync(yabai)) !== owner.helperHashes.yabai.sha256) throw new Error("Verified native helper changed.");
const append = (file, value) => appendFileSync(join(owner.evidence, file), JSON.stringify({ ...value, at: Date.now() }) + "\n", { mode: 0o600 });
const fail = (kind, detail) => { appendFileSync(join(root, "guard-violations.jsonl"), JSON.stringify({ kind, detail, at: Date.now() }) + "\n", { mode: 0o600 }); throw new Error(`Native history Find guard: ${kind}`); };
const loopback = url => ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => { const url = new URL(input instanceof Request ? input.url : String(input)); if (!loopback(url)) fail("desktop-nonloopback-fetch", url.origin); return originalFetch(input, init); };
const OriginalWebSocket = globalThis.WebSocket;
if (OriginalWebSocket) globalThis.WebSocket = class extends OriginalWebSocket {
  constructor(url, protocols) { if (!loopback(new URL(String(url)))) fail("desktop-nonloopback-websocket"); super(url, protocols); }
};
let appPeerObserved = false, expected;
let sequenceStep = 0, pendingInspection;
let initialAdmission, initialAdmissionStarted = false;
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => originalHandle(channel, async (...args) => {
  if (channel === "host:native-terminal-input") fail("find-reached-native-input");
  if (channel === "host:command") {
    const type = args[1]?.command?.type;
    if (!["draft.put", "preferences.put", "preferences.keymap.mutate"].includes(type)) fail("forbidden-provider-or-command", typeof type === "string" ? type : "missing");
    if (!appPeerObserved) fail("ui-write-before-real-app-peer-observation");
  }
  const value = await listener(...args);
  if (channel === "host:peers") {
    if (!Array.isArray(value?.hosts) || value.hosts.length !== 0) fail("actual-app-nonzero-peers");
    appPeerObserved = true; append("app-peer-observations.jsonl", { status: value.status, discoveredPeers: value.hosts.length });
  }
  if (channel === "host:native-terminal-action") append("app-native-actions.jsonl", { type: args[1]?.type });
  return value;
});
app.setPath("userData", join(root, "desktop"));
app.setAppPath(join(repo, "apps/desktop"));
if (process.env.NATIVE_FIND_CDP_PORT) {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", process.env.NATIVE_FIND_CDP_PORT);
}
app.on("browser-window-created", (_event, window) => {
  window.webContents.on("before-input-event", (_event, input) => append("actual-key-inputs.jsonl", { pid: process.pid, windowId: window.id, input }));
  window.webContents.on("did-finish-load", () => {
    if (window.webContents.getURL() !== new URL("file://" + join(repo, "apps/desktop/dist/renderer/index.html")).href) return;
    const compiled = Object.fromEntries(["main.cjs", "preload.cjs", "renderer/index.html"].map(file => [file, sha(readFileSync(join(repo, "apps/desktop/dist", file)))]));
    writeFileSync(join(owner.evidence, "app-ready.json"), JSON.stringify({ mode, pid: process.pid, source: owner.source, url: window.webContents.getURL(), bounds: window.getBounds(),
      executable: { path: process.execPath, sha256: sha(readFileSync(process.execPath)), versions: process.versions }, compiled, at: Date.now() }, null, 2), { flag: "wx", mode: 0o600 });
    console.log("Native history Find actual App ready; no input until peer0 and bound geometry probe");
  });
});
function ownedWindow() {
  const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.webContents.getURL().startsWith("file:"));
  if (windows.length !== 1) fail("ambiguous-actual-app-window");
  return windows[0];
}
async function readNativeMetadata(command, args, label, timeout = 30_000) {
  let output;
  try {
    output = await execFileAsync(command, args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
    append("native-probe-command-observations.jsonl", { label, command, args, ...output });
    return JSON.parse(output.stdout);
  } catch (error) {
    fail("native-metadata-command-failed", { label, command, args, error: String(error), code: error.code, signal: error.signal,
      killed: error.killed, stdout: error.stdout ?? output?.stdout, stderr: error.stderr ?? output?.stderr });
  }
}
async function admitInitialManager(label) {
  const startedAt = Date.now(), deadline = startedAt + 20_000;
  let identity, observation = 0;
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) fail("initial-manager-admission-deadline", { label, startedAt, deadline, identity, observation });
    return milliseconds;
  };
  const observe = async phase => {
    const window = ownedWindow(), cg = await readNativeMetadata(inspector, ["metadata", String(process.pid)], `${label}-${observation}-${phase}`, remaining());
    const owned = Array.isArray(cg.windows) ? cg.windows.filter(value => value.kCGWindowOwnerPID === process.pid && value.kCGWindowIsOnscreen && value.kCGWindowLayer === 0) : [];
    const native = owned[0], inventory = cg.ax, axWindow = inventory?.windows?.[0], ax = axWindow?.bounds, bounds = window.isDestroyed() ? null : window.getBounds(), b = native?.kCGWindowBounds;
    append("initial-manager-admission.jsonl", { phase: "native-observation", label, observation, samplingPhase: phase, cg, bounds });
    if (!bounds || cg.pid !== process.pid || !cg.accessibilityPermission || !cg.screenCapturePermission || cg.frontmost !== true || !window.isFocused()
      || window.webContents.getURL() !== new URL("file://" + join(repo, "apps/desktop/dist/renderer/index.html")).href
      || owned.length !== 1 || !Number.isSafeInteger(native?.kCGWindowNumber) || inventory?.pid !== process.pid || inventory.queryError !== 0
      || inventory.windowCount !== 1 || !Array.isArray(inventory.windows) || inventory.windows.length !== 1
      || axWindow?.pidError !== 0 || axWindow.pid !== process.pid || axWindow.position?.error !== 0 || axWindow.size?.error !== 0
      || axWindow.role?.error !== 0 || axWindow.subrole?.error !== 0 || typeof axWindow.role.value !== "string" || typeof axWindow.subrole.value !== "string"
      || !ax || !b || !["x", "y", "width", "height"].every(key => Number.isFinite(ax[key])) || ax.width <= 0 || ax.height <= 0
      || ax.x !== b.X || ax.y !== b.Y || ax.width !== b.Width || ax.height !== b.Height
      || ax.x !== bounds.x || ax.y !== bounds.y || ax.width !== bounds.width || ax.height !== bounds.height) {
      fail("initial-native-owner-or-geometry-unavailable", { label, observation, phase, cg, bounds });
    }
    const current = { pid: process.pid, cgWindow: native.kCGWindowNumber, electronWindowId: window.id, webContentsId: window.webContents.id,
      axPid: axWindow.pid, axIndex: axWindow.index, axRole: axWindow.role.value, axSubrole: axWindow.subrole.value };
    append("initial-manager-admission.jsonl", { phase: "native-identity", label, observation, samplingPhase: phase, identity: current });
    if (identity && JSON.stringify(identity) !== JSON.stringify(current)) fail("initial-native-identity-changed", { label, observation, expected: identity, observed: current, cg });
    identity ??= current;
    return { identity: current, cg, bounds };
  };
  append("initial-manager-admission.jsonl", { phase: "start", label, startedAt, deadline });
  for (;;) {
    observation++;
    await observe("before-query");
    const args = ["-m", "query", "--windows", "--window", String(identity.cgWindow)];
    const queryTimeout = remaining();
    let output, receipt;
    try {
      output = await execFileAsync(yabai, args, { encoding: "utf8", timeout: queryTimeout, maxBuffer: 4 * 1024 * 1024 });
      receipt = { exitCode: 0, stdout: output.stdout, stderr: output.stderr };
    } catch (error) {
      receipt = { exitCode: error.code, signal: error.signal, killed: error.killed, stdout: error.stdout, stderr: error.stderr, error: String(error) };
    }
    append("initial-manager-admission.jsonl", { phase: "manager-observation", label, observation, command: yabai, args, identity, receipt });
    if (!output) {
      const pending = receipt.exitCode === 1 && !receipt.signal && !receipt.killed && receipt.stdout === ""
        && receipt.stderr === `could not locate window with the specified id '${identity.cgWindow}'.\n`;
      if (!pending) fail("unexpected-initial-manager-error", { label, observation, identity, receipt });
      append("initial-manager-admission.jsonl", { phase: "pending-exact-id-not-found", label, observation, identity, receipt });
      await waitForReadiness(Math.min(50, remaining()));
      continue;
    }
    let manager;
    try { manager = JSON.parse(output.stdout); } catch (error) { fail("invalid-initial-manager-reply", { label, observation, receipt, error: String(error) }); }
    if (output.stderr !== "" || manager?.id !== identity.cgWindow || manager.pid !== identity.pid || manager["has-ax-reference"] !== true) {
      fail("initial-manager-mapping-mismatch", { label, observation, identity, manager, receipt });
    }
    const native = await observe("after-mapping"), bounds = native.bounds;
    if (manager.frame?.x !== bounds.x || manager.frame?.y !== bounds.y || manager.frame?.w !== bounds.width || manager.frame?.h !== bounds.height) {
      fail("initial-manager-geometry-mismatch", { label, observation, identity, manager, native });
    }
    remaining();
    const admitted = { kind: "initial-unbound-manager-admission", label, identity, startedAt, deadline, admittedAt: Date.now(), observations: observation, native, manager,
      qualification: "Only initial passive mapping readiness. AX association is the sole owned AX window matching this pinned CG window and bounds. No delay/exclusion/churn cause established; no post-binding retry." };
    append("initial-manager-admission.jsonl", { phase: "admitted", ...admitted });
    return admitted;
  }
}
async function probe(label, requireBinding = true) {
  if (!initialAdmission) fail("initial-manager-admission-required", { label });
  const window = ownedWindow();
  const cg = await readNativeMetadata(inspector, ["metadata", String(process.pid)], label);
  const owned = cg.windows.filter(value => value.kCGWindowOwnerPID === process.pid && value.kCGWindowIsOnscreen && value.kCGWindowLayer === 0);
  if (!cg.accessibilityPermission || !cg.screenCapturePermission || cg.frontmost !== true || owned.length !== 1 || !window.isFocused()) fail("native-permission-window-or-foreground-binding", { label, cg, electronFocused: window.isFocused() });
  const native = owned[0], bounds = window.getBounds(), contentBounds = window.getContentBounds();
  if (native.kCGWindowNumber !== initialAdmission.identity.cgWindow || window.id !== initialAdmission.identity.electronWindowId
    || window.webContents.id !== initialAdmission.identity.webContentsId) fail("admitted-native-window-changed", { label, admitted: initialAdmission.identity, cg, bounds });
  const manager = await readNativeMetadata(yabai, ["-m", "query", "--windows", "--window", String(native.kCGWindowNumber)], label);
  const axInventory = cg.ax, axWindow = axInventory?.windows?.[0], ax = axWindow?.bounds;
  if (cg.pid !== process.pid || axInventory?.pid !== process.pid || axInventory.queryError !== 0
    || axInventory.windowCount !== 1 || !Array.isArray(axInventory.windows) || axInventory.windows.length !== 1
    || axWindow?.pidError !== 0 || axWindow.pid !== process.pid || axWindow.position?.error !== 0 || axWindow.size?.error !== 0
    || !ax || !["x", "y", "width", "height"].every(key => Number.isFinite(ax[key])) || ax.width <= 0 || ax.height <= 0) {
    fail("actual-ax-inventory-or-window-unavailable", { label, cg, axInventory, ownedCGCount: owned.length, native, bounds, manager });
  }
  if (axWindow.index !== initialAdmission.identity.axIndex || axWindow.role?.value !== initialAdmission.identity.axRole
    || axWindow.subrole?.value !== initialAdmission.identity.axSubrole) fail("admitted-ax-association-changed", { label, admitted: initialAdmission.identity, axInventory });
  const renderer = await window.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready;
    const visible = node => node.getClientRects().length && !node.closest('[hidden]');
    const history = [...document.querySelectorAll('.native-terminal-history')].find(visible);
    const css = node => { const s = getComputedStyle(node); return { colorScheme:s.colorScheme, background:s.backgroundColor, color:s.color, fontFamily:s.fontFamily, fontSize:s.fontSize, lineHeight:s.lineHeight, fontStyle:s.fontStyle, fontWeight:s.fontWeight, fontStretch:s.fontStretch, letterSpacing:s.letterSpacing, fontFeatureSettings:s.fontFeatureSettings, fontVariationSettings:s.fontVariationSettings, fontKerning:s.fontKerning }; };
    const rootStyle = getComputedStyle(document.documentElement);
    const fontTokens = Object.fromEntries(['--terminal-font','--terminal-font-size','--code-font','--code-font-size','--code-font-weight','--code-line-height'].map(name=>[name,rootStyle.getPropertyValue(name).trim()]));
    const sample = 'MWil0 [] .* İ 😀';
    const fonts = [];
    const font = (role, node) => {
      const style = css(node), shorthand = style.fontStyle+' '+style.fontWeight+' '+style.fontSize+' '+style.fontFamily;
      const context = new OffscreenCanvas(1,1).getContext('2d');
      if (!context) throw new Error('Actual font metrics unavailable');
      context.font = shorthand;
      const measured = context.measureText(sample);
      const metrics = Object.fromEntries(['width','actualBoundingBoxLeft','actualBoundingBoxRight','actualBoundingBoxAscent','actualBoundingBoxDescent','fontBoundingBoxAscent','fontBoundingBoxDescent'].map(name=>[name,measured[name]]));
      fonts.push({ role, ready:document.fonts.check(shorthand,sample), font:context.font, sample,
        style:Object.fromEntries(Object.entries(style).filter(([name])=>!['colorScheme','background','color'].includes(name))), metrics });
    };
    font('root',document.documentElement); font('body',document.body);
    // Xterm WidthCache uses fixed regular/bold/italic/bold-italic slots. Bind
    // those identities, not computed CSS that could rename a drifting font.
    const variants = ['regular','bold','italic','bold-italic'];
    for (const container of document.querySelectorAll('.native-terminal-grid .xterm-width-cache-measure-container')) {
      const nodes = [...container.children].filter(node => node.classList.contains('xterm-char-measure-element'));
      if (nodes.length !== variants.length) throw new Error('Unexpected native font measurement slots');
      nodes.forEach((node,index) => font('native-output-'+variants[index],node));
    }
    for (const node of document.querySelectorAll('.native-terminal-grid .xterm-char-measure-element')) {
      if (!node.closest('.xterm-width-cache-measure-container')) font('native-cell-size',node);
    }
    for (const node of history?.querySelectorAll('pre') ?? []) font('history-output',node);
    const findStatus = history?.querySelector('.native-terminal-history-find-status')?.textContent;
    const findIndex = findStatus?.match(/^([0-9]+) of ([0-9]+) matches · /);
    const activeMark = history?.querySelector('mark[aria-current=true]'), scrollport = history?.querySelector('.native-terminal-history-content');
    const activeBounds = activeMark?.getBoundingClientRect(), scrollBounds = scrollport?.getBoundingClientRect();
    return { url:location.href, screenX, screenY, width:innerWidth, height:innerHeight, aspect:innerWidth/innerHeight, dpr:devicePixelRatio,
      fontsReady:document.fonts.status==='loaded', fontTokens, fonts,
      visualViewport:visualViewport && { width:visualViewport.width, height:visualViewport.height, scale:visualViewport.scale },
      theme:{ rootClass:document.documentElement.className, rootData:{...document.documentElement.dataset}, root:css(document.documentElement), body:css(document.body), terminal:history?css(history):null },
      active:{ tag:document.activeElement?.tagName, label:document.activeElement?.getAttribute('aria-label'), text:document.activeElement?.textContent?.slice(0,160) },
      history:history && { busy:history.getAttribute('aria-busy')==='true', terminalView:history.closest('.native-terminal-view')?.id, generation:history.dataset.historyGeneration, revision:history.dataset.historyRevision, capturedAt:history.dataset.historyCapturedAt,
        query:history.querySelector('input[type=search]')?.value, status:findStatus,
        matchIndex:findIndex?Number(findIndex[1]):null, matchCount:findIndex?Number(findIndex[2]):null,
        activeMatch:activeMark?.textContent, activeSection:activeMark?.closest('pre')?.getAttribute('aria-label'),
        activeVisible:!!activeBounds&&!!scrollBounds&&activeBounds.bottom>scrollBounds.top&&activeBounds.top<scrollBounds.bottom&&activeBounds.right>scrollBounds.left&&activeBounds.left<scrollBounds.right,
        sections:[...history.querySelectorAll('pre')].map(node=>({label:node.getAttribute('aria-label'),text:node.textContent,style:css(node)})) } };
  })()`);
  if (renderer.history) renderer.history.sections = renderer.history.sections.map(({ text, ...value }) => ({ ...value, textLength: text.length, textSha256: sha(text) }));
  const b = native.kCGWindowBounds, display = screen.getDisplayMatching(bounds), zoomFactor = window.webContents.getZoomFactor();
  const nativeDisplays = cg.screens?.filter(value => value.id === display.id) ?? [];
  const nativeDisplay = nativeDisplays[0];
  if (nativeDisplays.length !== 1 || !Number.isFinite(nativeDisplay?.backingScale) || nativeDisplay.backingScale <= 0 || nativeDisplay.backingScale !== display.scaleFactor
    || !["width", "height", "pixelWidth", "pixelHeight"].every(key => Number.isInteger(nativeDisplay?.mode?.[key]) && nativeDisplay.mode[key] > 0)) fail("actual-native-display-mode-or-backing-unavailable", { label, nativeDisplays, display });
  const displayBinding = JSON.stringify({ native: nativeDisplay, electron: display, dpr: renderer.dpr });
  const fonts = {};
  if (!renderer.fontsReady || !renderer.fonts.length) fail("actual-fonts-not-ready", { label, renderer });
  for (const font of renderer.fonts) {
    if (!font.ready || !Object.values(font.metrics).every(Number.isFinite)) fail("actual-output-font-not-ready", { label, font });
    const value = JSON.stringify(font);
    if (fonts[font.role] && fonts[font.role] !== value) fail("inconsistent-output-font-role", { label, fonts, font });
    fonts[font.role] = value;
  }
  if (manager.id !== native.kCGWindowNumber || manager.pid !== process.pid || !manager["has-ax-reference"] || !manager["is-floating"] || manager["is-native-fullscreen"] || window.isFullScreen()
    || b.X !== bounds.x || b.Y !== bounds.y || b.Width !== bounds.width || b.Height !== bounds.height
    || manager.frame.x !== bounds.x || manager.frame.y !== bounds.y || manager.frame.w !== bounds.width || manager.frame.h !== bounds.height
    || renderer.url !== new URL("file://" + join(repo, "apps/desktop/dist/renderer/index.html")).href
    || ax.x !== bounds.x || ax.y !== bounds.y || ax.width !== bounds.width || ax.height !== bounds.height
    || renderer.screenX !== bounds.x || renderer.screenY !== bounds.y || renderer.visualViewport?.scale !== 1
    || renderer.width * zoomFactor !== contentBounds.width || renderer.height * zoomFactor !== contentBounds.height
    || renderer.dpr !== display.scaleFactor * zoomFactor) fail("actual-geometry-zoom-or-floating-drift", { label, cg, ax, manager, bounds, contentBounds, renderer, zoomFactor });
  if (requireBinding && (!expected || !appPeerObserved || expected.pid !== process.pid || expected.cgWindow !== native.kCGWindowNumber
    || JSON.stringify(expected.bounds) !== JSON.stringify(bounds) || expected.space !== manager.space || expected.display !== manager.display
    || expected.zoomFactor !== zoomFactor || expected.width !== renderer.width || expected.height !== renderer.height
    || expected.displayBinding !== displayBinding || expected.theme !== stableTheme(renderer))) fail("input-capture-preflight-not-bound", { label, expected, cg, ax, manager, bounds, contentBounds, renderer, display, nativeDisplay, zoomFactor, appPeerObserved });
  // New mounted output roles bind once; closing history never erases an observed font.
  if (requireBinding) for (const [role, value] of Object.entries(fonts)) {
    if (expected.fonts[role] && expected.fonts[role] !== value) fail("bound-output-font-drift", { label, role, expected: expected.fonts[role], observed: value });
    expected.fonts[role] = value;
  }
  return { label, pid: process.pid, cgWindow: native.kCGWindowNumber, cg, ax: { ...ax, inventory: axInventory },
    window: { bounds, contentBounds, aspect: bounds.width / bounds.height, fullscreen: window.isFullScreen(), zoomFactor, zoomLevel: window.webContents.getZoomLevel() },
    display, nativeDisplay, displayBinding, fonts, fontBindings: requireBinding ? { ...expected.fonts } : fonts,
    manager, renderer, nativeTheme: { source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }, appPeerObserved, at: Date.now() };
}
async function boot() {
  const connection = JSON.parse(readFileSync(join(root, "host/connection.json"), "utf8"));
  if (!loopback(new URL(connection.origin))) fail("nonloopback-owning-host");
  // Complete real peer admission synchronously: yielding here can make Electron
  // ready before production main registers its privileged protocols.
  const peers = JSON.parse(execFileSync(process.env.NATIVE_FIND_BUN, ["--no-env-file", "-e", `
    const connection = await Bun.file(process.env.AGENT_DESKTOP_DATA_DIR + "/connection.json").json();
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(connection.origin).hostname)) throw Error("Nonloopback peer preflight");
    const response = await fetch(connection.origin + "/v1/peers", { headers: { Authorization: "Bearer " + connection.token, "X-Agent-Host-Id": connection.hostId } });
    const peers = await response.json();
    console.log(JSON.stringify({ ok: response.ok, hostId: connection.hostId, status: peers.status, discoveredPeers: Array.isArray(peers.hosts) ? peers.hosts.length : null }));
  `], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 }));
  if (!peers.ok || peers.hostId !== connection.hostId || peers.discoveredPeers !== 0) fail("prelaunch-nonzero-peers");
  append("prelaunch-peer-observations.jsonl", { status: peers.status, discoveredPeers: peers.discoveredPeers });
  const ready = app.whenReady().then(() => session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const url = new URL(details.url);
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !loopback(url)) {
      appendFileSync(join(root, "guard-violations.jsonl"), JSON.stringify({ kind: "chromium-nonloopback-request", origin: url.origin, at: Date.now() }) + "\n", { mode: 0o600 });
      callback({ cancel: true }); return;
    }
    callback({});
  }));
  // Actual production main owns the ordinary window, preload, bridge, App and terminal view.
  require(join(repo, "apps/desktop/dist/main.cjs"));
  await ready;
  for await (const line of createInterface({ input: process.stdin, terminal: false })) {
    const [command, label, ...values] = line.trim().split(/\s+/);
    if (!command) continue;
    if (!label || !/^[a-zA-Z0-9_-]{1,80}$/.test(label)) throw new Error("Every fixture control needs a unique safe label.");
    const file = join(owner.evidence, `${label}.json`);
    if (existsSync(file)) throw new Error("Frozen evidence labels cannot be reused.");
    if (mode === "capture-sequencing" && ((pendingInspection && command !== "inspect") || sequenceStep > 1)) {
      fail("original-image-inspection-required-or-sequence-complete", { command, label, sequenceStep, pendingInspection });
    }
    if (command === "admit") {
      if (initialAdmissionStarted || expected || !appPeerObserved) fail("initial-manager-admission-not-allowed", { label, initialAdmissionStarted, bound: !!expected, appPeerObserved });
      initialAdmissionStarted = true;
      initialAdmission = await admitInitialManager(label);
      writeFileSync(file, JSON.stringify(initialAdmission, null, 2), { flag: "wx", mode: 0o600 });
    } else if (command === "bind") {
      const [width, height, zoom = "1"] = values;
      const observed = await probe(label, false);
      if (!appPeerObserved || observed.window.bounds.width !== Number(width) || observed.window.bounds.height !== Number(height) || observed.window.zoomFactor !== Number(zoom)) fail("requested-layout-not-actually-observed");
      expected = { pid: process.pid, cgWindow: observed.cgWindow, bounds: observed.window.bounds, space: observed.manager.space, display: observed.manager.display,
        zoomFactor: observed.window.zoomFactor, width: observed.renderer.width, height: observed.renderer.height,
        displayBinding: observed.displayBinding, fonts: { ...observed.fonts }, theme: stableTheme(observed.renderer) };
      writeFileSync(file, JSON.stringify({ kind: "actual-layout-binding", observed, expected }, null, 2), { flag: "wx", mode: 0o600 });
    } else if (command === "probe") writeFileSync(file, JSON.stringify(await probe(label), null, 2), { flag: "wx", mode: 0o600 });
    else if (command === "capture") {
      const commandReceivedAt = Date.now(), before = await probe(`${label}-before`), image = join(owner.evidence, `${label}.png`);
      if (mode === "capture-sequencing") {
        const history = before.renderer.history, first = sequenceStep === 0;
        if (pendingInspection || sequenceStep > 1 || label !== (first ? "sequence-baseline" : "sequence-previous")
          || history?.busy || history?.query !== "needle" || history.matchCount !== 82 || history.matchIndex !== (first ? 1 : 82)
          || history.activeSection !== (first ? "Native scrollback text" : "Saved normal screen") || !history.activeVisible) {
          fail("capture-sequence-not-settled-or-inspected", { label, sequenceStep, pendingInspection, history });
        }
      }
      if (existsSync(image)) throw new Error("Frozen native capture cannot be overwritten.");
      const captureStartedAt = Date.now();
      append("capture-chronology.jsonl", { phase: "capture-start", label, commandReceivedAt, captureStartedAt, settledHistory: before.renderer.history });
      const captureReceipt = await execFileAsync("/usr/sbin/screencapture", ["-x", "-o", "-l", String(before.cgWindow), image]).catch(error => {
        append("capture-chronology.jsonl", { phase: "capture-error", label, error: String(error), code: error.code, signal: error.signal, stdout: error.stdout, stderr: error.stderr });
        throw error;
      });
      const captureFinishedAt = Date.now();
      append("capture-chronology.jsonl", { phase: "capture-return", label, captureStartedAt, captureFinishedAt, ...captureReceipt });
      const after = await probe(`${label}-after`);
      const png = readFileSync(image), raster = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      const stable = raster.width === before.window.bounds.width * before.display.scaleFactor && raster.height === before.window.bounds.height * before.display.scaleFactor
        && JSON.stringify(before.renderer.theme) === JSON.stringify(after.renderer.theme) && JSON.stringify(before.renderer.history) === JSON.stringify(after.renderer.history);
      const imageSha256 = sha(png), chronology = { commandReceivedAt, captureStartedAt, captureFinishedAt, afterObservedAt: after.at };
      writeFileSync(file, JSON.stringify({ evidenceClass: "actual native CG window raster", stable, pixelComparable: false, reason: "No reference comparison; reference geometry/zoom/theme are not established. Stable metadata is not original-image inspection.", chronology, before, after, raster, imageSha256 }, null, 2), { flag: "wx", mode: 0o600 });
      if (!stable) fail("native-capture-changed-or-raster-mismatch", { label, metadata: file });
      if (mode === "capture-sequencing") pendingInspection = { label, image, imageSha256, history: before.renderer.history, captureFinishedAt };
    } else if (command === "inspect") {
      const [captureLabel, imageSha256, query, index, count, section] = values;
      if (mode !== "capture-sequencing" || !pendingInspection || captureLabel !== pendingInspection.label) {
        fail("unexpected-original-image-inspection", { label, values, sequenceStep, pendingInspection });
      }
      const sectionNames = { scrollback: "Native scrollback text", screen: "Captured native screen", saved: "Saved normal screen" };
      const observed = { query, matchIndex: Number(index), matchCount: Number(count), activeSection: sectionNames[section] };
      const actualImageSha256 = sha(readFileSync(pendingInspection.image)), expectedHistory = pendingInspection.history;
      const matches = values.length === 6 && imageSha256 === actualImageSha256 && imageSha256 === pendingInspection.imageSha256
        && observed.query === expectedHistory.query && observed.matchIndex === expectedHistory.matchIndex
        && observed.matchCount === expectedHistory.matchCount && observed.activeSection === expectedHistory.activeSection;
      const inspection = { kind: "operator-original-image-inspection", label, captureLabel, imageSha256, actualImageSha256, observed, expectedHistory,
        matches, captureFinishedAt: pendingInspection.captureFinishedAt, inspectionReportedAt: Date.now(),
        qualification: "Operator-supplied values from viewing this original PNG; never inferred from DOM metadata or stable:true. A match is bounded evidence, not a cause or broad acceptance verdict." };
      writeFileSync(file, JSON.stringify(inspection, null, 2), { flag: "wx", mode: 0o600 });
      append("capture-chronology.jsonl", { phase: "original-image-inspection", ...inspection });
      if (!matches) fail("original-image-does-not-match-captured-state", { label, metadata: file });
      pendingInspection = undefined; sequenceStep++;
    } else throw new Error("Only initial admit, bind, probe, capture and explicit diagnostic inspect are allowed; Main supplies physical input, not synthetic focus or DOM writes.");
    console.log(`Native history Find ${command} ready ${label}`);
  }
}
boot().catch(error => { writeFileSync(join(owner.evidence, `app-failure-${Date.now()}.json`), JSON.stringify({ error: String(error.stack || error), at: Date.now() }, null, 2), { flag: "wx", mode: 0o600 }); console.error(error); app.exit(1); });
