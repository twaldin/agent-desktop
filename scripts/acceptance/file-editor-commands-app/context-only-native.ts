import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SymbolSelection } from "../../../packages/shared/src/symbol-navigation";
import { observeOriginalFileEditors, type OriginalEditorObservation } from "./observe";
import type { waitForOriginalFileEditors } from "./app";
import type { prepareFileEditorGeometry } from "./geometry";

type Page = Parameters<typeof waitForOriginalFileEditors>[0];
type Originals = { source: OriginalEditorObservation; target: OriginalEditorObservation };
type Geometry = Awaited<ReturnType<typeof prepareFileEditorGeometry>>;
type InputEventRecord = NonNullable<Window["fileEditorAcceptanceEvents"]>[number];
type Point = { x: number; y: number };

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
async function ledger(path: string): Promise<unknown[]> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if (record(error) && error.code === "ENOENT") return []; throw error; }
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as unknown);
}
export const caretAt = (selection: SymbolSelection | undefined, line: number, column: number) => selection?.start.line === line && selection.start.column === column
  && selection.end.line === line && selection.end.column === column;
/** Real compiler definition receipts the owned transport appended to the run root. */
export const definitionReceipts = async (runOutput: string) => (await ledger(join(runOutput, "compiler-transport.jsonl"))).filter(receipt => record(receipt) && receipt.type === "file.definitions");
/** Strict028 request predicate: exactly one resolved, unheld request for the clicked token on the source line. */
export function clickedTokenDefinitionRequest(requests: unknown[], line: number, columns: [number, number]): boolean {
  const request = requests[0];
  return requests.length === 1 && record(request) && request.path === "symbol-source.ts" && record(request.position) && request.position.line === line
    && typeof request.position.column === "number" && Number.isInteger(request.position.column) && request.position.column >= columns[0] && request.position.column <= columns[1]
    && request.status === 200 && request.held === false;
}
const preservedOriginal = (state: OriginalEditorObservation[], original: OriginalEditorObservation) => {
  const matches = state.filter(value => value.owner === original.owner);
  return matches.length === 1 && matches[0]!.inputConnected && matches[0]!.inputVisible && matches[0]!.native?.text === original.native?.text;
};
/** Strict028 case04 postconditions: settled, original target first1:17–22 focused, source caret3:3 and both originals preserved. */
export function contextDefinitionPostconditions(state: OriginalEditorObservation[], originals: Originals) {
  const target = state.find(value => value.label === "Edit symbol-target.ts"), source = state.find(value => value.label === "Edit symbol-source.ts"), selection = target?.native?.selections?.[0];
  return { settled: state.length > 0 && state.every(value => value.busy === false && value.revealPending === false && value.navigationMessage === ""), targetFocused: target?.focused === true,
    targetFirstSelected: selection?.start.line === 1 && selection.start.column === 17 && selection.end.line === 1 && selection.end.column === 22,
    sourceCaretPreserved: source !== undefined && source.owner === originals.source.owner && caretAt(source.native?.selections?.[0], 3, 3),
    sourcePreserved: preservedOriginal(state, originals.source), targetPreserved: preservedOriginal(state, originals.target) };
}
/** Request, popup ledger, sender ACK and the preserved popup-observer trace, read from the owned run directory the geometry and Electron shim write to. */
export async function readNativeFacts(runOutput: string, geometry: Geometry) {
  const menu = await ledger(join(runOutput, "native-menu-events.jsonl")), lifetimes = await ledger(join(runOutput, "native-sender-lifetimes.jsonl"));
  return { definitions: await definitionReceipts(runOutput), menu, batches: await ledger(join(runOutput, "native-batches.jsonl")), senderLifetimes: lifetimes,
    pointers: await ledger(join(runOutput, "native-pointers.jsonl")), captures: await ledger(join(runOutput, "native-captures.jsonl")),
    observerTimeouts: await ledger(join(runOutput, "native-menu-observer-timeouts.jsonl")), menuObservations: geometry.menuObservations(),
    menuCompleted: menu.some(receipt => record(receipt) && receipt.phase === "completed"),
    acknowledgedSenders: lifetimes.filter(receipt => record(receipt) && receipt.phase === "acknowledging").length };
}

