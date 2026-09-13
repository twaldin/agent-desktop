import { expect, test } from "bun:test";
import type { TranscriptMessage } from "../../../../packages/shared/src/protocol";
import { captureConversationMarkdown, type ConversationMarkdownSnapshot } from "./conversation-markdown";

const owner = { hostId: "host-a", sessionId: "chat-a" };
const snapshot = (messages: TranscriptMessage[]): ConversationMarkdownSnapshot => ({ owner, source: "host", loaded: true, loading: false, error: null, messages });

test("retains literal Markdown, user attribution and ordered tool output without breaking embedded fences", () => {
  const messages: TranscriptMessage[] = [
    { id: "u", role: "user", text: "**keep**\n\n```ts\n  source();  \n```" },
    { id: "a", role: "assistant", text: "[literal](./file.ts)\n\n> quoted", content: [{ type: "text", text: "[literal](./file.ts)\n\n> quoted" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "```" } }] },
    { id: "t", role: "toolResult", text: "fallback must not duplicate", content: [{ type: "text", text: "```\n  exact output  \n````" }], tool: { callId: "call", name: "read", status: "completed", isError: false } },
  ];
  const before = JSON.stringify(messages);
  const copied = captureConversationMarkdown(snapshot(messages), owner, "A # title");
  expect(copied).toBe('# A \\# title\n\n> **keep**\n>\n> ```ts\n>   source();  \n> ```\n\n[literal](./file.ts)\n\n> quoted\n\nTool call: ` read `\n\n````json\n{\n  "path": "```"\n}\n````\n\nTool result: ` read ` — Completed\n\n`````text\n```\n  exact output  \n````\n`````\n');
  expect(JSON.stringify(messages)).toBe(before);
});

test("refuses stale ownership, cached, loading, failed and empty snapshots rather than exporting another conversation", () => {
  const ready = snapshot([{ id: "a", role: "assistant", text: "original" }]);
  for (const change of [{ owner: null }, { owner: { ...owner, hostId: "host-b" } }, { owner: { ...owner, sessionId: "chat-b" } }, { source: "cache" as const }, { loaded: false }, { loading: true }, { error: "Host read refused" }, { messages: [] }])
    expect(() => captureConversationMarkdown({ ...ready, ...change }, owner, "Title")).toThrow();
  const captured = captureConversationMarkdown(ready, owner, "Title");
  ready.messages[0]!.text = "later streamed update";
  expect(captured).toBe("# Title\n\noriginal\n");
  expect(() => captureConversationMarkdown(snapshot([{ id: "empty", role: "user", text: "" }]), owner, "Title")).toThrow();
});

test("qualifies truncated, failed, image and unsupported content without exporting hidden reasoning or provider metadata", () => {
  const copied = captureConversationMarkdown(snapshot([
    { id: "a", role: "assistant", text: "", lifecycle: "complete", assistant: { provider: "PRIVATE-PROVIDER", model: "PRIVATE-MODEL", stopReason: "error", errorMessage: "Visible failure" }, content: [{ type: "thinking", thinking: "PRIVATE-REASONING" }, { type: "image", nativeType: "image", blockIndex: 0, mimeType: "image/png" }, { type: "unsupported", nativeType: "redactedThinking" }] },
    { id: "t", role: "toolResult", text: "only recorded preview", tool: { callId: "call", isError: true, status: "completed", output: { truncation: { truncated: true, direction: "middle", partialLine: true, artifactId: "full-output" }, summary: { lines: 1, elidedSpans: 1, elidedLines: 9 } } } },
    { id: "s", role: "system", text: "PRIVATE-SYSTEM-PAYLOAD" },
  ]), owner, "Title");
  expect(copied).toContain("Reasoning content is omitted");
  expect(copied).toContain("image data is not included");
  expect(copied).toContain("provider withheld this reasoning");
  expect(copied).toContain("Visible failure");
  expect(copied).toContain("— Failed");
  expect(copied).toContain("middle omitted");
  expect(copied).toContain("shown line is partial");
  expect(copied).toContain("summary omits 9 lines");
  expect(copied).toContain("only recorded preview");
  expect(copied).toContain("artifact://full-output");
  expect(copied).not.toContain("PRIVATE-");
});

test("keeps every user line attributed across CRLF and native carriage-return line endings", () => {
  expect(captureConversationMarkdown(snapshot([{ id: "u", role: "user", text: "first\r\n\r\nsecond\rthird" }]), owner, "Title"))
    .toBe("# Title\n\n> first\n>\n> second\n> third\n");
});

test("keeps captured selected text and native file qualifications without rereading paths or exporting image bytes", () => {
  const copied = captureConversationMarkdown(snapshot([
    { id: "u", role: "user", text: "Use this excerpt", selectedText: { contextEntryId: "context", submissionId: "submission", attachments: [{ id: "selection", text: "unsaved snapshot", source: { kind: "file", hostId: "remote-host", path: "/workspace/source.ts", range: { start: { line: 4, column: 2 }, end: { line: 4, column: 18 } } } }] } },
    { id: "f", role: "fileMention", text: "", fileReferences: [{ path: "/workspace/large.dat", content: "", skippedReason: "tooLarge" }, { path: "/workspace/image.png", content: "PRIVATE-IMAGE-BYTES", image: { blockIndex: 1, mimeType: "image/png" } }] },
    { id: "c", role: "commandOutput", text: "wrong fallback", commandOutput: { entryId: "command", command: "status", output: "recorded command result" } },
  ]), owner, "Title");
  expect(copied).toContain("unsaved snapshot");
  expect(copied).toContain("(4:2–4:18)");
  expect(copied).toContain("file too large");
  expect(copied).toContain("recorded command result");
  expect(copied).not.toContain("PRIVATE-IMAGE-BYTES");
  expect(copied).not.toContain("wrong fallback");
});
