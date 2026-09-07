import { expect, test } from "bun:test";
import { rawOffsetAt } from "./editor-selection";
import { fileTextSelection } from "../../../../packages/shared/src/selected-text";
test("native editor coordinates preserve blank first/last lines and mixed raw line separators", () => {
  const raw = "\r\n🌊\rthird\n";
  expect(rawOffsetAt(raw, { line: 0, character: 0 })).toBe(0);
  expect(rawOffsetAt(raw, { line: 1, character: 0 })).toBe(2);
  expect(rawOffsetAt(raw, { line: 1, character: 2 })).toBe(4);
  expect(rawOffsetAt(raw, { line: 2, character: 0 })).toBe(5);
  expect(rawOffsetAt(raw, { line: 3, character: 0 })).toBe(raw.length);
  expect(fileTextSelection(raw, 0, rawOffsetAt(raw, { line: 3, character: 0 }))?.text).toBe(raw);
});
