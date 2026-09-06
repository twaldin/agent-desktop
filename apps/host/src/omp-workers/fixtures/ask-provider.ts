// Controlled in-process provider that invokes OMP's real blocking ask tool.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("ask-contract", {
    baseUrl: "https://controlled.invalid", apiKey: "isolated-contract-not-a-real-key", api: "ask-contract-api" as Api,
    models: [{ id: "controlled", name: "Controlled ask fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple: (model, context) => {
      const stream = new AssistantMessageEventStream();
      const answered = context.messages.some(message => message.role === "toolResult" && message.toolName === "ask");
      const nullable = JSON.stringify(context.messages).includes("captured nullable ask");
      const message: AssistantMessage = { role: "assistant",
        content: answered ? [{ type: "text", text: "Native ask completed." }] : [{ type: "toolCall", id: "ask-contract-call", name: "ask", arguments: { questions: nullable ? [
          { id: "density", question: "Which density?", options: [{ label: "Comfortable", description: null, preview: null },
            { label: "Compact", description: null, preview: null }], header: null, multi: false, recommended: null },
        ] : [
          { id: "color", question: "Choose a color", options: [{ label: "Blue", description: "Cool tone" }, { label: "Green" }], recommended: 0 },
          { id: "detail", question: "Add a detail", options: [{ label: "No detail" }] },
        ] } }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: answered ? "stop" : "toolUse", timestamp: Date.now() };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      if (!answered) {
        const toolCall = message.content[0]!;
        if (toolCall.type !== "toolCall") throw new Error("Ask fixture lost its native tool call");
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...message, content: [{ ...toolCall, arguments: {} }] } });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
      }
      stream.push({ type: "done", reason: answered ? "stop" : "toolUse", message });
      return stream;
    },
  });
}
