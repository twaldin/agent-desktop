import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexResetPolicySessionBinding, ResetPass, ResetPlanSnapshot } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry, createAgentSession, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { AuthStorage, type OAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { createNativeResetPassContextFactory } from "./native-reset-context";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); AgentRegistry.resetGlobalForTests(); });
const credential = (access = "controlled-access"): OAuthCredential => ({ type: "oauth", access, refresh: "controlled-refresh", expires: Date.now() + 86_400_000,
  accountId: "account-a", email: "a@fixture.invalid", projectId: "project-a", orgId: "org-a" });
const credits = { available_count: 1, credits: [{ id: "credit-a", status: "available", expires_at: "2099-01-01T00:00:00Z" }] };

async function fixture(overrides?: Record<string, unknown>, holdCredits = false, beforeContext?: (binding: Readonly<CodexResetPolicySessionBinding>) => void) {
  const root = await mkdtemp(join(tmpdir(), "native-reset-context-")); roots.push(root);
  const cwd = join(root, "project"), agentDir = join(root, "agent"); await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  await writeFile(join(agentDir, "config.yml"), "codexResets:\n  autoRedeem: no\n  minBlockedMinutes: 60\n  keepCredits: 1\n  salvageHorizonHours: 12\n");
  let releaseCredits!: () => void, enterCredits!: () => void;
  const creditsEntered = new Promise<void>(resolve => { enterCredits = resolve; });
  const creditsRelease = new Promise<void>(resolve => { releaseCredits = resolve; });
  const usageFetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith("/rate-limit-reset-credits")) { if (holdCredits) { holdCredits = false; enterCredits(); await creditsRelease; } return Response.json(credits); }
    throw new Error(`Unexpected controlled request ${url.pathname}`);
  }) as typeof fetch;
  const authStorage = await AuthStorage.create(join(root, "auth.db"), { usageFetch }); await authStorage.set("openai-codex", credential());
  const settings = await Settings.loadReadOnly({ cwd, agentDir, overrides }); await settings.enableResetPolicyPersistence();
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"), { settings });
  let binding!: Readonly<CodexResetPolicySessionBinding>;
  const noOwner = { checkpoint: async () => {}, presentDecision: async () => {}, admit: async () => ({ kind: "hold" as const, reason: "owner-unavailable" as const }), complete: async () => {} };
  const created = await createAgentSession({ cwd, agentDir, settings, authStorage, modelRegistry, agentRegistry: AgentRegistry.global(),
    sessionManager: SessionManager.inMemory(cwd), disableExtensionDiscovery: true, enableMCP: false, enableIrc: false, enableLsp: false,
    toolNames: [], hasUI: false, codexResetPolicyOwnerFactory: value => { binding = value; return noOwner; } });
  const model = modelRegistry.getAll().find(item => item.provider === "openai-codex"); if (!model) throw new Error("Missing native Codex fixture model");
  await created.session.setModelTemporary(model); await authStorage.getApiKey("openai-codex", created.session.sessionId);
  const pass: ResetPass = Object.freeze({ passId: "pass-a", nativeSessionId: created.session.sessionId, trigger: "blocked", source: "blocked",
    startedAtMs: 1, provider: "openai-codex", modelId: model.id, codexBaseUrl: modelRegistry.getProviderBaseUrl("openai-codex") ?? model.baseUrl, policy: settings.getGroup("codexResets") });
  beforeContext?.(binding);
  const interactions = { runWithDecisionBinding: async <T>(bind: (id: string) => Promise<void>, select: () => Promise<T>) => { await bind("interaction-a"); return select(); } };
  const context = createNativeResetPassContextFactory({ binding, interactions })(pass);
  const credentialId = authStorage.listOAuthAccounts("openai-codex", created.session.sessionId)[0]!.credentialId!;
  const snapshot: ResetPlanSnapshot = Object.freeze({ pass, plannedAtMs: 2, reportRevision: "a".repeat(64), plan: { actions: [{ reason: "blocked-account" as const, target: { credentialId }, accountKey: "controlled", attemptKey: "attempt", label: "a", active: true }], skipped: [] } });
  return { root, cwd, agentDir, settings, authStorage, modelRegistry, session: created.session, context, snapshot, binding, interactions, pass, creditsEntered, releaseCredits, cleanup: async () => { context.dispose(); await created.session.dispose(); settings.disableResetPolicyPersistence(); authStorage.close(); } };
}

