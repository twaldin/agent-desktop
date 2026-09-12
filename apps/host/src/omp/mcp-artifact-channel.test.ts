import { expect, test } from "bun:test";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { NativeMcpApps, mcpFileViewers } from "./mcp-apps";
import { mcpViewerExtension, type NativeMcpAppRequest } from "../../../../packages/shared/src/session-mcp-app";
import type { McpArtifact } from "../../../../packages/shared/src/mcp-artifact";
const selection = { epoch: "epoch", expectedRevision: 1, serverName: "server", toolName: "report", resourceUri: "ui://report" };
const artifact: McpArtifact = { entryId: "entry", serverName: "server", toolName: "report", resourceUri: "ui://report", arguments: { original: 1 }, result: { content: [], structuredContent: { retained: 7 }, _meta: { private: "saved" } } };
function setup() {
  const methods: string[] = [], files: unknown[] = []; let calls = 0, saved: McpArtifact | undefined = structuredClone(artifact);
  const connection: MCPServerConnection = { name: "server", config: { command: "unused" }, capabilities: {}, serverInfo: { name: "server", version: "1" },
    tools: [{ name: "report", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: "ui://report" }, "openai/ui": { entrypoints: [{ type: "file", extensions: [".txt", "report.txt"] }] } } }],
    transport: { connected: true, async request<T>(method: string) { methods.push(method); return { contents: [{ uri: "ui://report", mimeType: "text/html;profile=mcp-app", text: "<h1>Report</h1>" }] } as T; }, async notify() {}, async close() {} } };
  let current = connection;
  const apps = new NativeMcpApps({ manager: { getConnection: () => current, getConnectionStatus: () => "connected", addConnectionStatusListener: () => () => {} },
    snapshot: () => ({ epoch: "epoch", revision: 1 }), assertOwner() {}, artifact: () => saved,
    executeTool: async () => { calls++; return { content: [] }; }, filePath: source => `/workspace/${source.path}`, fileResource: async (...args) => { files.push(args.slice(0, 3)); return { contents: [] }; } });
  return { apps, methods, files, connection, calls: () => calls, remove() { saved = undefined; }, replace() { current = { ...connection }; } };
}
const open = { type: "open" as const, channelId: "channel", selection, source: { type: "artifact" as const, entryId: "entry" } };
test("saved artifact opens without a current thread declaration or historical tool replay, then original entry loss retires admission", async () => {
  const f = setup();
  expect(await f.apps.request(open)).toMatchObject({ type: "opened", initialArguments: artifact.arguments, initialResult: artifact.result });
  expect(f.methods).toEqual(["resources/read"]); expect(f.calls()).toBe(0);
  f.remove(); await expect(f.apps.request({ type: "request", channelId: "channel", requestId: "next", method: "resources/read", params: { uri: "result://saved" } })).rejects.toThrow("original");
  expect(f.methods).toEqual(["resources/read"]); await f.apps.dispose();
});
test("missing or mismatched saved source cannot fall back to a fresh tool call", async () => {
  const f = setup();
  await expect(f.apps.request({ ...open, selection: { ...selection, resourceUri: "ui://replacement" } })).rejects.toThrow("saved MCP result");
  f.remove(); await expect(f.apps.request(open)).rejects.toThrow("saved MCP result");
  expect(f.calls()).toBe(0); expect(f.methods).toEqual([]); await f.apps.dispose();
});
test("file viewer exposes only declared longest suffix and routes resource descendants to the original file", async () => {
  const f = setup(), source = { type: "file" as const, path: "nested/Report.TXT", resourceUri: "codex-resource://owned" };
  expect(mcpFileViewers(f.connection)[0]?.extensions).toEqual([".txt", "report.txt"]);
  expect(mcpViewerExtension("nested/a.Report.TXT", [".txt", "report.txt"])).toBe("report.txt");
  expect(await f.apps.request({ ...open, source })).toMatchObject({ type: "opened", initialArguments: { file: { name: "Report.TXT", resourceUri: source.resourceUri } } });
  const read: NativeMcpAppRequest = { type: "request", channelId: "channel", requestId: "read", method: "resources/read", params: { uri: `${source.resourceUri}/preview` } };
  await f.apps.request(read); expect(f.files).toEqual([[source, "resources/read", read.params]]);
  await expect(f.apps.request({ ...read, requestId: "foreign", params: { uri: "codex-resource://different" } })).rejects.toThrow("original file viewer");
  f.replace(); await expect(f.apps.request({ ...read, requestId: "replacement" })).rejects.toThrow("original");
  expect(f.files).toHaveLength(1); expect(f.methods).toEqual(["resources/read"]); await f.apps.dispose();
});