// Dedicated case04: every interaction is an actual native pointer/keyboard
// event through the owned geometry; the page is only read for token
// coordinates and the original editors' public state.
export async function exerciseFileEditorContextOnlyNative(page: Page, output: string, geometry: Geometry, originals: Originals) {
  await mkdir(output, { recursive: true, mode: 0o700 });
  const runOutput = resolve(output, "..");
  let stage = "original-owner-admission";
  const errors: string[] = [];
  const onError = (error: unknown) => errors.push(String(error));
  page.on("pageerror", onError);
  const deliveryListeners = new Set<(event: InputEventRecord) => void>();
  await page.exposeFunction("fileEditorAcceptanceEvent", (event: InputEventRecord) => {
    for (const listener of deliveryListeners) listener(event);
  });
  const modifierRelease = (event: InputEventRecord) => event.type === "keyup" && event.code === "MetaLeft" && event.trusted === true
    && event.documentHasFocus === true && event.meta === false && event.control === false && event.shift === false;
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
    finally { clearTimeout(deadline); deliveryListeners.delete(listener); await operation.catch(() => undefined); }
  };
  await page.evaluate(() => {
    window.fileEditorAcceptanceEvents = [];
    for (const type of ["keydown", "keyup", "focusin", "focusout", "beforeinput", "input", "pointerdown", "pointerup", "mousedown", "mouseup", "contextmenu", "click"]) document.addEventListener(type, event => {
      const path = event.composedPath(), target = path.find(node => node instanceof HTMLElement), input = path.find(node => node instanceof HTMLElement && node.isContentEditable);
      const frame = path.find(node => node instanceof HTMLElement && node.hasAttribute("data-symbol-owner"));
      const observed: InputEventRecord = { type, at: performance.now(), wallTime: performance.timeOrigin + performance.now(), timeStamp: event.timeStamp,
        key: event instanceof KeyboardEvent ? event.key : undefined, code: event instanceof KeyboardEvent ? event.code : undefined,
        repeat: event instanceof KeyboardEvent ? event.repeat : undefined, trusted: event.isTrusted, documentHasFocus: document.hasFocus(),
        control: event instanceof KeyboardEvent ? event.ctrlKey : undefined, shift: event instanceof KeyboardEvent ? event.shiftKey : undefined, meta: event instanceof KeyboardEvent ? event.metaKey : undefined,
        button: event instanceof MouseEvent ? event.button : undefined, clientX: event instanceof MouseEvent ? event.clientX : undefined, clientY: event instanceof MouseEvent ? event.clientY : undefined,
        pointerType: event instanceof PointerEvent ? event.pointerType : undefined,
        target: target instanceof HTMLElement ? target.tagName : "", label: input instanceof HTMLElement ? input.getAttribute("aria-label") : null,
        owner: frame instanceof HTMLElement ? frame.getAttribute("data-symbol-owner") : null };
      window.fileEditorAcceptanceEvents!.push(observed);
      void window.fileEditorAcceptanceEvent?.(observed);
    }, { capture: true, passive: true });
  });
  const snapshot = () => page.evaluate(observeOriginalFileEditors);
  type State = Awaited<ReturnType<typeof snapshot>>;
  const events = () => page.evaluate(() => window.fileEditorAcceptanceEvents ?? []);
  const find = (state: State, file: string) => state.find(value => value.label === `Edit ${file}`);
  const wait = async (predicate: (state: State) => boolean, label: string) => {
    const deadline = Date.now() + 25_000;
    do {
      const state = await snapshot();
      if (predicate(state)) return state;
      await Bun.sleep(25);
    } while (Date.now() < deadline);
    throw new Error(`${label}: ${JSON.stringify(await snapshot())}`);
  };
  const preserved = (state: State, original: OriginalEditorObservation) => {
    const matches = state.filter(value => value.owner === original.owner);
    return matches.length === 1 && matches[0]!.inputConnected && matches[0]!.inputVisible && matches[0]!.native?.text === original.native?.text;
  };
  const atCaret = (state: State, original: OriginalEditorObservation, line: number, column: number) => {
    const editor = state.find(value => value.owner === original.owner);
    return editor?.focused === true && preserved(state, original) && caretAt(editor.native?.selections?.[0], line, column);
  };
  // Native key receipts: an unmodified key is one batch whose final key-up is
  // the geometry ACK; the chord additionally needs the original owner's Meta release.
  const chord = () => withDelivery(event => event.type === "keydown" && event.code === "KeyL" && event.trusted === true && event.meta === true && event.control === false && event.shift === false,
    delivered => geometry.nativeBatch([{ key: "l", modifiers: ["Meta"] }], delivered), modifierRelease);
  const key = (chordKey: string, code: string, accept: (event: InputEventRecord) => boolean) => withDelivery(
    event => event.type === "keydown" && event.code === code && event.trusted === true && accept(event), delivered => geometry.nativeBatch([{ key: chordKey }], delivered));
  const leftClick = (point: Point, owner: string) => withDelivery(event => event.type === "pointerup" && event.trusted === true && event.button === 0 && event.owner === owner,
    delivered => geometry.nativePointer({ ...point, button: "left" }, delivered));
  const inputPoint = (file: string) => page.evaluate((file: string) => {
    const inputs = [...document.querySelectorAll<HTMLElement>(".pierre-source-editor-frame")].flatMap(frame => [...(frame.querySelector("diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>('[contenteditable="true"]') ?? [])]);
    const input = inputs.find(input => input.getAttribute("aria-label") === `Edit ${file}` && input.getClientRects().length);
    if (!input) throw new Error("Missing exact visible native input: " + file);
    const rect = input.getBoundingClientRect(); return { x: rect.x + 12, y: rect.y + 12 };
  }, file);
  const goTo = async (original: OriginalEditorObservation, file: string, line: 2 | 3, column: number) => {
    const owner = original.owner;
    if (!owner) throw new Error("The admitted original editor has no owner: " + file);
    const point = await inputPoint(file);
    await leftClick(point, owner);
    await wait(state => state.find(value => value.owner === original.owner)?.focused === true && preserved(state, original), `native left click focused original ${file}`);
    await chord();
    const input = await page.waitForSelector('input[aria-label="Go to line"]', { visible: true });
    if (!input) throw new Error("Production Go to line did not open.");
    const digit = String(line);
    await key(digit, `Digit${digit}`, event => event.key === digit && event.target === "INPUT");
    await key("Enter", "Enter", event => event.target === "INPUT");
    await wait(state => atCaret(state, original, line, 1), `original ${file} line ${line} caret`);
    // Separate one-key batches keep each final ArrowRight key-up an unambiguous ACK fingerprint.
    for (let offset = 1; offset < column; offset++) {
      await key("ArrowRight", "ArrowRight", event => event.owner === original.owner && event.label === `Edit ${file}`);
      await wait(state => atCaret(state, original, line, offset + 1), `original ${file} caret ${line}:${offset + 1}`);
    }
    await appendFile(join(output, "native-setup-input.jsonl"), JSON.stringify({ file, owner: original.owner, point, line, column, wallTime: Date.now() }) + "\n");
  };
  const definitions = () => definitionReceipts(runOutput);
  const nativeFacts = () => readNativeFacts(runOutput, geometry);
  const capture = async (name: string) => {
    // The guarded helper writes only into the geometry's owned run directory.
    const image = join(runOutput, `${name}.png`);
    await appendFile(join(output, "capture-boundaries.jsonl"), JSON.stringify({ name, phase: "before-image", image, wallTime: Date.now() }) + "\n");
    await geometry.captureNative(image);
    await appendFile(join(output, "capture-boundaries.jsonl"), JSON.stringify({ name, phase: "after-image", image, wallTime: Date.now() }) + "\n");
    await writeFile(join(output, `${name}.json`), JSON.stringify({ image, editors: await snapshot(), events: await events(), native: await nativeFacts() }, null, 2));
    await appendFile(join(output, "capture-boundaries.jsonl"), JSON.stringify({ name, phase: "after-observation", image, wallTime: Date.now() }) + "\n");
  };
  const postconditions = (state: State) => contextDefinitionPostconditions(state, originals);
  const finalState = (state: State) => Object.values(postconditions(state)).every(Boolean);
  try {
    const initial = await snapshot();
    for (const original of [originals.source, originals.target]) if (!preserved(initial, original)) throw new Error("An admitted original editor changed before case04 setup.");
    stage = "distinct-target-second-setup";
    await goTo(originals.target, "symbol-target.ts", 2, 17);
    stage = "source-second-caret-setup";
    await goTo(originals.source, "symbol-source.ts", 3, 3);
    const setup = await wait(state => atCaret(state, originals.source, 3, 3) && caretAt(find(state, "symbol-target.ts")?.native?.selections?.[0], 2, 17), "distinct target second and source second caret");
    if (find(setup, "symbol-target.ts")?.owner !== originals.target.owner) throw new Error("Setup changed the admitted original target owner.");
    if ((await definitions()).length) throw new Error("Setup issued a compiler definitions request before the context gesture.");
    await writeFile(join(output, "context-only-setup.json"), JSON.stringify({ editors: setup, wallTime: Date.now() }, null, 2));
    stage = "native-first-token-context-click";
    const point = await page.evaluate(() => {
      const frame = [...document.querySelectorAll<HTMLElement>(".pierre-source-editor-frame")].find(frame => frame.getClientRects().length && frame.querySelector("diffs-container")?.shadowRoot?.querySelector('[contenteditable="true"]')?.getAttribute("aria-label") === "Edit symbol-source.ts");
      const token = [...(frame?.querySelector("diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>('[data-line="2"] [data-char]') ?? [])].find(node => node.textContent === "first");
      if (!token) throw new Error("Missing original Pierre first call token on source line2.");
      const rect = token.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, text: token.textContent, line: 2, char: token.dataset.char, owner: frame?.dataset.symbolOwner };
    });
    if (point.owner !== originals.source.owner) throw new Error("The first call token is not rendered by the admitted original source owner.");
    const clickedAt = Date.now();
    // Cocoa may consume the secondary mouse-up while its popup opens; the
    // semantic receipt is the original owner's trusted contextmenu event.
    await withDelivery(event => event.type === "contextmenu" && event.trusted === true && event.button === 2 && event.owner === originals.source.owner,
      delivered => geometry.nativePointer({ x: point.x, y: point.y, button: "right" }, delivered));
    await writeFile(join(output, "context-only-click.json"), JSON.stringify({ point, wallTime: clickedAt, input: "Actual native secondary click on the original Pierre first token; native menu keyboard selection follows." }, null, 2));
    stage = "native-menu-down-enter";
    await geometry.nativeMenuBatch([{ key: "ArrowDown" }, { key: "Enter" }]);
    stage = "native-context-definition-result";
    const final = await wait(finalState, "settled native context first definition");
    const requests = await definitions(), request = requests[0];
    if (!clickedTokenDefinitionRequest(requests, 2, [1, 5])) throw new Error("The actual compiler request did not resolve the clicked first call: " + JSON.stringify(requests));
    const observed = await events();
    const menuReceipt = observed.find(event => event.type === "contextmenu" && event.wallTime >= clickedAt);
    if (!menuReceipt || menuReceipt.trusted !== true || menuReceipt.owner !== originals.source.owner) throw new Error("The context receipt did not come from the exact original source owner.");
    if (errors.length) throw new Error(errors.join("\n"));
    await capture("04-native-context-definition");
    const result = { passed: true, acceptanceScope: "context-only-native", definitionRequest: request, postconditions: postconditions(final), native: await nativeFacts(),
      checks: ["All-native distinct targetsecond2:17 and sourcecaret3:3 setup: native left click, CmdL, digit, Enter, separate ArrowRight batches",
        "Actual native secondary click on the first token, exact-owner trusted contextmenu receipt, native menu Down/Enter with final Enter-up ACK",
        "One clicked first-token compiler request and original targetfirst1:17–22 focused",
        "Original owners/document text and source caret3:3 preserved; no pending/error; guarded native CG-window capture"],
      errors, scope: "One corrected case04 only, all input native through the owned geometry. No prior-case replay, case05, product edit or full Editor claim." };
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    // No retry, restart or further input: record the original failure with the
    // actual current state, request/menu/ACK facts, then a guarded native capture.
    const editors = await snapshot().catch(cause => ({ unavailable: String(cause) }));
    const native = await nativeFacts().catch(cause => ({ unavailable: String(cause), menuCompleted: false, acknowledgedSenders: 0 }));
    const delivery = native.menuCompleted && native.acknowledgedSenders > 0 ? "native-menu-completed-and-acknowledged" : native.menuCompleted ? "native-menu-completed" : native.acknowledgedSenders > 0 ? "native-batches-acknowledged" : "no-native-completion-receipt";
    await writeFile(join(output, "failure.json"), JSON.stringify({ stage, error: String(error), errorDetail: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : undefined, errors, delivery,
      postconditions: Array.isArray(editors) ? postconditions(editors) : undefined, editors, events: await events().catch(cause => String(cause)), native }, null, 2));
    try { await capture("04-failure"); }
    catch (captureError) { await writeFile(join(output, "failure-capture-refusal.json"), JSON.stringify({ error: String(captureError) }, null, 2)); }
    throw error;
  } finally { page.off("pageerror", onError); await page.removeExposedFunction("fileEditorAcceptanceEvent"); }
}
