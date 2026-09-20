// Actual ../entry, SDK Codex SSE/retry, reset planner, owner, context and receipts.
// Controlled seams: synthetic OAuth; an exact-route fetch relay to loopback; HTTP
// provider payloads/gates; and a transparent first-root registry observation tap.
// No streamFn, reset callback, lifecycle method or production owner is replaced.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import type { AgentRegistry, AgentSession } from "@oh-my-pi/pi-coding-agent";

const root = process.env.SHARED_RESET_FIXTURE_ROOT!;
assert.ok(root && path.isAbsolute(root));
assert.equal(process.env.HOME, root);
const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
assert.equal(process.env.PI_CODING_AGENT_DIR, agentDir);
const base = Number(process.env.SHARED_RESET_FIXTURE_BASE_MS);
assert.ok(Number.isSafeInteger(base) && base > 0, "Host must supply the same provider timestamp to both workers");
const accountId = "fixture-shared-account", creditId = "fixture-shared-credit";
// Deliberately unsigned, synthetic JWT shape: the real Codex transport extracts
// its account header from this claim, rather than from AuthStorage.accountId.
const access = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: accountId }, exp: base / 1000 + 86400,
})).toString("base64url")}.fixture-not-a-signature`;
type Route = "usage" | "credits" | "consume" | "inference";
type Target = "root" | "child" | "sibling";
type ConsumeMode = "reset" | "throw" | "malformed";
const routes: Record<string, Route> = {
  "/backend-api/wham/usage": "usage",
  "/backend-api/wham/rate-limit-reset-credits": "credits",
  "/backend-api/wham/rate-limit-reset-credits/consume": "consume",
  "/backend-api/codex/responses": "inference",
};
const counts = { usage: 0, credits: 0, consume: 0, inference: 0, escaped: 0, blockedPreconnect: 0, blockedWebSocket: 0 };
const blocked: Array<{ kind: string; url: string }> = [];
interface RouteGate { promise: Promise<void>; resolve(): void }
const gates = new Map<Route, RouteGate>();
const waits: Array<{ route: Route; count: number; resolve(): void }> = [];
const sessions: Partial<Record<Target, AgentSession>> = {};
const armed = new Set<string>();
const lifecycle: Array<{ seq: number; target: Target; sessionId: string; phase: string }> = [];
const lifecycleWaits: Array<{ target: Target; phase: string; resolve(): void }> = [];
const nativeEvents: Array<Record<string, unknown>> = [];
const resetDiagnostics: Array<{ message: string; error?: string; errorStack?: string }> = [];
let seq = 0, blockedTurn = false, redeemed = false;
let consumeMode: ConsumeMode = "reset";
interface TransportRequest {
  seq: number; route: Route; method: string; url: string; headers: Record<string, string>;
  rawBody: string | null; body: unknown; arrived?: number; responseStatus?: number;
  responseBody?: string; error?: string;
}
const transportRequests: TransportRequest[] = [];
const consumes: unknown[] = [];
const originalFetch = globalThis.fetch;
let providerOrigin: string | undefined;
function deny(kind: string, input: string): never {
  counts.escaped++;
  if (kind === "preconnect") counts.blockedPreconnect++;
  if (kind === "websocket") counts.blockedWebSocket++;
  blocked.push({ kind, url: input });
  throw new Error(`Outbound ${kind} disabled in shared reset fixture: ${input}`);
}
// Account APIs intentionally normalize away loopback baseUrl overrides in the SDK.
// Relay only these exact synthetic-auth URLs; original URL/headers/body stay in
// the journal. The only real network fetch is to this process's 127.0.0.1 server.
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init), url = new URL(request.url);
  const route = routes[url.pathname];
  if (!providerOrigin || url.origin !== "https://chatgpt.com" || url.search || !route
    || request.headers.get("Authorization") !== `Bearer ${access}`
    || request.headers.get("ChatGPT-Account-Id") !== accountId
    || request.method !== (route === "consume" || route === "inference" ? "POST" : "GET"))
    return deny("fetch", `${request.method} ${url.origin}${url.pathname}`);
  const rawBody = request.body ? await request.text() : null;
  const record: TransportRequest = { seq: ++seq, route, method: request.method, url: request.url,
    headers: Object.fromEntries(request.headers), rawBody, body: rawBody === null ? null : JSON.parse(rawBody) };
  transportRequests.push(record);
  const headers = new Headers(request.headers);
  headers.set("x-fixture-request-seq", String(record.seq));
  try {
    const response = await originalFetch(`${providerOrigin}${url.pathname}`, {
      method: request.method, headers, body: rawBody, signal: request.signal, redirect: "error",
    });
    // A labelled HTTP response requests a controlled fetch rejection after the
    // consume has reached loopback. The original dispatched identity is retained.
    if (response.headers.get("x-fixture-throw") === "consume") {
      await response.text();
      throw new TypeError("Controlled consume transport failure after loopback dispatch");
    }
    return response;
  } catch (error) { record.error = String(error); throw error; }
}, { preconnect: (input: string | URL) => deny("preconnect", String(input)) }) as typeof fetch;
// Select the SDK's real SSE implementation and prevent any WebSocket escape.
process.env.PI_CODEX_WEBSOCKET = "0";
process.env.PI_CODEX_ZSTD = "0";
globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
  construct(_constructor, args): never { return deny("websocket", String(args[0])); },
});

function usagePayload() {
  return { plan_type: "plus", rate_limit: { allowed: !blockedTurn, limit_reached: blockedTurn,
    primary_window: { used_percent: redeemed ? 0 : blockedTurn ? 100 : 60, limit_window_seconds: 18000, reset_at: base / 1000 + 10800 },
    secondary_window: { used_percent: redeemed ? 0 : 50, limit_window_seconds: 604800, reset_at: base / 1000 + 172800 } },
    rate_limit_reset_credits: { available_count: redeemed ? 0 : 1 } };
}
function creditsPayload() {
  return { available_count: redeemed ? 0 : 1, credits: [{ id: creditId, status: redeemed ? "redeemed" : "available",
    reset_type: "codex_rate_limits", granted_at: new Date(base - 86400000).toISOString(),
    expires_at: new Date(base + 7 * 86400000).toISOString() }] };
}
async function hold(route: Route, signal: AbortSignal): Promise<void> {
  const gate = gates.get(route);
  if (!gate) return;
  signal.throwIfAborted();
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason ?? new Error("Controlled request aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  try { await Promise.race([gate.promise, aborted.promise]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
function successSse(requestSeq: number): string {
  const id = `msg_fixture_${requestSeq}`, responseId = `resp_fixture_${requestSeq}`;
  const text = "Controlled shared-admission native response.";
  const item = { id, type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: responseId, status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_text.done", item_id: id, output_index: 0, content_index: 0, text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: responseId, status: "completed", output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0,
  async fetch(request) {
    const requestSeq = Number(request.headers.get("x-fixture-request-seq"));
    const record = transportRequests.find(candidate => candidate.seq === requestSeq);
    assert.ok(record && new URL(request.url).pathname === new URL(record.url).pathname, "Unowned loopback request");
    const route = record.route;
    record.arrived = ++seq;
    counts[route]++;
    if (route === "consume") consumes.push(record.body);
    const inferenceSession = request.headers.get("session_id");
    const rejectInference = route === "inference" && inferenceSession !== null && armed.delete(inferenceSession);
    if (rejectInference) blockedTurn = true;
    // Capture read bytes BEFORE waiting. The other worker's independent
    // loopback view intentionally remains stale after a competing reset.
    let payload = route === "usage" ? JSON.stringify(usagePayload()) : route === "credits" ? JSON.stringify(creditsPayload()) : "";
    const mode = consumeMode;
    for (const waiter of [...waits]) if (counts[waiter.route] >= waiter.count) {
      waits.splice(waits.indexOf(waiter), 1); waiter.resolve();
    }
    await hold(route, request.signal);
    let status = 200;
    const headers = new Headers({ "content-type": "application/json" });
    if (route === "consume") {
      if (mode === "throw") { headers.set("x-fixture-throw", "consume"); payload = "controlled consume transport failure"; }
      else if (mode === "malformed") payload = "{}";
      else {
        const body = record.body as Record<string, unknown>;
        assert.equal(body.account_id, accountId);
        assert.equal(body.credit_id, creditId);
        assert.equal(typeof body.redeem_request_id, "string");
        if (redeemed) payload = JSON.stringify({ code: "already_redeemed" });
        else {
          redeemed = true; blockedTurn = false;
          payload = JSON.stringify({ code: "reset" });
        }
      }
    } else if (route === "inference") {
      assert.ok(inferenceSession && Object.values(sessions).some(session => session?.sessionId === inferenceSession), "Inference needs an exact observed native session");
      if (rejectInference) {
        status = 429;
        headers.set("retry-after", "7200");
        headers.set("x-codex-primary-used-percent", "100");
        headers.set("x-codex-primary-reset-at", String(base / 1000 + 10800));
        payload = JSON.stringify({ error: { code: "usage_limit_reached", message: "You have hit your ChatGPT usage limit. retry-after: 7200",
          plan_type: "plus", resets_at: base / 1000 + 10800 } });
      } else { headers.set("content-type", "text/event-stream"); payload = successSse(record.seq); }
    }
    record.responseStatus = status; record.responseBody = payload;
    return new Response(payload, { status, headers });
  },
});
providerOrigin = `http://127.0.0.1:${provider.port}`;
await mkdir(agentDir, { recursive: true });
await mkdir(cwd, { recursive: true });

