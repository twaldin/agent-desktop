import { expect, test } from "bun:test";
import { goToLineNumber } from "./go-to-line";

test("line numbers clamp and negative numbers count from the end", () => {
  expect(["1", "14", "15", "-1", "-14", "-15", " 003 ", "-0002"].map(value => goToLineNumber(value, 14)))
    .toEqual([1, 14, 14, 14, 1, 1, 3, 13]);
  expect(goToLineNumber("9007199254740991", 14)).toBe(14);
  expect(goToLineNumber("-9007199254740991", 14)).toBe(1);
  expect(goToLineNumber("-1", 0)).toBe(1);
});

test("rejects zero, unsafe integers, and the unrelated CodeMirror column/percentage grammar", () => {
  for (const value of ["", " ", "0", "-0", "000", "1.0", "1e2", "+2", "2:3", "50%", "0x10", "1 2", "NaN", "Infinity", "9007199254740992", "-9007199254740992"])
    expect(goToLineNumber(value, 14)).toBeNull();
});
