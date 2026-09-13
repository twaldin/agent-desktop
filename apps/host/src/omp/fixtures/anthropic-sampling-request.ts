// Root-only native request proof. Run with env -i, an empty owned HOME and a
// kernel network-deny profile. Fake fetch replaces transport, NOT native builders.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { OmpStreamField } from "@agent-desktop/shared";

const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || process.env.HOME !== root || !root.includes("anthropic-sampling-native"))
  throw new Error("Use an empty owned anthropic-sampling-native directory as HOME and argv[2].");
const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
if (process.env.PI_CODING_AGENT_DIR !== agentDir) throw new Error("PI_CODING_AGENT_DIR must be the owned fixture directory.");
const key = "fixture-anthropic-sampling-clearly-inert-never-authenticate";
const oauthKey = "fixture-sk-ant-oat-sampling-clearly-inert-never-authenticate";
const requests: Array<{ auth: string; body: Record<string, unknown> }> = [];
let rejectedFetches = 0;
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const ownedFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init), url = new URL(request.url);
  const auth = request.headers.get("x-api-key") === key ? "api-key"
    : request.headers.get("authorization") === `Bearer ${oauthKey}` ? "oauth" : undefined;
  if (request.method !== "POST" || url.origin !== "https://api.anthropic.com" || url.pathname !== "/v1/messages" || !auth) {
    rejectedFetches++;
    throw new Error(`Unexpected fixture request: ${request.method} ${url.origin}${url.pathname}`);
  }
  const body = await request.json() as Record<string, unknown>;
  requests.push({ auth, body });
  const id = `msg_owned_sampling_${requests.length}`;
  return new Response(
    sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }) +
    sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Owned sampling response." } }) +
    sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) +
    sse("message_stop", { type: "message_stop" }),
    { status: 200, headers: { "content-type": "text/event-stream", "request-id": id } });
}, { preconnect: () => {} }) as typeof fetch;
globalThis.fetch = Object.assign(async () => {
  rejectedFetches++;
  throw new Error("Global network fetch is prohibited in this fixture.");
}, { preconnect: () => {} }) as typeof fetch;

await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
const stableFiles = new Map([
  [path.join(agentDir, "config.yml"), "extensions: []\nretry:\n  enabled: false\ntemperature: 0.35\ntopP: 0.8\n"],
  [path.join(agentDir, "settings.json"), "{\"fixture\":\"anthropic-sampling-settings-sentinel\"}\n"],
  [path.join(root, ".profile"), "anthropic sampling profile sentinel\n"],
]);
for (const [file, contents] of stableFiles) await writeFile(file, contents, { flag: "wx" });

