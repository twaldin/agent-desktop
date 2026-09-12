import type { Terminal } from "@xterm/xterm";
import metadata from "@xterm/xterm/package.json";
import type { NativeTerminalInput } from "../../../../packages/shared/src/terminals";
import { binaryTerminalInput } from "./xterm-input";

const keypad: Readonly<Record<string, string>> = { NumpadEnter: "KPEnter", NumpadAdd: "KP+", NumpadSubtract: "KP-", NumpadMultiply: "KP*", NumpadDivide: "KP/", NumpadDecimal: "KP." };
const special: Readonly<Record<string, string>> = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Home: "Home", End: "End", Insert: "IC", Delete: "DC", PageUp: "PPage", PageDown: "NPage", Backspace: "BSpace", Enter: "Enter", Tab: "Tab", Escape: "Escape" };

/** Native names are interpreted against the pane's modes, not the outer attach client's modes. */
export function nativeKey(event: Pick<KeyboardEvent, "key" | "code" | "location" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing">): string | undefined {
  if (event.isComposing) return;
  if (event.metaKey) {
    if (event.altKey || event.ctrlKey || event.shiftKey) return;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp": return "C-a";
      case "ArrowRight":
      case "ArrowDown": return "C-e";
      case "Backspace": return "C-u";
      case "Delete": return "C-k";
      default: return;
    }
  }
  let key = event.location === 3 ? keypad[event.code] ?? (/^Numpad[0-9]$/.test(event.code) ? `KP${event.code.at(-1)}` : undefined) : undefined;
  key ??= event.key === "Tab" && event.shiftKey ? "BTab" : special[event.key] ?? (/^F(?:[1-9]|1[0-2])$/.test(event.key) ? event.key : undefined);
  if (!key && (event.ctrlKey || event.altKey)) key = event.key === " " ? "Space" : /^[a-zA-Z0-9@\[\]\\^_?]$/.test(event.key) ? event.key : undefined;
  if (!key) return;
  return `${event.ctrlKey ? "C-" : ""}${event.altKey ? "M-" : ""}${event.shiftKey && key !== "BTab" && !/^[A-Z]$/.test(key) ? "S-" : ""}${key}`;
}

interface MouseEventFrame { button: number; action: number; col: number; row: number; ctrl?: boolean; alt?: boolean; shift?: boolean }
interface InputCore {
  browser: { isMac: boolean; isWindows: boolean };
  _isThirdLevelShift(browser: InputCore["browser"], event: KeyboardEvent): boolean;
  _handleTextAreaFocus(event: FocusEvent): void;
  _handleTextAreaBlur(): void;
  coreMouseService: { triggerMouseEvent(event: MouseEventFrame): boolean };
  coreService: { triggerDataEvent(data: string, wasUserInput?: boolean): void; triggerBinaryEvent(data: string): void };
  paste(data: string): void;
}
function nativeMouse(frame: MouseEventFrame): Extract<NativeTerminalInput, { kind: "mouse" }> {
  let button = (frame.ctrl ? 16 : 0) | (frame.shift ? 4 : 0) | (frame.alt ? 8 : 0);
  if (frame.button === 4) button |= 64 | frame.action;
  else { button |= frame.button & 3; if (frame.button & 4) button |= 64; if (frame.button & 8) button |= 128; if (frame.action === 32) button |= 32; }
  // xterm's actual mouse service has already range-checked, restricted and made cells 1-based.
  return { kind: "mouse", button, col: frame.col, row: frame.row, release: frame.action === 0 && frame.button !== 4 };
}