const answer = (f: Awaited<ReturnType<typeof fixture>>, value: "Yes" | "No") => f.context.runDecision(async () => {}, async () => value);

test("actual SDK binding captures original Settings/AuthStorage and rejects a relink across plan IO", async () => {
  const f = await fixture();
  try {
    const planned = await f.context.plan(f.snapshot); expect(planned.accounts).toHaveLength(1);
    f.authStorage.upsertCredential("openai-codex", credential("controlled-relinked"));
    expect(() => f.context.assertCurrent()).toThrow(/account evidence|selection/);
  } finally { await f.cleanup(); }
});

test("decision verifies continuity after the actual native selection promise settles", async () => {
  const f = await fixture();
  try {
    let bound = false;
    const pending = f.context.runDecision(async id => { expect(id).toBe("interaction-a"); bound = true; }, async () => {
      f.settings.override("codexResets.keepCredits", 9); return "Yes";
    });
    await expect(pending).rejects.toThrow(); expect(bound).toBe(true);
  } finally { await f.cleanup(); }
});

test("actual Settings one-shot native write is adopted, flushed, and proven without standing consent", async () => {
  const f = await fixture();
  try {
    await f.context.plan(f.snapshot); await answer(f, "Yes");
    f.settings.set("codexResets.autoRedeem", "yes");
    const proof = await f.context.persistence(f.snapshot, "yes");
    expect(proof).toMatchObject({ kind: "persistence", status: "verified", globalMode: "yes", layersUnchanged: true });
    expect(() => f.context.dispose()).not.toThrow(); expect(() => f.context.assertCurrent()).toThrow(/disposed/);
  } finally { await f.cleanup(); }
});


test("native selection OAuth to runtime and back stays stale", async () => {
  const f = await fixture();
  try {
    f.authStorage.setRuntimeApiKey("openai-codex", "controlled-runtime-key");
    f.authStorage.removeRuntimeApiKey("openai-codex");
    expect(() => f.context.assertCurrent()).toThrow(/selection/);
  } finally { await f.cleanup(); }
});

test("one Settings write can belong to only one of two independent pass observations", async () => {
  const f = await fixture();
  const secondPass = { ...f.pass, passId: "pass-b" } as ResetPass;
  const second = createNativeResetPassContextFactory({ binding: f.binding, interactions: f.interactions })(secondPass);
  const secondSnapshot = { ...f.snapshot, pass: secondPass } as ResetPlanSnapshot;
  try {
    await Promise.all([f.context.plan(f.snapshot), second.plan(secondSnapshot)]); await answer(f, "Yes");
    f.settings.set("codexResets.autoRedeem", "yes");
    await f.context.persistence(f.snapshot, "yes");
    expect(() => second.assertCurrent()).toThrow();
  } finally { second.dispose(); await f.cleanup(); }
});

test("a higher-layer shadow preserves effective no while proving the one global yes", async () => {
  const f = await fixture({ "codexResets.autoRedeem": "no" });
  try {
    await f.context.plan(f.snapshot); await answer(f, "Yes"); f.settings.set("codexResets.autoRedeem", "yes");
    const proof = await f.context.persistence(f.snapshot, "yes");
    expect(proof.globalMode).toBe("yes"); expect(proof.effectivePolicy?.autoRedeem).toBe("no");
  } finally { await f.cleanup(); }
});

test("flush failure is retained as failure and is never retried or treated as consent", async () => {
  const f = await fixture();
  try {
    await f.context.plan(f.snapshot); await answer(f, "Yes"); f.settings.set("codexResets.autoRedeem", "yes");
    const flush = spyOn(f.settings, "flush").mockRejectedValueOnce(new Error("controlled flush failure"));
    await expect(f.context.persistence(f.snapshot, "yes")).rejects.toThrow("controlled flush failure");
    expect(flush).toHaveBeenCalledTimes(1); flush.mockRestore(); await f.settings.flush();
  } finally { await f.cleanup(); }
});

