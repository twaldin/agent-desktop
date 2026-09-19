import { appendFile, readFile, realpath, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, extname, join, resolve as resolvePath } from "node:path";
import { userInfo } from "node:os";
import type { exerciseSymbolNavigationApp } from "../symbol-navigation-app";

type Page = Parameters<typeof exerciseSymbolNavigationApp>[0];
type Bounds = { x: number; y: number; width: number; height: number };
type Native = { pid: number; windowId: number; cgBounds: Bounds; axBounds: Bounds; frontmost: boolean; display: { id: number; scale: number; mode: { width: number; height: number; pixelWidth: number; pixelHeight: number } }; binary: string };
type MainWindow = { pid: number; windowId: number; webContentsId: number; requested: Bounds; bounds: Bounds; contentBounds: Bounds; zoomFactor: number; zoomLevel: number; profile: string; executable: string; appearance: { source: string; dark: boolean } };
type Manager = { id: number; pid: number; space: number; display: number; frame: Bounds; "is-floating": boolean; "is-native-fullscreen": boolean };
type MenuReceipt = { pid: number; windowId: number; webContentsId: number; popupId: number; phase: string; itemIds: string[] };
type Chord = { key: string; modifiers?: string[] };
type PointerButton = "left" | "right";
type Modifier = "Meta" | "Control" | "Shift" | "Alt";
type PointerPoint = { x: number; y: number; button: PointerButton; modifiers?: Modifier[] };
type NativeRequest = { operation: "keys"; chords: Chord[] } | { operation: "pointer"; point: PointerPoint };
// The append-only owner ledger is authoritative; filesystem notifications are
// not a completion guarantee. Read it under the same bounded state-wait contract.
export type MenuObservationTrace = {
  observationSequence: number; routingObserverPID: number | null; directory: string; ledger: string; createdAt: number;
  strategy: "bounded-authoritative-ledger"; intervalMs: number;
  reads: Array<{ owned: number; result: "selected" | "pending" | "threw"; error: string | null; at: number }>;
  cancels: Array<{ reason: string; stopped: boolean; at: number }>;
  timer: { armedAt: number; deadlineAt: number; firedAt: number | null; clearedAt: number | null };
  timeout: { at: number; ledger: Record<string, unknown>; select: { result: "selected" | "pending" | "threw"; error: string | null } } | null;
  outcome: "selected" | "failed" | null;
};
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function number(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function bounds(value: unknown): value is Bounds { return record(value) && number(value.x) && number(value.y) && number(value.width) && number(value.height) && value.width > 0 && value.height > 0; }
function parseNative(value: unknown): Native {
  if (!record(value) || !number(value.pid) || !number(value.windowId) || !bounds(value.cgBounds) || !bounds(value.axBounds) || typeof value.frontmost !== "boolean"
    || !record(value.display) || !number(value.display.id) || !number(value.display.scale) || value.display.scale <= 0 || typeof value.binary !== "string"
    || !record(value.display.mode) || !number(value.display.mode.width) || value.display.mode.width <= 0 || !number(value.display.mode.height) || value.display.mode.height <= 0
    || !number(value.display.mode.pixelWidth) || value.display.mode.pixelWidth <= 0 || !number(value.display.mode.pixelHeight) || value.display.mode.pixelHeight <= 0) throw new Error("Invalid native geometry record.");
  return { ...value, pid: value.pid, windowId: value.windowId, cgBounds: value.cgBounds, axBounds: value.axBounds, frontmost: value.frontmost,
    display: { ...value.display, id: value.display.id, scale: value.display.scale,
      mode: { width: value.display.mode.width, height: value.display.mode.height, pixelWidth: value.display.mode.pixelWidth, pixelHeight: value.display.mode.pixelHeight } }, binary: value.binary };
}
function parseManager(value: unknown): Manager {
  if (!record(value) || !number(value.id) || !number(value.pid) || !number(value.space) || !number(value.display) || !record(value.frame)
    || !number(value.frame.x) || !number(value.frame.y) || !number(value.frame.w) || value.frame.w <= 0 || !number(value.frame.h) || value.frame.h <= 0
    || typeof value["is-floating"] !== "boolean" || typeof value["is-native-fullscreen"] !== "boolean") throw new Error("Invalid owned window-manager geometry.");
  return { ...value, id: value.id, pid: value.pid, space: value.space, display: value.display, frame: { x: value.frame.x, y: value.frame.y, width: value.frame.w, height: value.frame.h }, "is-floating": value["is-floating"], "is-native-fullscreen": value["is-native-fullscreen"] };
}
function parseMain(value: unknown): MainWindow {
  if (!record(value) || !number(value.pid) || !number(value.windowId) || !number(value.webContentsId) || !bounds(value.requested) || !bounds(value.bounds) || !bounds(value.contentBounds)
    || !number(value.zoomFactor) || value.zoomFactor <= 0 || !number(value.zoomLevel) || typeof value.profile !== "string" || typeof value.executable !== "string"
    || !record(value.appearance) || typeof value.appearance.source !== "string" || typeof value.appearance.dark !== "boolean") throw new Error("Invalid actual main-window geometry.");
  return { ...value, pid: value.pid, windowId: value.windowId, webContentsId: value.webContentsId, requested: value.requested, bounds: value.bounds, contentBounds: value.contentBounds,
    zoomFactor: value.zoomFactor, zoomLevel: value.zoomLevel, profile: value.profile, executable: value.executable, appearance: { source: value.appearance.source, dark: value.appearance.dark } };
}
export class HelperRefusal extends Error {
  constructor(readonly status: number, readonly retryable: boolean, message: string) { super(message); }
}

export async function calibrateNativeGeometry(sample: (stage: string) => Promise<string>): Promise<(stage: string) => Promise<void>> {
  const deadline = Date.now() + 5000;
  let baseline: string;
  for (;;) {
    try { baseline = await sample("calibration"); break; }
    catch (error) {
      if (!(error instanceof HelperRefusal) || !error.retryable || Date.now() >= deadline) throw error;
      await Bun.sleep(50);
      if (Date.now() >= deadline) throw error;
    }
  }
  return async stage => {
    if (await sample(stage) !== baseline) throw new Error("Geometry drifted from the calibrated scenario. No input/capture may continue.");
  };
}

export async function prepareFileEditorGeometry(page: Page, context: { pid: number; executable: string; output: string; fixture: string }) {
  const probe = process.env.FILE_EDITOR_GEOMETRY_PROBE;
  if (!probe) throw new Error("Main must compile native.swift and supply FILE_EDITOR_GEOMETRY_PROBE after granting the owned UI lease.");
  const username = userInfo().username;
  const helperEnv: Record<string, string> = { HOME: context.fixture, TMPDIR: join(context.fixture, "tmp"), USER: username, LOGNAME: username, PATH: `${join(context.fixture, "bin")}:${process.env.PATH ?? ""}`, FILE_EDITOR_ACCEPTANCE_OUTPUT: context.output };
  const command = async (args: string[], timeout = 5000): Promise<unknown> => {
    const result = Bun.spawnSync(args, { env: helperEnv, timeout, killSignal: "SIGKILL" });
    if (result.exitCode) {
      const stderr = result.stderr.toString();
      let diagnostic: unknown = stderr;
      try { diagnostic = JSON.parse(stderr); } catch { /* Preserve non-JSON CLI refusals verbatim. */ }
      const retryable = args[0] === probe && args[1] === "inspect" && result.exitCode === 75 && record(diagnostic) && diagnostic.status === "refused"
        && diagnostic.pid === context.pid && diagnostic.retryable === true && ["cg-pending", "ax-pending", "ax-list", "ax-attribute", "geometry-pending"].includes(String(diagnostic.stage))
        && (args.length === 3 || (args.length === 4 && diagnostic.windowId === Number(args[3])));
      await appendFile(join(context.output, "helper-refusals.jsonl"), JSON.stringify({ pid: context.pid, command: args[0], operation: args[1], status: result.exitCode, retryable, diagnostic, at: Date.now() }) + "\n");
      throw new HelperRefusal(result.exitCode, retryable, `${args[0]} refused the owned operation: ${stderr}`);
    }
    return JSON.parse(result.stdout.toString());
  };
  const startupDeadline = Date.now() + 5000, mainPath = join(context.output, "main-window.json"), fixtureRoot = await realpath(context.fixture);
  let initial: Native | undefined;
  while (!initial) {
    if (!await Bun.file(mainPath).exists()) {
      await appendFile(join(context.output, "owner-startup.jsonl"), JSON.stringify({ stage: "main-pending", expectedPid: context.pid, at: Date.now() }) + "\n");
      if (Date.now() >= startupDeadline) throw new Error("The owned main process did not publish its window identity before the startup deadline.");
      await Bun.sleep(50); continue;
    }
    const main = parseMain(JSON.parse(await readFile(mainPath, "utf8")));
    const executable = await realpath(main.executable), profile = await realpath(main.profile);
    await appendFile(join(context.output, "owner-startup.jsonl"), JSON.stringify({ stage: "main-owner", expectedPid: context.pid, expectedExecutable: context.executable, main, executable, profile, at: Date.now() }) + "\n");
    if (main.pid !== context.pid || executable !== context.executable || !profile.startsWith(fixtureRoot + "/")) throw new Error("The spawned Electron PID, executable or private profile differs from the actual main-window record. No replacement owner was selected.");
    const remaining = startupDeadline - Date.now();
    if (remaining <= 0) throw new Error("The verified native owner did not become ready before the startup deadline.");
    try { initial = parseNative(await command([probe, "inspect", String(context.pid)], remaining)); }
    catch (error) {
      if (!(error instanceof HelperRefusal) || !error.retryable || Date.now() >= startupDeadline) throw error;
      await Bun.sleep(50);
    }
  }
  await appendFile(join(context.output, "owner-startup.jsonl"), JSON.stringify({ stage: "unique-native-owner", expectedPid: context.pid, native: initial, at: Date.now() }) + "\n");
  const windowId = initial.windowId;
  const wm = async () => parseManager(await command(["yabai", "-m", "query", "--windows", "--window", String(windowId)]));
  const identified = await wm();
  if (identified.id !== windowId || identified.pid !== context.pid) throw new Error("Window-manager ownership differs from the actual CG PID/window.");
  if (!identified["is-floating"]) {
    const result = Bun.spawnSync(["yabai", "-m", "window", String(windowId), "--toggle", "float"], { env: helperEnv });
    if (result.exitCode) throw new Error("Could not float only the owned window.");
  }
  const requested: Bounds = { x: 100, y: 100, width: 1280, height: 850 };
  for (const args of [["--move", "abs:100:100"], ["--resize", "abs:1280:850"]]) {
    const result = Bun.spawnSync(["yabai", "-m", "window", String(windowId), ...args], { env: helperEnv });
    if (result.exitCode) throw new Error("Could not calibrate the owned window.");
  }
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  let serial = 0, editorFontBaseline: string | undefined;
  const sample = async (stage: string) => {
    const [native, manager, main, renderer] = await Promise.all([
      command([probe, "inspect", String(context.pid), String(windowId)]).then(parseNative), wm(),
      readFile(join(context.output, "main-window.json"), "utf8").then(text => parseMain(JSON.parse(text))),
      page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const editorFonts = [...document.querySelectorAll<HTMLElement>(".pierre-source-editor-frame[data-symbol-owner]")].flatMap(frame => {
          const input = frame.querySelector("diffs-container")?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]');
          if (!input?.isConnected) return [];
          const computed = getComputedStyle(input);
          const font = { family: computed.fontFamily, size: computed.fontSize, weight: computed.fontWeight, style: computed.fontStyle,
            lineHeight: computed.lineHeight, letterSpacing: computed.letterSpacing, features: computed.fontFeatureSettings, variations: computed.fontVariationSettings };
          return [{ owner: frame.dataset.symbolOwner, label: input.getAttribute("aria-label"), visible: frame.getClientRects().length > 0,
            font, loaded: document.fonts.check(`${font.style} ${font.weight} ${font.size} ${font.family}`) }];
        });
        return { innerWidth, innerHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
          aspect: innerWidth / innerHeight, dpr: devicePixelRatio, visual: visualViewport && { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale, x: visualViewport.offsetLeft, y: visualViewport.offsetTop },
          documentHasFocus: document.hasFocus(),
          theme: document.documentElement.getAttribute("data-theme"), colorScheme: style.colorScheme, resolvedPrefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
          fontsReady: document.fonts.status === "loaded", editorFonts, fontObservation: editorFonts.some(value => value.visible) ? "visible-original-inputs" : "no-visible-original-input",
          font: style.fontFamily, codeFontToken: style.getPropertyValue("--code-font-family"), codeSize: style.getPropertyValue("--code-font-size"), codeLineHeight: style.getPropertyValue("--code-line-height") };
      }),
    ]);
    const value = { serial: ++serial, stage, requested, native, manager, main, renderer, at: Date.now(), comparison: "Unmatched reference conditions; no pixel-parity claim." };
    await appendFile(join(context.output, "geometry.jsonl"), JSON.stringify(value) + "\n");
    if (native.pid !== context.pid || native.windowId !== windowId || manager.pid !== context.pid || manager.id !== windowId || main.pid !== context.pid
      || !native.frontmost || !manager["is-floating"] || manager["is-native-fullscreen"] || !main.profile.startsWith(context.fixture + "/")
      || native.binary !== main.executable) throw new Error("Owned native geometry/profile/foreground state changed; input stopped.");
    const equal = (a: Bounds, b: Bounds) => ["x", "y", "width", "height"].every(key => a[key as keyof Bounds] === b[key as keyof Bounds]);
    if (!equal(native.cgBounds, requested) || !equal(native.axBounds, requested) || !equal(main.bounds, requested) || !equal(manager.frame, requested)
      || Math.abs(main.contentBounds.width / main.zoomFactor - renderer.innerWidth) > 1 || Math.abs(main.contentBounds.height / main.zoomFactor - renderer.innerHeight) > 1
      || Math.abs(native.display.scale * main.zoomFactor - renderer.dpr) > 0.01) throw new Error("Native and renderer geometry do not agree with the declared scenario.");
    const { editorFonts, fontObservation: _fontObservation, documentHasFocus: _documentHasFocus, ...rendererGeometry } = renderer;
    const visibleFonts = editorFonts.filter(value => value.visible);
    if (visibleFonts.length) {
      if (!renderer.fontsReady || visibleFonts.some(value => !value.loaded)) throw new Error("The actual original editor fonts are not ready; input stopped.");
      const signature = JSON.stringify([...new Set(visibleFonts.map(value => JSON.stringify(value.font)))].sort());
      if (editorFontBaseline === undefined) editorFontBaseline = signature;
      else if (signature !== editorFontBaseline) throw new Error("The original editor's computed font settings changed from its first calibrated visible sample.");
    }
    if (main.appearance.source === "system" && main.appearance.dark !== renderer.resolvedPrefersDark) throw new Error("Native system appearance and the renderer's resolved dark state disagree.");
    return JSON.stringify({ bounds: native.cgBounds, display: native.display, space: manager.space, zoom: [main.zoomFactor, main.zoomLevel], appearance: main.appearance, renderer: rendererGeometry });
  };
  const check = await calibrateNativeGeometry(sample);
  let depth = 0;
  const guard = (owner: object, name: string, capture = false) => {
    const object = owner as Record<string, (...args: unknown[]) => Promise<unknown>>, original = object[name]!.bind(owner);
    object[name] = async (...args) => {
      if (depth) return original(...args);
      await check(name + ":before"); depth++;
      try { return await original(...args); }
      finally { depth--; if (capture) await check(name + ":after"); }
    };
  };
  for (const name of ["click", "down", "up", "move", "wheel"]) guard(page.mouse, name);
  for (const name of ["down", "up", "press", "type", "sendCharacter"]) guard(page.keyboard, name);
  guard(page, "screenshot", true);
  let routingCheck: (() => void) | undefined, routingObserverPID: number | null = null;
  const observedRoutes: Record<string, unknown>[] = [];
  const routeListeners = new Set<(receipt: Record<string, unknown>) => void>();
  const emitNative = async (request: NativeRequest, continuation?: { after: Chord[]; subscribe: (signal: () => void) => () => void }) => {
    const tag = helperEnv.FILE_EDITOR_NATIVE_TRACE_TAG;
    if (!routingCheck || !tag) throw new Error("Native sender ownership requires an active tagged routing observer.");
    if (continuation && request.operation !== "keys") throw new Error("Only key chords may continue after the original owner's focus.");
    routingCheck();
    const pointer = request.operation === "pointer" ? request.point : undefined;
    const args = [probe, continuation ? "focus-sequence" : request.operation, String(context.pid), String(windowId),
      JSON.stringify(request.operation === "keys" ? request.chords : request.point)];
    if (continuation) args.push(JSON.stringify(continuation.after));
    const child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: helperEnv });
    let signalled = false;
    const unsubscribe = continuation?.subscribe(() => {
      if (!signalled) { signalled = true; child.stdin.write("focus\n"); void child.stdin.flush(); }
    });
    const deadline = setTimeout(() => child.kill(continuation ? "SIGTERM" : "SIGKILL"), continuation ? 25_000 : 5000);
    const stderr = new Response(child.stderr).text(), reader = child.stdout.getReader(), decoder = new TextDecoder();
    let listener: ((receipt: Record<string, unknown>) => void) | undefined, acknowledged: Record<string, unknown> | undefined, failure: unknown;
    try {
      let stdout = "";
      while (!stdout.includes("\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("The native sender exited before its complete post report.");
        stdout += decoder.decode(value, { stream: true });
      }
      const result: unknown = JSON.parse(stdout);
      await appendFile(join(context.output, "native-batches.jsonl"), JSON.stringify(result) + "\n");
      if (!record(result) || result.pid !== context.pid || result.windowId !== windowId || result.senderPID !== child.pid
        || result.traceTag !== tag || result.senderLifetime !== "observer-ack" || !Array.isArray(result.events)
        || result.trigger !== (continuation ? "passive-original-owner-focus" : "transaction-start")
        || result.unpaused !== !continuation || (continuation && !signalled)) throw new Error("The native sender report has a different owner or input phase.");
      const final: unknown = result.events.at(-1);
      if (!record(final) || final.sourceUserData !== tag || typeof final.eventTimestamp !== "string"
        || !number(final.eventType) || !number(final.keyCode) || !number(final.flags)) throw new Error("The actual final posted event has no safely observable fixture tag or identity.");
      // A pointer batch is the requested modifier presses, exactly one move/down/up
      // of the requested button, then the releases in reverse. Its ACK event is the
      // actual mouse-up (fingerprint carries the button number) unless modifiers were
      // requested; then the ACK is the first modifier's final release.
      const modifiers = pointer?.modifiers ?? [];
      if (pointer) {
        const up: unknown = result.events[modifiers.length + 2];
        if (result.events.length !== 3 + 2 * modifiers.length || result.button !== pointer.button
          || !Array.isArray(result.modifiers) || result.modifiers.length !== modifiers.length || !result.modifiers.every((name: unknown, index) => name === modifiers[index])
          || !record(up) || up.phase !== "up" || up.eventType !== (pointer.button === "left" ? 2 : 4) || up.mouseButton !== (pointer.button === "left" ? 0 : 1) || up.clickState !== 1
          || (modifiers.length === 0 ? final !== up : final.phase !== "modifier-up" || final.key !== modifiers[0] || final.eventType !== 12 || final.flags !== 0)) {
          throw new Error("The native pointer report is not one modified move/down/up batch for the requested button.");
        }
      }
      const button = pointer && modifiers.length === 0 ? final.mouseButton : undefined;
      // Sender and routed timestamps differ. Require an unambiguous final
      // fingerprint instead of rewriting event metadata to force correlation.
      if (result.events.filter(event => record(event) && event.sourceUserData === final.sourceUserData
        && event.eventType === final.eventType && event.keyCode === final.keyCode && event.flags === final.flags).length !== 1) {
        throw new Error("The native batch's final event fingerprint is ambiguous.");
      }
      let receive!: (receipt: Record<string, unknown>) => void;
      const observed = new Promise<Record<string, unknown>>(resolve => { receive = resolve; });
      listener = receipt => {
        if (receipt.tag === tag && receipt.sourcePID === child.pid && receipt.targetPID === context.pid
          && receipt.type === final.eventType
          && receipt.keyCode === final.keyCode && receipt.flags === final.flags
          && (button === undefined || receipt.mouseButton === button)) receive(receipt);
      };
      routeListeners.add(listener);
      for (const receipt of observedRoutes) listener(receipt);
      acknowledged = await Promise.race([observed, child.exited.then(status => { throw new Error(`Native sender exited ${status} before its final-event acknowledgement.`); })]);
      routingCheck();
      await appendFile(join(context.output, "native-sender-lifetimes.jsonl"), JSON.stringify({ phase: "acknowledging", senderPID: child.pid, tag, route: acknowledged, wallTime: Date.now() }) + "\n");
      child.stdin.write(`observed ${tag}\n`); await child.stdin.flush();
      if (await child.exited !== 0) throw new Error("The acknowledged native sender did not exit successfully.");
    } catch (error) { failure = error; throw error; }
    finally {
      unsubscribe?.();
      if (listener) routeListeners.delete(listener);
      if (child.exitCode === null) child.kill("SIGTERM");
      const status = await child.exited; clearTimeout(deadline);
      await reader.cancel(); reader.releaseLock();
      await appendFile(join(context.output, "native-sender-lifetimes.jsonl"), JSON.stringify({ phase: "finished", senderPID: child.pid, tag, status, focusSignalled: continuation ? signalled : undefined,
        acknowledged: Boolean(acknowledged), error: failure ? String(failure) : null, stderr: await stderr, wallTime: Date.now() }) + "\n");
    }
  };
  const popupOwner = parseMain(JSON.parse(await readFile(mainPath, "utf8")));
  const menuReceipts = async (): Promise<MenuReceipt[]> => {
    let text: string;
    try { text = await readFile(join(context.output, "native-menu-events.jsonl"), "utf8"); }
    catch (error) { if (record(error) && error.code === "ENOENT") return []; throw error; }
    const lines = text.split("\n"); lines.pop();
    return lines.filter(Boolean).map(line => {
      const value: unknown = JSON.parse(line);
      if (!record(value) || !number(value.pid) || !number(value.windowId) || !number(value.webContentsId) || !number(value.popupId)
        || typeof value.phase !== "string" || !["requested", "shown", "will-close", "completed", "error"].includes(value.phase)
        || !Array.isArray(value.itemIds) || !value.itemIds.every(id => typeof id === "string")) throw new Error("Invalid native popup lifecycle receipt.");
      return { pid: value.pid, windowId: value.windowId, webContentsId: value.webContentsId, popupId: value.popupId, phase: value.phase, itemIds: value.itemIds };
    }).filter(value => value.pid === context.pid && value.windowId === popupOwner.windowId && value.webContentsId === popupOwner.webContentsId);
  };
  const ledgerPath = join(context.output, "native-menu-events.jsonl");
  // Unfiltered view of the exact-owner ledger for the deadline dump only: raw
  // line/byte counts and owner filtering are reported side by side so a missed
  // notification, an owner-filtered receipt, and a parse failure stay distinct.
  const ledgerDiagnostic = async (): Promise<Record<string, unknown>> => {
    let text: string, bytes: number, mtimeMs: number;
    try { const info = await stat(ledgerPath); bytes = info.size; mtimeMs = info.mtimeMs; text = await readFile(ledgerPath, "utf8"); }
    catch (error) { return { exists: false, error: String(error) }; }
    const lines = text.split("\n"), terminated = lines.pop() === "";
    let owned = 0, foreign = 0, invalid = 0;
    const entries: Record<string, unknown>[] = [];
    for (const line of lines) {
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { invalid++; continue; }
      if (record(value) && value.pid === context.pid && value.windowId === popupOwner.windowId && value.webContentsId === popupOwner.webContentsId) {
        owned++; entries.push({ popupId: value.popupId, phase: value.phase, itemIds: value.itemIds, wallTime: value.wallTime, monotonicNs: value.monotonicNs });
      } else foreign++;
    }
    return { exists: true, bytes, mtimeMs, lines: lines.length, terminated, owned, foreign, invalid,
      owner: { pid: context.pid, windowId: popupOwner.windowId, webContentsId: popupOwner.webContentsId }, entries };
  };
  const menuObservationTraces: MenuObservationTrace[] = [];
  const observeMenu = <T,>(select: (receipts: MenuReceipt[]) => T | undefined) => {
    let failure: unknown, stopped = false;
    const armedAt = Date.now();
    const trace: MenuObservationTrace = { observationSequence: menuObservationTraces.length + 1, routingObserverPID, directory: context.output, ledger: basename(ledgerPath), createdAt: armedAt,
      strategy: "bounded-authoritative-ledger", intervalMs: 25, reads: [], cancels: [],
      timer: { armedAt, deadlineAt: armedAt + 25_000, firedAt: null, clearedAt: null }, timeout: null, outcome: null };
    menuObservationTraces.push(trace);
    const cancel = (error: unknown = new Error("Owned native popup observation cancelled.")) => {
      trace.cancels.push({ reason: String(error), stopped, at: Date.now() });
      if (!stopped) failure = error;
    };
    let timeoutInspection: Promise<void> | undefined;
    const deadline = setTimeout(() => {
      trace.timer.firedAt = Date.now();
      // Commit failure before forensic reads; a late receipt never heals a timeout.
      cancel(new Error("The actual owned native popup lifecycle was not completed."));
      timeoutInspection = (async () => {
        try {
          const ledger = await ledgerDiagnostic();
          let selection: MenuObservationTrace["reads"][number]["result"] = "pending", error: string | null = null;
          try { if (select(await menuReceipts()) !== undefined) selection = "selected"; }
          catch (thrown) { selection = "threw"; error = String(thrown); }
          trace.timeout = { at: Date.now(), ledger, select: { result: selection, error } };
          await appendFile(join(context.output, "native-menu-observer-timeouts.jsonl"), JSON.stringify(trace) + "\n");
        } catch (error) { trace.cancels.push({ reason: `timeout diagnostic failed: ${String(error)}`, stopped, at: Date.now() }); }
      })();
    }, 25_000);
    const promise = (async () => {
      try {
        for (;;) {
          if (failure) throw failure;
          let receipts: MenuReceipt[] = [], result: T | undefined;
          try { receipts = await menuReceipts(); result = select(receipts); }
          catch (error) { trace.reads.push({ owned: receipts.length, result: "threw", error: String(error), at: Date.now() }); throw error; }
          trace.reads.push({ owned: receipts.length, result: result === undefined ? "pending" : "selected", error: null, at: Date.now() });
          if (failure) throw failure;
          if (result !== undefined) { trace.outcome = "selected"; return result; }
          await Bun.sleep(trace.intervalMs);
        }
      } catch (error) { trace.outcome = "failed"; throw error; }
      finally {
        stopped = true; clearTimeout(deadline); trace.timer.clearedAt = Date.now();
        if (timeoutInspection) await timeoutInspection;
      }
    })();
    return { promise, cancel };
  };
  return {
    check,
    async withNativeRoutingTrace<T>(run: () => Promise<T>): Promise<T> {
      if (routingCheck || helperEnv.FILE_EDITOR_NATIVE_TRACE_TAG) throw new Error("A native routing observer is already owned.");
      const tag = String(randomBytes(6).readUIntBE(0, 6) + 1);
      helperEnv.FILE_EDITOR_NATIVE_TRACE_TAG = tag;
      const child = Bun.spawn([probe, "trace", String(context.pid), String(windowId)], {
        stdin: "pipe", stdout: "pipe", stderr: Bun.file(join(context.output, "native-routing-errors.log")), env: helperEnv,
      });
      routingObserverPID = child.pid;
      let ready = false, stopping = false, routingFailure: unknown;
      let receive!: () => void, refuse!: (error: unknown) => void;
      const started = new Promise<void>((resolve, reject) => { receive = resolve; refuse = reject; });
      const pump = (async () => {
        const reader = child.stdout.getReader(), decoder = new TextDecoder();
        let pending = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            await appendFile(join(context.output, "native-routing.jsonl"), text);
            pending += text;
            for (let index = pending.indexOf("\n"); index >= 0; index = pending.indexOf("\n")) {
              const line = pending.slice(0, index); pending = pending.slice(index + 1);
              const receipt: unknown = JSON.parse(line);
              if (!record(receipt) || receipt.probe !== "DEBUG-file-editor-native-routing") throw new Error("Invalid owned native routing record.");
              if (receipt.phase === "ready") {
                if (receipt.pid !== context.pid || receipt.windowId !== windowId || receipt.observerPID !== child.pid || receipt.tag !== tag
                  || JSON.stringify(receipt.stages) !== JSON.stringify(["session-head", "annotated-session-tail", "owned-pid-tail"])) throw new Error("Native routing observer ownership or stages differ.");
                ready = true; receive();
              } else if (receipt.phase === "disabled") throw new Error(`Owned native routing stage was disabled: ${String(receipt.stage)}.`);
              else if (receipt.phase === "event" && receipt.stage === "owned-pid-tail") {
                if (receipt.tag !== tag) throw new Error("An unowned event entered the routing observer's tagged receipt stream.");
                observedRoutes.push(receipt);
                for (const listener of routeListeners) listener(receipt);
              }
            }
          }
          if (pending.trim()) throw new Error("Native routing ended with an incomplete receipt.");
        } finally { reader.releaseLock(); }
      })().catch(error => { routingFailure = error; refuse(error); });
      void child.exited.then(status => {
        if (!stopping) {
          routingFailure ??= new Error(`Owned native routing observer exited unexpectedly (${status}); see native-routing-errors.log.`);
          refuse(routingFailure);
        }
      });
      const startupDeadline = setTimeout(() => {
        routingFailure = new Error("Owned native routing observer did not become ready.");
        refuse(routingFailure); child.kill("SIGTERM");
      }, 5000);
      const stop = async () => {
        stopping = true; routingCheck = undefined; routingObserverPID = null; delete helperEnv.FILE_EDITOR_NATIVE_TRACE_TAG;
        observedRoutes.length = 0; routeListeners.clear();
        clearTimeout(startupDeadline);
        const deadline = setTimeout(() => child.kill("SIGTERM"), 5000);
        if (child.exitCode === null) child.stdin.end();
        try {
          const status = await child.exited; await pump;
          await appendFile(join(context.output, "native-routing-cleanup.jsonl"), JSON.stringify({ pid: child.pid, tag, ready, status, error: routingFailure ? String(routingFailure) : null }) + "\n");
          if (status !== 0 || routingFailure) throw routingFailure ?? new Error(`Owned native routing observer exited ${status}.`);
        } finally { clearTimeout(deadline); }
      };
      let result: T;
      try {
        await started; clearTimeout(startupDeadline);
        routingCheck = () => {
          if (routingFailure) throw routingFailure;
          if (child.exitCode !== null) throw new Error("The owned native routing observer is no longer running.");
        };
        result = await run();
      } catch (error) {
        // Keep the original scenario failure; observer cleanup has its own receipt.
        await stop().catch(() => undefined); throw error;
      }
      await stop(); return result;
    },
    async nativeBatch(chords: Chord[], delivered: Promise<void>) {
      await check("native-unpaused-batch:before");
      // The native helper emits the whole sequence without sleeps or renderer reads.
      await emitNative({ operation: "keys", chords });
      await delivered;
      await check("native-unpaused-batch:after");
    },
    async nativePointer(point: PointerPoint, delivered: Promise<void>) {
      await check("native-pointer:before");
      // CSS viewport coordinates become in-window CG points through the admitted
      // owner's actual content origin and zoom; the sample above just verified that
      // main.bounds equals the CG window bounds, so the helper adds only the origin.
      const main = parseMain(JSON.parse(await readFile(mainPath, "utf8")));
      if (main.pid !== context.pid || main.windowId !== popupOwner.windowId || main.webContentsId !== popupOwner.webContentsId) throw new Error("The actual main-window identity differs from the admitted owner; no pointer input was emitted.");
      const content = main.contentBounds, frame = main.bounds;
      if (content.x < frame.x || content.y < frame.y || content.x + content.width > frame.x + frame.width || content.y + content.height > frame.y + frame.height) throw new Error("The admitted content bounds are not confined to the owned window.");
      if (!number(point.x) || !number(point.y) || point.x < 0 || point.y < 0 || point.x * main.zoomFactor >= content.width || point.y * main.zoomFactor >= content.height) throw new Error("The requested CSS point is outside the admitted content area.");
      const inWindow: PointerPoint = { x: content.x - frame.x + point.x * main.zoomFactor, y: content.y - frame.y + point.y * main.zoomFactor, button: point.button, ...(point.modifiers ? { modifiers: point.modifiers } : {}) };
      await appendFile(join(context.output, "native-pointers.jsonl"), JSON.stringify({ pid: context.pid, windowId, css: point, zoomFactor: main.zoomFactor, contentBounds: content, bounds: frame, inWindow, wallTime: Date.now() }) + "\n");
      await emitNative({ operation: "pointer", point: inWindow });
      await delivered;
      await check("native-pointer:after");
    },
    async captureNative(path: string) {
      const target = resolvePath(path);
      const [directory, outputRoot] = await Promise.all([realpath(dirname(target)), realpath(context.output)]);
      if (directory !== outputRoot || extname(target) !== ".png" || basename(target) === ".png") throw new Error("Native captures are confined to PNG files directly inside the owned acceptance output.");
      if (await Bun.file(target).exists()) throw new Error("The native capture target already exists; no image is replaced.");
      await check("capture-native:before");
      const started = Date.now();
      const result: unknown = await command([probe, "capture", String(context.pid), String(windowId), target]);
      if (!record(result) || result.pid !== context.pid || result.windowId !== windowId || result.path !== target
        || !number(result.imageWidth) || !number(result.imageHeight)) throw new Error("The native capture report has a different owner or target.");
      const image = Bun.file(target), header = new Uint8Array(await image.slice(0, 8).arrayBuffer());
      if (image.size <= 8 || [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].some((byte, index) => header[index] !== byte)) throw new Error("The owned-window capture is not a PNG image.");
      await check("capture-native:after");
      await appendFile(join(context.output, "native-captures.jsonl"), JSON.stringify({ ...result, bytes: image.size, startedAt: started, finishedAt: Date.now() }) + "\n");
    },
    menuObservations(): readonly MenuObservationTrace[] { return menuObservationTraces; },
    async nativeMenuBatch(chords: Chord[]) {
      await check("native-menu-batch:before");
      const shown = observeMenu(receipts => {
        const active = new Map<number, MenuReceipt>();
        for (const receipt of receipts) {
          if (receipt.phase === "shown") active.set(receipt.popupId, receipt);
          else if (receipt.phase === "will-close" || receipt.phase === "completed" || receipt.phase === "error") active.delete(receipt.popupId);
        }
        if (active.size > 1) throw new Error("The owned native popup is ambiguous; no menu keys were emitted.");
        const menu = active.values().next().value;
        if (menu && (menu.itemIds.length !== 1 || menu.itemIds[0] !== "definition")) throw new Error("The actual open popup is not the requested file-definition menu.");
        return menu?.popupId;
      });
      const popupId = await shown.promise;
      const completed = observeMenu(receipts => {
        if (receipts.some(value => value.popupId === popupId && value.phase === "error")) throw new Error("The actual native popup failed.");
        return receipts.some(value => value.popupId === popupId && value.phase === "completed") ? true : undefined;
      });
      const operation = emitNative({ operation: "keys", chords }).catch(error => { completed.cancel(error); throw error; });
      try { await Promise.all([operation, completed.promise]); }
      finally { completed.cancel(); await operation.catch(() => undefined); }
      await check("native-menu-batch:after");
    },
    async focusSequence(initial: Chord[], after: Chord[], subscribe: (signal: () => void) => () => void, delivered: Promise<void>) {
      await check("accepted-focus-sequence:before");
      await emitNative({ operation: "keys", chords: initial }, { after, subscribe });
      await delivered;
      await check("accepted-focus-sequence:after");
    },
  };
}
