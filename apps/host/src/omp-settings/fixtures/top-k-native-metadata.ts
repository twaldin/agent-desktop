// Actual pinned catalog/registry/SDK metadata path under an isolated owned HOME.
// Every Google Models request terminates at the injected fake fetch boundary.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Model } from "@oh-my-pi/pi-catalog/types";

const [agentDir, cwd] = process.argv.slice(2);
if (!agentDir || !cwd || process.env.PI_CODING_AGENT_DIR !== agentDir)
  throw new Error("Use the wrapper-owned native metadata directories.");
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
const configPath = path.join(agentDir, "config.yml");
const config = "extensions: []\ntemperature: 0.35\ntopP: 0.8\ntopK: 20\nretry:\n  enabled: false\n";
await writeFile(configPath, config, { flag: "wx" });

type ListItem = Record<string, unknown>;
type Gate = { promise: Promise<void>; resolve(value?: void): void; reject(reason?: unknown): void };
type Hold = { started: Gate; release: Gate };
type Reply = { models: ListItem[]; hold?: Hold } | "failure";
const replies: Reply[] = [];
const requests: string[] = [];
let rejectedFetches = 0;
const inertGoogleKey = "owned-google-model-metadata-not-a-credential";
const fakeFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init), url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== "https://generativelanguage.googleapis.com"
    || url.pathname !== "/v1beta/models" || url.searchParams.get("key") !== inertGoogleKey) {
    rejectedFetches++;
    throw new Error("Only the controlled Google Models GET is available in this fixture.");
  }
  requests.push(request.url.replace(inertGoogleKey, "[redacted-owned-key]"));
  const reply = replies.shift();
  if (!reply) throw new Error("Unexpected native discovery request.");
  if (reply === "failure") throw new Error("Controlled native discovery failure.");
  if (reply.hold) { reply.hold.started.resolve(); await reply.hold.release.promise; }
  return Response.json(reply);
}, { preconnect: () => {} });
globalThis.fetch = fakeFetch as typeof fetch;

const { fingerprintStaticModels } = await import("@oh-my-pi/pi-catalog/model-manager");
const { writeModelCache } = await import("@oh-my-pi/pi-catalog/model-cache");
const { getBundledModel, getBundledModels } = await import("@oh-my-pi/pi-catalog/models");
const { googleModelManagerOptions } = await import("@oh-my-pi/pi-catalog/provider-models/google");
const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
const auth = await discoverAuthStorage(agentDir);
auth.setConfigApiKey("google", inertGoogleKey);
auth.setConfigApiKey("anthropic", "owned-anthropic-key-not-used");
const settings = await Settings.loadReadOnly({ agentDir, cwd });
const modelsPath = path.join(agentDir, "models.yml");
const flash = getBundledModel("google", "gemini-2.5-flash") as Model;
const pro = getBundledModel("google", "gemini-2.5-pro") as Model;
const anthropic = getBundledModel("anthropic", "claude-haiku-4-5") as Model;
const item = (model: Model, topK: unknown = 40, include = true): ListItem => ({
  name: `models/${model.id}`, displayName: model.name, supportedGenerationMethods: ["generateContent"],
  inputTokenLimit: model.contextWindow, outputTokenLimit: model.maxTokens, ...(include ? { topK } : {}),
});
const newRegistry = (label: string) => new ModelRegistry(auth, modelsPath, {
  settings, fetch: fakeFetch, cacheDbPath: path.join(agentDir, `${label}.db`),
});
const seed = async (registryLabel: string, model: Model, topK: number | undefined, updatedAt: number) => {
  const db = path.join(agentDir, `${registryLabel}.db`);
  const bundled = getBundledModels("google") as Model[];
  const options = googleModelManagerOptions();
  const dropIds = options.dropCachedModelIdsOnStaticMismatch ?? [];
  const fingerprint = `${fingerprintStaticModels(bundled, true)}${dropIds.length > 0 ? `:drop:${Bun.hash(dropIds.join("\0")).toString(36)}` : ""}`;
  const seeded = [{ ...model, ...(topK === undefined ? {} : { topK }) }];
  writeModelCache("google:top-k-v1", updatedAt, seeded, true, fingerprint, db, bundled);
};
const create = async (registry: InstanceType<typeof ModelRegistry>, model: Model, label: string) => {
  const manager = SessionManager.create(cwd, path.join(agentDir, `sessions-${label}`));
  try {
    const result = await createAgentSession({ agentDir, cwd, authStorage: auth, modelRegistry: registry, settings,
      agentRegistry: new AgentRegistry(), sessionManager: manager, model, thinkingLevel: "off", getApiKey: () => inertGoogleKey,
      hasUI: false, interactivePrompts: false, disableExtensionDiscovery: true, enableMCP: false, enableLsp: false,
      toolNames: [], restrictToolNames: true, skills: [], rules: [], contextFiles: [], systemPrompt: "Owned metadata fixture." });
    return { session: result.session, manager };
  } catch (error) { await manager.close(); throw error; }
};

