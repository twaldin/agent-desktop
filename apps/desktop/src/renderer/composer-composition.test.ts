import { expect, test } from "bun:test";
import { ComposerCompositionGuard } from "./composer-composition";

const enter = (timeStamp: number, isComposing = false, keyCode = 13) => ({
  key: "Enter", code: "Enter", timeStamp, isComposing, keyCode,
});

test("a native IME confirmation replay cannot become a new composer action", () => {
  const guard = new ComposerCompositionGuard();
  // Captured on macOS: composing Enter, compositionend, keyup, then a
  // non-composing Enter with the same native timestamp and physical code.
  expect(guard.classify(enter(4428598.7, true, 229))).toBe("composition");
  expect(guard.classify(enter(4428598.7))).toBe("replay");
  expect(guard.classify(enter(4428598.7))).toBe("replay");
  // A genuinely new Enter is eligible immediately; there is no cooldown.
  expect(guard.classify(enter(4428598.8))).toBeUndefined();
});

test("legacy IME key codes and the editor composition state preserve input ownership", () => {
  const guard = new ComposerCompositionGuard();
  expect(guard.classify(enter(10, false, 229))).toBe("composition");
  expect(guard.classify(enter(10))).toBe("replay");
  expect(guard.classify(enter(11), true)).toBe("composition");
  expect(guard.classify(enter(11))).toBe("replay");
  expect(guard.classify({ ...enter(12), key: "a", code: "KeyA" })).toBeUndefined();
  expect(guard.classify(enter(13))).toBeUndefined();
});

test("a new editor ownership lifetime cannot inherit an old confirmation", () => {
  const guard = new ComposerCompositionGuard();
  guard.classify(enter(20, true, 229));
  guard.reset();
  expect(guard.classify(enter(20))).toBeUndefined();
});
