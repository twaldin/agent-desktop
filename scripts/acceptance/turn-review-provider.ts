import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
/** Only model tool choices are controlled. Production Agent/AgentSession and native tools perform every mutation. */
export default function turnReviewProvider(pi: ExtensionAPI) {
  pi.registerProvider("turn-review-fixture", {
    baseUrl: "https://controlled.invalid", apiKey: "inert-local-fixture", api: "turn-review-fixture-api" as Api,
    models: [{ id: "controlled", name: "Turn review controlled native tools", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 }],
    streamSimple(model, context) {
      const lastInput = context.messages.findLastIndex(message => message.role === "user");
      const prompt = JSON.stringify(context.messages[lastInput]);
      const results = context.messages.slice(lastInput + 1).filter(message => message.role === "toolResult");
      const steps = prompt.includes("turn-first") ? [
        { name: "read", arguments: { path: "tracked.txt" } },
        { name: "edit", arguments: { path: "tracked.txt", old_string: "DIRTY BEFORE", new_string: "EDIT RECORDED" } },
        { name: "write", arguments: { path: "written.txt", content: "WRITE RECORDED\n" } },
        { name: "bash", arguments: { command: "printf 'SHELL RECORDED\\n' > shell.txt", timeout: 10 } },
      ] : prompt.includes("turn-abort") ? [
        { name: "bash", arguments: { command: "printf 'ABORT RECORDED\\n' > aborted.txt; sleep 30", timeout: 60 } },
      ] : prompt.includes("turn-background") ? [
        { name: "bash", arguments: { command: "printf 'BACKGROUND STARTED\\n' > background.txt; sleep 30", async: true, timeout: 60 } },
      ] : prompt.includes("turn-error") ? [
        { name: "bash", arguments: { command: "printf 'ERROR RECORDED\\n' > errored.txt; exit 7", timeout: 10 } },
      ] : prompt.includes("turn-second") ? [
        { name: "write", arguments: { path: "written.txt", content: "SECOND TURN RECORDED\n" } },
      ] : [];
      const step = steps[results.length];
      if (process.env.TURN_REVIEW_PRODUCER_LOG) appendFileSync(process.env.TURN_REVIEW_PRODUCER_LOG, JSON.stringify({ prompt, step: step ?? null, completedTools: results.map(result => ({ toolCallId: result.toolCallId, toolName: result.toolName, isError: result.isError })) }) + "\n");
      const failure = !step && prompt.includes("turn-error");
      const message: AssistantMessage = { role: "assistant", content: step ? [{ type: "toolCall", id: crypto.randomUUID(), ...step }] : [{ type: "text", text: "Controlled native turn finished." }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: step ? "toolUse" : failure ? "error" : "stop", ...(failure ? { errorMessage: "Controlled native terminal error after a real failing shell mutation." } : {}), timestamp: Date.now() };
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        const call = message.content[0];
        if (call?.type === "toolCall") {
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...message, content: [{ ...call, arguments: {} }] } });
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        }
        if (failure) stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", reason: step ? "toolUse" : "stop", message });
      });
      return stream;
    },
  });
}
