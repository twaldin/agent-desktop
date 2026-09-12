import { expect, test } from "bun:test";
import { effectiveSendMode, submissionForEnter, type ComposerEnterKey } from "./follow-up-submit";
const key = (patch: Partial<ComposerEnterKey> = {}): ComposerEnterKey => ({ key: "Enter", altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, keyCode: 13, isComposing: false, ...patch });

test("Enter mode keeps plain Enter normal and Command or Control Enter opposite only during a turn", () => {
  const mode = effectiveSendMode("enter", "first\nsecond");
  expect(mode).toEqual({ normal: "enter", opposite: "mod-enter" });
  expect(submissionForEnter(key(), mode, "follow-up")).toBe("follow-up");
  expect(submissionForEnter(key({ metaKey: true }), mode, "follow-up")).toBe("steer");
  expect(submissionForEnter(key({ ctrlKey: true }), mode, "steer")).toBe("follow-up");
  expect(submissionForEnter(key(), mode, null)).toBe("send");
  expect(submissionForEnter(key({ metaKey: true }), mode, null)).toBe("send");
});

test("always-modified mode requires a modifier even on one line and Shift inverts only during a turn", () => {
  const mode = effectiveSendMode("mod-enter", "one line");
  expect(submissionForEnter(key(), mode, null)).toBeNull();
  expect(submissionForEnter(key(), mode, "steer")).toBeNull();
  expect(submissionForEnter(key({ ctrlKey: true }), mode, null)).toBe("send");
  expect(submissionForEnter(key({ metaKey: true }), mode, "steer")).toBe("steer");
  expect(submissionForEnter(key({ metaKey: true, shiftKey: true }), mode, "steer")).toBe("follow-up");
  expect(submissionForEnter(key({ metaKey: true, shiftKey: true }), mode, null)).toBeNull();
});

test("conditional single-line send keeps modified Enter normal and modified Shift Enter opposite", () => {
  const mode = effectiveSendMode("mod-enter-if-multiline", "one line");
  expect(mode).toEqual({ normal: "enter", opposite: "mod-shift-enter" });
  expect(submissionForEnter(key(), mode, null)).toBe("send");
  expect(submissionForEnter(key(), mode, "follow-up")).toBe("follow-up");
  expect(submissionForEnter(key({ metaKey: true }), mode, "follow-up")).toBe("follow-up");
  expect(submissionForEnter(key({ ctrlKey: true, shiftKey: true }), mode, "follow-up")).toBe("steer");
});

test("conditional multiline send leaves Enter to the editor and retains both active-turn lanes", () => {
  const mode = effectiveSendMode("mod-enter-if-multiline", "first\nsecond");
  expect(mode).toEqual({ normal: "mod-enter", opposite: "mod-shift-enter" });
  expect(submissionForEnter(key(), mode, null)).toBeNull();
  expect(submissionForEnter(key(), mode, "steer")).toBeNull();
  expect(submissionForEnter(key({ metaKey: true }), mode, null)).toBe("send");
  expect(submissionForEnter(key({ ctrlKey: true }), mode, "steer")).toBe("steer");
  expect(submissionForEnter(key({ metaKey: true, shiftKey: true }), mode, "steer")).toBe("follow-up");
});

test("conditional mode counts authored blank and trailing lines without treating wrapping as a newline", () => {
  for (const text of ["\n", "text\n", "\ntext", "first\n\nlast", " \n "])
    expect(effectiveSendMode("mod-enter-if-multiline", text).normal).toBe("mod-enter");
  for (const text of ["", "   ", "a long visually wrapped line ".repeat(100)])
    expect(effectiveSendMode("mod-enter-if-multiline", text).normal).toBe("enter");
  expect(effectiveSendMode("enter", "\n").normal).toBe("enter");
  expect(effectiveSendMode("mod-enter", "").normal).toBe("mod-enter");
});

test("Shift Enter, IME, keyCode 229, Alt and unrelated keys cannot submit in any effective mode", () => {
  const modes = [effectiveSendMode("enter", ""), effectiveSendMode("mod-enter", ""),
    effectiveSendMode("mod-enter-if-multiline", "")];
  const blocked = [key({ shiftKey: true }), key({ isComposing: true }), key({ keyCode: 229 }),
    key({ altKey: true }), key({ metaKey: true, altKey: true }), key({ key: "a" }),
    key({ metaKey: true, shiftKey: true, isComposing: true }),
    key({ ctrlKey: true, shiftKey: true, keyCode: 229 }),
    key({ metaKey: true, shiftKey: true, altKey: true })];
  for (const mode of modes)
    for (const selected of [null, "follow-up", "steer"] as const)
      for (const event of blocked) expect(submissionForEnter(event, mode, selected)).toBeNull();
  expect(submissionForEnter(key({ metaKey: true, shiftKey: true }), modes[0]!, "follow-up")).toBeNull();
});
