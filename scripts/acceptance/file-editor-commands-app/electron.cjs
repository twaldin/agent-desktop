const { app, nativeTheme, Menu } = require("electron");
const { join } = require("node:path");
const { appendFileSync, writeFileSync, renameSync, existsSync } = require("node:fs");
const output = process.env.FILE_EDITOR_ACCEPTANCE_OUTPUT;
if (!output || !process.env.AGENT_DESKTOP_PROFILE_DIR) throw new Error("Explicit isolated acceptance paths are required.");
const requested = { x: 100, y: 100, width: 1280, height: 850 };
const ownedWindows = new WeakMap();
let popupSequence = 0;
const nativePopup = Menu.prototype.popup;
Menu.prototype.popup = function (...args) {
  const options = args[0], owner = options?.window && ownedWindows.get(options.window);
  if (!owner) return Reflect.apply(nativePopup, this, args);
  const menu = this, popupId = ++popupSequence, itemIds = menu.items.map(item => item.id);
  const recordPopup = (phase, error) => {
    try { appendFileSync(join(output, "native-menu-events.jsonl"), JSON.stringify({
      ...owner, popupId, phase, itemIds, error, wallTime: Date.now(), monotonicNs: process.hrtime.bigint().toString(),
    }) + "\n"); }
    catch (error) { console.error("Native popup observation failed; no completion may be assumed:", error); }
  };
  const shown = () => recordPopup("shown"), closing = () => recordPopup("will-close");
  const cleanup = () => { menu.removeListener("menu-will-show", shown); menu.removeListener("menu-will-close", closing); };
  menu.once("menu-will-show", shown); menu.once("menu-will-close", closing);
  const originalCallback = options.callback;
  const observed = { ...options, callback: function (...callbackArgs) {
    // Native popup completion invokes the unchanged production finish callback
    // exactly once. Its choice, return value and thrown error are never replaced.
    try { return originalCallback?.apply(this, callbackArgs); }
    finally { cleanup(); recordPopup("completed"); }
  } };
  recordPopup("requested");
  try { return Reflect.apply(nativePopup, menu, [observed, ...args.slice(1)]); }
  catch (error) { cleanup(); recordPopup("error", String(error)); throw error; }
};
app.commandLine.appendSwitch("remote-debugging-port", "0");
app.setAppPath(join(process.argv[2], "apps/desktop"));
app.on("session-created", owned => {
  owned.webRequest.onBeforeRequest((details, reply) => {
    const url = new URL(details.url);
    const allowed = ["file:", "data:", "blob:", "devtools:", "chrome-devtools:"].includes(url.protocol)
      || ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!allowed) appendFileSync(join(output, "refused-network.jsonl"), JSON.stringify({ url: details.url, at: Date.now() }) + "\n");
    reply({ cancel: !allowed });
  });
});
app.on("browser-window-created", (_event, window) => {
  const contents = window.webContents, identity = { pid: process.pid, windowId: window.id, webContentsId: contents.id };
  ownedWindows.set(window, identity);
  let inputSequence = 0, windowFocused = window.isFocused(), contentsFocused = contents.isFocused();
  const inputRecord = (type, input) => {
    // Event payload and last reported native focus only. No geometry/renderer
    // query, focus call, prevention or awaited work enters native input dispatch.
    appendFileSync(join(output, "main-input-events.jsonl"), JSON.stringify({ ...identity, sequence: ++inputSequence, type, input,
      windowFocused, contentsFocused, wallTime: Date.now(), monotonicNs: process.hrtime.bigint().toString() }) + "\n");
  };
  inputRecord("created-focus-state");
  if (existsSync(join(output, "observer-admission-only.json"))) {
    let previous = process.hrtime.bigint();
    const heartbeat = phase => {
      const now = process.hrtime.bigint();
      appendFileSync(join(output, "observer-main-heartbeat.jsonl"), JSON.stringify({ ...identity, phase,
        wallTime: Date.now(), monotonicNs: now.toString(), gapNs: (now - previous).toString(),
        intervalMs: 100, windowFocused, contentsFocused }) + "\n");
      previous = now;
    };
    heartbeat("start");
    const timer = setInterval(() => heartbeat("tick"), 100);
    timer.unref();
    window.once("closed", () => { clearInterval(timer); heartbeat("stop"); });
  }
  window.on("focus", () => { windowFocused = true; inputRecord("window-focus"); });
  window.on("blur", () => { windowFocused = false; inputRecord("window-blur"); });
  contents.on("focus", () => { contentsFocused = true; inputRecord("contents-focus"); });
  contents.on("blur", () => { contentsFocused = false; inputRecord("contents-blur"); });
  contents.on("before-input-event", (_event, input) => inputRecord("before-input-event", {
    type: input.type, key: input.key, code: input.code, isAutoRepeat: input.isAutoRepeat, isComposing: input.isComposing,
    shift: input.shift, control: input.control, alt: input.alt, meta: input.meta,
  }));
  const record = () => {
    if (window.isDestroyed()) return;
    const value = { pid: process.pid, windowId: window.id, requested, bounds: window.getBounds(), contentBounds: window.getContentBounds(),
      zoomFactor: window.webContents.getZoomFactor(), zoomLevel: window.webContents.getZoomLevel(), fullscreen: window.isFullScreen(),
      appearance: { source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors },
      webContentsId: contents.id, profile: app.getPath("userData"), executable: process.execPath, at: Date.now() };
    const path = join(output, "main-window.json");
    writeFileSync(path + ".tmp", JSON.stringify(value)); renameSync(path + ".tmp", path);
  };
  window.once("ready-to-show", () => { window.setBounds(requested); record(); });
  window.on("move", record); window.on("resize", record);
  window.webContents.on("did-finish-load", record); window.webContents.on("zoom-changed", record);
  nativeTheme.on("updated", record);
  window.once("closed", () => nativeTheme.off("updated", record));
});
require(join(process.argv[2], "apps/desktop/dist/main.cjs"));
