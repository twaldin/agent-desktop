// Controlled transport only: the native OMP agent, queue, events, and JSONL
// persistence remain real. Every response waits for a test-owned file gate.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

export default function (pi: ExtensionAPI) {
  const directory = process.env.STEER_CONTRACT_GATES;
  if (!directory) throw new Error("Controlled steer provider requires isolated file gates");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "extension-loader.pid"), String(process.pid));
  pi.on("message_end", async event => {
    const hold = path.join(directory, "hold-persistence");
    if (!existsSync(hold) || event.message.role !== "user") return;
    const content = typeof event.message.content === "string" ? event.message.content : event.message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    if (content !== readFileSync(hold, "utf8")) return;
    writeFileSync(path.join(directory, "persistence.started"), "");
    const deadline = Date.now() + 10_000;
    while (!existsSync(path.join(directory, "persistence.release")) && Date.now() < deadline) await Bun.sleep(5);
  });
  let call = 0;
  pi.registerProvider("steer-contract", {
    baseUrl: "https://controlled.invalid", apiKey: "isolated-contract-not-a-real-key", api: "steer-contract-api" as Api,
    models: [{ id: "controlled", name: "Controlled transport fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple: (model, context, options) => {
      const stream = new AssistantMessageEventStream(), current = ++call;
      // Discovery also loads this extension. Only a real provider invocation
      // identifies the worker whose held response the test intends to kill.
      writeFileSync(path.join(directory, `${current}.worker.pid`), String(process.pid));
      writeFileSync(path.join(directory, `${current}.started`), JSON.stringify(context.messages));
      const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      void (async () => {
        const deadline = Date.now() + 20_000;
        while (!existsSync(path.join(directory, `${current}.release`)) && !options?.signal?.aborted && Date.now() < deadline) await Bun.sleep(5);
        if (options?.signal?.aborted || Date.now() >= deadline) {
          message.stopReason = "aborted"; message.errorMessage = "Controlled transport interrupted";
          stream.push({ type: "error", reason: "aborted", error: message });
        } else {
          message.content = [{ type: "text", text: `Controlled provider fixture response ${current}` }];
          stream.push({ type: "done", reason: "stop", message });
        }
      })();
      return stream;
    },
  });
}
