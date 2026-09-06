// Controlled provider transport only. Native OMP constructs the ephemeral
// context and owns cancellation; the fixture records bounded, test-only facts.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

function textOf(context: Context): string {
  return context.messages.map(message => {
    if (message.role === "user" || message.role === "assistant") {
      return typeof message.content === "string" ? message.content : message.content
        .flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    }
    return "";
  }).filter(Boolean).join("\n---\n").slice(0, 128 * 1024);
}

export default function (pi: ExtensionAPI) {
  const directory = process.env.BTW_CONTRACT_GATES;
  if (!directory) throw new Error("Controlled btw provider requires isolated file gates");
  mkdirSync(directory, { recursive: true });
  let call = 0;
  pi.registerProvider("btw-contract", {
    baseUrl: "https://controlled.invalid", apiKey: "isolated-btw-contract-inert-key", api: "btw-contract-api" as Api,
    models: [{ id: "controlled", name: "Controlled btw transport", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple: (model, context, options) => {
      const stream = new AssistantMessageEventStream(), current = ++call;
      const sessionId = options?.sessionId ?? "";
      const side = sessionId.includes(":side:");
      writeFileSync(path.join(directory, `${current}.started`), JSON.stringify({
        side, sessionId, promptCacheKey: options?.promptCacheKey ?? null,
        context: textOf(context), tools: context.tools?.map(tool => tool.name) ?? [],
      }));
      const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      void (async () => {
        const delta = side ? `Side delta ${current} ` : `Parent partial context ${current} `;
        message.content = [{ type: "text", text: delta }];
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
        const deadline = Date.now() + 20_000;
        while (!existsSync(path.join(directory, `${current}.release`)) && !options?.signal?.aborted && Date.now() < deadline) await Bun.sleep(5);
        if (options?.signal?.aborted || Date.now() >= deadline) {
          writeFileSync(path.join(directory, `${current}.aborted`), "");
          message.stopReason = "aborted"; message.errorMessage = "Controlled btw transport interrupted";
          stream.push({ type: "error", reason: "aborted", error: message });
        } else {
          const answer = side ? `Side answer ${current}` : `Persistent assistant context ${current}`;
          const completeText = delta + answer;
          message.content = [{ type: "text", text: completeText }];
          stream.push({ type: "text_delta", contentIndex: 0, delta: answer, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: completeText, partial: message });
          stream.push({ type: "done", reason: "stop", message });
        }
      })();
      return stream;
    },
  });
}
