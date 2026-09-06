// Controlled local provider for the native detached-question contract.
import type { ExtensionAPI, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import path from "node:path";
import { writeFileSync } from "node:fs";

async function waitForRelease(file: string, signal?: AbortSignal): Promise<void> {
  while (!await Bun.file(file).exists()) { signal?.throwIfAborted(); await Bun.sleep(5); }
}

export default function (pi: ExtensionAPI) {
  const gates = process.env.DETACHED_QUESTION_GATES;
  if (!gates) throw new Error("Detached question fixture requires its isolated gate directory");
  const holdTool = { name: "detached_hold", label: "Detached hold", description: "Controlled shared tool used only by the detached-question native contract.",
    parameters: z.object({}), approval: "read", strict: true,
    concurrency: "shared" as const,
    async execute(_id, _params, signal) {
      writeFileSync(path.join(gates, "hold.started"), "started");
      try { await waitForRelease(path.join(gates, "hold.release"), signal); }
      catch (error) {
        if (signal?.aborted && await Bun.file(path.join(gates, "hold.delay-abort")).exists()) {
          writeFileSync(path.join(gates, "abort.started"), "started");
          await waitForRelease(path.join(gates, "abort.release"));
        }
        throw error;
      }
      return { content: [{ type: "text", text: "Independent shared tool completed." }] };
    } } satisfies ToolDefinition & { concurrency: "shared" };
  pi.registerTool(holdTool);
  pi.registerProvider("detached-contract", {
    baseUrl: "https://controlled.invalid", apiKey: "isolated-contract-not-a-real-key", api: "detached-contract-api" as Api,
    models: [{ id: "controlled", name: "Controlled detached question fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple: (model, context) => {
      const stream = new AssistantMessageEventStream();
      const invoked = context.messages.some(message => message.role === "toolResult" && message.toolName === "ask_async");
      const delivered = context.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("Answers to detached question"));
      const calls = [
        { type: "toolCall" as const, id: "detached-ask-call", name: "ask_async", arguments: { questions: [
          { id: "density", question: "Which density?", header: null, multi: false, recommended: 1,
            options: [{ label: "Comfortable", description: null, preview: null }, { label: "Compact", description: "Tighter layout", preview: null }] },
          { id: "note", question: "Any detail?", options: [], multi: true },
        ] } },
        { type: "toolCall" as const, id: "detached-hold-call", name: "detached_hold", arguments: {} },
      ];
      const message: AssistantMessage = { role: "assistant", content: invoked
        ? [{ type: "text", text: delivered ? "Detached answer received." : "Independent work completed." }] : calls,
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: invoked ? "stop" : "toolUse", timestamp: Date.now() };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      if (!invoked) calls.forEach((toolCall, contentIndex) => {
        stream.push({ type: "toolcall_start", contentIndex, partial: { ...message, content: calls.slice(0, contentIndex).concat({ ...toolCall, arguments: {} }) } });
        stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
      });
      stream.push({ type: "done", reason: invoked ? "stop" : "toolUse", message });
      return stream;
    },
  });
}
