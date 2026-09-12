import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { build as viteBuild } from "vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? ".data/dock-menu-lifecycle-2026-09-08/controlled/final");
const sources = [
  "apps/desktop/src/renderer/DockPanel.tsx",
  "apps/desktop/src/renderer/dock-panel.css",
  "scripts/acceptance/dock-menu-lifecycle.ts",
  "scripts/acceptance/dock-menu-lifecycle-browser.tsx",
];

if (!existsSync(resolve(repo, "node_modules/electron"))) {
  throw new Error("node_modules/electron is required");
}

if (existsSync(output) && readdirSync(output).length > 0) throw new Error(`Output must be empty: ${output}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const hashes = Object.fromEntries(
  sources.map((source) => [source, createHash("sha256").update(readFileSync(resolve(repo, source))).digest("hex")]),
);
const build = resolve(output, "vite");
const entry = resolve(import.meta.dir, "dock-menu-lifecycle-browser.tsx");
await Bun.write(resolve(output, "index.html"), `<!doctype html><meta charset="utf-8"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}main{display:flex;height:100%;flex-direction:column}main>button{flex:none}.fixture{display:grid;flex:1;min-height:0;grid-template-columns:minmax(0,1fr) 320px;grid-template-rows:minmax(0,1fr) 240px}.dock-panel-right{grid-column:2;grid-row:1 / span 2}.dock-panel-bottom{grid-column:1;grid-row:2}</style><div id="root"></div><script type="module" src="${entry}"></script>`);
await viteBuild({
  configFile: false,
  logLevel: "warn",
  root: output,
  plugins: [react()],
  base: "./",
  build: { outDir: build, emptyOutDir: true, rollupOptions: { input: resolve(output, "index.html") } },
});

const profile = mkdtempSync(resolve(tmpdir(), "dock-menu-lifecycle-"));
const main = resolve(output, "main.cjs");
writeFileSync(main, String.raw`
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const output = process.argv[2];
const page = process.argv[3];
const profile = process.argv[4];
const resultPath = path.join(output, "result.json");
const fail = (message) => { throw new Error(message); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.setPath("userData", profile);
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 700,
    webPreferences: { contextIsolation: false, nodeIntegration: false },
  });
  const js = (source) => win.webContents.executeJavaScript(source, true);
  const state = () => js("dockMenuState()");
  const steps = [];
  const observe = async (name) => { steps.push({ name, state: await state() }); };
  const assert = (condition, message) => { if (!condition) fail(message); };
  const nativeKey = { ArrowDown: "Down", ArrowUp: "Up" };
  const key = async (keyCode) => {
    const code = nativeKey[keyCode] || keyCode;
    win.focus();
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: code });
    if (keyCode.length === 1) win.webContents.sendInputEvent({ type: "char", keyCode });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: code });
    await sleep(80);
  };
  const click = async (selector) => {
    const box = await js("dockMenuTarget(" + JSON.stringify(selector) + ")");
    assert(box, "missing target " + selector);
    win.webContents.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await sleep(100);
  };
  const trigger = (destination) => '[aria-label="Open ' + destination + ' panel tab"]';
  const menuFor = (value, destination) => value.menus.find((menu) => menu.destination === destination);
  const focusTrigger = async (destination) => {
    const selector = trigger(destination);
    const found = await js("document.querySelector(" + JSON.stringify(selector) + ")?.focus(); Boolean(document.activeElement?.matches(" + JSON.stringify(selector) + "))");
    assert(found, "could not focus " + destination + " trigger");
  };
  const openByKey = async (destination, input) => {
    await focusTrigger(destination);
    await key(input);
    const value = await state();
    const menu = menuFor(value, destination);
    assert(menu, input + " did not open " + destination + " menu");
    assert(menu.focused === "Files", input + " did not focus first Files item: " + menu.focused);
    assert(menu.box.left >= 6 && menu.box.top >= 6 && menu.box.right <= 1094 && menu.box.bottom <= 694,
      "menu escaped initial viewport: " + JSON.stringify(menu.box));
    assert(menu.box.width >= 270 && menu.box.width <= 290, "unexpected menu width: " + menu.box.width);
    return value;
  };

  try {
    await win.loadURL(page);
    await sleep(300);

    await openByKey("right", "Enter");
    await observe("right-enter-open");
    await key("End");
    assert((await state()).menus[0].focused === "Browser", "End did not focus Browser");
    await key("ArrowDown");
    assert((await state()).menus[0].focused === "Browser", "ArrowDown wrapped from last item");
    await key("Home");
    assert((await state()).menus[0].focused === "Files", "Home did not focus Files");
    await key("ArrowUp");
    assert((await state()).menus[0].focused === "Files", "ArrowUp wrapped from first item");
    await key("ArrowDown");
    assert((await state()).menus[0].focused === "Review", "ArrowDown did not focus Review");
    await key("ArrowUp");
    assert((await state()).menus[0].focused === "Files", "ArrowUp did not focus Files");
    await key("Tab");
    const tabbed = await state();
    assert(tabbed.menus.length === 1 && tabbed.menus[0].focused === "Files", "Tab escaped open menu");
    await observe("right-keyboard-navigation");
    await key("Escape");
    const escaped = await state();
    assert(escaped.menus.length === 0, "Escape did not close right menu");
    assert(escaped.active.includes("Open right panel tab"), "Escape did not restore right trigger focus: " + escaped.active);
    await observe("right-escape-restored-trigger");

    await openByKey("bottom", "Space");
    await click("#outside");
    const outside = await state();
    assert(outside.menus.length === 0, "outside pointer did not dismiss bottom menu");
    assert(outside.selected.length === 0, "outside pointer selected an action");
    assert(outside.active === "Outside", "outside pointer focus was not preserved: " + outside.active);
    await observe("bottom-outside-dismissed");

    await openByKey("right", "ArrowDown");
    await key("ArrowDown");
    assert((await state()).menus[0].focused === "Review", "Review setup did not move to Review");
    await key("Enter");
    const reviewSelected = await state();
    assert(reviewSelected.selected.length === 1 && reviewSelected.selected[0].id === "Review" && reviewSelected.selected[0].destination === "right" && reviewSelected.selected[0].menuPresent,
      "immediate Review did not dispatch once while menu was open: " + JSON.stringify(reviewSelected.selected));
    await observe("right-review-immediate-selection");

    await openByKey("right", "ArrowDown");
    await key("ArrowDown");
    assert((await state()).menus[0].focused === "Review", "typeahead setup did not move to Review");
    await key("f");
    assert((await state()).menus[0].focused === "Files", "typeahead f did not focus Files");
    await key("Enter");
    const rightSelected = await state();
    assert(rightSelected.selected.length === 2 && rightSelected.selected[1].id === "Files" && rightSelected.selected[1].destination === "right" && !rightSelected.selected[1].menuPresent,
      "right Files selection was not exactly once: " + JSON.stringify(rightSelected.selected));
    await observe("right-files-deferred-selection");

    await openByKey("bottom", "ArrowDown");
    await key("Enter");
    const selected = await state();
    assert(selected.selected.length === 3 && selected.selected[2].id === "Files" && selected.selected[2].destination === "bottom" && !selected.selected[2].menuPresent,
      "bottom Files selection was not exactly once: " + JSON.stringify(selected.selected));
    await observe("bottom-files-deferred-selection");

    await click('[data-app-shell-tab-strip-controller="bottom"] [aria-label="Dock options"]');
    const options = await js("(() => { const strip = document.querySelector('[data-app-shell-tab-strip-controller=\"bottom\"]'); const popup = strip?.querySelector('details.dock-menu[open] > div'); if (!strip || !popup) return null; const stripBox = strip.getBoundingClientRect(), popupBox = popup.getBoundingClientRect(); return { stripTop: stripBox.top, popupTop: popupBox.top, popupBottom: popupBox.bottom }; })()");
    assert(options && options.popupTop < options.stripTop && options.popupBottom <= options.stripTop + 8, "bottom Dock options did not open above its strip: " + JSON.stringify(options));
    await click('[data-app-shell-tab-strip-controller="bottom"] [aria-label="Dock options"]');

    await openByKey("right", "Enter");
    fs.writeFileSync(path.join(output, "menu.png"), await win.webContents.capturePage().then((image) => image.toPNG()));
    win.webContents.debugger.attach("1.3");
    const ax = await win.webContents.debugger.sendCommand("Accessibility.getFullAXTree");
    win.webContents.debugger.detach();
    fs.writeFileSync(path.join(output, "menu.ax.json"), JSON.stringify(ax, null, 2));
    await observe("right-menu-captured");

    await win.setContentSize(360, 420);
    await sleep(100);
    const resized = menuFor(await state(), "right");
    assert(resized, "open menu closed during resize");
    assert(resized.box.left >= 6 && resized.box.right <= 354 && resized.box.top >= 6 && resized.box.bottom <= 414,
      "menu escaped resized viewport: " + JSON.stringify(resized.box));
    await observe("right-menu-resized-while-open");
    await key("Escape");

    fs.writeFileSync(resultPath, JSON.stringify({
      status: "pass",
      source: "green-only production DockPanel via Vite and hidden Electron",
      input: "Electron webContents.sendInputEvent",
      selected: (await state()).selected,
      screenshot: "menu.png",
      accessibility: "menu.ax.json",
      steps,
    }, null, 2));
  } catch (error) {
    fs.writeFileSync(resultPath, JSON.stringify({ status: "fail", error: String(error.stack || error) }, null, 2));
    process.exitCode = 1;
  } finally {
    await win.close();
    app.quit();
  }
});
`);

try {
  const electron = Bun.spawn([process.execPath, resolve(repo, "node_modules/electron/cli.js"), main, output, `file://${resolve(build, "index.html")}`, profile], {
    cwd: profile,
    env: { PATH: "/usr/bin:/bin", HOME: profile, TMPDIR: profile },
    stdout: "inherit",
    stderr: "inherit",
  });
  const timeout = setTimeout(() => electron.kill(), 90_000);
  const exitCode = await electron.exited;
  clearTimeout(timeout);
  if (exitCode !== 0) throw new Error("Electron lifecycle run failed");
} finally {
  rmSync(profile, { recursive: true, force: true });
}

const result = JSON.parse(readFileSync(resolve(output, "result.json"), "utf8"));
const sourceAfterRun = Object.fromEntries(
  sources.map((source) => [source, createHash("sha256").update(readFileSync(resolve(repo, source))).digest("hex")]),
);
result.sourceAtBuild = hashes;
result.sourceAfterRun = sourceAfterRun;
result.sourceHashesStable = JSON.stringify(hashes) === JSON.stringify(sourceAfterRun);
writeFileSync(resolve(output, "result.json"), JSON.stringify(result, null, 2));
writeFileSync(resolve(output, "manifest.json"), JSON.stringify({
  files: sources,
  hashes,
  result: basename(resolve(output, "result.json")),
}, null, 2));
if (result.status !== "pass" || !result.sourceHashesStable) throw new Error(result.error ?? "source changed during run");
