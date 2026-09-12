/** Disposable, real stdio MCP provider used by worker and rendered acceptance. */
import { appendFileSync, readFileSync } from "node:fs";
let enabled = false, count = 0;
const uri = "ui://fixture/counter";
const send = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const fail = (id: unknown, message: string) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");
async function handle(value: { id?: number | string; method: string; params?: any }) {
  if (value.id === undefined) return;
  const { id, method, params } = value;
  if (process.env.MCP_APP_TEST_LOG) appendFileSync(process.env.MCP_APP_TEST_LOG, JSON.stringify({ method, params }) + "\n");
  if (method === "initialize") {
    enabled = params?.capabilities?.extensions?.["io.modelcontextprotocol/ui"]?.mimeTypes?.includes("text/html;profile=mcp-app") === true;
    send(id, { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
      serverInfo: { name: "fixture-apps", title: "Fixture Apps", version: "1.0.0", icons: [{ src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%235a8dee'/%3E%3C/svg%3E", sizes: ["any"] }] } }); return;
  }
  if (method === "tools/list") {
    send(id, { tools: [{ name: "ordinary", description: "A normal model tool", inputSchema: { type: "object" } }, ...(enabled ? [
      { name: "counter", title: "Counter app", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: uri }, "openai/ui": { entrypoints: [{ type: "thread" }] } } },
      { name: "increment", title: "Increment counter", inputSchema: { type: "object", properties: { by: { type: "number" } } }, _meta: { ui: { visibility: ["app"] } } },
      { name: "model_only", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["model"] } } },
    ] : [])] }); return;
  }
  if (method === "resources/list") { send(id, { resources: enabled ? [{ uri, name: "Counter interface", mimeType: "text/html;profile=mcp-app" }, { uri: "fixture://notes", name: "Provider notes", mimeType: "text/plain" }] : [] }); return; }
  if (method === "resources/templates/list") { send(id, { resourceTemplates: [] }); return; }
  if (method === "resources/read") {
    if (params?.uri === uri && enabled) send(id, { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: process.env.MCP_APP_TEST_HTML ? readFileSync(process.env.MCP_APP_TEST_HTML, "utf8") : "<h1>Counter app</h1>" }] });
    else if (params?.uri === "fixture://notes") send(id, { contents: [{ uri: params.uri, mimeType: "text/plain", text: "Notes from the original MCP provider" }] });
    else fail(id, "Resource not found");
    return;
  }
  if (method === "tools/call") {
    if (params?.name === "increment") count += typeof params.arguments?.by === "number" ? params.arguments.by : 1;
    else if (params?.name !== "counter" && params?.name !== "ordinary" && params?.name !== "model_only") { fail(id, "Unknown tool"); return; }
    send(id, { content: [{ type: "text", text: `Count ${count}` }], structuredContent: { count } }); return;
  }
  fail(id, "Method not found");
}
let buffer = ""; const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  for (;;) {
    const newline = buffer.indexOf("\n"); if (newline < 0) break;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (line) void handle(JSON.parse(line)).catch(error => process.stderr.write(String(error) + "\n"));
  }
}
