// Main-only proof runner. Launch under an EMPTY owned HOME with env -i; never a personal profile.
// The actual native Agent loop -> SDK stream chain -> streamSimple -> Google builder runs.
// fetch is an owned in-memory request boundary: there is no socket and no provider quota.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OmpStreamField } from "@agent-desktop/shared";

const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || process.env.HOME !== root || !root.includes("native-stream")) throw new Error("Use an explicitly owned native-stream directory as both HOME and argv[2].");
const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
if (process.env.PI_CODING_AGENT_DIR !== agentDir) throw new Error("PI_CODING_AGENT_DIR must be the owned fixture agent directory.");
const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
const inertKey = "native-stream-owned-boundary-not-a-credential";
let rejectedFetches = 0;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (request.method !== "POST" || !["generativelanguage.googleapis.com", "aiplatform.googleapis.com"].includes(url.hostname)
    || !url.pathname.endsWith(":streamGenerateContent") || request.headers.get("x-goog-api-key") !== inertKey) {
    rejectedFetches++;
    throw new Error("All non-owned requests are forbidden in native stream proof.");
  }
  captured.push({ url: request.url, body: await request.json() as Record<string, unknown> });
  return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Owned request boundary response." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}, { preconnect: () => {} }) as typeof fetch;
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
const configPath = path.join(agentDir, "config.yml");
const config = "extensions: []\ntemperature: 0.35\ntopP: 0.8\nretry:\n  enabled: false\n";
await writeFile(configPath, config, { flag: "wx" });
// Intentionally exercise the native module-loading boundary only after the
// outbound fetch guard is installed; static imports would run native discovery first.
const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
const { NativeSessionControls } = await import("../../omp-settings/models");
const { parseSessionControlMutation } = await import("../../settings-http");
const auth = await discoverAuthStorage(agentDir);
const settings = await Settings.loadReadOnly({ agentDir, cwd });
const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
const evidence: Array<Record<string, unknown>> = [];
try {
  for (const target of [{ provider: "google", api: "google-generative-ai" }, { provider: "google-vertex", api: "google-vertex" }] as const) {
    const model = registry.find(target.provider, "gemini-2.5-flash");
    if (!model || model.api !== target.api) throw new Error("Pinned native Gemini model/API missing; do not fabricate catalog entries.");
    const create = async (file?: string) => {
      const manager = file ? await SessionManager.open(file) : SessionManager.create(cwd, path.join(agentDir, "sessions"));
      try {
        const result = await createAgentSession({ agentDir, cwd, authStorage: auth, modelRegistry: registry,
          settings: await Settings.loadReadOnly({ agentDir, cwd }), agentRegistry: new AgentRegistry(), sessionManager: manager,
          model, thinkingLevel: "off", getApiKey: () => inertKey, hasUI: false, interactivePrompts: false,
          disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, toolNames: [], restrictToolNames: true,
          skills: [], rules: [], contextFiles: [], systemPrompt: "Owned native-stream request construction proof." });
        await manager.ensureOnDisk();
        return { session: result.session, manager, controls: new NativeSessionControls(result.session) };
      } catch (error) { await manager.close(); throw error; }
    };
    let native = await create();
    const request = async (label: string) => {
      const before = captured.length;
      await native.session.agent.prompt("Owned native-stream fixture input; no external provider transport.");
      assert.equal(captured.length, before + 1, "Exactly one real native builder request must reach the owned boundary.");
      const body = captured[before]!.body;
      const generation = body.generationConfig as Record<string, unknown>;
      assert.ok(generation && typeof generation === "object", "Google's actual wire generationConfig is required.");
      evidence.push({ provider: target.provider, api: target.api, label, generationConfig: generation, requestUrl: captured[before]!.url });
      return generation;
    };
    const mutate = async (field: OmpStreamField, action: "set" | "inherit" | "provider-default", value?: number) => {
      const snapshot = native.controls.read();
      const mutation = parseSessionControlMutation({ expectedRevision: snapshot.revision, operation: "advanced-stream", model: snapshot.advancedStream!.model,
        field, action, ...(action === "set" ? { value } : {}) });
      return native.controls.mutate(mutation, async () => { throw new Error("The proof must not change accounts/models via stream controls."); });
    };
    try {
      const baseline = await request("native-startup-defaults");
      assert.equal(baseline.temperature, 0.35); assert.equal(baseline.topP, 0.8); assert.equal(baseline.maxOutputTokens, model.maxTokens);
      const stale = native.controls.read();
      await mutate("temperature", "set", 0); await mutate("topP", "set", 0.4); await mutate("maxTokens", "set", 256);
      const custom = await request("explicit-zero-sampling-and-output");
      assert.equal(custom.temperature, 0); assert.equal(custom.topP, 0.4); assert.equal(custom.maxOutputTokens, 256);
      await assert.rejects(native.controls.mutate({ operation: "advanced-stream", expectedRevision: stale.revision, model: stale.advancedStream!.model!, field: "topP", action: "set", value: 0.9 }, async () => {}), { code: "conflict" });
      await assert.rejects(mutate("topP", "set", 2), { code: "invalid-value" });
      await assert.rejects(mutate("maxTokens", "set", 0), { code: "invalid-value" });
      await mutate("temperature", "provider-default"); await mutate("topP", "provider-default");
      const omitted = await request("explicit-provider-defaults");
      assert.equal(Object.hasOwn(omitted, "temperature"), false); assert.equal(Object.hasOwn(omitted, "topP"), false); assert.equal(omitted.maxOutputTokens, 256);
      for (const field of ["temperature", "topP", "maxTokens"] as const) await mutate(field, "inherit");
      const inherited = await request("cleared-to-native-startup-defaults");
      assert.equal(inherited.temperature, 0.35); assert.equal(inherited.topP, 0.8); assert.equal(inherited.maxOutputTokens, model.maxTokens);
      await mutate("temperature", "set", 0.6); await mutate("topP", "set", 0.55); await mutate("maxTokens", "set", 512);
      const file = native.manager.getSessionFile()!;
      await native.session.dispose(); native = await create(file);
      const reopened = await request("native-session-reopened");
      assert.equal(reopened.temperature, 0.6); assert.equal(reopened.topP, 0.55); assert.equal(reopened.maxOutputTokens, 512);
      const otherModel = registry.find(target.provider, "gemini-2.5-pro");
      if (!otherModel || otherModel.api !== target.api) throw new Error("Pinned native alternate Gemini model missing.");
      native.session.agent.setModel(otherModel);
      assert.deepEqual(native.controls.read().advancedStream!.selection, {});
      const other = await request("different-model-inherits-native");
      assert.equal(other.temperature, 0.35); assert.equal(other.topP, 0.8); assert.equal(other.maxOutputTokens, otherModel.maxTokens);
      native.session.agent.setModel(model);
      assert.equal(native.controls.read().advancedStream!.selection.maxTokens, 512);
    } finally { await native.session.dispose(); }
  }
  assert.equal(await readFile(configPath, "utf8"), config);
  console.log(JSON.stringify({ sourceCommit: "f241301c83726afe75a847e919b89977a54dafbe", version: "18.1.10", evidenceClass: "real-native-agent-loop-and-request-builder-controlled-fetch; not-App-UI-or-live-provider", accountWrites: 0, externalNetworkRequests: 0, rejectedFetches, evidence }, null, 2));
} finally { auth.close(); }
