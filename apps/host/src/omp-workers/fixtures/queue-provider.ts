// Isolated queue acceptance provider. It performs no network request and only
// releases after the fixture writes its local gate.
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

export default function queueProvider(pi: ExtensionAPI) {
  const directory = process.env.QUEUE_ACCEPTANCE_GATES;
  if (!directory) throw new Error("Queue acceptance requires isolated gates.");
  mkdirSync(directory, { recursive: true });
  let call = 0;
  pi.registerProvider("queue-acceptance", {
    baseUrl: "https://queue-acceptance.invalid",
    apiKey: "isolated-not-a-real-key",
    api: "queue-acceptance-api" as Api,
    models: [{ id: "controlled", name: "Controlled queue fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple: (model, _context, options) => {
      const current = ++call, stream = new AssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      if (current === 1) {
        pi.sendUserMessage("First native steer", { deliverAs: "steer" });
        pi.sendUserMessage("Second native steer", { deliverAs: "steer" });
        pi.sendUserMessage("Native follow-up from controlled extension", { deliverAs: "followUp" });
      }
      writeFileSync(path.join(directory, `${current}.started`), "");
      void (async () => {
        const release = path.join(directory, `${current}.release`), deadline = Date.now() + 20_000;
        while (!existsSync(release) && !options?.signal?.aborted && Date.now() < deadline) await Bun.sleep(5);
        if (options?.signal?.aborted || Date.now() >= deadline) {
          message.stopReason = "aborted"; message.errorMessage = "Controlled queue transport interrupted";
          stream.push({ type: "error", reason: "aborted", error: message });
        } else {
          message.content = [{ type: "text", text: "Controlled queue response" }];
          stream.push({ type: "done", reason: "stop", message });
        }
      })();
      return stream;
    },
  });
}
