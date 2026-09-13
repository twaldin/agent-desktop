// Controlled public-native API fixture. It uses the real native Plan controller,
// rejects every network request, and writes only below its disposable HOME.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parsePlanExternalEditorRequest, type PlanExternalEditorEdit } from "../../../../../packages/shared/src/plan-external-editor";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

let blockedFetches = 0;
globalThis.fetch = Object.assign(async () => {
  blockedFetches++;
  throw new Error("Network is disabled in the native Plan external-editor fixture");
}, { preconnect: () => { throw new Error("Preconnect is disabled in the native Plan external-editor fixture"); } }) as typeof fetch;

const directory = process.argv[2]!;
assert.equal(process.env.HOME, directory);
const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(cwd, { recursive: true })]);
const config = "extensions: []\ndefaultThinkingLevel: low\nmodelRoles:\n  default: [plan-editor-fixture/base]\n  plan: [plan-editor-fixture/planner:high]\n";
const configPath = path.join(agentDir, "config.yml");
await writeFile(configPath, config);
const model = (id: string) => ({ id, name: `Local non-executing ${id}`, reasoning: true, input: ["text"],
  contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "plan-editor-fixture": {
  api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", auth: "none", models: [model("base"), model("planner")],
} } }));

const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
const { resolveLocalUrlToPath } = await import("@oh-my-pi/pi-coding-agent/internal-urls");
const { NativePlanController } = await import("../plan-controller");
const storage = await discoverAuthStorage(agentDir);
const settings = await Settings.loadReadOnly({ agentDir, cwd });
const registry = new ModelRegistry(storage, path.join(agentDir, "models.yml"), { settings });
const manager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
let extension: ExtensionAPI | undefined;
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
let controller: InstanceType<typeof NativePlanController> | undefined;
try {
  const created = await createAgentSession({ agentDir, cwd, settings, authStorage: storage, modelRegistry: registry,
    agentRegistry: new AgentRegistry(), sessionManager: manager, model: registry.find("plan-editor-fixture", "base"),
    extensions: [pi => { extension = pi; }], hasUI: false, interactivePrompts: false, deferUsageReserveConfirmation: true });
  session = created.session;
  assert.ok(session.model); assert.ok(extension);
  await manager.ensureOnDisk();
  controller = new NativePlanController(session, manager, { assertOwner() {}, confirmExit: async () => true });
  await controller.enter();
  const planReference = "local://external-editor-plan.md";
  const planContent = "# External editor Plan\nKeep the original content and extension.\n";
  const tool = session.getToolByName("write"); assert.ok(tool);
  await tool.execute("external-editor-plan-write", { path: planReference, content: planContent });
  const review = await controller.openLatestReview();
  const summary = review.document;
  assert.ok(summary?.sections[0]);
  const selection = { reviewId: review.id, reviewRevision: review.revision,
    documentRevision: summary.documentRevision, renderColumns: summary.renderColumns };
  const section = controller.readReviewDocumentSection({ ...selection, sectionId: summary.sections[0].sectionId });
  assert.ok(section.rows[0]);
  const request = (edit: PlanExternalEditorEdit, owner = selection) => parsePlanExternalEditorRequest({
    requestId: randomUUID(), controlEpoch: randomUUID(), sessionId: session!.sessionId,
    ticket: { epoch: randomUUID(), nativeSessionId: session!.sessionId, revision: "a".repeat(64) },
    reviewId: owner.reviewId, reviewRevision: owner.reviewRevision, documentRevision: owner.documentRevision, edit,
  });

  const planPrepared = await controller.prepareExternalEditor(request({ kind: "plan" }));
  assert.deepEqual(planPrepared, { content: planContent, extension: ".md", trimTrailingNewline: false });
  const note = "Retain this exact annotation.\n";
  const annotationPrepared = await controller.prepareExternalEditor(request({ kind: "annotation", note, renderColumns: summary.renderColumns,
    target: { kind: "line", sectionId: section.sectionId, rowId: section.rows[0].rowId } }));
  assert.deepEqual(annotationPrepared, { content: note, extension: ".md", trimTrailingNewline: true });

  const invalidRow = `${section.rows[0].rowId.slice(0, -1)}${section.rows[0].rowId.endsWith("0") ? "1" : "0"}`;
  await assert.rejects(controller.prepareExternalEditor(request({ kind: "annotation", note: "Must not open", renderColumns: summary.renderColumns,
    target: { kind: "line", sectionId: section.sectionId, rowId: invalidRow } })), /annotation row is no longer/);

  const annotated = await controller.mutateReviewDocument({ reviewId: review.id, reviewRevision: review.revision,
    renderColumns: summary.renderColumns, action: { kind: "annotate", expectedDocumentRevision: summary.documentRevision,
      target: { kind: "section", sectionId: section.sectionId }, note: "Document revision changes without artifact bytes." } });
  assert.equal(annotated.artifactChanged, false);
  assert.notEqual(annotated.review.document?.documentRevision, summary.documentRevision);
  await assert.rejects(controller.prepareExternalEditor(request({ kind: "plan" })), /document changed/);
  const refreshedOwner = { reviewId: annotated.review.id, reviewRevision: annotated.review.revision,
    documentRevision: annotated.review.document!.documentRevision, renderColumns: annotated.review.document!.renderColumns };
  assert.equal((await controller.prepareExternalEditor(request({ kind: "plan" }, refreshedOwner))).content, planContent);

  const absolute = resolveLocalUrlToPath(planReference, { getArtifactsDir: () => manager.getArtifactsDir(),
    getSessionId: () => manager.getSessionId() });
  const externalContent = "# Externally changed Plan\nDo not return stale bytes.\n";
  await writeFile(absolute, externalContent);
  await assert.rejects(controller.prepareExternalEditor(request({ kind: "plan" }, refreshedOwner)), /artifact changed/);
  const reopened = await controller.openLatestReview();
  await assert.rejects(controller.prepareExternalEditor(request({ kind: "plan" }, refreshedOwner)), /review changed/);
  const reopenedOwner = { reviewId: reopened.id, reviewRevision: reopened.revision,
    documentRevision: reopened.document!.documentRevision, renderColumns: reopened.document!.renderColumns };
  const reopenedPrepared = await controller.prepareExternalEditor(request({ kind: "plan" }, reopenedOwner));
  assert.deepEqual(reopenedPrepared, { content: externalContent, extension: ".md", trimTrailingNewline: false });

  assert.equal(blockedFetches, 0);
  assert.equal(await readFile(configPath, "utf8"), config);
  process.stdout.write(JSON.stringify({ blockedFetches, configUnchanged: true, extension: planPrepared.extension,
    originalContent: planPrepared.content === planContent, annotationValidated: true, annotationOnlyRevisionChanged: true,
    staleOwnerRefused: true, externalBytesRefused: true, reopenedContent: reopenedPrepared.content === externalContent }) + "\n");
} finally {
  await controller?.dispose().catch(() => {});
  await session?.dispose().catch(() => {});
  storage.close();
}
