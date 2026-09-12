import { expect, test } from "bun:test";
import type { TranscriptMessage } from "@agent-desktop/shared";
import { nativeMcpArtifact, projectMcpArtifacts } from "./mcp-artifacts";

test("a saved result keeps its actual structured data, metadata and effective arguments without parsing display text", () => {
  const message = { role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "A lossy formatted summary" }],
    details: { serverName: "original", mcpToolName: "make", rawContent: [{ type: "text", text: "Protocol text" }],
      structuredContent: { count: 42 }, mcpMeta: { ui: { resourceUri: "ui://original/result" } },
      mcpToolMeta: { ui: { resourceUri: "ui://old/template" } }, mcpArguments: { input: "effective" } } };
  const artifact = nativeMcpArtifact("native-entry", message)!;
  expect(artifact).toMatchObject({ entryId: "native-entry", serverName: "original", resourceUri: "ui://original/result",
    arguments: { input: "effective" }, result: { content: [{ text: "Protocol text" }], structuredContent: { count: 42 } } });
  message.details.structuredContent.count = 0;
  expect(artifact.result.structuredContent).toEqual({ count: 42 });
  (artifact.arguments!).input = "consumer change";
  expect(message.details.mcpArguments.input).toBe("effective");
  expect(nativeMcpArtifact("missing", { ...message, details: undefined })).toBeUndefined();
});

test("only the exact saved native entry gets its artifact, never a reused call ID or transient display row", () => {
  const messages: TranscriptMessage[] = [
    { id: "first", nativeId: "first-native", role: "toolResult", text: "same", tool: { callId: "reused" } },
    { id: "second", nativeId: "second-native", role: "toolResult", text: "same", tool: { callId: "reused" } },
    { id: "pending", role: "toolResult", text: "same", tool: { callId: "reused" } },
  ];
  projectMcpArtifacts(messages, [{ id: "first-native", type: "message", message: { role: "toolResult", toolCallId: "reused",
    details: { serverName: "original", mcpToolName: "make", rawContent: [], mcpToolMeta: { ui: { resourceUri: "ui://original/template" } } } } }]);
  expect(messages[0]!.mcpArtifact?.entryId).toBe("first-native");
  expect(messages[0]!.mcpArtifact?.arguments).toBeUndefined();
  expect(messages[1]!.mcpArtifact).toBeUndefined();
  expect(messages[2]!.mcpArtifact).toBeUndefined();
});

test("invalid saved protocol data reports unavailability without replacing the original visible tool result", () => {
  const messages: TranscriptMessage[] = [{ id: "display", nativeId: "native", role: "toolResult", text: "Actual tool text" }];
  projectMcpArtifacts(messages, [{ id: "native", type: "message", message: { role: "toolResult", details: {
    serverName: "original", mcpToolName: "make", rawContent: [undefined], mcpMeta: { ui: { resourceUri: "ui://original/result" } },
  } } }]);
  expect(messages[0]!.mcpArtifact).toBeUndefined();
  expect(messages[0]!.mcpArtifactError).toContain("not been rerun");
  expect(messages[0]!.text).toBe("Actual tool text");
});


test("native xd execution retains only its original inner MCP result; help envelopes cannot acquire an artifact", () => {
  const inner = { serverName: "server", mcpToolName: "report", rawContent: [], mcpMeta: { ui: { resourceUri: "ui://report" } }, mcpArguments: { original: true } };
  const message = { role: "toolResult", details: { xdev: { tool: "mcp__server_report", mode: "execute", inner } } };
  expect(nativeMcpArtifact("entry", message)).toMatchObject({ entryId: "entry", toolName: "report", arguments: { original: true } });
  message.details.xdev.mode = "help";
  expect(nativeMcpArtifact("entry", message)).toBeUndefined();
});