test("admission reuses the original account and its final synchronous native proof", async () => {
  const f = await fixture();
  try {
    await f.context.plan(f.snapshot);
    const admitted = await f.context.admission(f.snapshot, 0);
    const account = admitted.evidence.account;
    const proof = f.authStorage.getResetAccountEvidence("openai-codex", account.credentialId);
    expect(admitted.evidence.credit.id).toBe("credit-a");
    expect(admitted.beforeConsume({ provider: "openai-codex", credentialId: account.credentialId, accountId: account.accountId,
      email: account.email, projectId: account.projectId, orgId: account.orgId, creditId: "credit-a", resetAccountEvidence: proof })).toBe(true);
    f.authStorage.upsertCredential("openai-codex", credential("controlled-relinked"));
    expect(admitted.beforeConsume({ provider: "openai-codex", credentialId: account.credentialId, creditId: "credit-a", resetAccountEvidence: proof })).toBe(false);
  } finally { await f.cleanup(); }
});


test("a relink during the awaited credit read rejects admission without recapture", async () => {
  const f = await fixture(undefined, true);
  try {
    await f.context.plan(f.snapshot);
    const pending = f.context.admission(f.snapshot, 0); await f.creditsEntered;
    f.authStorage.upsertCredential("openai-codex", credential("controlled-during-credit-read")); f.releaseCredits();
    await expect(pending).rejects.toThrow(/account evidence|selection/);
  } finally { await f.cleanup(); }
});

test("the native one-shot No write is persisted without synthesizing an answer", async () => {
  const f = await fixture();
  try {
    await f.context.plan(f.snapshot); await answer(f, "No"); f.settings.set("codexResets.autoRedeem", "no");
    expect(await f.context.persistence(f.snapshot, "no")).toMatchObject({ status: "verified", globalMode: "no" });
  } finally { await f.cleanup(); }
});


test("cold revival supplies a new exact SDK binding and therefore a distinct pass context", async () => {
  const f = await fixture();
  const { AgentLifecycleManager } = await import("@oh-my-pi/pi-coding-agent/registry/agent-lifecycle");
  const { createPersistedSubagentReviverFactory } = await import("@oh-my-pi/pi-coding-agent/task/persisted-revive");
  const registry = AgentRegistry.global(), lifecycle = new AgentLifecycleManager(registry), bindings: Readonly<CodexResetPolicySessionBinding>[] = [];
  const ownerFactory = (binding: Readonly<CodexResetPolicySessionBinding>) => { bindings.push(binding); return { checkpoint: async () => {}, presentDecision: async () => {}, admit: async () => ({ kind: "hold" as const, reason: "owner-unavailable" as const }), complete: async () => {} }; };
  lifecycle.setPersistedSubagentReviverFactory(createPersistedSubagentReviverFactory({ session: f.session, authStorage: f.authStorage,
    modelRegistry: f.modelRegistry, settings: f.settings, enableLsp: false, codexResetPolicyOwnerFactory: ownerFactory }), 0);
  const manager = SessionManager.create(f.cwd, join(f.cwd, "cold-child"));
  manager.appendSessionInit({ systemPrompt: "controlled cold child", task: "no provider", tools: [], restrictToolNames: true, spawns: "" });
  await manager.ensureOnDisk(); await manager.flush(); const sessionFile = manager.getSessionFile()!; await manager.close();
  registry.register({ id: "context-cold-child", displayName: "cold child", kind: "sub", parentId: "Main", session: null, sessionFile, status: "parked" });
  let firstContext: ReturnType<ReturnType<typeof createNativeResetPassContextFactory>> | undefined;
  let secondContext: ReturnType<ReturnType<typeof createNativeResetPassContextFactory>> | undefined;
  try {
    const first = await lifecycle.ensureLive("context-cold-child"), model = f.modelRegistry.getAll().find(item => item.provider === "openai-codex")!;
    await first.setModelTemporary(model); await f.authStorage.getApiKey("openai-codex", first.sessionId);
    const firstPass = { ...f.pass, passId: "cold-first", nativeSessionId: first.sessionId } as ResetPass;
    firstContext = createNativeResetPassContextFactory({ binding: bindings[0]!, interactions: f.interactions })(firstPass);
    await lifecycle.park("context-cold-child");
    const revived = await lifecycle.ensureLive("context-cold-child"); await revived.setModelTemporary(model); await f.authStorage.getApiKey("openai-codex", revived.sessionId);
    const secondPass = { ...f.pass, passId: "cold-second", nativeSessionId: revived.sessionId } as ResetPass;
    secondContext = createNativeResetPassContextFactory({ binding: bindings[1]!, interactions: f.interactions })(secondPass);
    expect(bindings).toHaveLength(2); expect(bindings[0]!.session).not.toBe(bindings[1]!.session);
    expect(firstContext).not.toBe(secondContext); expect(firstContext.source.kind).toBe("source"); expect(secondContext.source.kind).toBe("source");
  } finally { firstContext?.dispose(); secondContext?.dispose(); await lifecycle.dispose(); await f.cleanup(); }
});


