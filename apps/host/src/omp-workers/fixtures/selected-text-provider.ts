// Test-only local model transport. It captures the native context supplied to
// the provider and never opens a network connection.
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

export default function (pi: ExtensionAPI) {
  const gates = process.env.SELECTED_TEXT_CONTRACT_GATES;
  if (!gates) throw new Error("Selected-text fixture requires isolated gates");
  pi.registerProvider("selected-text-contract", {
    baseUrl: "https://controlled.invalid", apiKey: "isolated-contract-not-a-real-key", api: "selected-text-contract-api" as Api,
    models: [{ id: "controlled", name: "Selected text contract fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple: (model, context) => {
      const stream = new AssistantMessageEventStream();
      // Return the exact native model context through the real assistant
      // stream. The parent test observes normal session persistence, without
      // a provider-side filesystem channel.
      const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: JSON.stringify(context.messages) }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
  });
}
