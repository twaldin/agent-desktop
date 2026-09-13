// Main-only native Anthropic output-budget proof. Launch with env -i under the
// task-private sandbox-exec network-deny profile and an empty owned HOME.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Model } from "@oh-my-pi/pi-catalog/types";

const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || process.env.HOME !== root || !root.includes("anthropic-output-native"))
  throw new Error("Use an empty owned anthropic-output-native directory as HOME and argv[2].");
const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
if (process.env.PI_CODING_AGENT_DIR !== agentDir) throw new Error("PI_CODING_AGENT_DIR must be the owned fixture agent directory.");

const inertApiKey = "fixture-anthropic-output-key-clearly-inert";
const inertOAuthKey = "fixture-sk-ant-oat-output-clearly-inert-never-authenticate";
const requests: Array<{ auth: "api-key" | "oauth"; body: Record<string, unknown>; status: 200 }> = [];
let rejectedFetches = 0, responseSequence = 0;
function sse(event: string, data: unknown): string { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
const ownedFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init), url = new URL(request.url);
  const auth = request.headers.get("x-api-key") === inertApiKey ? "api-key"
    : request.headers.get("authorization") === `Bearer ${inertOAuthKey}` ? "oauth" : undefined;
  if (request.method !== "POST" || url.hostname !== "api.anthropic.com" || url.pathname !== "/v1/messages" || !auth) {
    rejectedFetches++;
    throw new Error(`Unexpected request rejected: ${request.method} ${url.protocol}//${url.hostname}${url.pathname}`);
  }
  const body = await request.json() as Record<string, unknown>;
  requests.push({ auth, body, status: 200 });
  const id = `msg_owned_${++responseSequence}`;
  const payload =
    sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }) +
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Owned output-budget response." } }) +
    sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) +
    sse("message_stop", { type: "message_stop" });
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream", "request-id": id } });
}, { preconnect: () => {} }) as typeof fetch;
globalThis.fetch = Object.assign(async () => {
  rejectedFetches++;
  throw new Error("Global fetch is forbidden; every native request must use the explicit owned fetch seam.");
}, { preconnect: () => {} }) as typeof fetch;

await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
const stableFiles = new Map([
  [path.join(agentDir, "config.yml"), "extensions: []\nretry:\n  enabled: false\ntemperature: -1\ntopP: -1\n"],
  [path.join(agentDir, "settings.json"), "{\"fixture\":\"anthropic-output-settings-sentinel\"}\n"],
  [path.join(root, ".profile"), "anthropic output profile sentinel\n"],
]);
for (const [file, contents] of stableFiles) await writeFile(file, contents, { flag: "wx" });

// No native module executes before both fetch boundaries and owned paths exist.
const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings, VERSION } = await import("@oh-my-pi/pi-coding-agent");
const { getBundledModel } = await import("@oh-my-pi/pi-catalog/models");
const { parseCliThinkingLevel } = await import("@oh-my-pi/pi-coding-agent/thinking");
const { NativeSessionControls } = await import("../../omp-settings/models");
const { parseSessionControlMutation } = await import("../../settings-http");
const auth = await discoverAuthStorage(agentDir);
const settings = await Settings.loadReadOnly({ agentDir, cwd });
const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });

type Native = { session: Awaited<ReturnType<typeof createAgentSession>>["session"]; manager: Awaited<ReturnType<typeof SessionManager.open>>; controls: InstanceType<typeof NativeSessionControls> };
async function create(model: Model, key: string, file?: string, thinkingLevel?: "off" | "high"): Promise<Native> {
  const manager = file ? await SessionManager.open(file) : SessionManager.create(cwd, path.join(agentDir, "sessions"));
  try {
    const result = await createAgentSession({ agentDir, cwd, authStorage: auth, modelRegistry: registry,
      settings: await Settings.loadReadOnly({ agentDir, cwd }), agentRegistry: new AgentRegistry(), sessionManager: manager,
      model, ...(thinkingLevel ? { thinkingLevel: parseCliThinkingLevel(thinkingLevel) } : {}), getApiKey: () => key, hasUI: false, interactivePrompts: false,
      disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, toolNames: [], restrictToolNames: true,
      skills: [], rules: [], contextFiles: [], systemPrompt: "Owned native Anthropic output-budget proof." });
    // Explicit provider seam is installed before the product controls wrap the
    // native streamFn, so every baseline and selected request stays in memory.
    const nativeStream = result.session.agent.streamFn;
    result.session.agent.streamFn = (streamModel, context, options) => nativeStream(streamModel, context, { ...options, fetch: ownedFetch });
    await manager.ensureOnDisk();
    return { session: result.session, manager, controls: new NativeSessionControls(result.session) };
  } catch (error) { await manager.close(); throw error; }
}
async function close(native: Native): Promise<void> {
  await native.session.dispose();
  await native.manager.close();
}
async function mutate(native: Native, action: "set" | "inherit", value?: number) {
  const state = native.controls.read(), advanced = state.advancedStream!;
  const request = parseSessionControlMutation({ expectedRevision: state.revision, operation: "advanced-stream", model: advanced.model,
    field: "maxTokens", action, ...(action === "set" ? { value } : {}) });
  return native.controls.mutate(request, async () => { throw new Error("Output budget mutation must not change models."); });
}
async function prompt(native: Native, label: string) {
  const before = requests.length;
  await native.session.agent.prompt(`Owned ${label} request; no provider transport.`);
  assert.equal(requests.length, before + 1, `${label} must produce exactly one owned native request.`);
  const request = requests[before]!;
  return { label, auth: request.auth, status: request.status, wire: {
    model: request.body.model, max_tokens: request.body.max_tokens,
    temperature: Object.hasOwn(request.body, "temperature") ? request.body.temperature : "<omitted>",
    top_p: Object.hasOwn(request.body, "top_p") ? request.body.top_p : "<omitted>",
    thinking: request.body.thinking ?? "<omitted>", output_config: request.body.output_config ?? "<omitted>",
  } };
}

