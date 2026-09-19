import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { symbolOffset } from "../../../packages/shared/src/symbol-navigation";
import { observeOriginalFileEditors, type OriginalEditorObservation } from "./observe";
import { caretAt, clickedTokenDefinitionRequest, contextDefinitionPostconditions, definitionReceipts, readNativeFacts } from "./context-only-native";
import type { exerciseSymbolNavigationApp } from "../symbol-navigation-app";
import type { prepareFileEditorGeometry } from "./geometry";
import type { interceptOwnedHost } from "./transport";
import { symbolAcceptanceFiles } from "../symbol-navigation-fixture";

type Page = Parameters<typeof exerciseSymbolNavigationApp>[0];
type Geometry = Awaited<ReturnType<typeof prepareFileEditorGeometry>>;
type Transport = Awaited<ReturnType<typeof interceptOwnedHost>>;
type Modifier = "Meta" | "Control" | "Shift" | "Alt";
type Point = { x: number; y: number };
type InputEventRecord = { type: string; at: number; wallTime: number; timeStamp: number; key?: string; code?: string; repeat?: boolean; trusted?: boolean; documentHasFocus?: boolean; control?: boolean; shift?: boolean; meta?: boolean; alt?: boolean;
  button?: number; clientX?: number; clientY?: number; pointerType?: string; activator?: string | null; commandValue?: string | null; originalInput?: "source" | "target" | null;
  target: string; label: string | null; owner: string | null; surface?: "command-menu"; visible?: string[]; status?: string[] };
declare global { interface Window {
  fileEditorAcceptanceEvents?: InputEventRecord[];
  fileEditorAcceptanceEvent?(event: InputEventRecord): Promise<void>;
  fileEditorAcceptanceFocusSerial?: number;
  fileEditorAcceptanceOriginalInputs?: { source: HTMLElement; target: HTMLElement };
} }

export type OriginalFileEditors = { source: OriginalEditorObservation; target: OriginalEditorObservation };
function originalFileEditors(state: OriginalEditorObservation[]): OriginalFileEditors | undefined {
  const sources = state.filter(value => value.label === "Edit symbol-source.ts");
  const targets = state.filter(value => value.label === "Edit symbol-target.ts");
  if (sources.length !== 1 || targets.length !== 1) return;
  const source = sources[0]!, target = targets[0]!;
  const ready = (value: OriginalEditorObservation, text: string) => Boolean(value.owner && value.inputConnected && value.inputVisible
    && value.native?.text === text && value.busy === false && value.revealPending === false);
  if (source.owner !== target.owner && ready(source, symbolAcceptanceFiles["symbol-source.ts"]) && ready(target, symbolAcceptanceFiles["symbol-target.ts"])) return { source, target };
}
async function waitForEditorObservation(page: Page, predicate: (state: OriginalEditorObservation[]) => boolean, stage: string) {
  const deadline = Date.now() + 25_000;
  do {
    const state = await page.evaluate(observeOriginalFileEditors);
    if (predicate(state)) return state;
    await Bun.sleep(25);
  } while (Date.now() < deadline);
  throw new Error(`${stage}: ${JSON.stringify(await page.evaluate(observeOriginalFileEditors))}`);
}
export async function waitForOriginalFileEditors(page: Page): Promise<OriginalFileEditors> {
  const state = await waitForEditorObservation(page, state => Boolean(originalFileEditors(state)), "visible connected original source/target documents");
  return originalFileEditors(state)!;
}

