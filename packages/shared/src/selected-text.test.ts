import { expect, test } from "bun:test";
import { fileTextSelection, MAX_SELECTED_TEXT_SERIALIZED_CHARS, parseSelectedTextAttachments, sameSelectedTextAttachments, type SelectedTextAttachment } from "./selected-text";

const snapshot = (text = "  original α\nlast line  ", id = "selection-one"): SelectedTextAttachment => ({ id, text,
  source: { kind: "file", hostId: "other-owner", path: "/deleted-or-unsaved/README.md", range: fileTextSelection(text, 0, text.length)!.range } });

test("captured excerpts retain exact whitespace and remote provenance without rereading files", () => {
  const input = snapshot(), parsed = parseSelectedTextAttachments([input]);
  expect(parsed).toEqual([input]); expect(parsed[0]).not.toBe(input);
  input.text = "replaced"; input.source.path = "/new-path"; input.source.range.end.line = 90;
  expect(parsed[0]!.text).toBe("  original α\nlast line  ");
  expect(parsed[0]!.source.path).toBe("/deleted-or-unsaved/README.md");
  expect(parsed[0]!.source.range.end.line).toBe(2);
});

test("same content is repeatable with independent identities and preserved order", () => {
  const one = snapshot("quote", "one"), two = snapshot("quote", "two");
  expect(parseSelectedTextAttachments([one, two])).toEqual([one, two]);
  expect(sameSelectedTextAttachments([one, two], [two, one])).toBe(false);
  expect(sameSelectedTextAttachments([one], structuredClone([one]))).toBe(true);
  expect(sameSelectedTextAttachments([one], [{ text: one.text, source: one.source, id: one.id }])).toBe(true);
  expect(() => parseSelectedTextAttachments([one, one])).toThrow("distinct");
  expect(sameSelectedTextAttachments(undefined, [])).toBe(false);
  expect(parseSelectedTextAttachments([])).toEqual([]);
});

test("snapshot parser rejects malformed or inconsistent ranges and unknown transport fields", () => {
  for (const invalid of [null, {}, new Array(2), [undefined], [Object.create(snapshot())],
    [{ ...snapshot(), source: Object.create(snapshot().source) }], [{ ...snapshot(), command: "run" }],
    [{ ...snapshot(), text: "  \n\t" }], [{ ...snapshot(), text: "x\0" }],
    [{ ...snapshot(), source: { ...snapshot().source, kind: "browser" } }],
    [{ ...snapshot(), source: { ...snapshot().source, path: "relative" } }],
    [{ ...snapshot(), source: { ...snapshot().source, path: "/one/../two" } }],
    [{ ...snapshot(), source: { ...snapshot().source, path: "/one/./two" } }],
    [{ ...snapshot(), source: { ...snapshot().source, hostId: "bad\nowner" } }],
    [{ ...snapshot(), source: { ...snapshot().source, range: { start: { line: 0, column: 1 }, end: { line: 2, column: 1 } } } }],
    [{ ...snapshot("quote"), source: { ...snapshot().source, range: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } } } }],
    [{ ...snapshot(), source: { ...snapshot().source, range: { start: { line: 2, column: 1 }, end: { line: 1, column: 1 } } } }],
    [{ ...snapshot(), source: { ...snapshot().source, range: { start: { line: 1, column: 1 }, end: { line: Infinity, column: 1 } } } }],
  ]) expect(() => parseSelectedTextAttachments(invalid)).toThrow();
});

test("serialized bound counts provenance and escaped text across the whole ordered batch", () => {
  expect(() => parseSelectedTextAttachments([snapshot("x".repeat(MAX_SELECTED_TEXT_SERIALIZED_CHARS))])).toThrow("400,000");
  expect(() => parseSelectedTextAttachments([snapshot("\\".repeat(200_000))])).toThrow("400,000");
  expect(() => parseSelectedTextAttachments([snapshot("x".repeat(210_000), "one"), snapshot("y".repeat(210_000), "two")])).toThrow("400,000");
  expect(parseSelectedTextAttachments([snapshot("x".repeat(100_000), "one"), snapshot("y".repeat(100_000), "two")])).toHaveLength(2);
  const original = snapshot("x".repeat(399_000)), available = MAX_SELECTED_TEXT_SERIALIZED_CHARS - JSON.stringify([original]).length + original.text.length;
  expect(JSON.stringify(parseSelectedTextAttachments([snapshot("x".repeat(available))])).length).toBe(MAX_SELECTED_TEXT_SERIALIZED_CHARS);
});

test("file selection preserves CRLF, CR, LF, astral characters and exclusive UTF-16 positions", () => {
  const value = "first\r\n  α😀 here\rfinal\n";
  const from = value.indexOf("α"), to = value.indexOf("final") + "final".length;
  const selection = fileTextSelection(value, from, to)!;
  expect(selection).toEqual({ text: "α😀 here\rfinal", range: { start: { line: 2, column: 3 }, end: { line: 3, column: 6 } } });
  expect(parseSelectedTextAttachments([{ ...snapshot(), ...selection, source: { ...snapshot().source, range: selection.range } }].map(({ range: _, ...item }) => item))).toHaveLength(1);
  expect(fileTextSelection(value, from, from + 3)).toEqual({ text: "α😀", range: { start: { line: 2, column: 3 }, end: { line: 2, column: 6 } } });
  for (const [a, b] of [[0, 0], [-1, 3], [3, 2], [0, value.length + 1], [0.5, 3], [0, Infinity]]) expect(fileTextSelection(value, a!, b!)).toBeUndefined();
  expect(fileTextSelection(" \r\n ", 0, 4)).toBeUndefined();
  expect(fileTextSelection("a\r\nb", 0, 2)).toBeUndefined();
  expect(fileTextSelection("a\r\nb", 2, 4)).toBeUndefined();
});
