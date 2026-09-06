import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "vite";

const root = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? ".data/composer-selection-popup-controls");
const profile = await mkdtemp(join(tmpdir(), "composer-popup-"));
const sources = [
  "apps/desktop/src/renderer/ComposerSelections.tsx",
  "apps/desktop/src/renderer/ComposerSelectionPopup.tsx",
  "apps/desktop/src/renderer/composer-selection-popup.css",
  "apps/desktop/src/renderer/composer-catalog.test.tsx",
  "scripts/acceptance/composer-selection-popup.ts",
  "scripts/acceptance/composer-selection-popup-browser.tsx",
];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async source => [
  source,
  createHash("sha256").update(await readFile(join(root, source))).digest("hex"),
])));

await mkdir(output, { recursive: true });
const sourceAtBuild = await hashes();
try {
  await writeFile(join(output, "index.html"), `<!doctype html><html><body><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "composer-selection-popup-browser.tsx"))}"></script></body></html>`);
  await build({
    configFile: join(root, "apps/desktop/vite.config.ts"),
    root: output,
    logLevel: "warn",
    build: { outDir: join(output, "web"), emptyOutDir: true, rollupOptions: { input: join(output, "index.html") } },
  });
  await writeFile(join(output, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.setPath("userData", ${JSON.stringify(profile)});
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const evaluate = source => window.webContents.executeJavaScript(source, true);
  const snapshot = () => evaluate("composerSelectionSnapshot()");
  const waitFor = async (read, label, timeout = 8000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) { const value = await read(); if (value) return value; await delay(20); }
    throw new Error("Timed out: " + label);
  };
  const nativeClick = async name => {
    const point = await evaluate("composerSelectionPoint(" + JSON.stringify(name) + ")");
    const zoom = window.webContents.getZoomFactor();
    const x = Math.round(point.x * zoom), y = Math.round(point.y * zoom);
    window.webContents.sendInputEvent({ type: "mouseMove", x, y });
    window.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    await delay(50);
    return { name, observedCssPoint: point, zoom, sentPoint: { x, y } };
  };
  const nativeKey = async keyCode => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await delay(50);
  };
  const capture = async (name, expectedLabel) => {
    await delay(100);
    const geometry = await snapshot();
    if (!geometry.open || geometry.menuLabel !== expectedLabel || !geometry.fitting) throw new Error("Invalid capture state: " + name);
    fs.writeFileSync(path.join(__dirname, name + ".png"), (await window.webContents.capturePage()).toPNG());
    return { name: name + ".png", ...geometry };
  };
  try {
    await window.loadFile(path.join(__dirname, "web/index.html"));
    window.setContentSize(1440, 1000);
    await delay(100);
    await waitFor(async () => (await snapshot()).ready, "fixture ready");
    window.webContents.focus();
    const nativeInputs = [];
    const captures = [];

    nativeInputs.push(await nativeClick("trigger"));
    await waitFor(async () => (await snapshot()).menuLabel === "Composer selections", "wide main menu");
    captures.push(await capture("wide-main", "Composer selections"));
    nativeInputs.push(await nativeClick("power"));
    await nativeKey("End");
    await waitFor(async () => (await snapshot()).patches.some(patch => patch.thinkingLevel === "max"), "native range selection");
    nativeInputs.push(await nativeClick("model-menu"));
    const initialCatalog = await waitFor(async () => { const value = await snapshot(); return value.menuLabel === "Select model" ? value : null; }, "model catalog");
    if (initialCatalog.catalogRows > 100) throw new Error("Initial catalog rendered more than 100 rows: " + initialCatalog.catalogRows);
    if (initialCatalog.activeId !== "Search models") throw new Error("Model catalog did not focus search");
    nativeInputs.push(await nativeClick("search"));
    await window.webContents.insertText("provider-17 m4790");
    await waitFor(async () => (await snapshot()).targetVisible, "full-catalog search target");
    captures.push(await capture("wide-search", "Select model"));
    nativeInputs.push(await nativeClick("target-model"));
    await waitFor(async () => (await snapshot()).patches.some(patch => patch.model === "p17\\0m4790"), "native target model selection");

    nativeInputs.push(await nativeClick("trigger"));
    await waitFor(async () => (await snapshot()).menuLabel === "Composer selections", "main menu after model");
    nativeInputs.push(await nativeClick("auto"));
    await waitFor(async () => (await snapshot()).patches.some(patch => patch.thinkingLevel === "auto"), "native auto selection");
    nativeInputs.push(await nativeClick("trigger"));
    const autoState = await waitFor(async () => { const value = await snapshot(); return value.menuLabel === "Composer selections" ? value : null; }, "main menu after auto");
    if (!autoState.powerDisabled || autoState.powerOutput !== "Select effort" || !autoState.checkedEfforts.includes("auto")) throw new Error("Auto was treated as ordinal reasoning power");
    nativeInputs.push(await nativeClick("off"));
    await waitFor(async () => (await snapshot()).patches.some(patch => patch.thinkingLevel === "off"), "native off selection");
    nativeInputs.push(await nativeClick("trigger"));
    const offState = await waitFor(async () => { const value = await snapshot(); return value.menuLabel === "Composer selections" ? value : null; }, "main menu after off");
    if (!offState.powerDisabled || offState.powerOutput !== "Select effort" || !offState.checkedEfforts.includes("off")) throw new Error("Off was treated as ordinal reasoning power");
    nativeInputs.push(await nativeClick("reset"));
    await waitFor(async () => (await snapshot()).patches.some(patch => patch.model === null && Object.hasOwn(patch, "thinkingLevel")), "combined reset");
    const afterReset = await snapshot();
    if (!afterReset.triggerText?.includes("low")) throw new Error("Collapsed selection did not display the effective native effort after reset");

    nativeInputs.push(await nativeClick("trigger"));
    await waitFor(async () => (await snapshot()).open, "main menu before Escape");
    await nativeKey("Escape");
    await waitFor(async () => !(await snapshot()).open, "Escape dismissal");
    const afterEscape = await snapshot();
    if (afterEscape.activeId !== "Model and reasoning effort") throw new Error("Escape did not restore trigger focus");

    nativeInputs.push(await nativeClick("trigger"));
    await waitFor(async () => (await snapshot()).open, "main menu before outside pointer");
    nativeInputs.push(await nativeClick("outside"));
    await waitFor(async () => !(await snapshot()).open, "outside-pointer dismissal");
    const afterOutside = await snapshot();
    if (afterOutside.activeId !== "outside-target") throw new Error("Outside-pointer dismissal stole focus");

    nativeInputs.push(await nativeClick("trigger"));
    await waitFor(async () => (await snapshot()).open, "main menu before disable");
    const callbacksBeforeDisable = (await snapshot()).patches.length;
    nativeInputs.push(await nativeClick("toggle-disabled"));
    await waitFor(async () => !(await snapshot()).open, "disabled close");
    nativeInputs.push(await nativeClick("trigger"));
    await delay(100);
    const disabledState = await snapshot();
    if (disabledState.open || disabledState.patches.length !== callbacksBeforeDisable) throw new Error("Disabled control opened or invoked a callback");

    const behavior = await evaluate("composerSelectionResult()");

    await window.loadFile(path.join(__dirname, "web/index.html"));
    window.setContentSize(760, 1000);
    window.webContents.setZoomFactor(1.5);
    await delay(150);
    await waitFor(async () => (await snapshot()).ready, "narrow fixture ready");
    nativeInputs.push(await nativeClick("trigger"));
    await waitFor(async () => (await snapshot()).menuLabel === "Composer selections", "narrow main menu");
    captures.push(await capture("narrow150-main", "Composer selections"));
    nativeInputs.push(await nativeClick("model-menu"));
    const narrowCatalog = await waitFor(async () => { const value = await snapshot(); return value.menuLabel === "Select model" ? value : null; }, "narrow model catalog");
    if (narrowCatalog.catalogRows > 100) throw new Error("Narrow initial catalog rendered more than 100 rows: " + narrowCatalog.catalogRows);
    if (narrowCatalog.activeId !== "Search models") throw new Error("Narrow model catalog did not focus search");
    nativeInputs.push(await nativeClick("search"));
    await window.webContents.insertText("provider-17 m4790");
    await waitFor(async () => (await snapshot()).targetVisible, "narrow full-catalog search target");
    captures.push(await capture("narrow150-search", "Select model"));

    const result = {
      ...behavior,
      passed: behavior.passed && captures.length === 4 && captures.every(scene => scene.fitting),
      initialCatalogRows: initialCatalog.catalogRows,
      narrowInitialCatalogRows: narrowCatalog.catalogRows,
      target: { provider: "provider-17", id: "m4790", value: "p17\\0m4790" },
      captures,
      nativeInputs,
      electron: process.versions.electron,
      hidden: true,
      scope: "Actual ComposerSelectionPopup in controlled hidden Electron; no provider, host, credential, or installed-app action. Native Electron mouse/key input covers trigger and selection; captures are controlled Electron surfaces, not native macOS windows or Codex parity proof."
    };
    fs.writeFileSync(path.join(__dirname, "result.json"), JSON.stringify(result, null, 2));
    window.destroy();
    app.exit(result.passed ? 0 : 1);
  } catch (error) {
    const progress = await snapshot().catch(() => null);
    fs.writeFileSync(path.join(__dirname, "failure.png"), (await window.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(__dirname, "result.json"), JSON.stringify({ passed: false, error: String(error), progress }, null, 2));
    window.destroy();
    app.exit(1);
  }
});
`);

  const child = Bun.spawn([process.execPath, join(root, "node_modules/electron/cli.js"), join(output, "main.cjs")], {
    stdout: Bun.file(join(output, "electron.log")),
    stderr: Bun.file(join(output, "electron-errors.log")),
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 90_000);
  const code = await child.exited;
  clearTimeout(timer);
  let result: Record<string, any>;
  try {
    result = await Bun.file(join(output, "result.json")).json();
  } catch (error) {
    result = { passed: false, error: `Missing or invalid child result: ${String(error)}` };
  }
  result.childExitCode = code;
  result.timedOut = timedOut;
  result.sourceAtBuild = sourceAtBuild;
  result.sourceAfter = await hashes();
  result.sourceHashesStable = JSON.stringify(result.sourceAtBuild) === JSON.stringify(result.sourceAfter);
  result.passed = Boolean(result.passed && code === 0 && !timedOut && result.sourceHashesStable);
  await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ passed: result.passed, captures: result.captures?.length, sourceHashesStable: result.sourceHashesStable, result: join(output, "result.json") }));
  if (!result.passed) throw new Error(`Composer popup acceptance failed; inspect ${join(output, "result.json")}`);
} finally {
  await rm(profile, { recursive: true, force: true });
}
