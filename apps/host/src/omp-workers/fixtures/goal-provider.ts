// Controlled in-process provider for the native goal lifecycle contract.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("goal-contract", {
    baseUrl: "https://controlled.invalid", apiKey: "isolated-contract-not-a-real-key", api: "goal-contract-api" as Api,
    models: [{ id: "controlled", name: "Controlled goal fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple: (model, context) => {
      const stream = new AssistantMessageEventStream();
      const serialized = JSON.stringify(context.messages);
      const mainTurn = context.tools?.some(tool => tool.name === "goal") === true;
      const completed = context.messages.some(message => message.role === "toolResult" && message.toolName === "goal");
      const complete = mainTurn && !completed;
      const message: AssistantMessage = { role: "assistant",
        content: complete ? [{ type: "toolCall", id: "goal-complete-contract", name: "goal", arguments: { op: "complete" } }]
          : [{ type: "text", text: mainTurn ? "Native goal completion reported." : "Goal contract title." }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: complete ? "toolUse" : "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      if (complete) {
        const toolCall = message.content[0]!;
        if (toolCall.type !== "toolCall") throw new Error("Goal fixture lost its native tool call");
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...message, content: [{ ...toolCall, arguments: {} }] } });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
      }
      stream.push({ type: "done", reason: complete ? "toolUse" : "stop", message });
      return stream;
    },
  });
}
