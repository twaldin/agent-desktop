import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { appendFileSync, existsSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  const trace = process.env.SESSION_RECOVERY_TRACE;
  if (!trace) throw new Error("SESSION_RECOVERY_TRACE required");
  let calls = 0;
  pi.registerProvider("session-recovery-contract", {
    baseUrl: "https://controlled.invalid", apiKey: "inert-local-fixture-key", api: "session-recovery-contract-api" as Api,
    models: [{ id: "controlled", name: "Controlled recovery fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      const stream = new AssistantMessageEventStream();
      const call = ++calls;
      appendFileSync(trace, `${JSON.stringify({ call, sessionId: options?.sessionId, messages: context.messages.length })}\n`);
      void (async () => {
        const hold = process.env.SESSION_RECOVERY_HOLD;
        while (call === 2 && hold && existsSync(hold) && !options?.signal?.aborted) await Bun.sleep(5);
        const toolResult = context.messages.some(message => message.role === "toolResult");
        const freshProbe = context.messages.some(message => message.role === "user" && JSON.stringify(message).includes("fresh identity probe"));
        const aborted = options?.signal?.aborted;
        const content = call === 1 || aborted ? [] : !toolResult && !freshProbe
          ? [{ type: "toolCall" as const, id: "recovery-write", name: "write", arguments: { path: "recovered.txt", content: "recovered by original native session\n" } }]
          : [{ type: "text" as const, text: freshProbe ? "Fresh provider identity observed." : "Recovered turn completed." }];
        const reason = aborted ? "aborted" : call === 1 ? "error" : content[0]?.type === "toolCall" ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: reason, errorMessage: call === 1 ? "Controlled original failure" : undefined, timestamp: Date.now() };
        stream.push({ type: "start", partial: { ...message, content: [] } });
        const block = content[0];
        if (block?.type === "toolCall") {
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...message, content: [{ ...block, arguments: {} }] } });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: message });
        }
        if (call === 1 || aborted) stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
        else stream.push({ type: "done", reason: reason as "stop" | "toolUse", message });
      })().catch(error => stream.end());
      return stream;
    },
  });
}
