// Actual production entry and SDK. Provider transport is controlled, and a
// transparent public registry-registration tap captures the actual root session.
// No native owner, callback, Settings instance, permit or reply is replaced.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import path from "node:path";

const root = process.env.RESET_RECONNECT_FIXTURE_ROOT!;
assert.ok(root && process.env.HOME === root && process.env.PI_CODING_AGENT_DIR === path.join(root, "agent"));
const base = Math.floor(Date.now() / 1000) * 1000;
const counts = { usage: 0, credits: 0, consume: 0, blockedPreconnect: 0, escaped: 0 };
const blocked: string[] = [];
type Route = "usage" | "credits" | "consume";
const gates = new Map<Route, ReturnType<typeof Promise.withResolvers<void>>>();
const waits: Array<{ route: Route; count: number; resolve(): void }> = [];
const consumes: unknown[] = [];
let blockedTurn = false;
let redeemed = false;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init), url = new URL(request.url);
  const route: Route | undefined = url.pathname.endsWith("/wham/usage") ? "usage"
    : url.pathname.endsWith("/wham/rate-limit-reset-credits") ? "credits"
    : url.pathname.endsWith("/wham/rate-limit-reset-credits/consume") ? "consume" : undefined;
  if (!route || url.origin !== "https://chatgpt.com" || request.headers.get("ChatGPT-Account-Id") !== "fixture-reconnect-account"
    || request.headers.get("Authorization") !== "Bearer fixture-reconnect-access") {
    counts.escaped++;
    blocked.push(`${request.method} ${url.origin}${url.pathname}`);
    throw new Error("Outbound network is disabled; request is outside the controlled reset fixture.");
  }
  counts[route]++;
  if (route === "consume") consumes.push(await request.json());
  for (const waiter of [...waits]) if (counts[waiter.route] >= waiter.count) { waits.splice(waits.indexOf(waiter), 1); waiter.resolve(); }
  const gate = gates.get(route);
  if (gate) await gate.promise;
  if (route === "usage") return Response.json({ plan_type: "plus", rate_limit: { allowed: !blockedTurn, limit_reached: blockedTurn,
    primary_window: { used_percent: redeemed ? 0 : blockedTurn ? 100 : 60, limit_window_seconds: 18000, reset_at: base / 1000 + 10800 },
    secondary_window: { used_percent: redeemed ? 0 : 50, limit_window_seconds: 604800, reset_at: base / 1000 + 172800 } },
    rate_limit_reset_credits: { available_count: redeemed ? 0 : 1 } });
  if (route === "credits") return Response.json({ available_count: redeemed ? 0 : 1, credits: [{ id: "fixture-reconnect-credit",
    status: redeemed ? "redeemed" : "available", reset_type: "codex_rate_limits", granted_at: new Date(base - 86400000).toISOString(),
    expires_at: new Date(base + 3600000).toISOString() }] });
  assert.equal(request.method, "POST");
  redeemed = true;
  return Response.json({ code: "reset" });
}, { preconnect: (url: string | URL) => {
  counts.blockedPreconnect++;
  blocked.push(`preconnect ${new URL(url).origin}`);
  throw new Error("Outbound preconnect is disabled.");
} }) as typeof fetch;

const resetDiagnostics: Array<{ message: string; error?: unknown }> = [];
const { registerLogSink } = await import("@oh-my-pi/pi-utils/logger");
registerLogSink(event => {
  if (event.message.includes("codex") && resetDiagnostics.length < 64)
    resetDiagnostics.push({ message: event.message, error: event.context?.error });
});
const { AssistantMessageEventStream } = await import("@oh-my-pi/pi-ai/utils/event-stream");
const native = await import("@oh-my-pi/pi-coding-agent");
const auth = await native.discoverAuthStorage(process.env.PI_CODING_AGENT_DIR);
await auth.set("openai-codex", { type: "oauth", access: "fixture-reconnect-access", refresh: "fixture-reconnect-refresh",
  expires: base + 86400000, accountId: "fixture-reconnect-account", email: "reconnect@fixture.invalid" });
auth.close();

let originalRegistry: import("@oh-my-pi/pi-coding-agent").AgentRegistry | undefined;
const register = native.AgentRegistry.prototype.register;
native.AgentRegistry.prototype.register = function (input) {
  const registered = register.call(this, input);
  if (input.kind === "main") {
    originalRegistry = this;
    native.AgentRegistry.prototype.register = register;
  }
  return registered;
};
const server = createServer(socket => {
  let input = "";
  socket.on("data", data => {
    input += data.toString();
    if (!input.includes("\n")) return;
    const line = input.slice(0, input.indexOf("\n")); input = "";
    void (async () => {
      const command = JSON.parse(line) as { op: string; route?: Route; count?: number };
      if (command.op === "gate") { assert.ok(command.route); gates.set(command.route, Promise.withResolvers<void>()); return null; }
      if (command.op === "release") { assert.ok(command.route); gates.get(command.route)?.resolve(); gates.delete(command.route); return null; }
      if (command.op === "wait") {
        const route = command.route!, count = command.count!;
        if (counts[route] < count) {
          const pending = Promise.withResolvers<void>();
          waits.push({ route, count, resolve: pending.resolve });
          await pending.promise;
        }
        return { ...counts };
      }
      const session = originalRegistry?.get("Main")?.session;
      assert.ok(session, "Original production native session is not registered");
      if (command.op === "failPrepare") {
        const drain = session.drainCodexResetPolicy;
        session.drainCodexResetPolicy = async () => {
          session.drainCodexResetPolicy = drain;
          await drain.call(session);
          throw new Error("Controlled original native drain failure");
        };
        return null;
      }
      if (command.op === "armBlocked") {
        let calls = 0;
        blockedTurn = true;
        session.agent.streamFn = model => {
          assert.equal(model.provider, "openai-codex");
          const output: import("@oh-my-pi/pi-ai").AssistantMessage = { role: "assistant", content: [], api: model.api,
            provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          const stream = new AssistantMessageEventStream();
          if (calls++ === 0) {
            output.stopReason = "error"; output.errorStatus = 429;
            output.errorMessage = "429 usage_limit_reached: You have hit your ChatGPT usage limit. retry-after: 7200";
            stream.push({ type: "error", reason: "error", error: output });
          } else {
            output.content = [{ type: "text", text: "Controlled native response." }];
            stream.push({ type: "done", reason: "stop", message: output });
          }
          stream.end();
          return stream;
        };
        await session.modelRegistry.authStorage.getApiKey("openai-codex", session.sessionId);
        return null;
      }
      if (command.op === "drain") return { policy: await session.drainCodexResetPolicy(), resetDiagnostics, counts };
      if (command.op === "sweep") {
        await session.modelRegistry.authStorage.getApiKey("openai-codex", session.sessionId);
        const result = await session.fetchUsageReportsWithResetPolicy({ source: "manual" });
        return { ...result, resetDiagnostics: [...resetDiagnostics], counts: { ...counts } };
      }
      if (command.op === "status") return { counts: { ...counts }, blocked, resetDiagnostics, consumes, sessionId: session.sessionId,
        isStreaming: session.isStreaming, hasPostPromptWork: session.hasPostPromptWork };
      throw new Error("Unknown controlled fixture operation");
    })().then(value => socket.end(JSON.stringify({ ok: true, value }) + "\n"),
      error => socket.end(JSON.stringify({ ok: false, error: String(error) }) + "\n"));
  });
});
const listening = Promise.withResolvers<void>();
server.once("error", listening.reject);
server.listen(path.join(root, "control.sock"), listening.resolve);
await listening.promise;
await import("../entry");
