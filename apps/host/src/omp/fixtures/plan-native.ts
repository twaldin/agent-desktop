// Controlled public-native API fixture. No model request is made; all network
// calls are rejected before native imports. HOME and all artifacts are disposable.
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

let blockedFetches = 0;
globalThis.fetch = Object.assign(async () => {
  blockedFetches++;
  throw new Error("Network is disabled in the native plan fixture");
}, { preconnect: () => { throw new Error("Preconnect is disabled in the native plan fixture"); } }) as typeof fetch;

const directory = process.argv[2]!, scenario = process.argv[3]!;
assert.equal(process.env.HOME, directory);
const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
const config = "extensions: []\ndefaultThinkingLevel: low\nmodelRoles:\n  default: [plan-fixture/base]\n  plan: [plan-fixture/planner:high]\n";
const configPath = path.join(agentDir, "config.yml");
await writeFile(configPath, config);
const model = (id: string) => ({ id, name: `Local non-executing ${id}`, reasoning: true, input: ["text"],
  contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "plan-fixture": {
  api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", auth: "none", models: [model("base"), model("planner")],
} } }));
const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
const { resolveLocalUrlToPath } = await import("@oh-my-pi/pi-coding-agent/internal-urls");
const { writeDeviceDispatch } = await import("@oh-my-pi/pi-coding-agent/tools/resolve");
const { parseConfiguredThinkingLevel } = await import("@oh-my-pi/pi-coding-agent/thinking");
const { NativePlanController, NativePlanError, resolveNativePlanInvocation } = await import("../plan-controller");

