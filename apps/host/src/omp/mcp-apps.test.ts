import { expect, test } from "bun:test";
import type { MCPServerConnection } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { NativeMcpApps } from "./mcp-apps";
const resource = { uri: "ui://app", mimeType: "text/html;profile=mcp-app", text: "<h1>App</h1>" };
const selection = { epoch: "epoch", expectedRevision: 1, serverName: "server", toolName: "entry", resourceUri: resource.uri };
const opening = { type: "open" as const, channelId: "channel", selection };
const request = { type: "request" as const, channelId: "channel", requestId: "request", method: "tools/call" as const, params: { name: "entry", arguments: {} } };
function fixture(executeTool: ConstructorParameters<typeof NativeMcpApps>[0]["executeTool"]) {
  const reads: string[] = [];
  const connection: MCPServerConnection = { name: "server", config: { command: "unused-controlled-transport" }, serverInfo: { name: "server", version: "1" }, capabilities: {},
    tools: [{ name: "entry", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: resource.uri }, "openai/ui": { entrypoints: [{ type: "thread" }] } } }],
    transport: { connected: true, async request<T>(method: string) { reads.push(method); return { contents: [resource] } as T; }, async notify() {}, async close() {} },
  };
  let original = connection;
  const apps = new NativeMcpApps({ manager: { getConnection: () => original, getConnectionStatus: () => "connected", addConnectionStatusListener: () => () => {} },
    snapshot: () => ({ epoch: "epoch", revision: 1 }), assertOwner() {}, executeTool });
  return { apps, reads, replace() { original = { ...connection }; } };
}

test("confirmed retirement reports a late malformed result separately and retains it for session drain", async () => {
  const result = Promise.withResolvers<unknown>(), entered = Promise.withResolvers<void>(); let calls = 0;
  const { apps } = fixture(async () => { calls++; entered.resolve(); return result.promise; });
  await apps.request(opening);
  const operation = apps.request(request); void operation.catch(() => {}); await entered.promise;
  let closed = false;
  const closing = apps.request({ type: "close", channelId: "channel" }).then(value => { closed = true; return value; });
  await Promise.resolve(); expect(closed).toBe(false);
  result.resolve({ contents: [undefined] });
  await expect(operation).rejects.toThrow("Invalid MCP app");
  expect(await closing).toEqual({ type: "closed", channelId: "channel", operationErrors: 1 });
  expect(await apps.request({ type: "close", channelId: "channel" })).toEqual({ type: "closed", channelId: "channel", operationErrors: 1 });
  expect(calls).toBe(1);
  expect(await apps.request({ ...opening, channelId: "fresh" })).toMatchObject({ type: "opened", channelId: "fresh" });
  await expect(apps.dispose()).rejects.toThrow("cleanup failed");
});

test("retirement reserves close before synchronous cancellation callbacks and drains the original operation", async () => {
  const result = Promise.withResolvers<unknown>(), entered = Promise.withResolvers<void>(); let reentered = 0, nested: Promise<unknown> | undefined;
  const { apps } = fixture(async (_connection, _tool, _args, signal) => {
    signal.addEventListener("abort", () => { reentered++; nested = apps.request({ type: "close", channelId: "channel" }); });
    entered.resolve(); return result.promise;
  });
  await apps.request(opening); const operation = apps.request(request); void operation.catch(() => {}); await entered.promise;
  const closing = apps.request({ type: "close", channelId: "channel" });
  expect(reentered).toBe(1); result.resolve({ content: [] });
  await expect(operation).rejects.toThrow("original");
  expect(await closing).toEqual({ type: "closed", channelId: "channel" }); expect(await nested).toEqual({ type: "closed", channelId: "channel" });
  await apps.dispose();
});

test("malformed tool arguments cannot become an empty call, and a replaced native connection cannot dispatch", async () => {
  let calls = 0; const { apps, replace, reads } = fixture(async () => { calls++; return { content: [] }; });
  await apps.request(opening);
  await expect(apps.request({ ...request, params: { name: "entry", arguments: "wrong" } })).rejects.toThrow("arguments");
  replace(); await expect(apps.request({ ...request, requestId: "next" })).rejects.toThrow("original");
  expect(calls).toBe(0); expect(reads).toEqual(["resources/read"]);
  await apps.dispose();
});
