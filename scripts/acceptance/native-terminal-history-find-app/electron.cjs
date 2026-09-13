const { app, BrowserWindow, ipcMain, nativeTheme, screen, session } = require("electron");
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createInterface } = require("node:readline");
const { basename, isAbsolute, join, resolve } = require("node:path");
const root = resolve(process.argv[2] || ""), repo = resolve(process.argv[3] || "");
if (!process.argv[2] || !process.argv[3] || !basename(root).startsWith("native-history-find-") || process.env.HOME !== root
  || process.env.AGENT_DESKTOP_DATA_DIR !== join(root, "host") || process.env.AGENT_DESKTOP_PROFILE_DIR !== join(root, "desktop")
  || process.env.PI_CODING_AGENT_DIR !== join(root, "agent") || process.env.PI_DISABLE_DOTENV !== "1" || process.env.PATH?.split(":")[0] !== join(root, "bin")
  || process.env.AGENT_DESKTOP_BUN !== join(root, "bin/guarded-bun")) throw new Error("Exact isolated native Find launch environment required.");
const owner = JSON.parse(readFileSync(join(root, "fixture-owner.json"), "utf8"));
if (owner.root !== root || owner.repo !== repo || process.env.NATIVE_FIND_HOST_ENTRY !== owner.hostEntry) throw new Error("Owned fixture mismatch.");
const inspector = process.env.NATIVE_FIND_INSPECTOR, yabai = process.env.NATIVE_FIND_YABAI;
if (!inspector || !isAbsolute(inspector) || !yabai || !isAbsolute(yabai)) throw new Error("Main must supply verified absolute native inspector and yabai paths.");
const sha = value => createHash("sha256").update(value).digest("hex");
const stableTheme = renderer => JSON.stringify({ root: renderer.theme.root, body: renderer.theme.body, source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors });
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
    writeFileSync(join(owner.evidence, "app-ready.json"), JSON.stringify({ pid: process.pid, source: owner.source, url: window.webContents.getURL(), bounds: window.getBounds(),
      executable: { path: process.execPath, sha256: sha(readFileSync(process.execPath)), versions: process.versions }, compiled, at: Date.now() }, null, 2), { flag: "wx", mode: 0o600 });
    console.log("Native history Find actual App ready; no input until peer0 and bound geometry probe");
  });
});
function ownedWindow() {
  const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.webContents.getURL().startsWith("file:"));
  if (windows.length !== 1) fail("ambiguous-actual-app-window");
  return windows[0];
}
async function probe(label, requireBinding = true) {
  const window = ownedWindow();
  const cg = JSON.parse(execFileSync(inspector, ["metadata", String(process.pid)], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }));
  const owned = cg.windows.filter(value => value.kCGWindowOwnerPID === process.pid && value.kCGWindowIsOnscreen && value.kCGWindowLayer === 0);
  if (!cg.accessibilityPermission || !cg.screenCapturePermission || owned.length !== 1) fail("native-permission-or-window-binding");
  const native = owned[0], bounds = window.getBounds(), contentBounds = window.getContentBounds();
  const manager = JSON.parse(execFileSync(yabai, ["-m", "query", "--windows", "--window", String(native.kCGWindowNumber)], { encoding: "utf8" }));
  const ax = execFileSync("/usr/bin/osascript", ["-e", `tell application "System Events"
set ownedProcess to first application process whose unix id is ${process.pid}
tell ownedProcess
if (count of windows) is not 1 then error "Ambiguous owned AX window"
set p to position of window 1
set s to size of window 1
return {item 1 of p, item 2 of p, item 1 of s, item 2 of s}
end tell
end tell`], { encoding: "utf8" }).trim().split(",").map(Number);
  const renderer = await window.webContents.executeJavaScript(`(() => {
    const visible = node => node.getClientRects().length && !node.closest('[hidden]');
    const history = [...document.querySelectorAll('.native-terminal-history')].find(visible);
    const css = node => { const s = getComputedStyle(node); return { colorScheme:s.colorScheme, background:s.backgroundColor, color:s.color, fontFamily:s.fontFamily, fontSize:s.fontSize, lineHeight:s.lineHeight }; };
    return { url:location.href, screenX, screenY, width:innerWidth, height:innerHeight, aspect:innerWidth/innerHeight, dpr:devicePixelRatio,
      visualViewport:visualViewport && { width:visualViewport.width, height:visualViewport.height, scale:visualViewport.scale },
      theme:{ rootClass:document.documentElement.className, rootData:{...document.documentElement.dataset}, root:css(document.documentElement), body:css(document.body), terminal:history?css(history):null },
      active:{ tag:document.activeElement?.tagName, label:document.activeElement?.getAttribute('aria-label'), text:document.activeElement?.textContent?.slice(0,160) },
      history:history && { busy:history.getAttribute('aria-busy')==='true', terminalView:history.closest('.native-terminal-view')?.id, generation:history.dataset.historyGeneration, revision:history.dataset.historyRevision, capturedAt:history.dataset.historyCapturedAt,
        query:history.querySelector('input[type=search]')?.value, status:history.querySelector('.native-terminal-history-find-status')?.textContent,
        activeMatch:history.querySelector('mark[aria-current=true]')?.textContent,
        sections:[...history.querySelectorAll('pre')].map(node=>({label:node.getAttribute('aria-label'),text:node.textContent,style:css(node)})) } };
  })()`);
  if (renderer.history) renderer.history.sections = renderer.history.sections.map(({ text, ...value }) => ({ ...value, textLength: text.length, textSha256: sha(text) }));
  const b = native.kCGWindowBounds, display = screen.getDisplayMatching(bounds), zoomFactor = window.webContents.getZoomFactor();
  if (manager.id !== native.kCGWindowNumber || manager.pid !== process.pid || !manager["has-ax-reference"] || !manager["is-floating"] || manager["is-native-fullscreen"] || window.isFullScreen()
    || b.X !== bounds.x || b.Y !== bounds.y || b.Width !== bounds.width || b.Height !== bounds.height
    || manager.frame.x !== bounds.x || manager.frame.y !== bounds.y || manager.frame.w !== bounds.width || manager.frame.h !== bounds.height
    || renderer.url !== new URL("file://" + join(repo, "apps/desktop/dist/renderer/index.html")).href
    || ax.length !== 4 || ax.some((value, i) => value !== [bounds.x, bounds.y, bounds.width, bounds.height][i])
    || renderer.screenX !== bounds.x || renderer.screenY !== bounds.y || renderer.visualViewport?.scale !== 1
    || renderer.width * zoomFactor !== contentBounds.width || renderer.height * zoomFactor !== contentBounds.height
    || renderer.dpr !== display.scaleFactor * zoomFactor) fail("actual-geometry-zoom-or-floating-drift", { label, cg, ax, manager, bounds, contentBounds, renderer, zoomFactor });
  if (requireBinding && (!expected || !appPeerObserved || expected.pid !== process.pid || expected.cgWindow !== native.kCGWindowNumber
    || JSON.stringify(expected.bounds) !== JSON.stringify(bounds) || expected.space !== manager.space || expected.display !== manager.display
    || expected.zoomFactor !== zoomFactor || expected.width !== renderer.width || expected.height !== renderer.height
    || expected.theme !== stableTheme(renderer))) fail("input-capture-preflight-not-bound", { label, expected, cg, ax, manager, bounds, contentBounds, renderer, zoomFactor, appPeerObserved });
  return { label, pid: process.pid, cgWindow: native.kCGWindowNumber, cg, ax: { x: ax[0], y: ax[1], width: ax[2], height: ax[3] },
    window: { bounds, contentBounds, aspect: bounds.width / bounds.height, fullscreen: window.isFullScreen(), zoomFactor, zoomLevel: window.webContents.getZoomLevel() },
    display, manager, renderer, nativeTheme: { source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }, appPeerObserved, at: Date.now() };
}
async function boot() {
  const connection = JSON.parse(readFileSync(join(root, "host/connection.json"), "utf8"));
  if (!loopback(new URL(connection.origin))) fail("nonloopback-owning-host");
  const response = await fetch(connection.origin + "/v1/peers", { headers: { Authorization: `Bearer ${connection.token}` } });
  const peers = await response.json();
  if (!response.ok || !Array.isArray(peers.hosts) || peers.hosts.length !== 0) fail("prelaunch-nonzero-peers");
  append("prelaunch-peer-observations.jsonl", { status: peers.status, discoveredPeers: peers.hosts.length });
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const url = new URL(details.url);
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !loopback(url)) {
      appendFileSync(join(root, "guard-violations.jsonl"), JSON.stringify({ kind: "chromium-nonloopback-request", origin: url.origin, at: Date.now() }) + "\n", { mode: 0o600 });
      callback({ cancel: true }); return;
    }
    callback({});
  });
  // Actual production main owns the ordinary window, preload, bridge, App and terminal view.
  require(join(repo, "apps/desktop/dist/main.cjs"));
  for await (const line of createInterface({ input: process.stdin, terminal: false })) {
    const [command, label, width, height, zoom = "1"] = line.trim().split(/\s+/);
    if (!command) continue;
    if (!label || !/^[a-zA-Z0-9_-]{1,80}$/.test(label)) throw new Error("Every probe/capture/bind needs a unique safe label.");
    const file = join(owner.evidence, `${label}.json`);
    if (existsSync(file)) throw new Error("Frozen evidence labels cannot be reused.");
    if (command === "bind") {
      const observed = await probe(label, false);
      if (!appPeerObserved || observed.window.bounds.width !== Number(width) || observed.window.bounds.height !== Number(height) || observed.window.zoomFactor !== Number(zoom)) fail("requested-layout-not-actually-observed");
      expected = { pid: process.pid, cgWindow: observed.cgWindow, bounds: observed.window.bounds, space: observed.manager.space, display: observed.manager.display,
        zoomFactor: observed.window.zoomFactor, width: observed.renderer.width, height: observed.renderer.height, theme: stableTheme(observed.renderer) };
      writeFileSync(file, JSON.stringify({ kind: "actual-layout-binding", observed, expected }, null, 2), { flag: "wx", mode: 0o600 });
    } else if (command === "probe") writeFileSync(file, JSON.stringify(await probe(label), null, 2), { flag: "wx", mode: 0o600 });
    else if (command === "capture") {
      const before = await probe(`${label}-before`), image = join(owner.evidence, `${label}.png`);
      if (existsSync(image)) throw new Error("Frozen native capture cannot be overwritten.");
      execFileSync("/usr/sbin/screencapture", ["-x", "-o", "-l", String(before.cgWindow), image]);
      const after = await probe(`${label}-after`);
      const png = readFileSync(image), raster = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      const stable = raster.width === before.window.bounds.width * before.display.scaleFactor && raster.height === before.window.bounds.height * before.display.scaleFactor
        && JSON.stringify(before.renderer.theme) === JSON.stringify(after.renderer.theme) && JSON.stringify(before.renderer.history) === JSON.stringify(after.renderer.history);
      writeFileSync(file, JSON.stringify({ evidenceClass: "actual native CG window raster", stable, pixelComparable: false, reason: "No reference comparison; reference geometry/zoom/theme are not established.", before, after, raster, imageSha256: sha(png) }, null, 2), { flag: "wx", mode: 0o600 });
      if (!stable) fail("native-capture-changed-or-raster-mismatch", { label, metadata: file });
    } else throw new Error("Only bind, probe and capture are allowed; Main supplies physical input, not synthetic focus or DOM writes.");
    console.log(`Native history Find ${command} ready ${label}`);
  }
}
boot().catch(error => { writeFileSync(join(owner.evidence, `app-failure-${Date.now()}.json`), JSON.stringify({ error: String(error.stack || error), at: Date.now() }, null, 2), { flag: "wx", mode: 0o600 }); console.error(error); app.exit(1); });
