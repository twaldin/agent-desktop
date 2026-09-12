/** Actual disposable stdio MCP provider; no network, OAuth, or personal state. */
import { appendFileSync, readFileSync } from "node:fs";
let calls = 0;
const send = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const fail = (id: unknown, message: string) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");
async function handle(value: { id?: number | string; method: string; params?: any }) {
  if (value.id === undefined) return;
  const { id, method, params } = value;
  if (process.env.ARTIFACT_TEST_LOG) appendFileSync(process.env.ARTIFACT_TEST_LOG, JSON.stringify({ method, params }) + "\n");
  if (method === "initialize") { send(id, { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "artifact-fixture", version: "1" } }); return; }
  if (method === "tools/list") { send(id, { tools: [
    { name: "report", title: "Report", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] }, _meta: { ui: { resourceUri: "ui://artifact-declaration" } } },
    { name: "viewer", title: "Note viewer", inputSchema: { type: "object", properties: { file: { type: "object" } } }, _meta: { ui: { resourceUri: "ui://file-viewer", visibility: ["app"] }, "openai/ui": { entrypoints: [{ type: "file", extensions: [".note", "report.note"] }] } } },
  ] }); return; }
  if (method === "resources/list" || method === "resources/templates/list") { send(id, method === "resources/list" ? { resources: [] } : { resourceTemplates: [] }); return; }
  if (method === "resources/read") {
    if (!["ui://artifact-result", "ui://artifact-declaration", "ui://file-viewer"].includes(params?.uri)) { fail(id, "Unknown resource"); return; }
    const html = process.env.ARTIFACT_TEST_HTML ? readFileSync(process.env.ARTIFACT_TEST_HTML, "utf8") : "<h1>Original artifact</h1>";
    send(id, { contents: [{ uri: params.uri, mimeType: "text/html;profile=mcp-app", text: html }] }); return;
  }
  if (method === "tools/call") {
    if (params?.name === "report") { calls++; send(id, { content: [{ type: "text", text: "Original report result" }], structuredContent: { title: params.arguments.title, calls, retained: [3, 5, 8] }, _meta: { ui: { resourceUri: "ui://artifact-result" }, privateResult: "retained-native" } }); return; }
    if (params?.name === "viewer") { send(id, { content: [{ type: "text", text: "Original file viewer" }], structuredContent: { file: params.arguments.file, metadata: params._meta } }); return; }
    fail(id, "Unknown tool"); return;
  }
  fail(id, "Unknown method");
}
let buffer = ""; const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  for (;;) { const newline = buffer.indexOf("\n"); if (newline < 0) break; const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (line) void handle(JSON.parse(line)).catch(error => process.stderr.write(String(error) + "\n")); }
}
