// Controlled public-native Plan review/decision fixture. No provider request;
// HOME, journal, workspace, and artifacts are disposable.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

let blockedFetches = 0;
let compactionHookCalls = 0;
globalThis.fetch = Object.assign(async () => {
  blockedFetches++; throw new Error("Network is disabled in the native Plan review fixture");
}, { preconnect: () => { throw new Error("Preconnect is disabled in the native Plan review fixture"); } }) as typeof fetch;

const directory = process.argv[2]!, scenario = process.argv[3]!;
assert.equal(process.env.HOME, directory);
const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
const config = "extensions: []\ndefaultThinkingLevel: low\nmodelRoles:\n  default: [plan-fixture/base]\n  plan: [plan-fixture/planner:high]\n  slow: [plan-fixture/planner:medium]\n";
const configPath = path.join(agentDir, "config.yml"); await writeFile(configPath, config);
const model = (id: string) => ({ id, name: `Local non-executing ${id}`, reasoning: true, input: ["text"],
  contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "plan-fixture": {
  api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", auth: "none", models: [model("base"), model("planner")],
} } }));
const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
const { resolveLocalUrlToPath } = await import("@oh-my-pi/pi-coding-agent/internal-urls");
const { writeDeviceDispatch } = await import("@oh-my-pi/pi-coding-agent/tools/resolve");
const { NativePlanController, NativePlanError } = await import("../plan-controller");

async function nativeSession() {
  const storage = await discoverAuthStorage(agentDir), settings = await Settings.loadReadOnly({ agentDir, cwd });
  const registry = new ModelRegistry(storage, path.join(agentDir, "models.yml"), { settings });
  const manager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
  let extension!: ExtensionAPI;
  const result = await createAgentSession({ agentDir, cwd, settings, authStorage: storage, modelRegistry: registry,
    agentRegistry: new AgentRegistry(), sessionManager: manager, model: registry.find("plan-fixture", "base"),
    extensions: [pi => {
      extension = pi;
      if (scenario === "compact-cancel") pi.on("session_before_compact", async () => { compactionHookCalls++; return { cancel: true }; });
      if (scenario === "compact-ok") pi.on("session_before_compact", async event => { compactionHookCalls++; return { compaction: {
        summary: "Controlled native compaction summary", firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      } }; });
      if (scenario === "new-session-cancel") pi.on("session_before_switch", async event => event.reason === "new" ? { cancel: true } : undefined);
    }], hasUI: false, interactivePrompts: false, deferUsageReserveConfirmation: true });
  await manager.ensureOnDisk();
  return { session: result.session, manager, settings, registry, extension, storage,
    local: (url: string) => resolveLocalUrlToPath(url, { getArtifactsDir: () => manager.getArtifactsDir(), getSessionId: () => manager.getSessionId() }),
    close: async () => { try { await result.session.dispose(); } finally { storage.close(); } } };
}
const native = await nativeSession();
let changes = 0;
let controller = new NativePlanController(native.session, native.manager, { assertOwner() {}, confirmExit: async () => true,
  onChanged: () => { changes++; } });
