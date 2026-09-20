import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { CommandEnvelope, CommandResult, Project, SessionSummary } from "../../../packages/shared/src/protocol";
const fixture = resolve(process.argv[2]!), agentDir = join(fixture, "agent"), projectPath = join(fixture, "project"), bin = join(fixture, "bin");
if (process.env.HOME !== fixture || process.env.PI_CODING_AGENT_DIR !== agentDir || process.env.CONTEXT_MAINTENANCE_FIXTURE_DIRECTORY !== fixture || process.env.PATH?.split(delimiter)[0] !== bin)
  throw new Error("An isolated context-maintenance App environment is required.");
for (const name of ["data", "agent", "project", "bin"]) await mkdir(join(fixture, name), { recursive: true });
await writeFile(join(projectPath, "README.md"), "# Context maintenance App fixture\n");
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url); if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
  const body = await request.json() as { stream?: boolean; model?: unknown; messages?: Array<{ role?: unknown }> }, mode = (await readFile(join(fixture, "provider-mode"), "utf8").catch(() => "normal")).trim();
  await appendFile(join(fixture, "provider-requests.jsonl"), JSON.stringify({ requestId: crypto.randomUUID(), at: Date.now(), stream: body.stream === true, mode, model: body.model, messageCount: Array.isArray(body.messages) ? body.messages.length : null, lastRole: Array.isArray(body.messages) ? (body.messages.at(-1) as any)?.role : null }) + "\n");
  if (mode === "failure") return Response.json({ error: { message: "controlled compact provider failure" } }, { status: 400 });
  if (mode === "hold" && body.stream) {
    await appendFile(join(fixture, "held-provider.jsonl"), JSON.stringify({ at: Date.now() }) + "\n");
    const id = crypto.randomUUID(), encoder = new TextEncoder(); let timer: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`));
        timer = setInterval(() => void (async () => {
          const current = (await readFile(join(fixture, "provider-mode"), "utf8").catch(() => "hold")).trim();
          if (current === "hold") return;
          clearInterval(timer); timer = undefined;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "Controlled released compact summary." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`)); controller.close();
        })(), 10);
      },
      async cancel() { if (timer) clearInterval(timer); await appendFile(join(fixture, "provider-aborts.jsonl"), JSON.stringify({ at: Date.now() }) + "\n"); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }
  if (!body.stream) return Response.json({ choices: [{ message: { content: "Controlled remote compact summary." } }] });
  const id = crypto.randomUUID(), chunk = (delta: Record<string, unknown>, finish: string | null, usage?: object) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
  return new Response(chunk({ role: "assistant", content: "Controlled soft compact summary." }, null) + chunk({}, "stop", { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 }) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
} });
const origin = `http://127.0.0.1:${provider.port}`;
await writeFile(join(fixture, "provider-origin"), origin); await writeFile(join(fixture, "provider-mode"), "normal");
await writeFile(join(agentDir, "config.yml"), ["extensions: []", "defaultThinkingLevel: off", "compaction:", "  enabled: true", "  methodOrder: [soft]", "  keepRecentTokens: 1000", "  reserveTokens: 2048", `  remoteEndpoint: ${origin}/v1/chat/completions`, "  remoteStreamingV2Enabled: false", "retry:", "  enabled: false", ""].join("\n"));
await writeFile(join(agentDir, "models.yml"), JSON.stringify({ providers: { "context-maintenance": { api: "openai-completions", baseUrl: `${origin}/v1`, auth: "none", models: [{ id: "fixture", name: "Controlled context maintenance", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
const originalFetch = globalThis.fetch; globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => { const url = new URL(input instanceof Request ? input.url : String(input)); if (url.origin !== origin && url.hostname !== "127.0.0.1") throw new Error("Nonlocal network forbidden"); return originalFetch(input, init); }, { preconnect: () => {} }) as typeof fetch;
const { startHost } = await import("../../../apps/host/src/server");
const options = { dataDirectory: join(fixture, "data"), agentDirectory: agentDir, discoveryDirectory: projectPath, workerPath: resolve(import.meta.dir, "worker.ts"), tailscale: false, port: 0 };
let host = await startHost(options);
async function command(command: CommandEnvelope["command"]) { const response = await fetch(`${host.connection.origin}/v1/commands`, { method: "POST", headers: { Authorization: `Bearer ${host.connection.token}`, "content-type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), command }) }); const result = await response.json() as CommandResult; if (!response.ok || !result.ok) throw new Error(JSON.stringify(result)); return result.value; }
const project = await command({ type: "project.add", path: projectPath, name: "Context maintenance workspace" }) as Project;
const session = await command({ type: "session.create", projectId: project.id, model: { provider: "context-maintenance", id: "fixture" } }) as SessionSummary;
await host.stop();
const { SessionManager } = await import("@oh-my-pi/pi-coding-agent"), manager = await SessionManager.open(session.sessionFile);
const usage = { input: 3000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
manager.appendMessage({ role: "user", content: [{ type: "text", text: "Owned image context" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], timestamp: 1 });
manager.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "Owned private reasoning" }, { type: "text", text: "```text\n" + "heavy block ".repeat(900) + "\n```" }], api: "openai-completions", provider: "context-maintenance", model: "fixture", usage, stopReason: "stop", timestamp: 2 } as AssistantMessage);
manager.appendMessage({ role: "toolResult", toolCallId: "owned-call", toolName: "read", content: [{ type: "text", text: "Owned tool result ".repeat(1800) }], isError: false, timestamp: 3 } as ToolResultMessage);
for (let i=0;i<12;i++) { manager.appendMessage({ role:"user", content:`Owned compact user ${i} `+"detail ".repeat(1200), timestamp:10+i*2 }); manager.appendMessage({ role:"assistant", content:[{type:"text",text:`Owned compact assistant ${i} `+"detail ".repeat(1200)}], api:"openai-completions", provider:"context-maintenance", model:"fixture", usage, stopReason:"stop", timestamp:11+i*2 } as AssistantMessage); }
await manager.flush(); await manager.close();
host = await startHost(options); const fixedPort=Number(new URL(host.connection.origin).port); await writeFile(join(fixture,"connection.json"),JSON.stringify(host.connection),{mode:0o600}); await writeFile(join(fixture,"context.json"),JSON.stringify({projectId:project.id,sessionId:session.id,sessionFile:session.sessionFile}));
let restarting=false, handledRestart=""; const restartTimer=setInterval(()=>void(async()=>{if(stopping||restarting)return;const request=await readFile(join(fixture,"restart-host"),"utf8").catch(()=>"");if(!request||request===handledRestart)return;restarting=true;try{await host.stop();host=await startHost({...options,port:fixedPort});await writeFile(join(fixture,"connection.json"),JSON.stringify(host.connection),{mode:0o600});handledRestart=request;await writeFile(join(fixture,"restart-complete"),request)}finally{restarting=false}})(),20);
let stopping=false; async function stop(){if(stopping)return;stopping=true;clearInterval(restartTimer);try{await host.stop();provider.stop(true);process.exit(0)}catch(e){console.error(e);process.exit(1)}} process.on("SIGTERM",()=>void stop()); for await(const chunk of process.stdin) if(String(chunk).trim()==="stop") await stop();
