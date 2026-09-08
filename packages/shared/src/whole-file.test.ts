import { expect, test } from "bun:test";
import { copyWholeFileAttachments, hasRepeatedWholeFileIntent, hasRepeatedWholeFileSources, MAX_WHOLE_FILE_ATTACHMENTS, parseInlineWholeFileMentions, parseWholeFileAttachments, sameWholeFileAttachments, serializeRepeatedWholeFilePrompt, type WholeFileAttachment } from "./whole-file";

const file = (id = "file-one", path = "/outside/project/file.ts", hostId = "other-owner", textOffset?: number): WholeFileAttachment => ({
  id, ...(textOffset !== undefined ? { textOffset } : {}), source: { kind: "file", hostId, path },
});

test("whole-file references retain literal remote provenance without content or ranges", () => {
  const input = file(), parsed = parseWholeFileAttachments([input]);
  expect(parsed).toEqual([input]);
  expect(parsed[0]).not.toBe(input); expect(parsed[0]!.source).not.toBe(input.source);
  input.source.path = "/changed";
  expect(parsed[0]!.source.path).toBe("/outside/project/file.ts");
  expect(Object.keys(parsed[0]!.source)).toEqual(["kind", "hostId", "path"]);
});

test("whole-file identities and sources are distinct while order remains meaningful", () => {
  const one = file(), two = file("file-two", "/outside/project/other.ts");
  expect(parseWholeFileAttachments([one, two])).toEqual([one, two]);
  expect(() => parseWholeFileAttachments([one, file("file-one", "/different")])).toThrow("identities");
  expect(() => parseWholeFileAttachments([one, file("file-two")])).toThrow("sources");
  expect(parseWholeFileAttachments([one, file("file-two", one.source.path, "different-host")])).toHaveLength(2);
  expect(sameWholeFileAttachments([one, two], [two, one])).toBe(false);
  expect(sameWholeFileAttachments([one], copyWholeFileAttachments([one]))).toBe(true);
  expect(sameWholeFileAttachments(undefined, [])).toBe(false);
});

test("UTF-16 text offsets are copied, compared, contextually bounded, and ordered ties are allowed", () => {
  const one = file("file-one", "/one", "owner", 2), two = file("file-two", "/two", "owner", 2);
  expect(parseWholeFileAttachments([one, two], "😀".length)).toEqual([one, two]);
  expect(copyWholeFileAttachments([one])).toEqual([one]);
  expect(sameWholeFileAttachments([one], [file("file-one", "/one", "owner", 2)])).toBe(true);
  expect(sameWholeFileAttachments([one], [file("file-one", "/one", "owner", 1)])).toBe(false);
  expect(() => parseWholeFileAttachments([file("file", "/file", "owner", 3)], "😀".length)).toThrow("UTF-16");
  expect(() => parseWholeFileAttachments([file("file", "/file", "owner", -1)])).toThrow("UTF-16");
  expect(() => parseWholeFileAttachments([{ ...file(), textOffset: undefined }])).toThrow("UTF-16");
  expect(() => parseWholeFileAttachments([{ ...file(), textOffset: 0, extra: true }])).toThrow();
});

test("v9 inline mentions retain repeated sources with distinct identities and stable ties", () => {
  const repeated = [file("first", "/same.ts", "owner", 1), file("second", "/same.ts", "owner", 1)];
  expect(parseInlineWholeFileMentions(repeated, 2)).toEqual(repeated);
  expect(hasRepeatedWholeFileSources(repeated)).toBe(true);
  expect(hasRepeatedWholeFileIntent({ type: "draft.put", draft: { wholeFileAttachments: repeated } })).toBe(true);
  expect(serializeRepeatedWholeFilePrompt("ab", repeated)).toBe(`a[same\\.ts](/same.ts)[same\\.ts](/same.ts)b`);
  expect(() => parseInlineWholeFileMentions([file("legacy", "/same.ts")], 0)).toThrow("offsets");
  expect(() => parseInlineWholeFileMentions([repeated[0], { ...repeated[1], id: "first" }], 2)).toThrow("identities");
  expect(() => parseWholeFileAttachments(repeated, 2)).toThrow("sources");
});

test("parser enforces a bounded, exact, canonical absolute file contract", () => {
  expect(parseWholeFileAttachments(Array.from({ length: MAX_WHOLE_FILE_ATTACHMENTS }, (_, index) => file(`file-${index}`, `/files/${index}`)))).toHaveLength(MAX_WHOLE_FILE_ATTACHMENTS);
  expect(() => parseWholeFileAttachments(Array.from({ length: MAX_WHOLE_FILE_ATTACHMENTS + 1 }, (_, index) => file(`file-${index}`, `/files/${index}`)))).toThrow("100");
  for (const invalid of [null, {}, new Array(2), [undefined], [Object.create(file())],
    [{ ...file(), text: "do not snapshot" }], [{ ...file(), source: { ...file().source, range: {} } }],
    [{ ...file(), source: { ...file().source, kind: "directory" } }],
    [file("file", "relative")], [file("file", "/")], [file("file", "/one/")], [file("file", "/one//two")],
    [file("file", "/one/./two")], [file("file", "/one/../two")], [file("file", "/bad\npath")],
    [file("bad\nid")], [file("file", "/file", "bad\nhost")],
  ]) expect(() => parseWholeFileAttachments(invalid)).toThrow();
});