const observations: Array<Record<string, unknown>> = [];
let native: Native | undefined;
try {
  const sonnet = registry.find("anthropic", "claude-sonnet-4-5");
  const other = registry.find("anthropic", "claude-haiku-4-5");
  const opus = registry.find("anthropic", "claude-opus-4-8");
  if (!sonnet || !other || !opus || sonnet.api !== "anthropic-messages" || other.api !== "anthropic-messages" || opus.api !== "anthropic-messages")
    throw new Error("Pinned bundled Anthropic fixture models are unavailable.");
  for (const model of [sonnet, other, opus]) {
    const bundled = getBundledModel("anthropic", model.id);
    assert.equal(model.api, bundled.api); assert.equal(model.baseUrl, bundled.baseUrl);
    assert.equal(model.transport, bundled.transport); assert.deepEqual(model.identity, bundled.identity);
  }

  native = await create(sonnet, inertApiKey, undefined, "high");
  let state = native.controls.read(), advanced = state.advancedStream!;
  assert.equal(advanced.supported, false, "Legacy clients must not offer unimplemented sampling.");
  assert.equal(advanced.fields!.temperature.supported, false); assert.equal(advanced.fields!.topP.supported, false);
  assert.deepEqual(advanced.fields!.maxTokens, { supported: true, reason: advanced.fields!.maxTokens.reason, minimum: 1, maximum: 64000 });
  assert.match(advanced.outputBudgetNote!, /thinking may increase it/); assert.match(advanced.outputBudgetNote!, /OAuth may cap it at 64000/);
  await assert.rejects(native.controls.mutate(parseSessionControlMutation({ expectedRevision: state.revision, operation: "advanced-stream", model: advanced.model,
    field: "temperature", action: "set", value: 0.2 }), async () => {}), { code: "unsupported" });

  state = await mutate(native, "set", 2000);
  assert.equal(state.advancedStream!.selection.maxTokens, 2000);
  const high = await prompt(native, "thinking-high-budget-2000");
  assert.equal(high.wire.max_tokens, 20384);
  assert.deepEqual(high.wire.thinking, { type: "enabled", budget_tokens: 16384, display: "summarized" });
  assert.equal(high.wire.temperature, "<omitted>"); assert.equal(high.wire.top_p, "<omitted>");
  observations.push(high);

  const file = native.manager.getSessionFile()!;
  await close(native); native = undefined;
  native = await create(sonnet, inertApiKey, file);
  assert.equal(native.session.configuredThinkingLevel(), "high", "Native journal reopen must restore thinking high.");
  assert.equal(native.controls.read().advancedStream!.selection.maxTokens, 2000, "Native journal reopen must restore the model-bound budget receipt.");
  native.session.agent.setModel(other);
  assert.deepEqual(native.controls.read().advancedStream!.selection, {}, "A changed model must not inherit another model's budget.");
  native.session.agent.setModel(sonnet);
  assert.equal(native.controls.read().advancedStream!.selection.maxTokens, 2000, "Switchback must restore the original model-bound budget.");

  state = await mutate(native, "inherit");
  assert.equal(state.advancedStream!.selection.maxTokens, undefined);
  const inherited = await prompt(native, "explicit-inherit-native-budget");
  assert.equal(inherited.wire.max_tokens, 64000);
  observations.push(inherited);
  await close(native); native = undefined;

  for (const account of [{ label: "api-key-128k", key: inertApiKey, expected: 128000 }, { label: "oauth-64k", key: inertOAuthKey, expected: 64000 }] as const) {
    native = await create(opus, account.key, undefined, "off");
    const opusControls = native.controls.read().advancedStream!;
    assert.equal(opusControls.fields!.maxTokens.supported, true);
    assert.equal(opusControls.fields!.maxTokens.maximum, 128000, "The app must retain the native model limit instead of imposing a universal 64k cap.");
    const observed = await prompt(native, account.label);
    assert.equal(observed.wire.max_tokens, account.expected);
    assert.deepEqual(observed.wire.output_config, { effort: "low" });
    observations.push(observed);
    await close(native); native = undefined;
  }

  const stable = [];
  for (const [filePath, expected] of stableFiles) {
    const actual = await readFile(filePath, "utf8"); assert.equal(actual, expected);
    stable.push({ path: path.relative(root, filePath), bytes: Buffer.byteLength(actual), sha256: createHash("sha256").update(actual).digest("hex"), unchanged: true });
  }
  assert.equal(rejectedFetches, 0);
  console.log(JSON.stringify({ version: VERSION,
    evidenceClass: "actual-native-session-controls-mutation-journal-and-Anthropic-builder-under-explicit-in-memory-fetch-and-kernel-network-deny; not-live-provider/SDK/App/independent-review",
    externalNetworkRequests: 0, rejectedFetches, credentialsRead: 0, credentialsWritten: 0, requestCount: requests.length,
    fields: { anthropicSamplingSupported: false, anthropicOutputBudgetSupported: true }, observations, stable }, null, 2));
} finally {
  if (native) await close(native);
  auth.close();
}