test("the persisted mode must match the exact original native answer", async () => {
  const f = await fixture();
  try {
    await f.context.plan(f.snapshot); await answer(f, "No"); f.settings.set("codexResets.autoRedeem", "yes");
    await expect(f.context.persistence(f.snapshot, "yes")).rejects.toThrow(/original decision/); await f.settings.flush();
  } finally { await f.cleanup(); }
});

test("same-id model endpoint replacement invalidates the captured source", async () => {
  const f = await fixture();
  try {
    (f.session.model as { baseUrl: string }).baseUrl = "https://replacement.invalid";
    expect(() => f.context.assertCurrent()).toThrow(/model or endpoint/);
  } finally { await f.cleanup(); }
});

test("dispose attempts both owned resources and retains independent cleanup failures", async () => {
  let observationDisposed = 0, unsubscribeCalls = 0;
  const f = await fixture(undefined, false, binding => {
    const originalCapture = binding.settings.captureResetPolicySettingsObservation.bind(binding.settings);
    spyOn(binding.settings, "captureResetPolicySettingsObservation").mockImplementation(() => {
      const original = originalCapture(); return { assertCurrent: () => original.assertCurrent(), adoptNativeAutoRedeemSet: mode => original.adoptNativeAutoRedeemSet(mode),
        dispose: () => { observationDisposed++; original.dispose(); throw new Error("controlled observation cleanup"); } };
    });
    spyOn(binding.session, "subscribe").mockImplementation(() => () => { unsubscribeCalls++; throw new Error("controlled unsubscribe cleanup"); });
  });
  try {
    expect(() => f.context.dispose()).toThrow(AggregateError); expect(unsubscribeCalls).toBe(1); expect(observationDisposed).toBe(1);
    expect(() => f.context.dispose()).not.toThrow();
  } finally { await f.session.dispose(); f.settings.disableResetPolicyPersistence(); f.authStorage.close(); }
});

test("capture rollback retains the original failure when observation cleanup also throws", async () => {
  let captured!: Readonly<CodexResetPolicySessionBinding>, disposed = 0;
  await expect(fixture(undefined, false, binding => {
    captured = binding;
    const originalCapture = binding.settings.captureResetPolicySettingsObservation.bind(binding.settings);
    spyOn(binding.settings, "captureResetPolicySettingsObservation").mockImplementation(() => {
      const original = originalCapture(); return { assertCurrent: () => original.assertCurrent(), adoptNativeAutoRedeemSet: mode => original.adoptNativeAutoRedeemSet(mode),
        dispose: () => { disposed++; original.dispose(); throw new Error("controlled rollback cleanup"); } };
    });
    spyOn(binding.settings, "capturePersistedReadback").mockImplementation(() => { throw new Error("controlled capture failure"); });
  })).rejects.toThrow(/capture and observation cleanup/);
  expect(disposed).toBe(1);
  await captured.session.dispose(); captured.settings.disableResetPolicyPersistence(); captured.authStorage.close();
});

test("selection ABA during the awaited credit read rejects admission", async () => {
  const f = await fixture(undefined, true);
  try {
    await f.context.plan(f.snapshot); const pending = f.context.admission(f.snapshot, 0); await f.creditsEntered;
    f.authStorage.setRuntimeApiKey("openai-codex", "controlled-held-runtime"); f.authStorage.removeRuntimeApiKey("openai-codex"); f.releaseCredits();
    await expect(pending).rejects.toThrow(/selection/);
  } finally { await f.cleanup(); }
});

test("model configuration change during the awaited credit read rejects admission", async () => {
  const f = await fixture(undefined, true);
  try {
    await f.context.plan(f.snapshot); const pending = f.context.admission(f.snapshot, 0); await f.creditsEntered;
    (f.session.model as { baseUrl: string }).baseUrl = "https://held-replacement.invalid"; f.releaseCredits();
    await expect(pending).rejects.toThrow(/model or endpoint/);
  } finally { await f.cleanup(); }
});
