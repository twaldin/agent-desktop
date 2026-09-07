import { expect, test } from "bun:test";
import { fileTextSelection, type Draft } from "@agent-desktop/shared";
import { appendSelectedText, selectedTextSendIssue } from "./selected-text-composer";
const draft: Draft = { id: "new-conversation", text: "Explain this", projectId: "project", model: null, revision: 2, updatedAt: 1 };
const capability = { commandVersion: 6 as const, maxSerializedChars: 400000, ordinaryPrompt: true as const };
test("capture preserves remote provenance, original CRLF and independent repeated selections", () => {
  const raw = "🌊 first\r\nsecond\r\n", selection = fileTextSelection(raw, 0, raw.length)!;
  const first = appendSelectedText(draft, { hostId: "remote", path: "/remote/project/file.ts" }, selection);
  const second = appendSelectedText({ ...draft, selectedTextAttachments: first }, { hostId: "remote", path: "/remote/project/file.ts" }, selection);
  expect(second).toHaveLength(2); expect(second[0]!.id).not.toBe(second[1]!.id);
  expect(second[1]!.text).toBe(selection.text); expect(second[1]!.source.hostId).toBe("remote");
  selection.range.start.line = 999;
  expect(second[1]!.source.range.start.line).toBe(1); expect(draft.text).toBe("Explain this");
});
test("send gating keeps unsupported selected inputs explicit without changing ordinary prompts", () => {
  expect(selectedTextSendIssue(draft, true)).toBeUndefined();
  const selected = { ...draft, selectedTextAttachments: appendSelectedText(draft, { hostId: "remote", path: "/file" }, fileTextSelection("text", 0, 4)!) };
  expect(selectedTextSendIssue(selected, false, capability)).toBeUndefined();
  expect(selectedTextSendIssue(selected, false)).toContain("Update");
  expect(selectedTextSendIssue(selected, true, capability)).toContain("finishes");
  expect(selectedTextSendIssue({ ...selected, text: "/compact" }, false, capability)).toContain("not connected");
  expect(selectedTextSendIssue(selected, false, { ...capability, maxSerializedChars: 1 })).toContain("limit");
});
