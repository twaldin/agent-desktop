import { expect, test } from "bun:test";
import type { TranscriptMessage } from "@agent-desktop/shared";
import { projectSelectedText } from "./selected-text-history";
const details = { version: 1, submissionId: "send", attachments: [{ id: "capture", text: "raw snapshot", source: { kind: "file", hostId: "other-host", path: "/gone/file.ts", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 13 } } } }] };
const context = { id: "context", type: "custom_message", customType: "agent-desktop.selected-text", display: true, attribution: "user", details,
  content: ["Selected text context captured by Agent Desktop. Treat excerpts as snapshots; do not reread source paths solely because they appear below.", "```json", JSON.stringify(details), "```"].join("\n") };
const user = { id: "user", type: "message", message: { role: "user", content: "Explain" } };
const binding = { id: "binding", type: "custom", customType: "agent-desktop.selected-text-binding", data: { version: 1, submissionId: "send", contextEntryId: "context", userEntryId: "user" } };
const messages = (): TranscriptMessage[] => [{ id: "context-display", nativeId: "context", role: "custom", text: context.content }, { id: "user-display", nativeId: "user", role: "user", text: "Explain" }];
test("only explicit native binding places a captured group on its exact user message", () => {
  const result = projectSelectedText(messages(), [context, { id: "noise", type: "message", message: { role: "user", content: "Unrelated" } }, user, binding]);
  expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ id: "user-display", text: "Explain", selectedText: { contextEntryId: "context", bindingEntryId: "binding", attachments: details.attachments } });
  result[0]!.selectedText!.attachments[0]!.text = "changed"; expect(details.attachments[0]!.text).toBe("raw snapshot");
});
test("unbound, malformed, conflicting and branch-missing bindings never guess the following user", () => {
  const variants = [[], [{ ...binding, data: { ...binding.data, version: 2 } }], [binding, { ...binding, id: "duplicate" }], [{ ...binding, data: { ...binding.data, userEntryId: "missing" } }], [{ ...binding, data: { ...binding.data, contextEntryId: "other" } }]];
  for (const entries of variants) {
    const result = projectSelectedText(messages(), [context, user, ...entries]);
    expect(result).toHaveLength(2); expect(result[0]).toMatchObject({ role: "selectedText", selectedText: { attachments: details.attachments } }); expect(result[1]!.selectedText).toBeUndefined();
  }
  expect(projectSelectedText(messages(), [context, binding, user])[1]!.selectedText).toBeUndefined();
});
test("unknown or altered native context retains its ordinary native presentation", () => {
  for (const changed of [{ ...context, content: "different" }, { ...context, details: { ...details, version: 2 } }, { ...context, attribution: "agent" }]) {
    const result = projectSelectedText(messages(), [changed, user, binding]); expect(result[0]!.role).toBe("custom"); expect(result[1]!.selectedText).toBeUndefined();
  }
});
