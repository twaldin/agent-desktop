import { expect, test } from "bun:test";
import { fileSearchDisplayText, fileSearchLabelParts } from "./workspace-file-search-label";

test("file result labels highlight the contiguous query rather than splitting extensions", () => {
  expect(fileSearchLabelParts("main.test.js", " MAIN ")).toEqual([{ text: "main", isMatch: true }, { text: ".test.js", isMatch: false }]);
  expect(fileSearchLabelParts("main.test.js", ".test")).toEqual([{ text: "main", isMatch: false }, { text: ".test", isMatch: true }, { text: ".js", isMatch: false }]);
});

test("fuzzy title highlights preserve unmatched runs and absent filename matches", () => {
  expect(fileSearchLabelParts("main.test.js", "mts")).toEqual([{ text: "m", isMatch: true }, { text: "ain.", isMatch: false }, { text: "t", isMatch: true }, { text: "e", isMatch: false }, { text: "s", isMatch: true }, { text: "t.js", isMatch: false }]);
  expect(fileSearchLabelParts("main.js", "src/")).toEqual([{ text: "main.j", isMatch: false }, { text: "s", isMatch: true }]);
  expect(fileSearchLabelParts("main.js", "xyz")).toEqual([{ text: "main.js", isMatch: false }]);
});

test("empty queries and non-BMP names retain complete code points", () => {
  const name = "\u{10400}name.ts";
  expect(fileSearchLabelParts(name, "")).toEqual([{ text: name, isMatch: true }]);
  expect(fileSearchLabelParts(name, "NAME")).toEqual([{ text: "\u{10400}", isMatch: false }, { text: "name", isMatch: true }, { text: ".ts", isMatch: false }]);
});

test("long display labels clamp at the native 100-codepoint boundary without changing short names", () => {
  const hundred = "\u{10400}".repeat(100);
  expect(fileSearchDisplayText(hundred)).toBe(hundred);
  expect(fileSearchDisplayText(hundred + "x")).toBe("\u{10400}".repeat(99) + "…");
});