async function nativeSession(file?: string) {
  const storage = await discoverAuthStorage(agentDir);
  const settings = await Settings.loadReadOnly({ agentDir, cwd });
  const registry = new ModelRegistry(storage, path.join(agentDir, "models.yml"), { settings });
  const manager = file ? await SessionManager.open(file) : SessionManager.create(cwd, path.join(agentDir, "sessions"));
  let extension: ExtensionAPI | undefined;
  try {
    const result = await createAgentSession({ agentDir, cwd, settings, authStorage: storage, modelRegistry: registry,
      agentRegistry: new AgentRegistry(), sessionManager: manager, model: file ? undefined : registry.find("plan-fixture", "base"),
      extensions: [pi => { extension = pi; }], hasUI: false, interactivePrompts: false, deferUsageReserveConfirmation: true });
    await manager.ensureOnDisk();
    const session = result.session;
    assert.ok(session.model, "Fixture's local model must be registered");
    return { session, manager, settings, registry, extension: extension!,
      file: manager.getSessionFile()!, local: (url: string) => resolveLocalUrlToPath(url, {
        getArtifactsDir: () => manager.getArtifactsDir(), getSessionId: () => manager.getSessionId(),
      }), close: async () => { try { await session.dispose(); } finally { storage.close(); } } };
  } catch (error) { await manager.close(); storage.close(); throw error; }
}
const native = await nativeSession();
let live = true, confirm = true, confirmations = 0;
const controller = new NativePlanController(native.session, native.manager, {
  assertOwner: () => { if (!live) throw new Error("Fixture owner retired"); },
  confirmExit: async () => { confirmations++; return confirm; },
});
const command = (text: string) => {
  const invocation = resolveNativePlanInvocation(native.session, text);
  assert.ok(invocation, `Expected owning native command: ${text}`); return invocation;
};
const write = (url: string, content: string) => {
  const tool = native.session.getToolByName("write"); assert.ok(tool);
  return tool.execute("plan-fixture-local-write", { path: url, content });
};
const rows = async (file = native.file) => (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const result: Record<string, unknown> = {};
let closed = false;
try {
  if (scenario === "lifecycle") {
    await native.session.setActiveToolsByName(native.session.getEnabledToolNames().filter(name => name !== "write"));
    const before = { model: native.session.model!.id, thinking: native.session.configuredThinkingLevel(),
      enabled: native.session.getEnabledToolNames(), mounted: native.session.getMountedXdevToolNames() };
    const startBytes = await readFile(native.file, "utf8");
    assert.equal(controller.snapshot().mode, "off"); assert.equal(controller.snapshot().proposalHandlerOwned, false);
    assert.equal(await readFile(native.file, "utf8"), startBytes, "snapshot must not persist anything");
    const entered = await controller.toggle(command("/plan investigate the actual local code"));
    assert.equal(entered.prompt, "investigate the actual local code");
    assert.equal(entered.snapshot.model?.id, "planner"); assert.equal(entered.snapshot.thinking, "high");
    assert.ok(native.session.getEnabledToolNames().includes("write"));
    assert.equal((await rows()).filter(row => row.type === "message").length, 0, "controller must return optional prompt, not dispatch it");
    await write("local://duplicate-plan.md", "# duplicate\nOld plan\n");
    await write("local://newer-plan.md", "# duplicate\nLatest plan\n");
    await utimes(native.local("local://duplicate-plan.md"), 1, 1);
    await utimes(native.local("local://newer-plan.md"), 2, 2);
    const proposal = await write("xd://propose", "newer");
    const dispatch = writeDeviceDispatch("write", proposal);
    assert.equal(dispatch?.tool, "propose");
    assert.deepEqual(dispatch?.inner, { planFilePath: "local://newer-plan.md", title: "newer", planExists: true });
    const review = await controller.prepareLatestReview(command("/plan-review"));
    assert.equal(review.planFilePath, "local://newer-plan.md");
    await assert.rejects(write(path.join(cwd, "forbidden.txt"), "Must stay outside working tree"), /plan mode|read.only/i);
    confirm = false;
    assert.equal((await controller.toggle(command("/plan ignored while active"))).cancelled, true);
    assert.equal(controller.snapshot().mode, "active");
    const removed: string[] = [];
    native.session.setForcedToolChoice("read");
    native.session.toolChoiceQueue.pushOnce("auto", { now: true, label: "plan-mode-decision", onRejected: info => { removed.push(`plan:${info.reason}`); } });
    assert.equal(native.session.toolChoiceQueue.nextToolChoice(), "auto");
    confirm = true;
    const paused = await controller.pause();
    assert.equal(paused.snapshot.mode, "paused"); assert.equal(native.session.peekPlanProposalHandler(), undefined);
    assert.equal(native.session.model!.id, before.model); assert.equal(native.session.configuredThinkingLevel(), before.thinking);
    assert.deepEqual(native.session.getEnabledToolNames(), before.enabled);
    assert.deepEqual(native.session.getMountedXdevToolNames(), before.mounted);
    const queue = native.session.toolChoiceQueue;
    assert.deepEqual(queue.nextToolChoice(), { type: "function", name: "read" }); queue.resolve();
    assert.equal(queue.nextToolChoice(), "none"); queue.resolve(); assert.equal(queue.nextToolChoice(), undefined);
    assert.deepEqual(removed, ["plan:removed"]);
    const reentered = await controller.toggle(command("/plan:continue with feedback"));
    assert.equal(reentered.prompt, "continue with feedback"); assert.equal(native.session.getPlanModeState()?.reentry, true);
    await controller.pause(); await controller.toggle(command("/plan"));
    assert.equal(controller.snapshot().mode, "off");
    result.lifecycle = { entered: entered.snapshot, paused: paused.snapshot, review, proposal: dispatch,
      confirmations, modes: (await rows()).filter(row => row.type === "mode_change").map(row => row.mode) };
  } else if (scenario === "restore") {
    await controller.enter(); await write("local://resumed-plan.md", "# Resumed\nDurable native artifact\n");
    const id = native.session.sessionId, file = native.file;
    await controller.dispose(); await native.close(); closed = true;
    const reopened = await nativeSession(file);
    try {
      reopened.settings.override("modelRoles", { ...reopened.settings.get("modelRoles"), plan: "plan-fixture/base:low" });
      const restored = new NativePlanController(reopened.session, reopened.manager, { assertOwner() {}, confirmExit: async () => true });
      const bytes = await readFile(file, "utf8"), before = restored.snapshot();
      assert.equal(before.restorationRequired, true); assert.equal(before.mode, "off");
      assert.equal(await readFile(file, "utf8"), bytes); assert.equal(reopened.session.peekPlanProposalHandler(), undefined);
      const after = (await restored.restore()).snapshot;
      assert.equal(after.nativeSessionId, id); assert.equal(after.mode, "active");
      assert.equal(after.model?.id, "planner"); assert.equal(after.thinking, "high");
      assert.equal(after.restoration, "journal-model-preserved");
      assert.equal((await restored.prepareLatestReview()).planFilePath, "local://resumed-plan.md");
      await restored.pause(); assert.equal(reopened.session.model?.id, "planner", "historical pre-plan model is not invented on reopen");
      await restored.dispose(); result.restore = { before, after };
    } finally { await reopened.close(); }
    const paused = await nativeSession(file);
    try {
      const restored = new NativePlanController(paused.session, paused.manager, { assertOwner() {}, confirmExit: async () => true });
      assert.equal(restored.snapshot().mode, "paused"); await restored.restore(); await restored.disable();
      assert.equal(restored.snapshot().mode, "off");
      paused.manager.appendModeChange("plan_paused"); await paused.manager.flush();
      paused.settings.override("plan.enabled", false);
      assert.equal(restored.snapshot().mode, "paused", "a read must not clear a disabled stale journal mode");
      await restored.restore(); assert.equal(restored.snapshot().mode, "off"); await restored.dispose();
    } finally { await paused.close(); }
  } else if (scenario === "guards") {
    native.settings.override("plan.enabled", false);
    await assert.rejects(controller.enter(), /disabled/);
    native.settings.override("plan.enabled", true);
    for (const mode of ["goal", "goal_paused", "vibe"] as const) {
      native.manager.appendModeChange(mode); await native.manager.flush();
      await assert.rejects(controller.enter(), /Exit (goal|vibe)/);
    }
    native.manager.appendModeChange("none"); await native.manager.flush();
    native.session.setGoalModeState({ enabled: false, mode: "active", goal: {
      id: "fixture-paused-goal", objective: "Preserve native paused goal", status: "paused", tokensUsed: 0,
      timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
    } });
    await assert.rejects(controller.enter(), /Exit goal/);
    assert.equal(native.session.getGoalModeState()?.goal.id, "fixture-paused-goal");
    native.session.setGoalModeState(undefined);
    native.session.setVibeModeState({ enabled: true });
    await assert.rejects(controller.enter(), /Exit vibe/); assert.equal(native.session.getVibeModeState()?.enabled, true);
    native.session.setVibeModeState(undefined);
    const other = async () => ({ content: [{ type: "text" as const, text: "other lifetime" }] });
    native.session.setPlanProposalHandler(other);
    await assert.rejects(controller.enter(), /Another native lifetime/);
    assert.equal(native.session.peekPlanProposalHandler(), other);
    native.session.setPlanProposalHandler(null);
    const original = command("/plan draft"); let customCalls = 0;
    native.extension.registerCommand("plan", { description: "Actual fixture extension shadows canonical native plan", handler: async () => { customCalls++; } });
    assert.equal(resolveNativePlanInvocation(native.session, "/plan draft"), undefined);
    assert.throws(() => original.assertCurrent(), /no longer owns/);
    await assert.rejects(controller.enter(original), /no longer owns/);
    const alias = command("/plan:alias draft"); await controller.enter(alias);
    assert.equal(customCalls, 0);
    await write("local://guarded-plan.md", "# Guarded\nSafe content\n");
    const external = path.join(directory, "external-plan.md"); await writeFile(external, "Outside owner");
    await symlink(external, native.local("local://escape-plan.md"));
    await assert.rejects(controller.prepareProposal("escape"), /outside its native owner/);
    native.session.setPlanProposalHandler(other); await controller.dispose();
    assert.equal(native.session.peekPlanProposalHandler(), other, "cleanup must retain unrelated handler");
    result.guards = { customCalls, disabled: true, goalAndVibe: true, shadowAndAlias: true, localArtifact: true, unrelatedHandler: true };
  } else if (scenario === "models") {
    native.settings.override("modelRoles", { ...native.settings.get("modelRoles"), plan: "plan-fixture/unavailable" });
    assert.equal(native.session.resolveRoleModelWithThinking("plan").model, undefined);
    const entered = await controller.enter();
    assert.equal(entered.snapshot.model?.id, "base"); assert.match(entered.snapshot.warning!, /no available model/);
    await native.session.setModelTemporary(native.registry.find("plan-fixture", "planner")!, parseConfiguredThinkingLevel("high"));
    await controller.pause();
    assert.equal(native.session.model?.id, "planner", "unresolved plan role does not own later explicit user model changes");
    assert.equal(native.session.configuredThinkingLevel(), "high");
    await controller.disable();
    native.settings.override("modelRoles", { ...native.settings.get("modelRoles"), plan: "plan-fixture/planner:low" });
    let modelResets = 0;
    const original = native.session.setModelTemporary.bind(native.session);
    native.session.setModelTemporary = async (...args) => { modelResets++; return original(...args); };
    await controller.enter(); assert.equal(native.session.configuredThinkingLevel(), "low");
    await controller.pause(); assert.equal(native.session.configuredThinkingLevel(), "high");
    assert.equal(modelResets, 0, "same-model thinking transitions must not reset a provider session");
    result.models = { unavailableWarning: entered.snapshot.warning, explicitSelectionPreserved: true, sameModelResets: modelResets };
  } else if (scenario === "owner" || scenario === "handler") {
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const original = native.session.setActiveToolsByName.bind(native.session);
    native.session.setActiveToolsByName = async (...args) => { await original(...args); reached(); await held; };
    const before = await readFile(native.file, "utf8");
    const pending = controller.enter().then(() => { throw new Error("Owner loss must reject"); }, error => error);
    await entered;
    const other = async () => ({ content: [{ type: "text" as const, text: "replacement lifetime" }] });
    if (scenario === "owner") live = false;
    else native.session.setPlanProposalHandler(other);
    release();
    const error = await pending;
    assert.ok(error instanceof NativePlanError); assert.equal(error.outcome, "unknown");
    assert.equal(native.session.peekPlanProposalHandler(), scenario === "owner" ? undefined : other);
    assert.equal(native.session.model?.id, "base");
    assert.equal(await readFile(native.file, "utf8"), before);
    assert.equal(native.session.getPlanModeState()?.enabled, true, "do not roll back mutations across a retired owner");
    result[scenario] = { outcome: error.outcome, model: native.session.model?.id, journalUnchanged: true, stateNeedsReconciliation: true };
  } else throw new Error(`Unknown scenario ${scenario}`);
  assert.equal(blockedFetches, 0);
  assert.equal(await readFile(configPath, "utf8"), config);
  process.stdout.write(JSON.stringify({ scenario, ...result, blockedFetches, configUnchanged: true }) + "\n");
} finally { await controller.dispose(); if (!closed) await native.close(); }