const write = (url: string, content: string) => {
  const tool = native.session.getToolByName("write"); assert.ok(tool); return tool.execute(`plan-review-${Date.now()}`, { path: url, content });
};
const propose = async (url: string, content: string, title: string) => {
  await write(url, content);
  const proposal = await write("xd://propose", title);
  const dispatch = writeDeviceDispatch("write", proposal); assert.equal(dispatch?.tool, "propose");
  controller.observeEvent({ type: "tool_execution_end", toolCallId: `proposal-${Date.now()}`, toolName: "write", result: proposal });
  await controller.settleAfterTurn();
  const review = controller.readReview(); assert.ok(review); return review;
};
const result: Record<string, unknown> = {};
try {
  if (scenario === "review") {
    await controller.enter();
    const first = await propose("local://review-plan.md", "# Review\nFirst body\n", "review");
    assert.equal(first.status, "open");
    const edited = await controller.editReview({ reviewId: first.id, reviewRevision: first.revision,
      documentRevision: first.document.documentRevision, content: "# Review\nEdited body\n" });
    assert.notEqual(edited.revision, first.revision);
    await assert.rejects(controller.editReview({ reviewId: first.id, reviewRevision: first.revision,
      documentRevision: first.document.documentRevision, content: "stale" }), NativePlanError);
    const reviewPath = native.local("local://review-plan.md");
    const externalContent = "# Review\nExternal owner bytes\n";
    await writeFile(reviewPath, externalContent);
    await assert.rejects(controller.editReview({ reviewId: edited.id, reviewRevision: edited.revision,
      documentRevision: edited.document.documentRevision, content: "stale external overwrite" }),
      (error: unknown) => error instanceof NativePlanError && error.outcome === "rejected" && /changed/.test(error.message));
    assert.equal(await readFile(reviewPath, "utf8"), externalContent, "a stale edit must preserve externally changed bytes");
    assert.equal(controller.snapshot().reconciliationRequired, false, "a definite stale-artifact refusal must not poison reconciliation");
    const reopenedExternal = await controller.openLatestReview();
    assert.equal(reopenedExternal.content, externalContent);
    const recovered = await controller.editReview({ reviewId: reopenedExternal.id, reviewRevision: reopenedExternal.revision,
      documentRevision: reopenedExternal.document.documentRevision,
      content: "# Review\nFresh edit after reopen\n" });
    assert.equal(await readFile(reviewPath, "utf8"), recovered.content);
    assert.equal(controller.dismissReview({ reviewId: recovered.id, reviewRevision: recovered.revision }).review?.status, "dismissed");
    assert.equal(controller.reopenReview({ reviewId: recovered.id, reviewRevision: recovered.revision }).status, "open");
    const invite = await controller.prepareRefinement({ reviewId: recovered.id, reviewRevision: recovered.revision,
      documentRevision: recovered.document.documentRevision, text: "  " });
    assert.equal(invite.kind, "invite"); assert.equal(controller.readReview(), undefined);
    const refined = await propose("local://review-plan.md", "# Review\nEdited body\n", "review");
    const retryRefine = await controller.prepareRefinement({ reviewId: refined.id, reviewRevision: refined.revision,
      documentRevision: refined.document.documentRevision, text: "Keep the exact API" });
    assert.equal(retryRefine.kind, "admission"); if (retryRefine.kind !== "admission") throw new Error("expected refinement phase");
    assert.equal((await controller.prepareExecution({ phaseId: retryRefine.phaseId })).prompt, "Keep the exact API");
    await controller.claimExecution({ phaseId: retryRefine.phaseId });
    assert.equal((await controller.settleExecutionAdmission({ phaseId: retryRefine.phaseId, outcome: "not-entered" })).review?.status, "open");
    const admittedRefine = await controller.prepareRefinement({ reviewId: refined.id, reviewRevision: refined.revision,
      documentRevision: refined.document.documentRevision, text: "Admitted feedback" });
    assert.equal(admittedRefine.kind, "admission"); if (admittedRefine.kind !== "admission") throw new Error("expected refinement phase");
    await controller.claimExecution({ phaseId: admittedRefine.phaseId });
    assert.equal((await controller.settleExecutionAdmission({ phaseId: admittedRefine.phaseId, outcome: "entered" })).review, undefined);

    const relative = "legacy-relative-plan.md"; await writeFile(path.join(cwd, relative), "# Legacy relative\nNative journal path\n");
    native.session.setPlanModeState({ ...native.session.getPlanModeState()!, planFilePath: relative });
    const relativeProposal = await write("xd://propose", "legacy-relative");
    controller.observeEvent({ type: "tool_execution_end", toolCallId: "relative", toolName: "write", result: relativeProposal });
    await controller.settleAfterTurn();
    assert.equal(controller.readReview()?.reference, relative);
    const absolute = path.join(cwd, "legacy-absolute-plan.md"); await writeFile(absolute, "# Legacy absolute\nNative journal path\n");
    native.session.setPlanModeState({ ...native.session.getPlanModeState()!, planFilePath: absolute });
    const absoluteResult = await native.session.preparePlanForReview("legacy-absolute");
    assert.equal(absoluteResult.details?.planFilePath, absolute);
    const current = controller.readReview()!;
    const unknownRefine = await controller.prepareRefinement({ reviewId: current.id, reviewRevision: current.revision,
      documentRevision: current.document.documentRevision, text: "Unknown admission" });
    assert.equal(unknownRefine.kind, "admission"); if (unknownRefine.kind !== "admission") throw new Error("expected refinement phase");
    await controller.claimExecution({ phaseId: unknownRefine.phaseId });
    await controller.dispose();
    controller = new NativePlanController(native.session, native.manager, { assertOwner() {}, confirmExit: async () => true });
    await assert.rejects(controller.prepareExecution({ phaseId: unknownRefine.phaseId }),
      (error: unknown) => error instanceof NativePlanError && error.outcome === "unknown");
    const unknown = controller.snapshot();
    assert.equal(unknown.reconciliationRequired, true); assert.equal(unknown.canToggle, false);
    result.review = { firstRevision: first.revision, editedRevision: edited.revision, externalBytesPreserved: true,
      recoveredRevision: recovered.revision, legacyRelative: relative,
      legacyAbsolute: absoluteResult.details?.planFilePath, unknownRetained: unknown.reconciliationRequired, changes };
  } else if (scenario === "keep-fresh-save") {
    await controller.enter(); const keepReview = await propose("local://keep-plan.md", "# Keep\nExecute safely\n", "keep");
    await writeFile(native.local("local://keep-plan.md"), "# Keep\nChanged before approval\n");
    await assert.rejects(controller.decide({ reviewId: keepReview.id, reviewRevision: keepReview.revision,
      documentRevision: keepReview.document.documentRevision, action: "keep" }), /changed/);
    assert.equal(native.session.getPlanModeState()?.enabled, true, "stale review must fail before Plan exit");
    await writeFile(native.local("local://keep-plan.md"), "# Keep\nExecute safely\n");
    const keep = await controller.decide({ reviewId: keepReview.id, reviewRevision: keepReview.revision,
      documentRevision: keepReview.document.documentRevision, action: "keep", executionRole: "default" });
    assert.equal(keep.kind, "execution"); if (keep.kind !== "execution") throw new Error("expected execution");
    await writeFile(native.local("local://keep-plan.md"), "# Keep\nChanged after approval\n");
    await assert.rejects(controller.prepareExecution({ phaseId: keep.phase.phaseId }), /changed after review/);
    await writeFile(native.local("local://keep-plan.md"), "# Keep\nExecute safely\n");
    assert.match((await controller.prepareExecution({ phaseId: keep.phase.phaseId })).prompt, /Execute safely/);
    assert.equal(native.session.getPlanModeState(), undefined);
    await controller.claimExecution({ phaseId: keep.phase.phaseId });
    await controller.settleExecutionAdmission({ phaseId: keep.phase.phaseId, outcome: "not-entered" });
    await controller.claimExecution({ phaseId: keep.phase.phaseId });
    await controller.settleExecutionAdmission({ phaseId: keep.phase.phaseId, outcome: "entered" });

    await controller.enter(); const freshReview = await propose("local://fresh-plan.md", "# Fresh\nNew identity\n", "fresh");
    const fresh = await controller.decide({ reviewId: freshReview.id, reviewRevision: freshReview.revision,
      documentRevision: freshReview.document.documentRevision, action: "fresh", executionRole: "default" });
    assert.equal(fresh.kind, "fresh"); if (fresh.kind !== "fresh") throw new Error("expected fresh");
    assert.notEqual(fresh.receipt.oldIdentity.nativeSessionId, fresh.receipt.newIdentity.nativeSessionId);
    await controller.dispose();
    controller = new NativePlanController(native.session, native.manager, { assertOwner() {}, confirmExit: async () => true });
    const phaseB = await controller.prepareExecution({ phaseId: fresh.receipt.phaseId });
    assert.match(phaseB.prompt, /New identity/); await controller.claimExecution({ phaseId: phaseB.phaseId });
    await controller.settleExecutionAdmission({ phaseId: phaseB.phaseId, outcome: "entered" });

    await controller.enter(); const saveReview = await propose("local://save-plan.md", "# Save\nPersist me\n", "save");
    const destination = path.join(cwd, "saved-plan.md");
    const saved = await controller.saveAndStartNew({ reviewId: saveReview.id, reviewRevision: saveReview.revision,
      documentRevision: saveReview.document.documentRevision, destination });
    assert.equal(saved.transition, "new-session"); assert.equal(await Bun.file(destination).text(), "# Save\nPersist me\n");
    result.decisions = { keep: keep.kind, fresh: fresh.kind, phaseB: phaseB.branch, save: saved.transition,
      freshIdentityChanged: fresh.receipt.oldIdentity.nativeSessionId !== fresh.receipt.newIdentity.nativeSessionId };
  } else if (scenario === "compact-cancel" || scenario === "compact-failed" || scenario === "compact-ok") {
    await controller.enter();
    const review = await propose("local://compact-plan.md", "# Compact\nRetain queued intent\n", "compact");
    // A real native compaction needs a branch to prepare before the controlled
    // extension supplies cancellation/failure without any provider request.
    for (let index = 0; index < 12; index++) {
      native.manager.appendMessage({ role: "user", content: `Planning context ${index} ` + "detail ".repeat(2000), timestamp: Date.now() });
      native.manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `Plan reasoning ${index} ` + "detail ".repeat(2000) }],
        api: "openai-completions", provider: "plan-fixture", model: "planner", usage: { input: 2000, output: 2000,
          cacheRead: 0, cacheWrite: 0, totalTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now() });
    }
    let compactError = "";
    const originalCompact = native.session.compact.bind(native.session);
    native.session.compact = async (...args) => { try {
      if (scenario === "compact-failed") { compactionHookCalls++; throw new Error("controlled compaction failure before provider transport"); }
      return await originalCompact(...args); }
      catch (error) { compactError = `${error instanceof Error ? error.name : typeof error}:${error instanceof Error ? error.message : String(error)}`; throw error; } };
    const decision = await controller.decide({ reviewId: review.id, reviewRevision: review.revision,
      documentRevision: review.document.documentRevision, action: "compact" });
    if (scenario === "compact-cancel") {
      assert.equal(decision.kind, "cancelled");
      assert.equal(decision.snapshot?.mode, "off", "cancelled compaction still exits native Plan mode");
      assert.equal(decision.snapshot?.review, undefined, "cancelled compaction must not advertise the closed review");
      assert.equal(native.session.model?.id, "base", "cancelled compaction restores the pre-Plan execution model");
    } else {
      assert.equal(decision.kind, "execution");
      if (decision.kind !== "execution") throw new Error("expected compact execution phase");
      assert.equal(decision.phase.compactOutcome, scenario === "compact-ok" ? "ok" : "failed");
      if (scenario === "compact-failed") {
        assert.match(decision.phase.compactMessage ?? "", /controlled compaction failure before provider transport/);
        assert.equal(native.session.model?.id, "planner", "failed compaction keeps the native Plan model for best-effort dispatch");
        const phaseId = decision.phase.phaseId;
        await controller.dispose();
        controller = new NativePlanController(native.session, native.manager, { assertOwner() {}, confirmExit: async () => true });
        const restored = await controller.prepareExecution({ phaseId });
        assert.equal(restored.compactOutcome, "failed");
        assert.equal(restored.compactMessage, decision.phase.compactMessage);
        assert.match(restored.prompt, /Retain queued intent/);
      }
    }
    assert.equal(compactionHookCalls, 1, `native compact path must reach its controlled boundary (${compactError})`);
    result.compact = { scenario, kind: decision.kind,
      outcome: decision.kind === "execution" ? decision.phase.compactOutcome : decision.compactOutcome,
      message: decision.kind === "execution" ? decision.phase.compactMessage : decision.compactMessage,
      mode: decision.snapshot?.mode, review: decision.snapshot?.review ?? null, modelId: native.session.model?.id,
      restoredFailure: scenario === "compact-failed" };
  } else if (scenario === "new-session-cancel") {
    await controller.enter(); const freshReview = await propose("local://cancel-fresh-plan.md", "# Cancel fresh\n", "cancel-fresh");
    const fresh = await controller.decide({ reviewId: freshReview.id, reviewRevision: freshReview.revision,
      documentRevision: freshReview.document.documentRevision, action: "fresh" });
    assert.equal(fresh.kind, "cancelled"); assert.equal(native.session.getPlanModeState(), undefined);
    assert.equal(fresh.snapshot?.mode, "off"); assert.equal(fresh.snapshot?.review, undefined);
    await controller.enter(); const saveReview = await propose("local://cancel-save-plan.md", "# Cancel save\n", "cancel-save");
    const destination = path.join(cwd, "cancelled-transition-plan.md");
    const save = await controller.saveAndStartNew({ reviewId: saveReview.id, reviewRevision: saveReview.revision,
      documentRevision: saveReview.document.documentRevision, destination });
    assert.equal(save.transition, "cancelled"); assert.equal(await Bun.file(destination).text(), "# Cancel save\n");
    assert.equal(save.snapshot?.mode, "off"); assert.equal(save.snapshot?.review, undefined);
    result.cancel = { fresh: fresh.kind, freshMode: fresh.snapshot?.mode, freshReview: fresh.snapshot?.review ?? null,
      save: save.transition, saveMode: save.snapshot?.mode, saveReview: save.snapshot?.review ?? null,
      sameIdentity: native.session.sessionId === save.oldIdentity.nativeSessionId };
  } else if (scenario === "save-write-failed") {
    await controller.enter(); const review = await propose("local://write-failure-plan.md", "# Write failure\n", "write-failure");
    const save = await controller.saveAndStartNew({ reviewId: review.id, reviewRevision: review.revision,
      documentRevision: review.document.documentRevision,
      destination: path.join(cwd, "missing-parent", "plan.md") });
    assert.equal(save.transition, "unknown"); assert.match(save.message!, /ENOENT/);
    assert.equal(controller.snapshot().reconciliationRequired, true); assert.equal(controller.snapshot().canToggle, false);
    result.saveFailure = { transition: save.transition, reconciliationRequired: controller.snapshot().reconciliationRequired };
  } else throw new Error(`Unknown scenario ${scenario}`);
  assert.equal(blockedFetches, 0);
  assert.equal(await readFile(configPath, "utf8"), config);
  result.blockedFetches = blockedFetches; result.configUnchanged = true;
  console.log(JSON.stringify(result));
} finally { await native.close(); }
