import { expect, test } from "bun:test";
import { serializeRepeatedWholeFilePrompt, serializeWholeFilePrompt, type TranscriptMessage, type WholeFileAttachment } from "@agent-desktop/shared";
import { projectWholeFiles } from "./whole-file-history";
import { WHOLE_FILE_ATTEMPT_TYPE, WHOLE_FILE_BINDING_TYPE } from "./whole-file";

const authoredText = "Open 😀 then explain";
const attachments: WholeFileAttachment[] = [
  { id: "a", textOffset: 0, source: { kind: "file", hostId: "host", path: "/project/a.ts" } },
  { id: "b", textOffset: 7, source: { kind: "file", hostId: "host", path: "/project/b #.md" } },
];
const nativeText = serializeWholeFilePrompt(authoredText, attachments);
const attempt = { id: "attempt", type: "custom", customType: WHOLE_FILE_ATTEMPT_TYPE, data: { version: 1, submissionId: "send" } };
const files = { id: "files", type: "message", message: { role: "fileMention", timestamp: 1, files: attachments.map(item => ({ path: item.source.path, content: "snapshot" })) } };
const user = { id: "user", type: "message", message: { role: "user", content: nativeText, timestamp: 2 } };
const binding = { id: "binding", type: "custom", customType: WHOLE_FILE_BINDING_TYPE, data: { version: 2, submissionId: "send", userEntryId: "user", fileEntryIds: ["files"], authoredText, attachments } };
const messages = (): TranscriptMessage[] => [
  { id: "files-display", nativeId: "files", role: "fileMention", text: "", fileReferences: attachments.map(item => ({ path: item.source.path, content: "snapshot" })) },
  { id: "user-display", nativeId: "user", role: "user", text: nativeText, content: [{ type: "text", text: nativeText }], blocks: [{ type: "text", text: nativeText }] },
];

test("a strict v2 binding projects inline file provenance onto its exact native user", () => {
  const result = projectWholeFiles(messages(), [attempt, files, user, binding]);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ id: "user-display", text: nativeText, wholeFiles: { bindingEntryId: "binding", submissionId: "send", fileEntryIds: ["files"], authoredText, attachments } });
  result[0]!.wholeFiles!.attachments[0]!.source.path = "/changed";
  expect(attachments[0]!.source.path).toBe("/project/a.ts");
});

test("legacy, malformed, ambiguous, forged, and misordered bindings retain native file rows", () => {
  const legacy = { ...binding, data: { version: 1, submissionId: "send", userEntryId: "user", fileEntryIds: ["files"] } };
  const variants = [
    [attempt, files, user, legacy],
    [attempt, files, user, { ...binding, data: { ...binding.data, authoredText: "wrong" } }],
    [attempt, files, user, binding, { ...binding, id: "duplicate" }],
    [attempt, { ...files, message: { ...files.message, files: [{ path: "/other", content: "snapshot" }] } }, user, binding],
    [attempt, files, { ...files, id: "files", message: { ...files.message, timestamp: 9 } }, user, binding],
    [attempt, files, user, { ...binding, data: { ...binding.data, attachments: [{ ...attachments[0], source: { ...attachments[0]!.source, path: "/\ud800" } }] } }],
    [attempt, files, binding, user],
    [files, user, binding],
  ];
  for (const branch of variants) {
    const result = projectWholeFiles(messages(), branch);
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("fileMention");
    expect(result[1]!.wholeFiles).toBeUndefined();
  }
});

test("verified skipped native file records remain visible beside bound provenance", () => {
  const skippedFiles = { ...files, message: { ...files.message, files: attachments.map(item => ({ path: item.source.path, content: "skipped", skippedReason: "tooLarge" })) } };
  const display = messages(); display[0]!.fileReferences = attachments.map(item => ({ path: item.source.path, content: "skipped", skippedReason: "tooLarge" }));
  const result = projectWholeFiles(display, [attempt, skippedFiles, user, binding]);
  expect(result).toHaveLength(2);
  expect(result[0]!.role).toBe("fileMention");
  expect(result[1]!.wholeFiles?.bindingEntryId).toBe("binding");
});

test("a binding never moves to an adjacent or content-equal user", () => {
  const unrelated = { id: "other", type: "message", message: { role: "user", content: nativeText, timestamp: 2 } };
  const display = messages(); display.push({ id: "other-display", nativeId: "other", role: "user", text: nativeText });
  const result = projectWholeFiles(display, [attempt, files, unrelated, user, binding]);
  expect(result.find(item => item.nativeId === "other")?.wholeFiles).toBeUndefined();
  expect(result.find(item => item.nativeId === "user")?.wholeFiles?.bindingEntryId).toBe("binding");
});

test("binding v3 projects every repeated mention from one verified native snapshot", () => {
  const repeated = [attachments[0]!, { ...attachments[0]!, id: "again", textOffset: authoredText.length }];
  const wire = serializeRepeatedWholeFilePrompt(authoredText, repeated);
  const repeatedUser = { ...user, message: { role: "user", content: wire } };
  const repeatedBinding = { ...binding, data: { ...binding.data, version: 3, attachments: repeated } };
  const display: TranscriptMessage[] = [
    { id: "files-display", nativeId: "files", role: "fileMention", text: "", fileReferences: [{ path: repeated[0]!.source.path, content: "snapshot" }] },
    { id: "user-display", nativeId: "user", role: "user", text: wire, content: [{ type: "text", text: wire }] },
  ];
  const forgedDisplay = structuredClone(display);
  const result = projectWholeFiles(display, [attempt, { ...files, message: { ...files.message, files: [{ path: repeated[0]!.source.path, content: "snapshot" }] } }, repeatedUser, repeatedBinding]);
  expect(result).toHaveLength(1); expect(result[0]!.wholeFiles?.attachments).toEqual(repeated);
  const forgedV2 = projectWholeFiles(forgedDisplay, [attempt, files, repeatedUser, { ...repeatedBinding, data: { ...repeatedBinding.data, version: 2 } }]);
  expect(forgedV2.some(item => item.role === "fileMention")).toBe(true); expect(forgedV2.find(item => item.role === "user")?.wholeFiles).toBeUndefined();
  const mixedOwners = repeated.map((item, index) => index ? { ...item, source: { ...item.source, hostId: "other" } } : item);
  const forgedOwners = projectWholeFiles(structuredClone(forgedDisplay), [attempt, files, repeatedUser,
    { ...repeatedBinding, data: { ...repeatedBinding.data, attachments: mixedOwners } }]);
  expect(forgedOwners.some(item => item.role === "fileMention")).toBe(true); expect(forgedOwners.find(item => item.role === "user")?.wholeFiles).toBeUndefined();
});
