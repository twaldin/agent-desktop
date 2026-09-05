// Controlled provider transport only. Native normalization, agent dispatch,
// message events, blob externalization and session persistence remain real.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

export default function (pi: ExtensionAPI) {
  const directory = process.env.IMAGE_CONTRACT_GATES;
  if (!directory) throw new Error("Image transport fixture requires an isolated gate directory");
  const mode = () => existsSync(path.join(directory, "mode")) ? readFileSync(path.join(directory, "mode"), "utf8") : "";
  pi.registerCommand("image-effect", { description: "Controlled side-effect guard", handler: async () => { writeFileSync(path.join(directory, "slash-executed"), ""); } });
  pi.on("before_agent_start", event => {
    if (mode() === "reorder" && event.images?.length === 2) {
      const first = event.images[0]!, second = event.images[1]!;
      [first.data, second.data] = [second.data, first.data];
      [first.mimeType, second.mimeType] = [second.mimeType, first.mimeType];
    }
  });
  pi.registerProvider("image-contract", {
    baseUrl: "https://controlled.invalid", apiKey: "isolated-image-contract-inert-key", api: "image-contract-api" as Api,
    models: [true, false].map(vision => ({ id: vision ? "vision" : "text", name: `Controlled ${vision ? "vision" : "text"} transport`, reasoning: false,
      input: vision ? ["text", "image"] : ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 })),
    streamSimple: (model, context, options) => {
      const stream = new AssistantMessageEventStream();
      const messages = context.messages.filter(message => message.role === "user").map(message => ({
        role: message.role, content: typeof message.content === "string" ? message.content : message.content.map(block => block.type === "image"
          ? { type: "image", mimeType: block.mimeType, sha256: createHash("sha256").update(Buffer.from(block.data, "base64")).digest("hex") }
          : { type: "text", text: block.text }),
      }));
      writeFileSync(path.join(directory, "provider-input.json"), JSON.stringify(messages));
      const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      void (async () => {
        while (mode() === "hold" && !options?.signal?.aborted) await Bun.sleep(5);
        if (options?.signal?.aborted) {
          message.stopReason = "aborted"; message.errorMessage = "Controlled image transport interrupted";
          stream.push({ type: "error", reason: "aborted", error: message });
        } else {
          message.content = [{ type: "text", text: "Controlled image transport completed; no vision inference performed" }];
          stream.push({ type: "done", reason: "stop", message });
        }
      })();
      return stream;
    },
  });
}
