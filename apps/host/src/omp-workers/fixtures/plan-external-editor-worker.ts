// Production worker entry behind a controlled provider and disposable environment.
// Response corruption scenarios exercise the real parent parsers and owner fences.
import assert from "node:assert/strict";
import path from "node:path";

type RequestMessage = { type?: string; id?: string; operation?: string };
const requests = new Map<string, string>();
process.on("message", (message: unknown) => {
  const value = message as RequestMessage;
  if (value?.type === "request" && typeof value.id === "string" && typeof value.operation === "string")
    requests.set(value.id, value.operation);
});
const nativeSend = process.send?.bind(process);
if (!nativeSend) throw new Error("The Plan external-editor fixture requires the actual worker IPC channel.");
process.send = ((message: unknown, ...args: unknown[]) => {
  let outgoing = message;
  if (message && typeof message === "object" && "type" in message && message.type === "response"
    && "id" in message && typeof message.id === "string" && "ok" in message && message.ok === true) {
    const operation = requests.get(message.id); requests.delete(message.id);
    if (operation === "getPlanExternalEditorAvailable" && process.env.PLAN_EDITOR_REPLY_SCENARIO === "invalid-availability")
      outgoing = { ...message, value: "yes" };
    if (operation === "preparePlanExternalEditor" && "value" in message && message.value && typeof message.value === "object") {
      if (process.env.PLAN_EDITOR_REPLY_SCENARIO === "wrong-cwd")
        outgoing = { ...message, value: { ...message.value, cwd: path.join(process.env.HOME!, "replacement-project") } };
      if (process.env.PLAN_EDITOR_REPLY_SCENARIO === "oversized-environment")
        outgoing = { ...message, value: { ...message.value,
          environment: Object.fromEntries(Array.from({ length: 4097 }, (_, index) => [`SAFE_${index}`, "value"])) } };
    }
  }
  return Reflect.apply(nativeSend, process, [outgoing, ...args]);
}) as typeof process.send;

type WireMessage = { role?: string; content?: unknown };
type WireRequest = { model?: string; stream?: boolean; messages?: WireMessage[] };
let sequence = 0;
const content = (message: WireMessage | undefined) => typeof message?.content === "string" ? message.content
  : Array.isArray(message?.content) ? message.content.flatMap(part => part && typeof part === "object" && "text" in part
    && typeof part.text === "string" ? [part.text] : []).join("") : "";
const chunk = (id: string, delta: unknown, finishReason: string | null = null) =>
  `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;

globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init), url = new URL(request.url);
  assert.equal(url.origin, "https://plan-editor-runtime.invalid");
  assert.equal(url.pathname, "/v1/chat/completions");
  assert.equal(request.method, "POST");
  const body = await request.json() as WireRequest;
  assert.equal(body.model, "controlled"); assert.equal(body.stream, true);
  const id = `plan_editor_runtime_${++sequence}`, last = body.messages?.at(-1), prompt = content(last);
  const match = last?.role === "user" ? prompt.match(/\[write-plan:([a-z-]+\.md)\]\s*([\s\S]*)/) : null;
  const payload = match
    ? chunk(id, { role: "assistant", tool_calls: [{ index: 0, id: `call_${sequence}`, type: "function",
      function: { name: "write", arguments: JSON.stringify({ path: `local://${match[1]}`, content: `# External editor worker Plan\n${match[2]}\n` }) } }] })
      + chunk(id, {}, "tool_calls")
    : chunk(id, { role: "assistant", content: "Controlled Plan editor completion." }) + chunk(id, {}, "stop");
  return new Response(payload + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}, { preconnect: () => { throw new Error("Preconnect is disabled in the Plan editor worker fixture"); } }) as typeof fetch;

await import("../entry");
