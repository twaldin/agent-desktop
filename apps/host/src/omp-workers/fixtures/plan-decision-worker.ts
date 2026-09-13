// Production worker entry with a controlled in-memory provider boundary.
// The fixture permits only the configured fake origin and never reads auth.
import assert from "node:assert/strict";

if (process.env.PLAN_DOCUMENT_REPLY_SCENARIO === "second-malformed") {
  const documentRequests = new Set<string>();
  let documentResponses = 0;
  process.on("message", (message: unknown) => {
    if (message && typeof message === "object" && "type" in message && message.type === "request"
      && "operation" in message && message.operation === "getPlanDocumentSection" && "id" in message
      && typeof message.id === "string") documentRequests.add(message.id);
  });
  const nativeSend = process.send?.bind(process);
  if (!nativeSend) throw new Error("The malformed Plan document fixture requires the actual worker IPC channel.");
  process.send = ((message: unknown, ...args: unknown[]) => {
    let outgoing = message;
    if (message && typeof message === "object" && "type" in message && message.type === "response"
      && "id" in message && typeof message.id === "string" && documentRequests.delete(message.id)
      && "ok" in message && message.ok === true && "value" in message) {
      documentResponses++;
      if (documentResponses === 2 && message.value && typeof message.value === "object") {
        outgoing = { ...message, value: { ...message.value, renderColumns: 121 } };
      }
    }
    return Reflect.apply(nativeSend, process, [outgoing, ...args]);
  }) as typeof process.send;
}

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
  assert.equal(url.origin, "https://plan-runtime.invalid");
  assert.equal(url.pathname, "/v1/chat/completions");
  assert.equal(request.method, "POST");
  const body = await request.json() as WireRequest;
  assert.equal(body.model, "controlled"); assert.equal(body.stream, true);
  const id = `plan_runtime_${++sequence}`, messages = body.messages ?? [], last = messages.at(-1);
  const prompt = content(last);
  const match = last?.role === "user" ? prompt.match(/\[write-plan:([a-z-]+\.md)\]\s*([\s\S]*)/) : null;
  let payload: string;
  if (match) {
    payload = chunk(id, { role: "assistant", tool_calls: [{ index: 0, id: `call_${sequence}`, type: "function",
      function: { name: "write", arguments: JSON.stringify({ path: `local://${match[1]}`, content: `# Native Plan\n${match[2]}\n` }) } }] })
      + chunk(id, {}, "tool_calls");
  } else {
    payload = chunk(id, { role: "assistant", content: "Controlled native Plan completion." }) + chunk(id, {}, "stop");
  }
  return new Response(payload + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}, { preconnect: () => { throw new Error("Preconnect is disabled in the Plan decision fixture"); } }) as typeof fetch;

// The native implementation checks transcript compaction eligibility before
// extension hooks. Inject only the actual AgentSession.compact boundary so this
// worker fixture can exercise the controller/runtime failed-compaction path
// without a provider request or a fabricated decision receipt.
if (process.env.PLAN_FIXTURE_SCENARIO === "compact-failed") {
  const { AgentSession } = await import("@oh-my-pi/pi-coding-agent/session/agent-session");
  AgentSession.prototype.compact = async () => { throw new Error("controlled worker compaction failure before provider transport"); };
}

await import("../entry");
