// Main-only proof runner. Launch under an EMPTY owned HOME with env -i; never a personal profile.
// The actual native Agent loop -> SDK stream chain -> streamSimple -> Google builder runs.
// fetch is an owned in-memory request boundary: there is no socket and no provider quota.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OmpStreamField } from "@agent-desktop/shared";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { ModelRegistry as NativeModelRegistry } from "@oh-my-pi/pi-coding-agent";

const root = path.resolve(process.argv[2] ?? "");
if (!process.argv[2] || process.env.HOME !== root || !root.includes("native-stream")) throw new Error("Use an explicitly owned native-stream directory as both HOME and argv[2].");
const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
if (process.env.PI_CODING_AGENT_DIR !== agentDir) throw new Error("PI_CODING_AGENT_DIR must be the owned fixture agent directory.");
const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
const inertKey = "native-stream-owned-boundary-not-a-credential";
let rejectedFetches = 0;
const discoveryRequests: string[] = [];
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (request.method === "GET" && url.origin === "https://generativelanguage.googleapis.com"
    && url.pathname === "/v1beta/models" && url.searchParams.get("key") === inertKey) {
    discoveryRequests.push(request.url);
    return Response.json({ models: ["gemini-2.5-flash", "gemini-2.5-pro"].map(id => ({
      name: `models/${id}`, displayName: id, supportedGenerationMethods: ["generateContent"],
      inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, topK: 40,
    })) });
  }
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
const config = "extensions: []\ntemperature: 0.35\ntopP: 0.8\ntopK: 20\nretry:\n  enabled: false\n";
await writeFile(configPath, config, { flag: "wx" });
// Intentionally exercise the native module-loading boundary only after the
// outbound fetch guard is installed; static imports would run native discovery first.
const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
const { getBundledModel } = await import("@oh-my-pi/pi-catalog/models");
const { NativeSessionControls } = await import("../../omp-settings/models");
const { parseSessionControlMutation } = await import("../../settings-http");
const auth = await discoverAuthStorage(agentDir);
auth.setConfigApiKey("google", inertKey);
const settings = await Settings.loadReadOnly({ agentDir, cwd });
const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
const evidence: Array<Record<string, unknown>> = [];
const boundaryEvidence: Array<{ provider: string; case: string; supported: boolean; mutation: "unsupported"; effective: { id: string; api: string; baseUrl: string; transport: string | null }; loadedWithoutErrors: true; bundledUnchanged: true }> = [];
const recoveryEvidence: Array<{ provider: string; retained: number; maximum: number; excessiveWriteRejected: true; excessiveDispatchBlocked: true; explicitInheritRequestLimit: number }> = [];
try {
  for (const target of [{ provider: "google", api: "google-generative-ai" }, { provider: "google-vertex", api: "google-vertex" }] as const) {
    const initialModel = registry.find(target.provider, "gemini-2.5-flash");
    if (!initialModel || initialModel.api !== target.api) throw new Error("Pinned native Gemini model/API missing; do not fabricate catalog entries.");
    let model: Model = initialModel;
    const create = async (file?: string, sessionModel: Model = model, sessionRegistry: NativeModelRegistry = registry) => {
      // The controlled overlay registries below share AuthStorage, and each
      // config reload clears config-sourced keys. Restore only this fixture's
      // inert key before each owned session instance.
      auth.setConfigApiKey("google", inertKey);
      if (sessionModel.provider === "google") {
        assert.equal(auth.hasResolvableAuth("google"), true, "Owned Google auth must remain natively resolvable before SDK creation.");
        assert.equal(sessionRegistry.hasConfiguredAuth(sessionModel), true, "Owning registry must recognize the fixture credential before SDK creation.");
      }
      const manager = file ? await SessionManager.open(file) : SessionManager.create(cwd, path.join(agentDir, "sessions"));
      try {
        const result = await createAgentSession({ agentDir, cwd, authStorage: auth, modelRegistry: sessionRegistry,
          settings: await Settings.loadReadOnly({ agentDir, cwd }), agentRegistry: new AgentRegistry(), sessionManager: manager,
          model: sessionModel, thinkingLevel: "off", getApiKey: () => inertKey, hasUI: false, interactivePrompts: false,
          disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, toolNames: [], restrictToolNames: true,
          skills: [], rules: [], contextFiles: [], systemPrompt: "Owned native-stream request construction proof." });
        await manager.ensureOnDisk();
        return { session: result.session, manager, controls: new NativeSessionControls(result.session) };
      } catch (error) { await manager.close(); throw error; }
    };
    let native = await create();
    model = native.session.model!;
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
      assert.equal(baseline.temperature, 0.35); assert.equal(baseline.topP, 0.8); assert.equal(baseline.topK, 20); assert.equal(baseline.maxOutputTokens, model.maxTokens);
      const topKControl = native.controls.read().advancedStream!.fields!.topK;
      assert.ok(topKControl); assert.equal(topKControl.supported, target.provider === "google"); assert.equal(topKControl.minimum, 1); assert.equal(topKControl.maximum, null);
      if (target.provider === "google-vertex") {
        assert.match(topKControl.reason, /fixed|Vertex/i);
        await assert.rejects(mutate("topK", "set", 40), { code: "unsupported" });
        // A receipt written by the rejected implementation remains readable and
        // explicitly clearable, but never reaches the fixed Vertex request.
        native.manager.appendCustomEntry("agent-desktop.advanced-stream.top-k.v1", {
          model: { provider: model.provider, id: model.id, api: model.api }, selection: { topK: 40 },
        });
        assert.equal(native.controls.read().advancedStream!.selection.topK, 40);
        const retained = await request("fixed-vertex-retained-receipt-suppressed");
        assert.equal(retained.topK, 20, "Unsupported retained intent must not replace the inherited native baseline.");
        await mutate("topK", "inherit");
        assert.equal(native.controls.read().advancedStream!.selection.topK, undefined);
        const cleared = await request("fixed-vertex-receipt-explicitly-cleared");
        assert.equal(cleared.topK, 20);
      } else {
        await mutate("topK", "set", 1);
        const focusedTopK = await request("top-k-preset-1");
        assert.equal(focusedTopK.topK, 1);
      }
      // Exercise real native models.yml overlays, not fabricated in-memory Models.
      // No request is dispatched while an unverified endpoint/model is selected.
      const customEndpoint = "https://native-stream-custom.invalid/v1beta";
      for (const boundary of [
        { label: "provider-endpoint-override", id: model.id, expectedBaseUrl: customEndpoint, configuration: { baseUrl: customEndpoint } },
        { label: "same-id-model-endpoint-override", id: model.id, expectedBaseUrl: customEndpoint, configuration: { api: model.api, baseUrl: model.baseUrl,
          models: [{ id: model.id, baseUrl: customEndpoint }] } },
        { label: "unlisted-gemini-id-official-endpoint", id: "gemini-native-stream-unlisted", expectedBaseUrl: model.baseUrl, configuration: { api: model.api, baseUrl: model.baseUrl,
          models: [{ id: "gemini-native-stream-unlisted", name: "Owned unlisted model" }] } },
      ]) {
        const bundledBefore: Model = getBundledModel(target.provider, model.id);
        const authority: Pick<Model, "id" | "api" | "baseUrl" | "transport" | "identity"> = { id: bundledBefore.id, api: bundledBefore.api, baseUrl: bundledBefore.baseUrl, transport: bundledBefore.transport, identity: structuredClone(bundledBefore.identity) };
        const modelConfigPath = path.join(agentDir, `${target.provider}-${boundary.label}.yml`);
        // Native custom model definitions require an explicit auth mode. This
        // owned no-dispatch registry shares AuthStorage; create() restores the
        // fixture's inert key after each overlay config reload.
        await writeFile(modelConfigPath, JSON.stringify({ providers: { [target.provider]: { auth: "none", ...boundary.configuration } } }), { flag: "wx" });
        const overlayRegistry = new ModelRegistry(auth, modelConfigPath, { settings });
        const overlayModel = overlayRegistry.find(target.provider, boundary.id);
        assert.equal(overlayRegistry.getError(), undefined, `Controlled native overlay must load: ${overlayRegistry.getError()?.message ?? boundary.label}`);
        assert.ok(overlayModel, "The actual pinned ModelRegistry must admit the controlled overlay.");
        assert.equal(overlayModel.provider, target.provider);
        assert.equal(overlayModel.id, boundary.id);
        assert.equal(overlayModel.api, model.api);
        assert.equal(overlayModel.baseUrl, boundary.expectedBaseUrl, "The actual native overlay must reach the intended endpoint.");
        assert.equal(overlayModel.transport, model.transport);
        const bundledAfter: Model = getBundledModel(target.provider, model.id);
        assert.deepEqual({ id: bundledAfter.id, api: bundledAfter.api, baseUrl: bundledAfter.baseUrl, transport: bundledAfter.transport, identity: bundledAfter.identity }, authority, "Native overlay composition must not mutate bundled catalog authority.");
        native.session.agent.setModel(overlayModel);
        const snapshot = native.controls.read();
        assert.equal(snapshot.advancedStream!.supported, false, `${boundary.label} must not advertise bundled native stream support.`);
        await assert.rejects(mutate("temperature", "set", 0.4), { code: "unsupported" });
        await assert.rejects(mutate("topK", "set", 40), { code: "unsupported" });
        boundaryEvidence.push({ provider: target.provider, case: boundary.label, supported: snapshot.advancedStream!.supported, mutation: "unsupported",
          effective: { id: overlayModel.id, api: overlayModel.api, baseUrl: overlayModel.baseUrl, transport: overlayModel.transport ?? null }, loadedWithoutErrors: true, bundledUnchanged: true });
        native.session.agent.setModel(model);
      }
      const stale = native.controls.read();
      await mutate("temperature", "set", 0); await mutate("topP", "set", 0.4);
      if (target.provider === "google") await mutate("topK", "set", 100);
      await mutate("maxTokens", "set", 256);
      const custom = await request("explicit-zero-sampling-and-output");
      assert.equal(custom.temperature, 0); assert.equal(custom.topP, 0.4);
      assert.equal(custom.topK, target.provider === "google" ? 100 : 20);
      assert.equal(custom.maxOutputTokens, 256);
      await assert.rejects(native.controls.mutate({ operation: "advanced-stream", expectedRevision: stale.revision, model: stale.advancedStream!.model!, field: "topP", action: "set", value: 0.9 }, async () => {}), { code: "conflict" });
      await assert.rejects(mutate("topP", "set", 2), { code: "invalid-value" });
      if (target.provider === "google") await assert.rejects(mutate("topK", "set", 2), { code: "invalid-value" });
      await assert.rejects(mutate("maxTokens", "set", 0), { code: "invalid-value" });
      await mutate("temperature", "provider-default"); await mutate("topP", "provider-default");
      if (target.provider === "google") await mutate("topK", "provider-default");
      const omitted = await request("explicit-provider-defaults");
      assert.equal(Object.hasOwn(omitted, "temperature"), false); assert.equal(Object.hasOwn(omitted, "topP"), false);
      assert.equal(target.provider === "google" ? Object.hasOwn(omitted, "topK") : omitted.topK, target.provider === "google" ? false : 20);
      for (const field of ["temperature", "topP", "maxTokens"] as const) await mutate(field, "inherit");
      if (target.provider === "google") await mutate("topK", "inherit");
      const inherited = await request("cleared-to-native-startup-defaults");
      assert.equal(inherited.temperature, 0.35); assert.equal(inherited.topP, 0.8); assert.equal(inherited.topK, 20); assert.equal(inherited.maxOutputTokens, model.maxTokens);
      await mutate("temperature", "set", 0.6); await mutate("topP", "set", 0.55);
      if (target.provider === "google") await mutate("topK", "set", 40);
      await mutate("maxTokens", "set", 512);
      const file = native.manager.getSessionFile()!;
      await native.session.dispose();
      const discoveryCountBeforeWarmRefresh = discoveryRequests.length;
      const directBeforeReopen = await registry.refreshSelectedModelMetadata(model);
      assert.equal(discoveryRequests.length, discoveryCountBeforeWarmRefresh, "Fresh selected-model metadata must reopen from its dedicated cache without another Models GET.");
      assert.equal(directBeforeReopen.topK, target.provider === "google" ? 40 : undefined,
        "Direct cached metadata refresh must preserve the provider's observed Top K state.");
      model = directBeforeReopen;
      native = await create(file);
      const reopenedState = native.controls.read().advancedStream!;
      assert.equal(reopenedState.selection.topK, target.provider === "google" ? 40 : undefined,
        "Reopen must preserve a supported receipt and keep an explicitly cleared fixed-provider receipt absent.");
      assert.equal(reopenedState.fields!.topK?.supported, target.provider === "google");
      assert.equal(native.session.model?.topK, target.provider === "google" ? 40 : undefined);
      const reopened = await request("native-session-reopened");
      assert.equal(reopened.temperature, 0.6); assert.equal(reopened.topP, 0.55);
      assert.equal(reopened.topK, target.provider === "google" ? 40 : 20);
      assert.equal(reopened.maxOutputTokens, 512);
      const otherModel = registry.find(target.provider, "gemini-2.5-pro");
      if (!otherModel || otherModel.api !== target.api) throw new Error("Pinned native alternate Gemini model missing.");
      native.session.agent.setModel(otherModel);
      assert.deepEqual(native.controls.read().advancedStream!.selection, {});
      const other = await request("different-model-inherits-native");
      assert.equal(other.temperature, 0.35); assert.equal(other.topP, 0.8); assert.equal(other.topK, 20); assert.equal(other.maxOutputTokens, otherModel.maxTokens);
      native.session.agent.setModel(model);
      assert.equal(native.controls.read().advancedStream!.selection.maxTokens, 512);
      assert.equal(native.controls.read().advancedStream!.selection.topK, target.provider === "google" ? 40 : undefined);
      // Preserve saved intent when an actual native model override lowers the
      // model limit. Reading its revision and explicitly clearing must remain possible.
      const lowerLimitConfig = path.join(agentDir, `${target.provider}-lower-output-limit.yml`);
      await writeFile(lowerLimitConfig, JSON.stringify({ providers: { [target.provider]: { modelOverrides: { [model.id]: { maxTokens: 128 } } } } }), { flag: "wx" });
      const lowerLimitRegistry = new ModelRegistry(auth, lowerLimitConfig, { settings });
      const lowerLimitModel = lowerLimitRegistry.find(target.provider, model.id);
      assert.equal(lowerLimitRegistry.getError(), undefined, `Native lower-limit config must load: ${lowerLimitRegistry.getError()?.message ?? target.provider}`);
      assert.ok(lowerLimitModel);
      assert.equal(lowerLimitModel.maxTokens, 128);
      assert.equal(lowerLimitModel.api, model.api);
      assert.equal(lowerLimitModel.baseUrl, model.baseUrl);
      assert.equal(lowerLimitModel.transport, model.transport);
      await native.session.dispose(); native = await create(file, lowerLimitModel, lowerLimitRegistry);
      const recovery = native.controls.read();
      assert.equal(recovery.advancedStream!.supported, true);
      assert.equal(recovery.advancedStream!.native.maxTokens, 128);
      assert.equal(recovery.advancedStream!.selection.maxTokens, 512, "Saved intent must not be silently clamped or discarded when the native limit changes.");
      assert.deepEqual(recovery.advancedStream!.outputLimitConflict, { saved: 512, maximum: 128 });
      await assert.rejects(mutate("maxTokens", "set", 512), { code: "invalid-value" });
      const beforeRejectedDispatch = captured.length;
      assert.throws(() => native.session.agent.streamFn(lowerLimitModel, { messages: [] }), { code: "invalid-value" });
      assert.equal(captured.length, beforeRejectedDispatch, "An excessive saved limit must be rejected before the provider request boundary.");
      const cleared = await native.controls.mutate(parseSessionControlMutation({ expectedRevision: recovery.revision, operation: "advanced-stream",
        model: recovery.advancedStream!.model, field: "maxTokens", action: "inherit" }), async () => { throw new Error("Recovery must not switch models."); });
      assert.equal(cleared.advancedStream!.selection.maxTokens, undefined);
      assert.equal(cleared.advancedStream!.outputLimitConflict, undefined);
      const lowerLimitRequest = await request("lowered-native-limit-explicitly-cleared-after-reopen");
      assert.equal(lowerLimitRequest.maxOutputTokens, 128);
      assert.equal(lowerLimitRequest.temperature, 0.6); assert.equal(lowerLimitRequest.topP, 0.55);
      assert.equal(lowerLimitRequest.topK, target.provider === "google" ? 40 : 20);
      recoveryEvidence.push({ provider: target.provider, retained: 512, maximum: 128, excessiveWriteRejected: true, excessiveDispatchBlocked: true, explicitInheritRequestLimit: 128 });
    } finally { await native.session.dispose(); }
  }
  assert.equal(await readFile(configPath, "utf8"), config);
  console.log(JSON.stringify({ sourceBase: "f3ca116d395700a9c4f26f5dcf2b0235eb377bb5", version: "18.1.10", evidenceClass: "real-native-agent-loop-and-request-builder-controlled-fetch; Google metadata uses controlled Models GET; Vertex proves inherited baseline and disabled receipt recovery; no live-provider acceptance", accountWrites: 0, externalNetworkRequests: 0, rejectedFetches, evidence, boundaryEvidence, recoveryEvidence }, null, 2));
} finally { auth.close(); }
