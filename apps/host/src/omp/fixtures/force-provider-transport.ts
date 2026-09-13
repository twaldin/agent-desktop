import assert from "node:assert/strict";
import type { Api } from "@oh-my-pi/pi-ai";

export interface ForceWireTool {
  type?: string;
  name?: string;
  function?: { name: string };
  toolSpec?: { name: string };
}
export interface ForceWireBody extends Record<string, unknown> {
  tools?: ForceWireTool[];
  toolConfig?: { tools: ForceWireTool[]; toolChoice?: unknown };
}
export interface ForceWireRequest { url: string; headers: Headers; body: ForceWireBody }

function assertObject(value: unknown): asserts value is Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected wire object");
}

/** Validates only the transport fields these assertions consume; retains the exact parsed body. */
function parseWireBody(value: unknown): ForceWireBody {
  assertObject(value);
  const toolLists: unknown[] = [];
  if (value.tools !== undefined) toolLists.push(value.tools);
  if (value.toolConfig !== undefined) {
    assertObject(value.toolConfig);
    toolLists.push(value.toolConfig.tools);
  }
  for (const tools of toolLists) {
    assert.ok(Array.isArray(tools));
    for (const tool of tools) {
      assertObject(tool);
      if (tool.type !== undefined) assert.equal(typeof tool.type, "string");
      if (tool.name !== undefined) assert.equal(typeof tool.name, "string");
      for (const key of ["function", "toolSpec"]) {
        if (tool[key] !== undefined) {
          const nested: unknown = tool[key]; assertObject(nested); assert.equal(typeof nested.name, "string");
        }
      }
    }
  }
  // All typed optional fields were validated above; no provider field is remapped.
  return value as ForceWireBody;
}

// Controlled successful provider responses are transport fixtures, never tool-choice mappers.
function eventFrame(type: string, value: unknown): Buffer {
  const headers = Buffer.concat(Object.entries({ ":message-type": "event", ":event-type": type, ":content-type": "application/json" }).map(([name, value]) => {
    const n = Buffer.from(name), v = Buffer.from(value), prefix = Buffer.alloc(1 + n.length + 3);
    prefix[0] = n.length; n.copy(prefix, 1); prefix[1 + n.length] = 7; prefix.writeUInt16BE(v.length, 2 + n.length);
    return Buffer.concat([prefix, v]);
  }));
  const payload = Buffer.from(JSON.stringify(value)), frame = Buffer.alloc(16 + headers.length + payload.length);
  frame.writeUInt32BE(frame.length, 0); frame.writeUInt32BE(headers.length, 4);
  frame.writeUInt32BE(Bun.hash.crc32(frame.subarray(0, 8)) >>> 0, 8);
  headers.copy(frame, 12); payload.copy(frame, 12 + headers.length);
  frame.writeUInt32BE(Bun.hash.crc32(frame.subarray(0, -4)) >>> 0, frame.length - 4);
  return frame;
}

export function forceProviderTransport() {
  const requests: ForceWireRequest[] = [];
  let api: Api | undefined, origin: string | undefined;
  let failure: "error" | "abort" | undefined;
  let reachedAbortBoundary: (() => void) | undefined;
  const fetchBoundary = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    assert.equal(request.method, "POST", "Only explicitly selected inference requests are permitted.");
    assert.equal(url.origin, origin, "No discovery/auth/other-provider request may escape the owned boundary.");
    const wireBytes = new Uint8Array(await request.arrayBuffer());
    const jsonBytes = request.headers.get("content-encoding") === "zstd" ? await Bun.zstdDecompress(wireBytes) : wireBytes;
    const body: unknown = JSON.parse(new TextDecoder().decode(jsonBytes));
    requests.push({ url: request.url, headers: request.headers, body: parseWireBody(body) });
    if (failure === "error") return Response.json({ error: { message: "Owned deliberate HTTP failure", type: "invalid_request_error" } }, { status: 400 });
    if (failure === "abort") {
      reachedAbortBoundary?.(); reachedAbortBoundary = undefined;
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Owned caller abort", "AbortError"));
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      });
    }
    const id = `force_owned_${requests.length}`;
    const sse = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    if (api === "anthropic-messages") return new Response(
      sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: requests.at(-1)!.body.model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }) +
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Owned force response." } }) +
      sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
      sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) +
      sse("message_stop", { type: "message_stop" }), { headers: { "content-type": "text/event-stream" } });
    if (api === "bedrock-converse-stream") return new Response(Buffer.concat([
      eventFrame("messageStart", { role: "assistant" }),
      eventFrame("contentBlockStart", { contentBlockIndex: 0, start: {} }),
      eventFrame("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Owned force response." } }),
      eventFrame("contentBlockStop", { contentBlockIndex: 0 }), eventFrame("messageStop", { stopReason: "end_turn" }),
      eventFrame("metadata", { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 } }),
    ]), { headers: { "content-type": "application/vnd.amazon.eventstream" } });
    if (api === "ollama-chat") return new Response(`${JSON.stringify({ model: "fixture", message: { role: "assistant", content: "Owned force response." }, done: false })}\n${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 })}\n`, { headers: { "content-type": "application/x-ndjson" } });
    if (api === "openai-completions") return new Response(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Owned force response." }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    const item = { id: `${id}_message`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Owned force response.", annotations: [] }] };
    return new Response(
      sse("response.created", { type: "response.created", response: { id, status: "in_progress", output: [] } }) +
      sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }) +
      sse("response.content_part.added", { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }) +
      sse("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "Owned force response." }) +
      sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }) +
      sse("response.completed", { type: "response.completed", response: { id, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
      { headers: { "content-type": "text/event-stream" } });
  }, { preconnect: () => {} }) as typeof fetch;
  return { requests, fetchBoundary,
    select(selectedApi: Api, selectedOrigin: string) { api = selectedApi; origin = selectedOrigin; },
    failRequests() { failure = "error"; },
    blockUntilAbort() {
      failure = "abort";
      const reached = Promise.withResolvers<void>();
      reachedAbortBoundary = reached.resolve;
      return reached.promise;
    },
    clearFailure() { failure = undefined; reachedAbortBoundary = undefined; },
  };
}