/** Pinned source seams preserve paste/mouse provenance before xterm turns it into escape bytes. */
export function wireNativeXtermInput(term: Terminal, send: (input: NativeTerminalInput) => void, enabled: () => boolean, clipboard: { copy(text: string): void; selectAll(): void }, focus: (focused: boolean) => void = () => {}) {
  const core = (term as unknown as { _core: InputCore })._core;
  if (metadata.version !== "6.0.0" || !core?.coreMouseService?.triggerMouseEvent || !core.coreService?.triggerBinaryEvent || !core.paste || !core._isThirdLevelShift || !core._handleTextAreaFocus || !core._handleTextAreaBlur) throw new Error("The native terminal input adapter needs verification for this xterm version.");
  const originalMouse = core.coreMouseService.triggerMouseEvent, originalData = core.coreService.triggerDataEvent, originalBinary = core.coreService.triggerBinaryEvent, originalPaste = core.paste;
  const originalFocus = core._handleTextAreaFocus, originalBlur = core._handleTextAreaBlur;
  let frame: MouseEventFrame | undefined;
  let focused: boolean | undefined;
  const emit = (input: NativeTerminalInput) => { if (enabled()) send(input); };
  const mouse: InputCore["coreMouseService"]["triggerMouseEvent"] = function(event) { const previous = frame; frame = event; try { return originalMouse.call(core.coreMouseService, event); } finally { frame = previous; } };
  const data: InputCore["coreService"]["triggerDataEvent"] = function(value, user) { if (frame) emit(nativeMouse(frame)); else if (focused !== undefined) focus(focused); else originalData.call(core.coreService, value, user); };
  const binary: InputCore["coreService"]["triggerBinaryEvent"] = function(value) { if (frame) emit(nativeMouse(frame)); else originalBinary.call(core.coreService, value); };
  const paste = (value: string) => { emit({ kind: "paste", data: value }); if (term.textarea) term.textarea.value = ""; };
  const focusIn = (event: FocusEvent) => { const previous = focused; focused = true; try { originalFocus.call(core, event); } finally { focused = previous; } };
  const focusOut = () => { const previous = focused; focused = false; try { originalBlur.call(core); } finally { focused = previous; } };
  core.coreMouseService.triggerMouseEvent = mouse; core.coreService.triggerDataEvent = data; core.coreService.triggerBinaryEvent = binary; core.paste = paste;
  core._handleTextAreaFocus = focusIn; core._handleTextAreaBlur = focusOut;
  const onData = term.onData(value => emit({ kind: "text", data: value }));
  const onBinary = term.onBinary(value => emit({ kind: "bytes", base64: binaryTerminalInput(value) }));
  const onPaste = (event: ClipboardEvent) => { if (!event.clipboardData) return; event.preventDefault(); event.stopImmediatePropagation(); paste(event.clipboardData.getData("text/plain")); };
  term.element?.addEventListener("paste", onPaste, true);
  term.attachCustomKeyEventHandler(event => {
    if (event.type !== "keydown") return true;
    if ((event.metaKey && !event.ctrlKey || event.ctrlKey && event.shiftKey) && event.key.toLowerCase() === "c" && term.hasSelection()) { event.preventDefault(); clipboard.copy(term.getSelection()); return false; }
    if (event.metaKey && event.key.toLowerCase() === "a") { event.preventDefault(); clipboard.selectAll(); return false; }
    // Preserve xterm's platform Option/AltGraph and IME behavior before mapping special keys.
    if (event.isComposing || event.key === "Dead" || event.key === "AltGraph" || core._isThirdLevelShift(core.browser, event)) return true;
    const key = nativeKey(event);
    if (!key) return true;
    if (event.metaKey) event.stopPropagation();
    event.preventDefault(); emit({ kind: "key", key }); return false;
  });
  return { dispose() {
    onData.dispose(); onBinary.dispose(); term.element?.removeEventListener("paste", onPaste, true);
    if (core.coreMouseService.triggerMouseEvent === mouse) core.coreMouseService.triggerMouseEvent = originalMouse;
    if (core.coreService.triggerDataEvent === data) core.coreService.triggerDataEvent = originalData;
    if (core.coreService.triggerBinaryEvent === binary) core.coreService.triggerBinaryEvent = originalBinary;
    if (core.paste === paste) core.paste = originalPaste;
    if (core._handleTextAreaFocus === focusIn) core._handleTextAreaFocus = originalFocus;
    if (core._handleTextAreaBlur === focusOut) core._handleTextAreaBlur = originalBlur;
  } };
}
