// Controlled provider transport for the Goal composer admission contract. It
// records exactly what each provider call received (model, tool roster, LLM
// view of the messages) so tests can prove the native goal context preceded
// the first user turn. Native goal runtime, agent dispatch, normalization and
// session persistence remain real; no inference or outbound transport occurs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { Api, AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

export interface GoalComposerProviderCall {
  call: number;
  model: string;
  tools: string[];
  sessionFile?: string;
  durableGoals: Array<{ id: string; objective: string; tokenBudget?: number }>;
  messages: Array<{ role: string; content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; sha256: string } | { type: "other"; kind: string }> }>;
}

export default function (pi: ExtensionAPI) {
  const gates = process.env.GOAL_COMPOSER_GATES;
  if (!gates) throw new Error("Goal composer transport fixture requires an isolated gate directory");
  let calls = 0;
  let sessionFile: string | undefined;
  pi.on("session_start", (_event, ctx) => { sessionFile = ctx.sessionManager.getSessionFile(); });
  pi.registerProvider("goal-composer-contract", {
    baseUrl: "https://controlled.invalid", apiKey: "isolated-goal-composer-inert-key", api: "goal-composer-contract-api" as Api,
    models: [true, false].map(vision => ({ id: vision ? "vision" : "text", name: `Controlled goal composer ${vision ? "vision" : "text"} transport`, reasoning: false,
      input: vision ? ["text", "image"] : ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 })),
    streamSimple: (model, context, options) => {
      const call = ++calls;
      const durable = sessionFile && existsSync(sessionFile) ? readFileSync(sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
      const record: GoalComposerProviderCall = { call, model: model.id, tools: context.tools?.map(tool => tool.name) ?? [], sessionFile,
        durableGoals: durable.filter(entry => entry.type === "mode_change" && entry.mode === "goal").map(entry => entry.data.goal),
        messages: context.messages.map(message => ({ role: message.role, content: typeof message.content === "string" ? [{ type: "text" as const, text: message.content }]
          : message.content.map(block => block.type === "text" ? { type: "text" as const, text: block.text }
            : block.type === "image" ? { type: "image" as const, mimeType: block.mimeType, sha256: createHash("sha256").update(Buffer.from(block.data, "base64")).digest("hex") }
            : { type: "other" as const, kind: block.type }) })) };
      writeFileSync(path.join(gates, `call-${call}.json`), JSON.stringify(record));
      if (sessionFile) writeFileSync(path.join(gates, `${createHash("sha256").update(sessionFile).digest("hex")}-call-${call}.json`), JSON.stringify(record));
      const stream = new AssistantMessageEventStream();
      const message: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now() };
      stream.push({ type: "start", partial: message });
      void (async () => {
        while (existsSync(path.join(gates, "hold")) && !options?.signal?.aborted) await Bun.sleep(5);
        if (options?.signal?.aborted) {
          message.stopReason = "aborted"; message.errorMessage = "Controlled goal composer transport interrupted";
          stream.push({ type: "error", reason: "aborted", error: message });
        } else {
          message.content = [{ type: "text", text: "Controlled goal composer transport completed; no inference performed." }];
          stream.push({ type: "done", reason: "stop", message });
        }
      })();
      return stream;
    },
  });
}