try {
  // Actual SDK initial selection: provider metadata is parsed, merged and placed on Agent.model.
  const initialRegistry = newRegistry("sdk-initial");
  replies.push({ models: [item(flash, 40), item(pro, 20)] });
  const initial = await create(initialRegistry, initialRegistry.find("google", flash.id)!, "sdk-initial");
  let observedInitialModel: Model;
  try {
    assert.equal(initial.session.model?.topK, 40);
    observedInitialModel = initial.session.model!;
    assert.equal(initial.session.agent.temperature, 0.35); assert.equal(initial.session.agent.topP, 0.8); assert.equal(initial.session.agent.topK, 20);
  } finally { await initial.session.dispose(); }
  const beforeWarmCache = requests.length;
  const warmCached = await initialRegistry.refreshSelectedModelMetadata(observedInitialModel!);
  assert.equal(requests.length, beforeWarmCache, "A fresh provider cache should avoid a second Google Models GET.");
  assert.equal(warmCached.topK, 40, "Provider-observed Top K must survive the actual additive same-id cache merge.");

  // A fresh old cache has no field. Selected metadata must force the real Google manager online.
  await seed("old-cache", flash, undefined, Date.now());
  const oldCacheRegistry = newRegistry("old-cache");
  const old = oldCacheRegistry.find("google", flash.id)!;
  assert.equal(old.topK, undefined);
  replies.push({ models: [item(flash, 20)] });
  const beforeOld = requests.length;
  const upgraded = await oldCacheRegistry.refreshSelectedModelMetadata(old);
  assert.equal(requests.length, beforeOld + 1); assert.equal(upgraded.topK, 20);

  // A stale positive must be replaced by explicit provider omission/null, never retained.
  await seed("stale-positive", flash, 100, Date.now() - 3 * 60 * 60 * 1000);
  const staleRegistry = newRegistry("stale-positive");
  const stale = { ...staleRegistry.find("google", flash.id)!, topK: 100 };
  assert.equal(stale.topK, 100);
  replies.push({ models: [item(flash, undefined, false)] });
  const removed = await staleRegistry.refreshSelectedModelMetadata(stale);
  assert.equal(removed.topK, null);

  // A stale positive plus a failed refresh becomes unknown. Stale provider
  // metadata must never be revived as a supported capability.
  await seed("stale-positive-failure", flash, 100, Date.now() - 3 * 60 * 60 * 1000);
  const staleFailureRegistry = newRegistry("stale-positive-failure");
  replies.push("failure");
  assert.equal((await staleFailureRegistry.refreshSelectedModelMetadata({
    ...staleFailureRegistry.find("google", flash.id)!, topK: 100,
  })).topK, undefined);

  // A successful catalog that no longer lists the selected id is unknown for
  // that id. It must clear the captured positive instead of borrowing bundled data.
  await seed("missing-selected", flash, 100, Date.now() - 3 * 60 * 60 * 1000);
  const missingRegistry = newRegistry("missing-selected"), previouslyPositive = {
    ...missingRegistry.find("google", flash.id)!, topK: 100,
  };
  assert.equal(previouslyPositive.topK, 100);
  replies.push({ models: [item(pro, 40)] });
  const missing = await missingRegistry.refreshSelectedModelMetadata(previouslyPositive);
  assert.equal(missing.topK, undefined);
  const beforeMissingWarmCache = requests.length;
  assert.equal((await missingRegistry.refreshSelectedModelMetadata(missing)).topK, undefined);
  assert.equal(requests.length, beforeMissingWarmCache, "A fresh authoritative cache without the selected id must not refetch repeatedly.");

  // Invalid provider numbers conservatively become an observed unsupported null.
  for (const [label, value] of [["zero", 0], ["fraction", 1.5], ["negative", -1], ["string", "40"]] as const) {
    const registry = newRegistry(`invalid-${label}`), selected = registry.find("google", flash.id)!;
    replies.push({ models: [item(flash, value)] });
    assert.equal((await registry.refreshSelectedModelMetadata(selected)).topK, null, label);
  }

  // Transport failure remains unknown; it must not manufacture a null or positive.
  const failureRegistry = newRegistry("unknown-failure"), unknown = failureRegistry.find("google", flash.id)!;
  replies.push("failure");
  assert.equal((await failureRegistry.refreshSelectedModelMetadata(unknown)).topK, undefined);

  // Endpoint, API, transport, wire-id and identity changes never borrow official metadata.
  const fenceRegistry = newRegistry("identity-fences");
  const fenced: Model[] = [
    { ...flash, baseUrl: "https://owned-proxy.invalid/v1beta" },
    { ...flash, api: "openai-completions" },
    { ...flash, transport: "pi-native" },
    { ...flash, requestModelId: "different-wire-model" },
    { ...flash, identity: { ...flash.identity, family: "different-family" } },
  ];
  const beforeFences = requests.length;
  for (const model of fenced) assert.equal((await fenceRegistry.refreshSelectedModelMetadata(model)).topK, undefined);
  assert.equal(requests.length, beforeFences);

  // The selected model is captured before native auth/discovery awaits. A caller
  // mutating its identity while the controlled response is held cannot acquire
  // the later capability or rewrite the returned selection tuple.
  const heldRegistry = newRegistry("held-identity"), mutable = {
    ...heldRegistry.find("google", flash.id)!, identity: structuredClone(flash.identity),
  } satisfies Model;
  const originalIdentity = structuredClone(mutable.identity);
  const hold: Hold = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  replies.push({ models: [item(flash, 40)], hold });
  const refreshing = heldRegistry.refreshSelectedModelMetadata(mutable);
  await hold.started.promise;
  try { (mutable.identity as { family?: string }).family = "mutated-during-discovery"; }
  finally { hold.release.resolve(); }
  const captured = await refreshing;
  assert.deepEqual(captured.identity, originalIdentity);
  assert.equal(captured.topK, 40);
  assert.equal(mutable.topK, undefined);
  assert.notDeepEqual(mutable.identity, captured.identity);

  // Existing native setModel uses the same selected-metadata seam before rebinding Agent.model.
  const switchRegistry = newRegistry("existing-set-model");
  const existing = await create(switchRegistry, anthropic, "existing-set-model");
  try {
    replies.push({ models: [item(pro, 40)] });
    await existing.session.setModel(switchRegistry.find("google", pro.id)!);
    assert.equal(existing.session.model?.provider, "google"); assert.equal(existing.session.model?.id, pro.id); assert.equal(existing.session.model?.topK, 40);
    assert.equal(existing.session.agent.temperature, 0.35); assert.equal(existing.session.agent.topP, 0.8); assert.equal(existing.session.agent.topK, 20);
  } finally { await existing.session.dispose(); }

  // Session settings can recover the currently selected Google model after an
  // unknown discovery result by selecting that same model again. The second
  // setModel call must refresh metadata rather than treating it as a no-op.
  const recoveryRegistry = newRegistry("same-current-recovery");
  const recovery = await create(recoveryRegistry, anthropic, "same-current-recovery");
  try {
    replies.push("failure");
    await recovery.session.setModel(recoveryRegistry.find("google", flash.id)!);
    assert.equal(recovery.session.model?.provider, "google"); assert.equal(recovery.session.model?.id, flash.id);
    assert.equal(recovery.session.model?.topK, undefined);
    assert.equal(recovery.session.agent.temperature, 0.35); assert.equal(recovery.session.agent.topP, 0.8); assert.equal(recovery.session.agent.topK, 20);

    replies.push({ models: [item(flash, 40)] });
    await recovery.session.setModel(recovery.session.model!);
    assert.equal(recovery.session.model?.provider, "google"); assert.equal(recovery.session.model?.id, flash.id);
    assert.equal(recovery.session.model?.topK, 40);
    assert.equal(recovery.session.agent.temperature, 0.35); assert.equal(recovery.session.agent.topP, 0.8); assert.equal(recovery.session.agent.topK, 20);
  } finally { await recovery.session.dispose(); }

  assert.equal(replies.length, 0); assert.equal(await readFile(configPath, "utf8"), config);
  process.stdout.write(`native Top K metadata contracts passed (${requests.length} controlled Models requests; ${rejectedFetches} unrelated fetches rejected)\n`);
} finally { auth.close(); }