// The complete ordered Editor sequence01→01b→01c→01d→01e→02…11 in one process
// and one tagged routing observer. Every required pointer/keyboard interaction is
// an actual native CG event through the owned geometry; the page is read only for
// coordinates and the original editors' public state, never to focus, select,
// type or click on the fixture's behalf.
export async function exerciseFileEditorCommands(page: Page, output: string, geometry: Geometry, transport: Transport, originals: OriginalFileEditors) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const runOutput = resolve(output, "..");
  const checks: string[] = [], errors: string[] = [], checkpoints: string[] = [];
  let stage = "original-owner-admission";
  const onError = (error: unknown) => errors.push(String(error)); page.on("pageerror", onError);
  let focusSignal: ((owner: string) => void) | undefined;
  const deliveryListeners = new Set<(event: InputEventRecord) => void>();
  await page.exposeFunction("fileEditorAcceptanceEvent", (event: InputEventRecord) => {
    if (event.type === "focusin" && event.owner) focusSignal?.(event.owner);
    for (const listener of deliveryListeners) listener(event);
  });
  const modifierRelease = (modifier: Modifier) => {
    const code = { Meta: "MetaLeft", Control: "ControlLeft", Shift: "ShiftLeft", Alt: "AltLeft" }[modifier];
    // This binding belongs to the verified App page. Posting or global flag
    // sampling is not a release receipt from that native input owner.
    return (event: InputEventRecord) => event.type === "keyup" && event.code === code && event.trusted === true
      && event.documentHasFocus === true && event.meta === false && event.control === false && event.shift === false && event.alt === false;
  };
  const withDelivery = async (accept: (event: InputEventRecord) => boolean, run: (delivered: Promise<void>) => Promise<void>, release?: (event: InputEventRecord) => boolean) => {
    const armedAt = Date.now();
    let semanticObserved = false, releaseObserved = release === undefined;
    let receive!: () => void, refuse!: (error: unknown) => void;
    const delivered = new Promise<void>((resolve, reject) => { receive = resolve; refuse = reject; });
    const listener = (event: InputEventRecord) => {
      if (event.wallTime < armedAt) return;
      if (accept(event)) semanticObserved = true;
      if (release?.(event)) releaseObserved = true;
      if (semanticObserved && releaseObserved) receive();
    };
    deliveryListeners.add(listener);
    const deadline = setTimeout(() => refuse(new Error(`Native completion was not passively observed: semantic=${semanticObserved}, modifierRelease=${releaseObserved}.`)), 25_000);
    const operation = run(delivered).catch(error => { refuse(error); throw error; });
    try { await Promise.all([delivered, operation]); }
    finally {
      clearTimeout(deadline); deliveryListeners.delete(listener);
      // Finish owned helper cleanup before the caller tears down the App. The
      // primary rejection above remains the reported failure.
      await operation.catch(() => undefined);
    }
  };
  await page.evaluate(() => {
    window.fileEditorAcceptanceEvents = [];
    window.fileEditorAcceptanceFocusSerial = 0;
    const originalInputs = [...document.querySelectorAll<HTMLElement>(".pierre-source-editor-frame")].flatMap(frame =>
      [...(frame.querySelector("diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>('[contenteditable="true"]') ?? [])]);
    const originalInput = (label: string) => {
      const matches = originalInputs.filter(input => input.getAttribute("aria-label") === label && input.isConnected && input.getClientRects().length);
      if (matches.length !== 1) throw new Error("Original native input identity is ambiguous: " + label);
      return matches[0]!;
    };
    window.fileEditorAcceptanceOriginalInputs = { source: originalInput("Edit symbol-source.ts"), target: originalInput("Edit symbol-target.ts") };
    for (const type of ["keydown", "keyup", "focus", "blur"]) window.addEventListener(type, event => {
      if ((type === "focus" || type === "blur") && event.target !== window) return;
      const path = event.composedPath(), target = path.find(node => node instanceof HTMLElement), input = path.find(node => node instanceof HTMLElement && node.isContentEditable);
      const frame = path.find(node => node instanceof HTMLElement && node.hasAttribute("data-symbol-owner"));
      window.fileEditorAcceptanceEvents!.push({ type: `window-${type}`, at: performance.now(), wallTime: performance.timeOrigin + performance.now(), timeStamp: event.timeStamp,
        key: event instanceof KeyboardEvent ? event.key : undefined, code: event instanceof KeyboardEvent ? event.code : undefined, repeat: event instanceof KeyboardEvent ? event.repeat : undefined,
        control: event instanceof KeyboardEvent ? event.ctrlKey : undefined, shift: event instanceof KeyboardEvent ? event.shiftKey : undefined, meta: event instanceof KeyboardEvent ? event.metaKey : undefined,
        trusted: event.isTrusted, documentHasFocus: document.hasFocus(), target: target instanceof HTMLElement ? target.tagName : "WINDOW",
        label: input instanceof HTMLElement ? input.getAttribute("aria-label") : null, owner: frame instanceof HTMLElement ? frame.getAttribute("data-symbol-owner") : null });
    }, { capture: true, passive: true });
    for (const type of ["keydown", "keyup", "focusin", "focusout", "beforeinput", "input", "pointerdown", "pointerup", "mousedown", "mouseup", "contextmenu", "click"]) document.addEventListener(type, event => {
      if (type === "focusin") window.fileEditorAcceptanceFocusSerial = (window.fileEditorAcceptanceFocusSerial ?? 0) + 1;
      const path = event.composedPath(), target = path.find(node => node instanceof HTMLElement), input = path.find(node => node instanceof HTMLElement && node.isContentEditable);
      const frame = path.find(node => node instanceof HTMLElement && node.hasAttribute("data-symbol-owner"));
      const modified = event instanceof KeyboardEvent || event instanceof MouseEvent ? event : undefined;
      const observed: InputEventRecord = { type, at: performance.now(), wallTime: performance.timeOrigin + performance.now(), timeStamp: event.timeStamp, key: event instanceof KeyboardEvent ? event.key : undefined,
        code: event instanceof KeyboardEvent ? event.code : undefined, repeat: event instanceof KeyboardEvent ? event.repeat : undefined, trusted: event.isTrusted, documentHasFocus: document.hasFocus(),
        control: modified?.ctrlKey, shift: modified?.shiftKey, meta: modified?.metaKey, alt: modified?.altKey,
        button: event instanceof MouseEvent ? event.button : undefined, clientX: event instanceof MouseEvent ? event.clientX : undefined, clientY: event instanceof MouseEvent ? event.clientY : undefined,
        pointerType: event instanceof PointerEvent ? event.pointerType : undefined,
        target: target instanceof HTMLElement ? target.tagName : "", label: input instanceof HTMLElement ? input.getAttribute("aria-label") : null, owner: frame instanceof HTMLElement ? frame.getAttribute("data-symbol-owner") : null,
        originalInput: input && input === window.fileEditorAcceptanceOriginalInputs?.source ? "source" : input && input === window.fileEditorAcceptanceOriginalInputs?.target ? "target" : null,
        commandValue: target instanceof HTMLElement ? target.closest("[cmdk-item]")?.getAttribute("data-value") ?? null : null,
        activator: target instanceof HTMLElement ? (target.closest("button")?.getAttribute("aria-label") ?? target.closest("button")?.getAttribute("title") ?? target.closest("button")?.textContent ?? null) : null,
        surface: target instanceof HTMLElement && target.closest(".command-menu") ? "command-menu" : undefined };
      window.fileEditorAcceptanceEvents!.push(observed);
      void window.fileEditorAcceptanceEvent?.(observed);
    }, { capture: true, passive: true });
    let lastPresentation = "";
    new MutationObserver(() => {
      // Logical presentation and transient status only: no layout, editor model,
      // focus call or selection read can heal the input sequence under observation.
      const visible = [...document.querySelectorAll<HTMLElement>("[data-symbol-owner]")].filter(frame => !frame.closest("[hidden]")).map(frame => frame.dataset.symbolOwner!);
      const status = [...document.querySelectorAll<HTMLElement>("[data-symbol-navigation]")].filter(frame => !frame.closest("[hidden]")).map(frame => frame.textContent ?? "");
      const value = JSON.stringify({ visible, status });
      if (value === lastPresentation) return; lastPresentation = value;
      window.fileEditorAcceptanceEvents!.push({ type: "presentation", at: performance.now(), wallTime: performance.timeOrigin + performance.now(), timeStamp: performance.now(), target: "workbench", label: null, owner: null, visible, status });
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "data-symbol-owner"] });
  });
  const snapshot = () => page.evaluate(observeOriginalFileEditors);
  type State = Awaited<ReturnType<typeof snapshot>>;
  const events = () => page.evaluate(() => window.fileEditorAcceptanceEvents ?? []);
  const clearEvents = () => page.evaluate(() => { window.fileEditorAcceptanceEvents = []; });
  const selected = (value: State[number] | undefined) => {
    const native = value?.native, selection = native?.selections?.[0];
    return native && selection ? native.text.slice(symbolOffset(native.text, selection.start), symbolOffset(native.text, selection.end)) : undefined;
  };
  const settled = (state: State) => state.length > 0 && state.every(value => value.busy === false && value.revealPending === false && value.navigationMessage === "");
  const find = (state: State, file: string) => state.find(value => value.label === `Edit ${file}`);
  const sameNative = (left: State[number] | undefined, right: State[number] | undefined) => JSON.stringify(left?.native) === JSON.stringify(right?.native);
  const selectionOf = (value: State[number] | undefined, start: [number, number], end: [number, number]) => {
    const selection = value?.native?.selections?.[0];
    return selection?.start.line === start[0] && selection.start.column === start[1] && selection.end.line === end[0] && selection.end.column === end[1];
  };
  const wait = (predicate: (state: State) => boolean, label: string) => waitForEditorObservation(page, predicate, label);
  const originalOwners = (state: State) => find(state, "symbol-source.ts")?.owner === originals.source.owner && find(state, "symbol-target.ts")?.owner === originals.target.owner;
  // Passive DOM reads: coordinates and focus/presentation facts only.
  const activeControl = () => page.evaluate(() => {
    const active = document.activeElement;
    return { focusSerial: window.fileEditorAcceptanceFocusSerial ?? 0, tag: active?.tagName ?? null, label: active?.getAttribute("aria-label") ?? null, expanded: active?.getAttribute("aria-expanded") ?? null,
      inMenu: Boolean(active?.closest(".command-menu")), editor: Boolean(active?.closest(".pierre-source-editor-frame")) };
  });
  const menuOpen = () => page.evaluate(() => { const menu = document.querySelector<HTMLElement>(".command-menu"); return Boolean(menu && menu.getClientRects().length); });
  const waitForDom = async (predicate: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 25_000;
    do { if (await predicate()) return; await Bun.sleep(25); } while (Date.now() < deadline);
    throw new Error(`${label}: ${JSON.stringify({ active: await activeControl(), menuOpen: await menuOpen(), editors: await snapshot() })}`);
  };
  const codeOf = (key: string) => /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : key;
  // Native key receipts: one chord per batch so the final key-up is an
  // unambiguous ACK fingerprint; a modified chord additionally needs the page's
  // trusted release of its outermost modifier.
  const chord = (key: string, modifiers: Modifier[] = [], accept: (event: InputEventRecord) => boolean = () => true) => {
    const code = codeOf(key), finalModifier = modifiers[0];
    return withDelivery(event => event.type === "keydown" && event.trusted === true && event.code === code
      && event.control === modifiers.includes("Control") && event.meta === modifiers.includes("Meta") && event.shift === modifiers.includes("Shift") && event.alt === modifiers.includes("Alt") && accept(event),
      delivered => geometry.nativeBatch([{ key, modifiers }], delivered), finalModifier ? modifierRelease(finalModifier) : undefined);
  };
  // Text is emitted one ASCII character per batch (uppercase through Shift);
  // the accept predicate binds every character to its intended input surface.
  const typeText = async (text: string, accept: (event: InputEventRecord) => boolean) => {
    for (const character of text) {
      if (character === " ") await chord("Space", [], accept);
      else if (/^[A-Z]$/.test(character)) await chord(character.toLowerCase(), ["Shift"], accept);
      else if (/^[a-z0-9]$/.test(character)) await chord(character, [], accept);
      else throw new Error("Unsupported native text character: " + JSON.stringify(character));
    }
  };
  const intoInput = (file: string) => (event: InputEventRecord) => event.label === `Edit ${file}`;
  const intoMenu = (event: InputEventRecord) => event.surface === "command-menu";
  const click = (point: Point, accept: (event: InputEventRecord) => boolean, modifiers: Modifier[] = []) => withDelivery(
    event => event.trusted === true && event.button === 0 && event.control === modifiers.includes("Control") && event.meta === modifiers.includes("Meta") && event.shift === modifiers.includes("Shift") && event.alt === modifiers.includes("Alt") && accept(event),
    delivered => geometry.nativePointer({ x: point.x, y: point.y, button: "left", modifiers }, delivered), modifiers[0] ? modifierRelease(modifiers[0]) : undefined);
  // Real control activation: the actual button (aria-label, title or text) under
  // the pointer must be the one that reports the trusted click.
  const pressControl = async (describe: string, selector: string, text?: string) => {
    const control = await page.evaluate((describe: string, selector: string, text: string | undefined) => {
      const button = [...document.querySelectorAll<HTMLElement>(selector)].find(node => (text === undefined || node.textContent === text) && node.getClientRects().length);
      if (!button) throw new Error("Missing actual control: " + describe);
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(button).pointerEvents === "none") throw new Error("The actual control cannot receive a pointer: " + describe);
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, activator: button.getAttribute("aria-label") ?? button.getAttribute("title") ?? button.textContent };
    }, describe, selector, text);
    await click(control, event => event.type === "click" && event.activator === control.activator);
  };
  const inputPoint = (file: string) => page.evaluate((file: string) => {
    const inputs = [...document.querySelectorAll<HTMLElement>(".pierre-source-editor-frame")].flatMap(frame => [...(frame.querySelector("diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>('[contenteditable="true"]') ?? [])]);
    const input = inputs.find(input => input.getAttribute("aria-label") === `Edit ${file}` && input.getClientRects().length);
    if (!input) throw new Error("Missing exact visible native input: " + file);
    const rect = input.getBoundingClientRect(); return { x: rect.x + 12, y: rect.y + 12 };
  }, file);
  const tokenPoint = (file: string, line: number, text: string) => page.evaluate((file: string, line: number, text: string) => {
    const frame = [...document.querySelectorAll<HTMLElement>(".pierre-source-editor-frame")].find(frame => frame.getClientRects().length && frame.querySelector("diffs-container")?.shadowRoot?.querySelector('[contenteditable="true"]')?.getAttribute("aria-label") === `Edit ${file}`);
    const token = [...(frame?.querySelector("diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>(`[data-line="${line}"] [data-char]`) ?? [])].find(node => node.textContent === text);
    if (!token) throw new Error("Missing original Pierre token: " + text);
    const rect = token.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, char: token.dataset.char, owner: frame?.dataset.symbolOwner };
  }, file, line, text);
  const goTo = async (file: string, line: number, column: number) => {
    const editor = find(await snapshot(), file), owner = editor?.owner, text = editor?.native?.text;
    if (!owner) throw new Error("The visible original editor has no owner: " + file);
    const point = await inputPoint(file);
    await click(point, event => event.type === "pointerup" && event.owner === owner);
    await wait(state => find(state, file)?.owner === owner && find(state, file)?.focused === true && find(state, file)?.native?.text === text, `native left click focused original ${file}`);
    await chord("l", ["Meta"], intoInput(file));
    await waitForDom(() => page.evaluate(() => Boolean(document.querySelector<HTMLElement>('input[aria-label="Go to line"]')?.getClientRects().length)), "production Go to line opened");
    const digits = String(line);
    await typeText(digits, event => event.key !== undefined && digits.includes(event.key) && event.target === "INPUT");
    await chord("Enter", [], event => event.target === "INPUT");
    await wait(state => find(state, file)?.owner === owner && find(state, file)?.focused === true && caretAt(find(state, file)?.native?.selections?.[0], line, 1), `original ${file} line ${line} caret`);
    // Separate one-key batches keep each final ArrowRight key-up an unambiguous ACK fingerprint.
    for (let offset = 1; offset < column; offset++) {
      await chord("ArrowRight", [], event => event.owner === owner && event.label === `Edit ${file}`);
      await wait(state => find(state, file)?.focused === true && caretAt(find(state, file)?.native?.selections?.[0], line, offset + 1), `original ${file} caret ${line}:${offset + 1}`);
    }
    await appendFile(join(output, "native-setup-input.jsonl"), JSON.stringify({ file, owner, point, line, column, wallTime: Date.now() }) + "\n");
  };
  const palette = async () => {
    await chord("k", ["Meta"]);
    await waitForDom(async () => await menuOpen() && (await activeControl()).inMenu, "central command palette opened with its own focus");
  };
  const paletteRows = () => page.evaluate(() => [...document.querySelectorAll(".command-menu [cmdk-item]")].map(node => node.getAttribute("data-value")));
  const requireSupportedRows = async () => {
    const rows = await paletteRows();
    if (!rows.includes("command:file.goToDefinition") || rows.some(row => /file\.(goToImplementation|goToType|findReferences)/.test(row ?? ""))) throw new Error("The palette did not advertise only real supported file capabilities.");
  };
  // Physical palette dispatch: the command title is typed natively so the actual
  // row is inside the list viewport, then one CG left click lands on that row.
  const chooseCommand = async (id: string, filter: string) => {
    await typeText(filter, event => event.type === "keydown" && intoMenu(event));
    const selector = `.command-menu [cmdk-item][data-value="command:${id}"]`;
    await waitForDom(() => page.evaluate((selector: string) => {
      const item = document.querySelector<HTMLElement>(selector), list = item?.closest<HTMLElement>(".command-menu-results");
      if (!item || !list || !item.getClientRects().length) return false;
      const rect = item.getBoundingClientRect(), bounds = list.getBoundingClientRect();
      return rect.top >= bounds.top && rect.bottom <= bounds.bottom && rect.left >= bounds.left && rect.right <= bounds.right;
    }, selector), `real command row visible in the palette list: ${id}`);
    const point = await page.evaluate((selector: string) => {
      const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, selector);
    await click(point, event => event.type === "click" && intoMenu(event) && event.commandValue === `command:${id}`);
  };
  const closePalette = async () => {
    await chord("Escape", [], intoMenu);
    await waitForDom(async () => !await menuOpen(), "palette closed by native Escape");
  };
  const tab = async (file: string) => {
    await pressControl(`file tab ${file}`, `[role="tab"][title="${file}"]`);
    await waitForDom(() => page.evaluate((file: string) => document.querySelector(`[role="tab"][title="${file}"]`)?.getAttribute("aria-selected") === "true", file), `actual file tab selected: ${file}`);
  };
  const context = async (file: string, line: number, text: string) => {
    const owner = find(await snapshot(), file)?.owner;
    const point = await tokenPoint(file, line, text);
    if (!owner || point.owner !== owner) throw new Error(`The ${text} token is not rendered by the visible original ${file} owner.`);
    // Cocoa may consume the secondary mouse-up while its popup opens; the
    // semantic receipt is the original owner's trusted contextmenu event.
    await withDelivery(event => event.type === "contextmenu" && event.trusted === true && event.button === 2 && event.owner === owner,
      delivered => geometry.nativePointer({ x: point.x, y: point.y, button: "right" }, delivered));
    return { ...point, owner };
  };
  const capture = async (name: string) => {
    // The guarded helper writes only into the geometry's owned run directory.
    const image = join(runOutput, `${name}.png`);
    await appendFile(join(output, "capture-boundaries.jsonl"), JSON.stringify({ name, phase: "before-image", image, wallTime: Date.now() }) + "\n");
    await geometry.captureNative(image);
    await appendFile(join(output, "capture-boundaries.jsonl"), JSON.stringify({ name, phase: "after-image", image, wallTime: Date.now() }) + "\n");
    await writeFile(join(output, `${name}.json`), JSON.stringify({ image, editors: await snapshot(), events: await events(), native: await readNativeFacts(runOutput, geometry) }, null, 2));
    await appendFile(join(output, "capture-boundaries.jsonl"), JSON.stringify({ name, phase: "after-observation", image, wallTime: Date.now() }) + "\n");
    checkpoints.push(name);
  };
  const requireNativeInput = async (key: string, label: string) => {
    await waitForDom(() => page.evaluate((key: string) => Boolean(window.fileEditorAcceptanceEvents?.some(event => event.type === "keydown" && event.key?.toLowerCase() === key.toLowerCase())), key), `unpaused ${key} keydown observed`);
    const observed = await events();
    const event = observed.find(event => event.type === "keydown" && event.key?.toLowerCase() === key.toLowerCase());
    if (!event || event.label !== `Edit ${label}`) throw new Error(`Unpaused ${key} missed the original native input: ${JSON.stringify(observed)}`);
  };
  // Cancellation must hand focus straight back to the captured original source:
  // the first focus after the Escape keydown is that exact input, no other visible
  // editor receives focus, and its text/selection are byte-identical.
  const requireSourceRestored = async (before: State, escapeAt: number) => {
    const final = await wait(state => !state.some(value => value.busy) && find(state, "symbol-source.ts")?.focused === true
      && sameNative(find(state, "symbol-source.ts"), find(before, "symbol-source.ts")), "captured original source refocused after palette cancellation");
    if (!originalOwners(final) || !sameNative(find(final, "symbol-target.ts"), find(before, "symbol-target.ts"))) throw new Error("Cancellation changed the admitted owners or the other visible editor.");
    if (await menuOpen()) throw new Error("The cancelled palette did not close.");
    const observed = (await events()).filter(event => event.wallTime >= escapeAt);
    const escape = observed.findIndex(event => event.type === "keydown" && event.code === "Escape" && event.surface === "command-menu");
    const released = observed.findIndex((event, index) => index > escape && event.type === "keyup" && event.code === "Escape");
    const restored = observed.map((event, index) => ({ event, index })).filter(({ event, index }) => index > escape && event.type === "focusin");
    if (escape < 0 || released < 0 || !restored.length || restored[0]!.index >= released
      || restored.some(({ event }) => event.originalInput !== "source" || event.owner !== originals.source.owner)) {
      throw new Error("Escape did not transfer directly to the exact captured native source input before key release: " + JSON.stringify({ escape, released, restored }));
    }
  };
  const escapePalette = async () => {
    const escapeAt = Date.now();
    await chord("Escape", [], intoMenu);
    return escapeAt;
  };
  // Keyboard-only traversal to the actual Search control. Pierre binds Tab and
  // Shift+Tab (exact modifier mask) and preventDefaults them; on macOS Blink's
  // DefaultTabEventHandler treats Option+Tab / Option+Shift+Tab as real sequential
  // focus navigation, so each backward hop is one native Option+Shift+Tab batch.
  // After every hop the source/target text+selection must stay exact, no file
  // editor may hold focus, and focus must actually have moved.
  const traverseToSearch = async (before: State, hops: number) => {
    let previous = JSON.stringify(await activeControl());
    for (let hop = 1; hop <= hops; hop++) {
      await chord("Tab", ["Alt", "Shift"]);
      const active = await activeControl(), state = await snapshot(), current = JSON.stringify(active);
      if (!sameNative(find(state, "symbol-source.ts"), find(before, "symbol-source.ts")) || !sameNative(find(state, "symbol-target.ts"), find(before, "symbol-target.ts"))) throw new Error(`Option+Shift+Tab hop ${hop} changed an original editor's text or selection: ${current}`);
      if (active.editor || state.some(value => value.focused)) throw new Error(`Option+Shift+Tab hop ${hop} left focus in or moved it into a file editor instead of a control: ${current}`);
      if (current === previous) throw new Error(`Option+Shift+Tab hop ${hop} did not move focus: ${current}`);
      previous = current;
      await appendFile(join(output, "search-traversal.jsonl"), JSON.stringify({ hop, active, wallTime: Date.now() }) + "\n");
      if (active.tag === "BUTTON" && active.label === "Search") return hop;
    }
    throw new Error(`The actual Search button was not reached within ${hops} native Option+Shift+Tab hops: ${JSON.stringify(await activeControl())}`);
  };
  const activateSearch = async () => {
    await chord("Enter", [], event => event.target === "BUTTON" && event.activator === "Search");
    await waitForDom(async () => await menuOpen() && (await activeControl()).inMenu
      && await page.evaluate(() => document.querySelector('button[aria-label="Search"]')?.getAttribute("aria-expanded") === "true"), "actual Search button opened the chats palette by keyboard");
  };
  const runPaletteDefinition = async (name: string) => {
    await goTo("symbol-source.ts", 3, 3);
    const sourceState = await wait(state => find(state, "symbol-source.ts")?.focused === true && caretAt(find(state, "symbol-source.ts")?.native?.selections?.[0], 3, 3), "original source caret before palette capture");
    const sourceBefore = find(sourceState, "symbol-source.ts")!;
    if (sourceBefore.owner !== originals.source.owner) throw new Error("Palette setup changed the admitted original source owner.");
    await clearEvents();
    await palette(); await requireSupportedRows();
    await chooseCommand("file.goToDefinition", "definition");
    const final = await wait(state => settled(state) && selected(find(state, "symbol-target.ts")) === "second" && find(state, "symbol-target.ts")?.focused === true, "settled retained palette definition");
    const source = find(final, "symbol-source.ts"), target = find(final, "symbol-target.ts");
    if (!originalOwners(final) || !sameNative(source, sourceBefore) || !selectionOf(target, [2, 17], [2, 23])) throw new Error("Captured palette definition changed the admitted source/owner or selected the wrong target location.");
    if (await menuOpen()) throw new Error("The selected command palette did not close through its actual UI path.");
    const observed = await events();
    const opened = observed.filter(event => event.type === "keydown" && event.code === "KeyK" && event.meta === true && event.control === false && event.shift === false);
    if (opened.length !== 1 || opened[0]?.trusted !== true || opened[0]?.owner !== originals.source.owner || opened[0]?.label !== "Edit symbol-source.ts") throw new Error("The palette was not opened by the one native CmdK in its admitted original source.");
    const dispatched = observed.filter(event => event.type === "click" && event.trusted === true && event.surface === "command-menu" && event.button === 0);
    if (dispatched.length !== 1) throw new Error("The palette command was not dispatched by exactly one trusted native pointer click on its row.");
    await capture(name); checks.push("The actual centralized palette, dispatched by a native CG pointer on its real row, resolves the captured source's second symbol to target second2:17–23, not the other visible editor.");
  };
  try {
    const admitted = await snapshot();
    if (!originalOwners(admitted) || !sameNative(find(admitted, "symbol-source.ts"), originals.source) || !sameNative(find(admitted, "symbol-target.ts"), originals.target)) {
      throw new Error("The admitted original editor owners or documents changed before the sequence started.");
    }
    if ((await definitionReceipts(runOutput)).length) throw new Error("A compiler definitions request was issued before the first case.");

    stage = "01-palette-cancel-immediate-undo";
    await goTo("symbol-source.ts", 2, 1);
    const originalSource = find(await snapshot(), "symbol-source.ts")!.native!.text;
    await typeText("x", intoInput("symbol-source.ts")); await palette(); await requireSupportedRows();
    await clearEvents();
    await withDelivery(event => event.type === "keydown" && event.key?.toLowerCase() === "z" && event.meta === true,
      delivered => geometry.nativeBatch([{ key: "Escape" }, { key: "z", modifiers: ["Meta"] }], delivered), modifierRelease("Meta"));
    await wait(state => find(state, "symbol-source.ts")?.native?.text === originalSource, "palette cancellation followed immediately by native Undo");
    await requireNativeInput("z", "symbol-source.ts"); await capture("01-palette-cancel-immediate-undo");
    checks.push("Palette captures the original source before focus transfer; cancellation followed by an unpaused native Undo reaches that original input and restores its exact text.");

    stage = "01b-no-delayed-focus-theft";
    await palette(); await clearEvents();
    await withDelivery(event => event.type === "focusin" && event.surface === "command-menu",
      delivered => geometry.nativeBatch([{ key: "Escape" }, { key: "k", modifiers: ["Meta"] }], delivered), modifierRelease("Meta"));
    await waitForDom(menuOpen, "palette reopened by the unpaused Escape→CmdK batch");
    const reopenedEvents = await events();
    const sourceFocus = reopenedEvents.findIndex(event => event.type === "focusin" && event.label === "Edit symbol-source.ts");
    const menuFocus = reopenedEvents.findIndex((event, index) => index > sourceFocus && event.type === "focusin" && event.surface === "command-menu");
    if (sourceFocus < 0 || menuFocus < 0) throw new Error("The genuine cancel→original editor→new menu focus sequence was not observed: " + JSON.stringify(reopenedEvents));
    for (let frame = 0; frame < 8; frame++) {
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
      if (!(await activeControl()).inMenu) throw new Error("A deferred native/Radix focus handoff stole the newly opened menu.");
    }
    await capture("01b-no-delayed-focus-theft"); checks.push("Cancel→immediate reopen retains the new menu's real focus through queued frames; neither Radix nor Pierre performs a stale second focus handoff.");
    await closePalette();

    stage = "01c-plain-escape-restores-captured-source";
    await goTo("symbol-source.ts", 2, 3);
    const beforePlainEscape = await wait(state => find(state, "symbol-source.ts")?.focused === true && caretAt(find(state, "symbol-source.ts")?.native?.selections?.[0], 2, 3)
      && find(state, "symbol-source.ts")?.native?.text === symbolAcceptanceFiles["symbol-source.ts"], "pristine original source caret2:3 before plain Escape");
    await clearEvents(); await palette();
    await requireSourceRestored(beforePlainEscape, await escapePalette());
    await capture("01c-plain-escape-restores-captured-source");
    checks.push("Plain palette Escape synchronously restores focus to the captured original source with its exact text and caret2:3; no other visible editor is focused or changed.");

    stage = "01d-keyboard-search-cancel-restores-captured-source";
    await goTo("symbol-source.ts", 2, 3);
    const beforeSearch = await wait(state => find(state, "symbol-source.ts")?.focused === true && caretAt(find(state, "symbol-source.ts")?.native?.selections?.[0], 2, 3), "original source caret2:3 before keyboard Search traversal");
    await clearEvents();
    const hops = await traverseToSearch(beforeSearch, 40);
    await activateSearch();
    await requireSourceRestored(beforeSearch, await escapePalette());
    await capture("01d-keyboard-search-cancel-restores-captured-source");
    checks.push(`Keyboard Search activation (${hops} native Option+Shift+Tab hops from the original source to the actual Search button, native Enter) captures the traversed-from original source; Escape restores exactly that input, text and caret, never another visible source.`);

    stage = "01e-other-control-search-capture-refusal";
    // The source's focus leaves to a real non-editor control (its own already
    // selected tab, a no-op selection) by native pointer, not by Tab traversal;
    // the later keyboard traversal to Search therefore has no retained capture.
    await pressControl("already selected original source tab", '[role="tab"][title="symbol-source.ts"]');
    const parked = await snapshot(), parkedControl = await activeControl();
    if (parkedControl.tag !== "BUTTON" || parkedControl.editor || parked.some(value => value.focused) || !sameNative(find(parked, "symbol-source.ts"), find(beforeSearch, "symbol-source.ts"))) {
      throw new Error("The native pointer did not park focus on the source tab control without changing the source: " + JSON.stringify(parkedControl));
    }
    await traverseToSearch(beforeSearch, 40);
    const refusalEscapeAt = Date.now() - 1;
    await activateSearch(); await escapePalette();
    await waitForDom(async () => !await menuOpen(), "palette closed after other-control Escape");
    const refused = await wait(state => !state.some(value => value.busy), "no fallback editor focus after other-control cancellation");
    if (refused.some(value => value.focused) || !sameNative(find(refused, "symbol-source.ts"), find(beforeSearch, "symbol-source.ts")) || !sameNative(find(refused, "symbol-target.ts"), find(beforeSearch, "symbol-target.ts"))) {
      throw new Error("Search activation from another control selected a visible editor as fallback or changed it: " + JSON.stringify(refused));
    }
    if ((await events()).some(event => event.wallTime >= refusalEscapeAt && event.type === "focusin" && event.label?.startsWith("Edit "))) throw new Error("Cancellation focused a file editor although no source was captured on the traversal to Search.");
    await capture("01e-other-control-search-capture-refusal");
    checks.push("When focus left the source by a native pointer to another control before the keyboard traversal to Search, activation has no captured source: cancellation refuses to focus any visible editor and changes nothing.");

    stage = "02-native-two-owner-history";
    await goTo("symbol-source.ts", 2, 3); await clearEvents();
    const origin = find(await snapshot(), "symbol-source.ts")!.native;
    await chord("BracketRight", ["Control"], intoInput("symbol-source.ts"));
    await wait(state => settled(state) && find(state, "symbol-target.ts")?.focused === true && selected(find(state, "symbol-target.ts")) === "first" && selectionOf(find(state, "symbol-target.ts"), [1, 17], [1, 22]), "settled native definition in the correct owner");
    if (JSON.stringify(find(await snapshot(), "symbol-source.ts")?.native) !== JSON.stringify(origin)) throw new Error("Definition mutated the other visible original editor.");
    await chord("Minus", ["Control"], intoInput("symbol-target.ts"));
    await wait(state => settled(state) && find(state, "symbol-source.ts")?.focused === true && JSON.stringify(find(state, "symbol-source.ts")?.native) === JSON.stringify(origin), "settled successful native Back with exact selection");
    await chord("Minus", ["Control", "Shift"], intoInput("symbol-source.ts"));
    const forwarded = await wait(state => settled(state) && find(state, "symbol-target.ts")?.focused === true && selected(find(state, "symbol-target.ts")) === "first" && selectionOf(find(state, "symbol-target.ts"), [1, 17], [1, 22]), "settled successful native Forward with exact declaration");
    if (!originalOwners(forwarded) || JSON.stringify(find(forwarded, "symbol-source.ts")?.native) !== JSON.stringify(origin)) throw new Error("Forward changed the admitted original owners or source state.");
    const shiftedMinus = (await events()).filter(event => event.type === "keydown" && event.code === "Minus" && event.control === true && event.shift === true && event.meta === false);
    if (shiftedMinus.length !== 1 || shiftedMinus[0]?.key !== "_" || shiftedMinus[0]?.trusted !== true || shiftedMinus[0]?.owner !== originals.source.owner || shiftedMinus[0]?.label !== "Edit symbol-source.ts") {
      throw new Error("Forward did not receive its one trusted shifted-Minus event in the admitted original source input.");
    }
    await capture("02-native-two-owner-history"); checks.push("Control+], Control+-, and Control+Shift+- route to the exact focused original owner with two visible editors, select target first1:17–22, restore the exact source and preserve the other editor; the shifted Minus arrives as one trusted `_` in the original source.");

    stage = "03-palette-definition";
    await runPaletteDefinition("03-palette-definition");

    stage = "04-native-context-definition";
    await goTo("symbol-source.ts", 3, 3);
    const contextSetup = await wait(state => find(state, "symbol-source.ts")?.focused === true && caretAt(find(state, "symbol-source.ts")?.native?.selections?.[0], 3, 3) && selectionOf(find(state, "symbol-target.ts"), [2, 17], [2, 23]), "source caret3:3 versus distinct target second before the context gesture");
    if (!originalOwners(contextSetup)) throw new Error("Context setup changed the admitted original owners.");
    const requestsBeforeContext = (await definitionReceipts(runOutput)).length, contextAt = Date.now();
    const contextPoint = await context("symbol-source.ts", 2, "first");
    if (contextPoint.owner !== originals.source.owner) throw new Error("The first call token is not rendered by the admitted original source owner.");
    await geometry.nativeMenuBatch([{ key: "ArrowDown" }, { key: "Enter" }]);
    const contextFinal = await wait(state => Object.values(contextDefinitionPostconditions(state, originals)).every(Boolean), "settled native context first definition");
    const contextRequests = (await definitionReceipts(runOutput)).slice(requestsBeforeContext);
    if (!clickedTokenDefinitionRequest(contextRequests, 2, [1, 5])) throw new Error("The actual compiler request did not resolve the clicked first call: " + JSON.stringify(contextRequests));
    const menuReceipt = (await events()).find(event => event.type === "contextmenu" && event.wallTime >= contextAt);
    if (!menuReceipt || menuReceipt.trusted !== true || menuReceipt.owner !== originals.source.owner) throw new Error("The context receipt did not come from the exact original source owner.");
    await writeFile(join(output, "04-context-postconditions.json"), JSON.stringify({ postconditions: contextDefinitionPostconditions(contextFinal, originals), request: contextRequests[0], point: contextPoint }, null, 2));
    await capture("04-native-context-definition"); checks.push("Pierre's actual token context menu (native secondary click, native menu Down/Enter) issues exactly one compiler request at the clicked first token, independent of the retained caret3:3, and focuses the original target first1:17–22.");

    stage = "05-context-cancel-immediate-input";
    await goTo("symbol-source.ts", 3, 3); await context("symbol-source.ts", 2, "first"); await clearEvents();
    await withDelivery(event => event.type === "keydown" && event.key === "ArrowRight",
      delivered => geometry.nativeBatch([{ key: "Escape" }, { key: "ArrowRight" }], delivered));
    await requireNativeInput("ArrowRight", "symbol-source.ts"); await capture("05-context-cancel-immediate-input");
    checks.push("Native context cancellation returns immediate Arrow input to the original source without a healing observer.");

    stage = "05b-modifier-click-away-caret-origin";
    await goTo("symbol-source.ts", 3, 3); await clearEvents();
    const beforeModifierClick = await wait(state => find(state, "symbol-source.ts")?.focused === true && caretAt(find(state, "symbol-source.ts")?.native?.selections?.[0], 3, 3), "source caret3:3 away from the token before modifier click");
    const requestsBeforeModifierClick = (await definitionReceipts(runOutput)).length;
    const tokenTarget = await tokenPoint("symbol-source.ts", 2, "first");
    if (tokenTarget.owner !== originals.source.owner) throw new Error("The first call token is not rendered by the admitted original source owner.");
    await click(tokenTarget, event => event.type === "click" && event.owner === originals.source.owner && event.label === "Edit symbol-source.ts", ["Meta"]);
    const modifierFinal = await wait(state => settled(state) && find(state, "symbol-target.ts")?.focused === true && selectionOf(find(state, "symbol-target.ts"), [1, 17], [1, 22]), "settled modifier-click definition in the original target");
    if (!originalOwners(modifierFinal) || find(modifierFinal, "symbol-source.ts")?.native?.text !== find(beforeModifierClick, "symbol-source.ts")?.native?.text) throw new Error("Modifier click changed the admitted owners or the source text.");
    const modifierRequests = (await definitionReceipts(runOutput)).slice(requestsBeforeModifierClick);
    if (!clickedTokenDefinitionRequest(modifierRequests, 2, [1, 1])) throw new Error("The modifier click did not issue exactly one compiler request at the clicked first token: " + JSON.stringify(modifierRequests));
    const modifierClicks = (await events()).filter(event => event.type === "click" && event.trusted === true && event.button === 0 && event.meta === true);
    if (modifierClicks.length !== 1 || modifierClicks[0]?.owner !== originals.source.owner) throw new Error("The definition was not dispatched by exactly one trusted Meta pointer click in the original source.");
    await chord("Minus", ["Control"], intoInput("symbol-target.ts"));
    await wait(state => settled(state) && find(state, "symbol-source.ts")?.focused === true && caretAt(find(state, "symbol-source.ts")?.native?.selections?.[0], 2, 1)
      && find(state, "symbol-source.ts")?.native?.text === symbolAcceptanceFiles["symbol-source.ts"], "Back restores the clicked-token origin2:1, not the stale caret3:3");
    await capture("05b-modifier-click-away-caret-origin");
    checks.push("An actual Meta pointer click on Pierre's first token away from the caret issues one semantic request at the clicked token, focuses the original target first1:17–22, and records the clicked token2:1 as Back's history origin instead of the stale caret.");

    stage = "06-choice-and-unresolved";
    await goTo("symbol-source.ts", 6, 12); await chord("BracketRight", ["Control"], intoInput("symbol-source.ts"));
    await wait(state => find(state, "symbol-source.ts")?.choices === 2, "real merged declaration choices");
    await pressControl("actionable compiler declaration", 'button[aria-label="Open symbol-source.ts, line 5, column 11"]');
    await wait(state => selected(find(state, "symbol-source.ts")) === "Merged", "chosen original declaration");
    await goTo("symbol-source.ts", 7, 29); await chord("BracketRight", ["Control"], intoInput("symbol-source.ts"));
    await wait(state => find(state, "symbol-source.ts")?.messages.some(message => message.includes("No semantic definition")) === true, "truthful unresolved symbol");
    await capture("06-choice-and-unresolved"); checks.push("Real multiple definitions remain actionable through a native pointer on the actual choice; a comment remains an explicit semantic refusal.");

    stage = "07-unsupported";
    await tab("unsupported.py"); await goTo("unsupported.py", 3, 2); await palette();
    if ((await paletteRows()).includes("command:file.goToDefinition")) throw new Error("Unsupported Python advertised a definition command.");
    await closePalette(); await context("unsupported.py", 3, "first");
    await geometry.nativeMenuBatch([{ key: "Escape" }]);
    await wait(state => find(state, "unsupported.py")?.messages.some(message => message.includes("JavaScript")) === true, "truthful unsupported-language context state");
    await capture("07-unsupported"); checks.push("Unsupported languages do not advertise definition commands and explain their unavailable context action.");

    stage = "08-stale-source";
    await tab("symbol-source.ts"); await goTo("symbol-source.ts", 2, 3);
    const sourceBeforeStale = find(await snapshot(), "symbol-source.ts")!;
    if (sourceBeforeStale.owner !== originals.source.owner) throw new Error("The retargeted source tab is not the admitted original source owner.");
    const stale = transport.holdNextDefinitions(); await clearEvents(); await palette(); await requireSupportedRows(); await chooseCommand("file.goToDefinition", "definition");
    await stale.arrived;
    await typeText("q", intoInput("symbol-source.ts")); stale.release();
    await wait(state => !state.some(value => value.busy) && find(state, "symbol-source.ts")?.messages.some(message => /changed|retry/i.test(message)) === true, "changed-source response rejection");
    await capture("08-stale-source"); checks.push("A real held compiler response is refused after native source input changes the captured source; no synthetic response is supplied.");
    await chord("z", ["Meta"], intoInput("symbol-source.ts")); await goTo("symbol-source.ts", 2, 3);
    stage = "08b-cancelled-request";
    const beforeCancel = find(await snapshot(), "symbol-target.ts")?.native;
    const cancelled = transport.holdNextDefinitions(); await chord("BracketRight", ["Control"], intoInput("symbol-source.ts")); await cancelled.arrived;
    await waitForDom(() => page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".symbol-navigation button")].some(button => button.textContent === "Cancel navigation" && button.getClientRects().length)), "real pending navigation cancellation action mounted");
    await pressControl("pending navigation cancellation", ".symbol-navigation button", "Cancel navigation"); cancelled.release();
    await wait(state => !state.some(value => value.busy), "cancelled compiler request");
    if (JSON.stringify(find(await snapshot(), "symbol-target.ts")?.native) !== JSON.stringify(beforeCancel)) throw new Error("Cancelled lookup changed the other visible target.");
    await capture("08b-cancelled-request"); checks.push("Cancelling the actual in-flight compiler request ignores its unchanged late response and preserves the other visible editor.");
    stage = "09-retargeted-owner";
    const retarget = transport.holdNextDefinitions(); await chord("BracketRight", ["Control"], intoInput("symbol-source.ts")); await retarget.arrived;
    await tab("unsupported.py"); retarget.release();
    await wait(state => !state.some(value => value.busy), "retargeted lookup settles");
    if (!find(await snapshot(), "unsupported.py") || find(await snapshot(), "symbol-source.ts")) throw new Error("Retargeted origin was reopened by a stale response.");
    await capture("09-retargeted-owner"); checks.push("Retargeting the actual original tab while its real response is held does not reopen it or steal the replacement route.");

    stage = "10a-unpaused-current-owner-undo";
    await tab("symbol-source.ts"); await goTo("symbol-source.ts", 2, 3);
    const targetBeforeEdit = find(await snapshot(), "symbol-target.ts")!.native!.text;
    await chord("BracketRight", ["Control"], intoInput("symbol-source.ts"));
    await wait(state => selected(find(state, "symbol-target.ts")) === "first" && find(state, "symbol-target.ts")?.focused === true, "target before native edit");
    await typeText("firstChanged", intoInput("symbol-target.ts"));
    await wait(state => find(state, "symbol-target.ts")?.native?.text.includes("firstChanged") === true, "native text reached the original target");
    await chord("Minus", ["Control"], intoInput("symbol-target.ts")); await wait(state => find(state, "symbol-source.ts")?.focused === true && !state.some(value => value.busy), "source before immediate Forward and Undo batch");
    const sourceBeforeEarlyInput = find(await snapshot(), "symbol-source.ts")!.native!.text;
    const dirtyTarget = find(await snapshot(), "symbol-target.ts")!.native!.text;
    await typeText(" ", intoInput("symbol-source.ts"));
    await wait(state => find(state, "symbol-source.ts")?.native?.text !== sourceBeforeEarlyInput, "native space reached the original source");
    await clearEvents();
    await withDelivery(event => event.type === "keydown" && event.key?.toLowerCase() === "z" && event.meta === true,
      delivered => geometry.nativeBatch([{ key: "Minus", modifiers: ["Control", "Shift"] }, { key: "z", modifiers: ["Meta"] }], delivered), modifierRelease("Meta"));
    await wait(state => !state.some(value => value.busy) && find(state, "symbol-source.ts")?.native?.text === sourceBeforeEarlyInput
      && find(state, "symbol-source.ts")?.messages.some(message => /changed|retry/i.test(message)) === true, "unpaused current-owner Undo invalidates the pending navigation");
    await requireNativeInput("z", "symbol-source.ts");
    if (find(await snapshot(), "symbol-target.ts")?.native?.text !== dirtyTarget) throw new Error("Transaction-start Undo was wrongly redirected to the unaccepted destination.");
    await capture("10a-unpaused-current-owner-undo");
    checks.push("Before async acceptance, zero-gap Forward→Undo stays with the actual current source; its native edit invalidates the stale navigation and leaves the dirty destination untouched.");

    stage = "10b-accepted-native-owner-undo";
    const targetOwner = find(await snapshot(), "symbol-target.ts")?.owner;
    if (!targetOwner || targetOwner !== originals.target.owner) throw new Error("The accepted-target test requires the original target identity.");
    await clearEvents();
    await withDelivery(event => event.type === "keydown" && event.key?.toLowerCase() === "z" && event.meta === true,
      delivered => geometry.focusSequence([{ key: "Minus", modifiers: ["Control", "Shift"] }], [{ key: "z", modifiers: ["Meta"] }], signal => {
        focusSignal = owner => { if (owner === targetOwner) signal(); };
        return () => { focusSignal = undefined; };
      }, delivered), modifierRelease("Meta"));
    await wait(state => find(state, "symbol-target.ts")?.native?.text === targetBeforeEdit, "native Undo immediately after the real accepted target focus");
    await requireNativeInput("z", "symbol-target.ts"); await capture("10b-accepted-native-owner-undo");
    checks.push("After the exact target's real native focus event, immediate native Undo reaches its original input and undo timeline; no editor/layout observation occurs between the initial dispatch and Undo.");

    stage = "10c-first-mounted-native-input";
    await goTo("symbol-source.ts", 2, 3);
    const firstMountOrigin = find(await snapshot(), "symbol-source.ts")?.native;
    await pressControl("disposable target tab close", 'button[aria-label="Close symbol-target.ts tab"]');
    await wait(state => !find(state, "symbol-target.ts"), "old target fully unmounted");
    await goTo("symbol-source.ts", 2, 3); await clearEvents();
    await withDelivery(event => event.type === "keydown" && event.key === "ArrowLeft" && event.shift === true,
      delivered => geometry.focusSequence([{ key: "BracketRight", modifiers: ["Control"] }], [{ key: "ArrowRight" }, { key: "ArrowLeft", modifiers: ["Shift"] }], signal => {
        focusSignal = owner => { if (owner === targetOwner) signal(); };
        return () => { focusSignal = undefined; };
      }, delivered), modifierRelease("Shift"));
    await requireNativeInput("ArrowRight", "symbol-target.ts");
    await wait(state => selected(find(state, "symbol-target.ts")) === "t", "first-mounted original input accepts immediate native selection");
    await capture("10c-first-mounted-native-input");
    await chord("Minus", ["Control"], intoInput("symbol-target.ts"));
    await wait(state => find(state, "symbol-source.ts")?.focused === true && JSON.stringify(find(state, "symbol-source.ts")?.native) === JSON.stringify(firstMountOrigin), "first-mounted reveal commits correct history");
    checks.push("A genuinely first-mounted target accepts immediate native Arrow/Shift input at its own focus event and commits history that restores the exact source; no retained editor masks attachment.");
    await tab("symbol-target.ts"); await chord("ArrowDown", ["Control"]);
    await wait(state => Boolean(find(state, "symbol-source.ts") && find(state, "symbol-target.ts")), "two real dock owners restored after first mount");

    stage = "11-closed-owner";
    await goTo("symbol-source.ts", 2, 3);
    const targetBeforeClose = find(await snapshot(), "symbol-target.ts")?.native;
    const closed = transport.holdNextDefinitions(); await chord("BracketRight", ["Control"], intoInput("symbol-source.ts")); await closed.arrived;
    await pressControl("original source tab close", 'button[aria-label="Close symbol-source.ts tab"]'); closed.release();
    await wait(state => !state.some(value => value.busy), "closed-owner response settles");
    if (JSON.stringify(find(await snapshot(), "symbol-target.ts")?.native) !== JSON.stringify(targetBeforeClose)) throw new Error("A closed owner's stale command changed the other visible editor.");
    if (find(await snapshot(), "symbol-source.ts")) throw new Error("A closed original editor was recreated by its old command.");
    await capture("11-closed-owner"); checks.push("Closing the original editor while the actual host response is held rejects that owner without choosing another visible editor.");
    if (errors.length) throw new Error(errors.join("\n"));
    stage = "complete";
    const result = { passed: true, checks, checkpoints, errors, acceptanceScope: "complete-file-editor-commands", originals: { source: originals.source.owner, target: originals.target.owner },
      native: await readNativeFacts(runOutput, geometry),
      scope: "Complete ordered Editor sequence01,01b,01c,01d,01e,02,03,04,05,05b,06,07,08,08b,09,10a,10b,10c,11 executed in this process against the readiness-admitted original source/target owners under one tagged routing observer. Every required pointer/keyboard interaction was an actual native CG event with a passive page receipt and final sender ACK; the page was read only for coordinates and public state. Actual production App/main/host/compiler/Pierre, central palette, native popup menus, real held compiler responses and guarded native CG-window captures. No historical014/016/019/020/028 evidence is counted as a current result. No provider, reference-profile, statistical reliability or pixel-parity claim." };
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2)); return result;
  } catch (error) {
    // No retry, refocus or reordered case: record the original failure, current
    // owner state, passive events and native ledgers, then a guarded native capture.
    const editors = await snapshot().catch(cause => ({ unavailable: String(cause) }));
    const native = await readNativeFacts(runOutput, geometry).catch(cause => ({ unavailable: String(cause), menuCompleted: false, acknowledgedSenders: 0 }));
    await writeFile(join(output, "failure.json"), JSON.stringify({ stage, error: String(error), errorDetail: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : undefined,
      checks, checkpoints, errors, editors, events: await events().catch(cause => String(cause)), native }, null, 2));
    try { await capture(`failure-${stage}`); }
    catch (captureError) { await writeFile(join(output, "failure-capture-refusal.json"), JSON.stringify({ stage, error: String(captureError) }, null, 2)); }
    throw error;
  } finally { focusSignal = undefined; page.off("pageerror", onError); await page.removeExposedFunction("fileEditorAcceptanceEvent"); }
}