// Both fetch boundaries exist before native module evaluation or discovery.
const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings, VERSION } = await import("@oh-my-pi/pi-coding-agent");
const { getBundledModel } = await import("@oh-my-pi/pi-catalog/models");
const { parseCliThinkingLevel } = await import("@oh-my-pi/pi-coding-agent/thinking");
const { NativeSessionControls } = await import("../../omp-settings/models");
const { parseSessionControlMutation } = await import("../../settings-http");
const auth = await discoverAuthStorage(agentDir);
const settings = await Settings.loadReadOnly({ agentDir, cwd });
const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
type Native = { session: Awaited<ReturnType<typeof createAgentSession>>["session"]; manager: Awaited<ReturnType<typeof SessionManager.open>>; controls: InstanceType<typeof NativeSessionControls> };
async function create(model: Model, file?: string, thinkingLevel?: "off" | "high", credential = key): Promise<Native> {
  const manager = file ? await SessionManager.open(file) : SessionManager.create(cwd, path.join(agentDir, "sessions"));
  try {
    const { session } = await createAgentSession({ agentDir, cwd, authStorage: auth, modelRegistry: registry,
      settings: await Settings.loadReadOnly({ agentDir, cwd }), agentRegistry: new AgentRegistry(), sessionManager: manager,
      model, ...(thinkingLevel ? { thinkingLevel: parseCliThinkingLevel(thinkingLevel) } : {}), getApiKey: () => credential,
      hasUI: false, interactivePrompts: false, disableExtensionDiscovery: true, enableMCP: false, enableLsp: false,
      toolNames: [], restrictToolNames: true, skills: [], rules: [], contextFiles: [], systemPrompt: "Owned native sampling proof." });
    const original = session.agent.streamFn;
    session.agent.streamFn = (model, context, options) => original(model, context, { ...options, fetch: ownedFetch });
    await manager.ensureOnDisk();
    return { session, manager, controls: new NativeSessionControls(session) };
  } catch (error) { await manager.close(); throw error; }
}
async function close(native: Native) { await native.session.dispose(); await native.manager.close(); }
async function mutate(native: Native, field: OmpStreamField, action: "set" | "inherit" | "provider-default", value?: number) {
  const state = native.controls.read();
  return native.controls.mutate(parseSessionControlMutation({ expectedRevision: state.revision, operation: "advanced-stream",
    model: state.advancedStream!.model, field, action, ...(action === "set" ? { value } : {}) }), async () => { throw new Error("Sampling must not change models."); });
}
async function thinking(native: Native, level: "off" | "high") {
  return native.controls.mutate(parseSessionControlMutation({ expectedRevision: native.controls.read().revision, operation: "thinking", level }), async () => {});
}
const observations: Array<Record<string, unknown>> = [];
async function prompt(native: Native, label: string) {
  const before = requests.length;
  await native.session.agent.prompt(`Owned ${label}; no provider transport.`);
  assert.equal(requests.length, before + 1, `${label} must produce one native request.`);
  const request = requests[before]!;
  const wire = { model: request.body.model, temperature: request.body.temperature, topP: request.body.top_p,
    thinking: request.body.thinking, outputConfig: request.body.output_config, maxTokens: request.body.max_tokens };
  observations.push({ label, auth: request.auth, wire });
  return wire;
}
function model(id: string): Model {
  const native = registry.find("anthropic", id), bundled = getBundledModel("anthropic", id);
  if (!native || native.api !== "anthropic-messages") throw new Error(`Missing pinned model ${id}`);
  assert.equal(native.baseUrl, bundled.baseUrl); assert.equal(native.api, bundled.api);
  assert.equal(native.transport, bundled.transport); assert.deepEqual(native.identity, bundled.identity);
  return native;
}
let native: Native | undefined;
try {
  const sonnet = model("claude-sonnet-4-5"), haiku = model("claude-haiku-4-5");
  native = await create(sonnet, undefined, "off");
  let snapshot = native.controls.read();
  assert.equal(snapshot.advancedStream!.supported, false);
  assert.equal(snapshot.advancedStream!.fields!.temperature.supported, true);
  assert.ok(snapshot.advancedStream!.samplingConflict, "Both inherited baselines conflict.");
  await assert.rejects(mutate(native, "temperature", "set", 0.2), { code: "invalid-value" });
  assert.equal(requests.length, 0);
  await mutate(native, "topP", "provider-default");
  snapshot = native.controls.read();
  await mutate(native, "temperature", "set", 0);
  await assert.rejects(native.controls.mutate(parseSessionControlMutation({ expectedRevision: snapshot.revision, operation: "advanced-stream",
    model: snapshot.advancedStream!.model, field: "topP", action: "set", value: 0.9 }), async () => {}), { code: "conflict" });
  await assert.rejects(mutate(native, "topP", "set", 0.9), { code: "invalid-value" });
  assert.deepEqual(native.controls.read().advancedStream!.selection, { temperature: 0, topP: null });
  let wire = await prompt(native, "temperature-zero-native-off");
  assert.equal(wire.temperature, 0); assert.equal(wire.topP, undefined); assert.deepEqual(wire.thinking, { type: "disabled" });
  const temperatureLeaf = native.manager.getLeafId()!;
  await mutate(native, "temperature", "provider-default"); await mutate(native, "topP", "set", 0.7);
  wire = await prompt(native, "explicit-switch-to-top-p");
  assert.equal(wire.temperature, undefined); assert.equal(wire.topP, 0.7);
  const topPLeaf = native.manager.getLeafId()!;
  native.manager.branch(temperatureLeaf);
  assert.equal(native.controls.read().advancedStream!.selection.temperature, 0);
  native.manager.branch(topPLeaf);
  assert.equal(native.controls.read().advancedStream!.selection.topP, 0.7);
  const file = native.manager.getSessionFile()!;
  await close(native); native = undefined;
  native = await create(sonnet, file);
  assert.deepEqual(native.controls.read().advancedStream!.selection, { temperature: null, topP: 0.7 });
  wire = await prompt(native, "journal-reopen-top-p"); assert.equal(wire.topP, 0.7); assert.equal(wire.temperature, undefined);
  native.session.agent.setModel(haiku);
  assert.deepEqual(native.controls.read().advancedStream!.selection, {});
  native.session.agent.setModel(sonnet);
  assert.deepEqual(native.controls.read().advancedStream!.selection, { temperature: null, topP: 0.7 });
  const offRevision = native.controls.read().revision;
  await thinking(native, "high");
  snapshot = native.controls.read(); assert.notEqual(snapshot.revision, offRevision);
  assert.equal(snapshot.advancedStream!.fields!.temperature.supported, false);
  assert.deepEqual(snapshot.advancedStream!.selection, { temperature: null, topP: 0.7 });
  wire = await prompt(native, "thinking-high-retains-but-suppresses-sampling");
  assert.equal(wire.temperature, undefined); assert.equal(wire.topP, undefined);
  assert.equal((wire.thinking as { type: string }).type, "enabled");
  await close(native); native = undefined;
  native = await create(sonnet, file);
  assert.equal(native.controls.read().advancedStream!.fields!.temperature.supported, false);
  assert.deepEqual(native.controls.read().advancedStream!.selection, { temperature: null, topP: 0.7 });
  await thinking(native, "off");
  wire = await prompt(native, "thinking-off-restores-saved-top-p"); assert.equal(wire.topP, 0.7);
  // Request-only native options may differ from the idle snapshot. Reject before fetch.
  await mutate(native, "temperature", "inherit");
  await mutate(native, "topP", "inherit");
  const beforeRejected = requests.length;
  assert.throws(() => native!.session.agent.streamFn(sonnet, { messages: [] }, { temperature: 0.35, topP: 0.8, disableReasoning: true }), { code: "invalid-value" });
  assert.equal(requests.length, beforeRejected);
  await mutate(native, "topP", "provider-default");
  wire = await prompt(native, "explicit-inherit-native-temperature"); assert.equal(wire.temperature, 0.35); assert.equal(wire.topP, undefined);
  // Same-ID native overlay: recover saved intent without applying it to a new endpoint.
  native.session.agent.setModel({ ...sonnet, baseUrl: "https://untrusted.invalid" });
  assert.equal(native.controls.read().advancedStream!.fields!.temperature.supported, false);
  await assert.rejects(mutate(native, "temperature", "set", 0.4), { code: "unsupported" });
  await mutate(native, "topP", "inherit");
  assert.deepEqual(native.controls.read().advancedStream!.selection, {});
  native.session.agent.setModel(sonnet);
  await close(native); native = undefined;

  for (const credential of [key, oauthKey]) {
    native = await create(haiku, undefined, "off", credential);
    await mutate(native, "topP", "provider-default"); await mutate(native, "temperature", "set", 0.4);
    wire = await prompt(native, credential === key ? "haiku-api-key" : "haiku-oauth");
    assert.equal(wire.temperature, 0.4); assert.equal(wire.topP, undefined);
    await close(native); native = undefined;
  }
  const adaptive = model("claude-opus-4-6");
  native = await create(adaptive, undefined, "high");
  assert.equal(native.controls.read().advancedStream!.fields!.temperature.supported, false);
  wire = await prompt(native, "adaptive-high");
  assert.equal(wire.temperature, undefined); assert.equal(wire.topP, undefined);
  assert.equal((wire.thinking as { type: string }).type, "adaptive");
  await thinking(native, "off");
  assert.equal(native.controls.read().advancedStream!.fields!.temperature.supported, true);
  await mutate(native, "topP", "provider-default"); await mutate(native, "temperature", "set", 0.3);
  wire = await prompt(native, "adaptive-native-off-omits-thinking");
  assert.equal(wire.temperature, 0.3); assert.equal(wire.topP, undefined); assert.equal(wire.thinking, undefined);
  await close(native); native = undefined;
  const mandatory = { ...adaptive, thinking: { ...adaptive.thinking!, requiresEffort: true } };
  native = await create(mandatory, undefined, "off");
  assert.equal(native.controls.read().advancedStream!.fields!.temperature.supported, false);
  wire = await prompt(native, "native-mandatory-overlay-normalizes-off");
  assert.equal(wire.temperature, undefined); assert.equal(wire.topP, undefined);
  assert.equal((wire.thinking as { type: string }).type, "adaptive");
  await close(native); native = undefined;
  for (const id of ["claude-opus-4-8", "claude-fable-5"]) {
    native = await create(model(id), undefined, "off");
    assert.equal(native.controls.read().advancedStream!.fields!.temperature.supported, false);
    await assert.rejects(mutate(native, "temperature", "set", 0.2), { code: "unsupported" });
    wire = await prompt(native, `${id}-compat-suppression`);
    assert.equal(wire.temperature, undefined); assert.equal(wire.topP, undefined);
    await close(native); native = undefined;
  }
  const stable = [];
  for (const [file, expected] of stableFiles) {
    const actual = await readFile(file, "utf8"); assert.equal(actual, expected);
    stable.push({ path: path.relative(root, file), sha256: createHash("sha256").update(actual).digest("hex"), unchanged: true });
  }
  assert.equal(rejectedFetches, 0);
  console.log(JSON.stringify({ version: VERSION,
    evidenceClass: "real-native-session-controls-parser-journal-agent-loop-and-Anthropic-request-builder-under-owned-fake-fetch; NOT-live-provider-or-native-UI-acceptance",
    requestCount: requests.length, rejectedFetches, observations, stable }, null, 2));
} finally {
  if (native) await close(native);
  auth.close();
}