// Guard and loopback server are established before every value-level SDK import.
const { registerLogSink } = await import("@oh-my-pi/pi-utils/logger");
registerLogSink(event => {
  if (/codex|reset|retry/i.test(event.message)) resetDiagnostics.push({ message: event.message,
    ...(event.context?.error === undefined ? {} : { error: String(event.context.error) }),
    ...(event.context?.error instanceof Error ? { errorStack: event.context.error.stack } : {}) });
});
const native = await import("@oh-my-pi/pi-coding-agent");
const auth = await native.discoverAuthStorage(agentDir);
await auth.set("openai-codex", { type: "oauth", access, refresh: "fixture-shared-refresh", expires: base + 86400000,
  accountId, email: "shared@fixture.invalid" });
auth.close();

function observe(target: Target, session: AgentSession): void {
  assert.ok(!sessions[target], `The first ${target} session identity must not be replaced`);
  sessions[target] = session;
  const mark = (phase: string) => {
    lifecycle.push({ seq: ++seq, target, sessionId: session.sessionId, phase });
    for (const waiter of [...lifecycleWaits]) if (waiter.target === target && waiter.phase === phase) {
      lifecycleWaits.splice(lifecycleWaits.indexOf(waiter), 1); waiter.resolve();
    }
  };
  mark("observed");
  // Public exact-session listener beside production listeners; never substitutes
  // for the real disposal or terminal drain and makes no retirement claim.
  session.registerCodexResetPolicyLifecycle({ beginClose: () => mark("beginClose"), drained: () => mark("drained") });
  session.subscribe(event => {
    if (event.type === "notice" || event.type === "auto_retry_start" || event.type === "auto_retry_end")
      nativeEvents.push({ seq: ++seq, target, sessionId: session.sessionId, ...event });
    if (event.type === "message_end" && event.message.role === "assistant") nativeEvents.push({ seq: ++seq, target,
      sessionId: session.sessionId, type: event.type, stopReason: event.message.stopReason,
      errorStatus: event.message.errorStatus, errorMessage: event.message.errorMessage, content: event.message.content });
  });
}
let originalRegistry: AgentRegistry | undefined;
let firstRegistration: { agentId: string; sessionId?: string } | undefined;
const register = native.AgentRegistry.prototype.register;
native.AgentRegistry.prototype.register = function (input) {
  const registered = register.call(this, input);
  if (input.kind === "main" && !originalRegistry) {
    originalRegistry = this;
    firstRegistration = { agentId: registered.id };
    native.AgentRegistry.prototype.register = register;
  }
  return registered;
};
function targetSession(target: Target = "root"): AgentSession {
  assert.ok(target === "root" || target === "child" || target === "sibling", "Unknown target");
  // SDK registration precedes attaching the created session to that same entry.
  // Observe the original entry when first used; never require a session in the
  // registration input or substitute another root.
  if (!sessions.root) {
    const original = firstRegistration && originalRegistry?.get(firstRegistration.agentId)?.session;
    assert.ok(original, "The first registered root must have its actual SDK session");
    observe("root", original);
    firstRegistration!.sessionId = original.sessionId;
  }
  const session = sessions[target];
  assert.ok(session, `The original ${target} native session is not registered`);
  return session;
}
function status() {
  const original = targetSession("root");
  return { pid: process.pid, workerPid: process.pid, sessionId: original?.sessionId ?? null,
    sessionIds: { root: original?.sessionId ?? null, child: sessions.child?.sessionId ?? null, sibling: sessions.sibling?.sessionId ?? null },
    firstRegistration, originalRegistrationIntact: !!firstRegistration && originalRegistry?.get(firstRegistration.agentId)?.session === original,
    sessions: Object.fromEntries(Object.entries(sessions).map(([target, session]) => [target, { sessionId: session.sessionId,
      isDisposed: session.isDisposed, isStreaming: session.isStreaming, hasPostPromptWork: session.hasPostPromptWork }])),
    isStreaming: original?.isStreaming ?? false, hasPostPromptWork: original?.hasPostPromptWork ?? false,
    counts: { ...counts }, consumes, transportRequests, lifecycle, nativeEvents, blocked, resetDiagnostics,
    provider: { origin: providerOrigin, accountId, creditId, blockedTurn, redeemed, consumeMode,
      inferenceTransport: "actual-sdk-codex-sse", readSnapshots: "captured-before-gate", armedSessionIds: [...armed] } };
}
type Command = { op: string; route?: Route; count?: number; target?: Target; phase?: "beginClose" | "drained"; mode?: ConsumeMode; text?: string };
async function control(command: Command) {
  if (command.op === "status") return status();
  if (command.op === "waitLifecycle") {
    const target = command.target!, phase = command.phase!;
    assert.ok(["root", "child", "sibling"].includes(target) && ["beginClose", "drained"].includes(phase));
    if (!lifecycle.some(event => event.target === target && event.phase === phase)) {
      const reached = Promise.withResolvers<void>(); lifecycleWaits.push({ target, phase, resolve: reached.resolve }); await reached.promise;
    }
    return status();
  }
  if (command.op === "gate" || command.op === "release" || command.op === "wait") {
    const route = command.route;
    assert.ok(route && ["usage", "credits", "consume", "inference"].includes(route), "Unknown provider route");
    if (command.op === "gate") { assert.ok(!gates.has(route), "Route already gated"); gates.set(route, Promise.withResolvers<void>()); return null; }
    if (command.op === "release") { gates.get(route)?.resolve(); gates.delete(route); return null; }
    const count = command.count ?? counts[route] + 1;
    assert.ok(Number.isInteger(count) && count > 0, "wait count must be a positive absolute count");
    if (counts[route] < count) { const reached = Promise.withResolvers<void>(); waits.push({ route, count, resolve: reached.resolve }); await reached.promise; }
    return { ...counts };
  }
  if (command.op === "setConsumeMode") {
    assert.ok(command.mode === "reset" || command.mode === "throw" || command.mode === "malformed");
    consumeMode = command.mode; return null;
  }
  const session = targetSession(command.target);
  if (command.op === "armBlocked") {
    assert.ok(!session.isDisposed && !session.isStreaming, "Cannot arm a disposed or streaming session");
    assert.equal(session.model?.provider, "openai-codex");
    assert.equal(session.model?.api, "openai-codex-responses");
    await session.modelRegistry.authStorage.getApiKey("openai-codex", session.sessionId);
    armed.add(session.sessionId); return { sessionId: session.sessionId };
  }
  if (command.op === "drain") return { policy: await session.drainCodexResetPolicy(), ...status() };
  if (command.op === "idle") { await session.waitForIdle(); await session.drainCodexResetPolicy(); return status(); }
  if (command.op === "createChildren") {
    assert.equal(command.target ?? "root", "root");
    assert.ok(!sessions.child && !sessions.sibling, "Child identities may only be created once");
    const factory = session.codexResetPolicyOwnerFactory, writer = session.settings.getResetPolicySettingsWriter();
    assert.ok(factory && writer && session.model, "Original production factory, writer and model are required");
    for (const target of ["child", "sibling"] as const) {
      const settings = await session.settings.cloneForCwd(cwd);
      assert.equal(settings.getResetPolicySettingsWriter(), writer);
      const result = await native.createAgentSession({ cwd, agentDir, settings, model: session.model,
        modelRegistry: session.modelRegistry, authStorage: session.modelRegistry.authStorage,
        agentRegistry: new native.AgentRegistry(), sessionManager: native.SessionManager.inMemory(cwd),
        disableExtensionDiscovery: true, extensions: [], enableMCP: false, enableIrc: false, enableLsp: false,
        toolNames: [], skills: [], rules: [], contextFiles: [], hasUI: false, interactivePrompts: false,
        systemPrompt: "Controlled disposable shared-admission native session.", codexResetPolicyOwnerFactory: factory });
      assert.equal(result.session.codexResetPolicyOwnerFactory, factory);
      assert.equal(result.session.modelRegistry.authStorage, session.modelRegistry.authStorage);
      observe(target, result.session);
    }
    return status();
  }
  if (command.op === "disposeChild") {
    assert.ok(command.target === "child" || command.target === "sibling", "Root disposal belongs to WorkerRuntime");
    await session.dispose(); await session.drainCodexResetPolicy(); return status();
  }
  if (command.op === "prompt") {
    assert.ok(command.target === "child" || command.target === "sibling", "Root prompts must use actual WorkerSession.prompt");
    await session.prompt(command.text ?? "Reply briefly for the controlled shared reset admission fixture.");
    await session.waitForIdle(); return status();
  }
  throw new Error(`Unknown controlled fixture operation: ${command.op}`);
}
const sockets = new Set<Socket>();
const server = createServer(socket => {
  sockets.add(socket); socket.once("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  let input = "", handled = false;
  socket.on("data", chunk => {
    if (handled) return;
    input += chunk.toString();
    if (input.length > 65536) { handled = true; socket.end(JSON.stringify({ ok: false, error: "Control request too large" }) + "\n"); return; }
    const newline = input.indexOf("\n"); if (newline < 0) return;
    handled = true;
    void Promise.resolve().then(() => control(JSON.parse(input.slice(0, newline)) as Command)).then(
      value => socket.end(JSON.stringify({ ok: true, value }) + "\n"),
      error => socket.end(JSON.stringify({ ok: false, error: String(error) }) + "\n"));
  });
});
const listening = Promise.withResolvers<void>();
server.once("error", listening.reject);
server.listen(path.join(root, "control.sock"), listening.resolve);
await listening.promise;
// Reconnect deliberately keeps this process and its original SDK objects alive.
// Production entry owns shutdown; no fixture listener converts disconnect into exit.
process.once("exit", () => { server.close(); for (const socket of sockets) socket.destroy(); void provider.stop(true); });
await import("../entry");
