import { expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import type { NativeTerminalInput } from "../../../../packages/shared/src/terminals";
import { nativeKey, wireNativeXtermInput } from "./native-xterm-input";
import { separateXtermReplies } from "./xterm-input";
const key = (value: string, options = {}) => ({ key: value, code: "", location: 0, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, isComposing: false, ...options });

test("native keys preserve modifiers, application keypad provenance, and composition text", () => {
  expect(nativeKey(key("ArrowUp"))).toBe("Up"); expect(nativeKey(key("ArrowLeft", { ctrlKey: true, altKey: true, shiftKey: true }))).toBe("C-M-S-Left");
  expect(nativeKey(key("Tab", { shiftKey: true }))).toBe("BTab"); expect(nativeKey(key("c", { ctrlKey: true }))).toBe("C-c");
  expect(nativeKey(key("1", { location: 3, code: "Numpad1" }))).toBe("KP1"); expect(nativeKey(key("Enter", { location: 3, code: "NumpadEnter" }))).toBe("KPEnter");
  expect(nativeKey(key("Dead", { isComposing: true }))).toBeUndefined(); expect(nativeKey(key("λ"))).toBeUndefined();
});

test("real xterm paste and mouse sources remain typed while parser replies stay attachment-scoped", async () => {
  const term = new Terminal({ cols: 80, rows: 24 });
  const core = (term as any)._core; core.textarea = { value: "" };
  const parser = separateXtermReplies(term), inputs: NativeTerminalInput[] = [];
  const wired = wireNativeXtermInput(term, input => inputs.push(input), () => true, { copy() {}, selectAll() {} });
  try {
    const replies = await parser.write("\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[4;9H\x1b[6n", 7);
    term.paste("raw\nλ paste"); term.input("typed λ", true);
    core.coreMouseService.triggerMouseEvent({ col: 39, row: 10, x: 0, y: 0, button: 0, action: 1, ctrl: true });
    core.coreMouseService.triggerMouseEvent({ col: 39, row: 10, x: 0, y: 0, button: 0, action: 0 });
    core.coreService.triggerBinaryEvent(String.fromCharCode(0, 255));
    expect(replies).toEqual([{ data: "\x1b[4;9R", outputSequence: 7, ordinal: 1 }]);
    expect(inputs).toEqual([{ kind: "paste", data: "raw\nλ paste" }, { kind: "text", data: "typed λ" }, { kind: "mouse", button: 16, col: 40, row: 11, release: false }, { kind: "mouse", button: 0, col: 40, row: 11, release: true }, { kind: "bytes", base64: "AP8=" }]);
    const count = inputs.length; core.coreMouseService.triggerMouseEvent({ col: 80, row: 0, x: 0, y: 0, button: 0, action: 1 }); expect(inputs).toHaveLength(count);
    await parser.write("\x1b[?1006l", 8); core.coreMouseService.triggerMouseEvent({ col: 2, row: 3, x: 0, y: 0, button: 4, action: 0 });
    expect(inputs.at(-1)).toEqual({ kind: "mouse", button: 64, col: 3, row: 4, release: false });
  } finally { wired.dispose(); parser.dispose(); term.dispose(); }
});

test("disposing an attachment cancels an in-flight parser batch without leaving a waiter", async () => {
  const term = new Terminal(), parser = separateXtermReplies(term);
  const pending = parser.write("\x1b[6n", 1); parser.dispose();
  await expect(pending).rejects.toThrow("disposed"); term.dispose();
});
