import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Deterministic in-process acceptance provider. */
export default function provider(pi: ExtensionAPI) {
  pi.registerProvider("environment-ui", {
    baseUrl: "https://controlled.invalid", apiKey: "fixture-value", api: "environment-ui-api" as Api,
    models: [{ id: "controlled", name: "Controlled environment fixture", reasoning: false, input: ["text"],
      cost: usage.cost, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple: model => {
      const stream = new AssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "Environment UI prompt completed." }],
        api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [] } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "Environment UI prompt completed.", partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: "Environment UI prompt completed.", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
  });
}
