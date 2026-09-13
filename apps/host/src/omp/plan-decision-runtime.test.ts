import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PlanMutation, SessionPlan } from "@agent-desktop/shared";
import type { WorkerSession } from "../omp-workers/runtime";
import { WorkerRuntime } from "../omp-workers/runtime";

const workerPath = fileURLToPath(new URL("../omp-workers/fixtures/plan-decision-worker.ts", import.meta.url));
const command = (session: WorkerSession, state: SessionPlan, mutation: PlanMutation) => ({ sessionId: session.id, ticket: state.ticket,
  reviewId: state.review!.id, reviewRevision: state.review!.revision, mutation });

test("actual worker Plan decisions preserve native artifacts, identities, and one-shot execution phases", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-desktop-plan-decision-runtime-"));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  const config = ["extensions: []", "plan:", "  enabled: true", "  defaultOnStartup: false", "defaultThinkingLevel: low",
    "modelRoles:", "  default: [plan-runtime/controlled]", "  plan: [plan-runtime/controlled:low]", ""].join("\n");
  await writeFile(path.join(agentDir, "config.yml"), config);
  await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "plan-runtime": {
    api: "openai-completions", baseUrl: "https://plan-runtime.invalid/v1", auth: "none", models: [{
      id: "controlled", name: "Controlled native Plan runtime", reasoning: false, input: ["text"], contextWindow: 128000,
      maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } }));
  const runtime = new WorkerRuntime({ agentDir, workerPath, environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb",
    PI_DISABLE_DOTENV: "1", PI_CODING_AGENT_DIR: agentDir }, startupTimeoutMs: 30_000, shutdownTimeoutMs: 10_000 });
  let session: WorkerSession | undefined;
  const enterAndReview = async (owner: WorkerSession, name: string, body: string) => {
    let state = await owner.getPlan();
    if (state.mode !== "active") state = (await owner.controlPlan({ sessionId: owner.id, ticket: state.ticket, action: "toggle" })).state;
    expect(state.mode).toBe("active");
    const run = owner.startPrompt(`[write-plan:${name}] ${body}`);
    expect(await run.accepted).toMatchObject({ kind: "user-message" });
    expect(await run.completion).toBeTrue();
    state = await owner.getPlan();
    expect(state.review).toBeNull();
    state = (await owner.controlPlan({ sessionId: owner.id, ticket: state.ticket, action: "review" })).state;
    expect(state.review).toMatchObject({ status: "ready", reference: `local://${name}` });
    return state;
  };
  try {
    session = await runtime.create({ cwd, model: { provider: "plan-runtime", id: "controlled" } });
    expect(session.sessionFile).toBe(await realpath(session.sessionFile));
    let state = await enterAndReview(session, "keep-plan.md", "Keep the original context.");
    const artifact = path.join(session.sessionFile.slice(0, -".jsonl".length), "local", "keep-plan.md");
    expect(await readFile(artifact, "utf8")).toBe("# Native Plan\nKeep the original context.\n");

    const initialDocument = state.review?.document;
    if (!initialDocument?.sections[0]) throw new Error(`Missing native Plan document summary: ${JSON.stringify(state)}`);
    const initialSelection = { documentRevision: initialDocument.documentRevision, renderColumns: 120,
      sectionId: initialDocument.sections[0].sectionId };
    const initialSection = await session.getPlanDocumentSection({ sessionId: session.id, ticket: state.ticket,
      reviewId: state.review!.id, reviewRevision: state.review!.revision, selection: initialSelection });
    expect(initialSection).toMatchObject({ documentRevision: initialDocument.documentRevision,
      renderColumns: 120, sectionId: initialSelection.sectionId, title: "Native Plan" });
    expect(initialSection.rows.map(row => row.text).join("\n")).toContain("Keep the original context.");

    state = (await session.controlPlan({ sessionId: session.id, ticket: state.ticket, action: "dismiss",
      reviewId: state.review!.id, reviewRevision: state.review!.revision })).state;
    expect(state.review).toMatchObject({ status: "dismissed", document: { documentRevision: initialDocument.documentRevision } });
    state = (await session.controlPlan({ sessionId: session.id, ticket: state.ticket, action: "reopen",
      reviewId: state.review!.id, reviewRevision: state.review!.revision })).state;
    expect(state.review).toMatchObject({ status: "ready", document: { documentRevision: initialDocument.documentRevision } });

    const emptyDocumentRevision = initialDocument.documentRevision;
    const emptyInvitation = await session.preparePlanDecision("empty-document-refine", command(session, state,
      { action: "refine", text: "" }));
    expect(emptyInvitation).toMatchObject({ receipt: { action: "refine", outcome: "applied", artifact: "unchanged",
      transition: "unchanged", execution: "not-requested" } });
    state = await session.getPlan();
    expect(state.review).toBeNull();
    state = (await session.controlPlan({ sessionId: session.id, ticket: state.ticket, action: "review" })).state;
    expect(state.review?.status).toBe("ready");
    expect(state.review?.document?.documentRevision).not.toBe(emptyDocumentRevision);

    const beforeAnnotationRevision = state.review!.document!.documentRevision;
    const annotated = await session.preparePlanDecision("annotate-plan", command(session, state, { action: "document", renderColumns: 120,
      documentAction: { kind: "annotate", expectedDocumentRevision: state.review!.document!.documentRevision,
        target: { kind: "section", sectionId: state.review!.document!.sections[0]!.sectionId }, note: "Keep this section exact." } }));
    expect(annotated.receipt).toMatchObject({ action: "document", outcome: "applied", artifact: "unchanged",
      transition: "unchanged", execution: "not-requested" });
    expect(await readFile(artifact, "utf8")).toBe("# Native Plan\nKeep the original context.\n");
    state = await session.getPlan();
    expect(state.review?.document?.documentRevision).not.toBe(beforeAnnotationRevision);
    expect(state.review?.document?.feedback).toContain("Keep this section exact.");
    expect(state.review?.document?.sections[0]?.annotationCount).toBe(1);
    const annotatedRevision = state.review!.document!.documentRevision;
    state = (await session.controlPlan({ sessionId: session.id, ticket: state.ticket, action: "dismiss",
      reviewId: state.review!.id, reviewRevision: state.review!.revision })).state;
    state = (await session.controlPlan({ sessionId: session.id, ticket: state.ticket, action: "reopen",
      reviewId: state.review!.id, reviewRevision: state.review!.revision })).state;
    expect(state.review?.document).toMatchObject({ documentRevision: annotatedRevision,
      feedback: expect.stringContaining("Keep this section exact.") });
    await expect(session.getPlanDocumentSection({ sessionId: session.id, ticket: state.ticket,
      reviewId: state.review!.id, reviewRevision: state.review!.revision, selection: initialSelection })).rejects.toThrow(/changed/);
    const mismatchedWidth = await session.getPlanDocumentSection({ sessionId: session.id, ticket: state.ticket,
      reviewId: state.review!.id, reviewRevision: state.review!.revision,
      selection: { documentRevision: annotatedRevision, renderColumns: 80,
        sectionId: state.review!.document!.sections[0]!.sectionId } }).catch(error => error);
    expect(mismatchedWidth).toBeInstanceOf(Error);
    expect(String(mismatchedWidth)).toMatch(/section changed/i);

    const beforeDelete = state.review!.content;
    const deleted = await session.preparePlanDecision("delete-plan-section", command(session, state, { action: "document", renderColumns: 120,
      documentAction: { kind: "delete-section", expectedDocumentRevision: state.review!.document!.documentRevision,
        sectionId: state.review!.document!.sections[0]!.sectionId } }));
    expect(deleted.receipt).toMatchObject({ action: "document", outcome: "applied", artifact: "written" });
    expect(await readFile(artifact, "utf8")).toBe("");
    state = await session.getPlan();
    expect(state.review?.document?.feedback).toContain("Remove these sections");

    const restored = await session.preparePlanDecision("undo-plan-delete", command(session, state, { action: "document", renderColumns: 120,
      documentAction: { kind: "undo", expectedDocumentRevision: state.review!.document!.documentRevision } }));
    expect(restored.receipt).toMatchObject({ action: "document", outcome: "applied", artifact: "written" });
    expect(await readFile(artifact, "utf8")).toBe(beforeDelete);
    state = await session.getPlan();
    expect(state.review?.document?.feedback).toContain("Keep this section exact.");
    const unannotated = await session.preparePlanDecision("undo-plan-annotation", command(session, state, { action: "document", renderColumns: 120,
      documentAction: { kind: "undo", expectedDocumentRevision: state.review!.document!.documentRevision } }));
    expect(unannotated.receipt).toMatchObject({ action: "document", outcome: "applied", artifact: "unchanged" });
    expect(await readFile(artifact, "utf8")).toBe(beforeDelete);
    state = await session.getPlan(); expect(state.review?.document?.feedback).toBe("");

    const editedContent = "# Native Plan\nKeep the actual edited artifact.\n";
    const edited = await session.preparePlanDecision("edit-plan", command(session, state, { action: "edit", content: editedContent }));
    expect(edited).toMatchObject({ receipt: { action: "edit", outcome: "applied", artifact: "written",
      transition: "unchanged", execution: "not-requested" } });
    expect(await readFile(artifact, "utf8")).toBe(editedContent);
    state = await session.getPlan();

    const invitation = await session.preparePlanDecision("empty-refine", command(session, state, { action: "refine", text: "" }));
    expect(invitation).toMatchObject({ receipt: { action: "refine", outcome: "applied", transition: "unchanged", execution: "not-requested" } });
    expect(invitation.execution).toBeUndefined();
    const priorDocumentRevision = state.review!.document!.documentRevision;
    state = await session.getPlan(); expect(state.review).toBeNull();
    state = (await session.controlPlan({ sessionId: session.id, ticket: state.ticket, action: "review" })).state;
    expect(state.review?.status).toBe("ready");
    expect(state.review?.document?.documentRevision).not.toBe(priorDocumentRevision);

    const kept = await session.preparePlanDecision("keep-plan", command(session, state, { action: "approve", context: "keep" }));
    if (typeof kept.execution?.phaseId !== "string") throw new Error(`Invalid kept phase fixture value: ${JSON.stringify(kept)}`);
    expect(kept.receipt).toMatchObject({ outcome: "applied", transition: "unchanged", execution: "not-entered" });
    const keepRun = session.startPlanExecution(kept.execution!.phaseId);
    const keepAdmission = await keepRun.accepted; expect(keepAdmission).toMatchObject({ kind: "native-plan-message" });
    await keepRun.completion;
    const keepJournal = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const keepEntry = keepJournal.find(entry => entry.id === keepAdmission!.entryId);
    expect(keepEntry).toMatchObject({ type: "message", message: { role: "developer", synthetic: true, attribution: "agent" } });
    expect(JSON.stringify(keepEntry.message.content)).toContain("Keep the actual edited artifact.");
    const beforeRepeat = keepJournal.filter(entry => entry.id === keepAdmission!.entryId).length;
    const repeated = session.startPlanExecution(kept.execution!.phaseId);
    await expect(repeated.accepted).rejects.toThrow(/already admitted|unavailable/);
    await expect(repeated.completion).rejects.toThrow(/already admitted|unavailable/);
    const afterRepeat = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line))
      .filter(entry => entry.id === keepAdmission!.entryId).length;
    expect(afterRepeat).toBe(beforeRepeat);

    state = await enterAndReview(session, "fresh-plan.md", "Start from a fresh native session.");
    const oldId = session.id, oldFile = session.sessionFile;
    const fresh = await session.preparePlanDecision("fresh-plan", command(session, state, { action: "approve", context: "fresh" }));
    expect(fresh.receipt).toMatchObject({ outcome: "applied", transition: "new-session", execution: "not-entered" });
    expect(typeof fresh.transition?.nativeSessionId).toBe("string"); expect(typeof fresh.transition?.sessionFile).toBe("string");
    expect(typeof fresh.execution?.phaseId).toBe("string");
    expect(fresh.transition!.nativeSessionId).not.toBe(oldId); expect(fresh.transition!.sessionFile).not.toBe(oldFile);
    expect(session.id).toBe(fresh.transition!.nativeSessionId); expect(session.sessionFile).toBe(fresh.transition!.sessionFile);
    expect(fresh.transition!.sessionFile).toBe(await realpath(fresh.transition!.sessionFile));
    const replacement = fresh.transition!;
    await session.dispose(); session = undefined;
    session = await runtime.open({ sessionFile: replacement.sessionFile });
    expect(session.id).toBe(replacement.nativeSessionId);
    expect((await session.getPlan()).ticket.nativeSessionId).toBe(replacement.nativeSessionId);
    const freshJournal = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const freshPhase = freshJournal.find(entry => entry.type === "custom" && entry.customType === "agent-desktop-plan-execution"
      && entry.data?.phaseId === fresh.execution!.phaseId);
    expect(freshPhase).toMatchObject({ data: { state: "pending", nativeSessionId: replacement.nativeSessionId,
      sessionFile: replacement.sessionFile } });
    const freshRun = session.startPlanExecution(fresh.execution!.phaseId);
    expect(await freshRun.accepted).toMatchObject({ kind: "native-plan-message" }); await freshRun.completion;

    state = await enterAndReview(session, "save-plan.md", "Save this artifact without executing it.");
    const destination = path.join(cwd, "SAVED_PLAN.md"), saveOldId = session.id;
    const saved = await session.preparePlanDecision("save-plan", command(session, state, { action: "save", destination }));
    expect(saved.receipt).toMatchObject({ outcome: "applied", artifact: "written", savedDestination: destination,
      transition: "new-session", execution: "not-requested" });
    expect(typeof saved.transition?.nativeSessionId).toBe("string");
    expect(saved.execution).toBeUndefined(); expect(saved.transition!.nativeSessionId).not.toBe(saveOldId);
    expect(await readFile(destination, "utf8")).toBe("# Native Plan\nSave this artifact without executing it.\n");
    expect(await readFile(path.join(agentDir, "config.yml"), "utf8")).toBe(config);
  } finally {
    await session?.dispose().catch(() => {});
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);

async function createBoundaryRuntime(scenario: "compact-failed" | "new-session-cancel", documentReplyScenario?: "second-malformed") {
  const root = await mkdtemp(path.join(tmpdir(), `agent-desktop-plan-${scenario}-`));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), extension = path.join(root, "plan-boundary.mjs");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  await writeFile(extension, `export default function (pi) {
    if (process.env.PLAN_FIXTURE_SCENARIO === "compact-failed") {
      pi.on("session_before_compact", async () => { throw new Error("controlled worker compaction failure before provider transport"); });
    }
    if (process.env.PLAN_FIXTURE_SCENARIO === "new-session-cancel") {
      pi.on("session_before_switch", async event => event.reason === "new" ? { cancel: true } : undefined);
    }
  }\n`);
  await writeFile(path.join(agentDir, "config.yml"), [`extensions:`, `  - ${JSON.stringify(extension)}`, "plan:", "  enabled: true",
    "  defaultOnStartup: false", "defaultThinkingLevel: low", "modelRoles:", "  default: [plan-runtime/controlled]",
    "  plan: [plan-runtime/controlled:low]", ""].join("\n"));
  await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "plan-runtime": {
    api: "openai-completions", baseUrl: "https://plan-runtime.invalid/v1", auth: "none", models: [{
      id: "controlled", name: "Controlled native Plan runtime", reasoning: false, input: ["text"], contextWindow: 128000,
      maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
  } } }));
  const runtime = new WorkerRuntime({ agentDir, workerPath, environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), TERM: "dumb",
    PI_DISABLE_DOTENV: "1", PI_CODING_AGENT_DIR: agentDir, PLAN_FIXTURE_SCENARIO: scenario,
    ...(documentReplyScenario ? { PLAN_DOCUMENT_REPLY_SCENARIO: documentReplyScenario } : {}) },
  startupTimeoutMs: 30_000, shutdownTimeoutMs: 10_000 });
  return { root, cwd, runtime };
}

async function enterAndWriteReview(owner: WorkerSession, name: string, body: string) {
  let state = await owner.getPlan();
  if (state.mode !== "active") state = (await owner.controlPlan({ sessionId: owner.id, ticket: state.ticket, action: "toggle" })).state;
  const run = owner.startPrompt(`[write-plan:${name}] ${body}`);
  expect(await run.accepted).toMatchObject({ kind: "user-message" }); expect(await run.completion).toBeTrue();
  state = await owner.getPlan();
  return (await owner.controlPlan({ sessionId: owner.id, ticket: state.ticket, action: "review" })).state;
}

test("actual worker Plan document reads preserve owner fields, reject malformed replies, and retire with their client", async () => {
  const { root, cwd, runtime } = await createBoundaryRuntime("compact-failed", "second-malformed");
  let session: WorkerSession | undefined;
  try {
    session = await runtime.create({ cwd, model: { provider: "plan-runtime", id: "controlled" } });
    const state = await enterAndWriteReview(session, "document-worker-plan.md", "Inspect this exact worker-owned section.");
    const document = state.review?.document;
    if (!document?.sections[0]) throw new Error(`Missing native Plan document summary: ${JSON.stringify(state)}`);
    const request = { sessionId: session.id, ticket: state.ticket, reviewId: state.review!.id,
      reviewRevision: state.review!.revision, selection: { documentRevision: document.documentRevision,
        renderColumns: document.renderColumns, sectionId: document.sections[0].sectionId } };
    const section = await session.getPlanDocumentSection(request);
    expect(section).toMatchObject({ documentRevision: request.selection.documentRevision,
      renderColumns: request.selection.renderColumns, sectionId: request.selection.sectionId });
    expect(section.rows.map(row => row.text).join("\n")).toContain("Inspect this exact worker-owned section.");
    await expect(session.getPlanDocumentSection(request)).rejects.toThrow(/render columns|section owner/i);
    const retired = session;
    await retired.dispose(); session = undefined;
    await expect(retired.getPlanDocumentSection(request)).rejects.toThrow(/stopp|disposed|closed|worker/i);
  } finally {
    await session?.dispose().catch(() => {}); await runtime.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 90_000);

test("failed Plan document writes retain the immutable owner and expose reconciliation without changing artifact bytes", async () => {
  const { root, cwd, runtime } = await createBoundaryRuntime("compact-failed");
  let session: WorkerSession | undefined;
  try {
    session = await runtime.create({ cwd, model: { provider: "plan-runtime", id: "controlled" } });
    const state = await enterAndWriteReview(session, "document-write-failure-plan.md", "Keep these exact bytes.");
    const document = state.review?.document;
    if (!document?.sections[0]) throw new Error(`Missing native Plan document summary: ${JSON.stringify(state)}`);
    const artifact = path.join(session.sessionFile.slice(0, -".jsonl".length), "local", "document-write-failure-plan.md");
    const before = await readFile(artifact, "utf8");
    await chmod(artifact, 0o444);
    const failed = await session.preparePlanDecision("document-write-failure", command(session, state, { action: "document", renderColumns: 120,
      documentAction: { kind: "delete-section", expectedDocumentRevision: document.documentRevision,
        sectionId: document.sections[0].sectionId } }));
    expect(failed.receipt).toMatchObject({ action: "document", outcome: "unknown", artifact: "unknown",
      transition: "unchanged", execution: "not-requested" });
    expect(await readFile(artifact, "utf8")).toBe(before);
    const after = await session.getPlan();
    expect(after.reconciliationRequired).toBe(true);
    expect(after.review?.document?.documentRevision).toBe(document.documentRevision);
  } finally {
    await session?.dispose().catch(() => {}); await runtime.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 90_000);

test("native Plan document feedback and general text compose into the owned refinement phase", async () => {
  const { root, cwd, runtime } = await createBoundaryRuntime("compact-failed");
  let session: WorkerSession | undefined;
  try {
    session = await runtime.create({ cwd, model: { provider: "plan-runtime", id: "controlled" } });
    let state = await enterAndWriteReview(session, "document-feedback-plan.md", "Preserve the reviewed section.");
    const document = state.review?.document;
    if (!document?.sections[0]) throw new Error(`Missing native Plan document summary: ${JSON.stringify(state)}`);
    await session.preparePlanDecision("document-feedback", command(session, state, { action: "document", renderColumns: 120,
      documentAction: { kind: "annotate", expectedDocumentRevision: document.documentRevision,
        target: { kind: "section", sectionId: document.sections[0].sectionId }, note: "Keep the reviewed section exact." } }));
    state = await session.getPlan();
    const prepared = await session.preparePlanDecision("combined-refinement", command(session, state,
      { action: "refine", text: "Also preserve the runtime boundary." }));
    const phaseId = prepared.execution?.phaseId;
    if (typeof phaseId !== "string") throw new Error(`Missing native refinement phase: ${JSON.stringify(prepared)}`);
    expect(prepared).toMatchObject({ receipt: { action: "refine", outcome: "applied", artifact: "unchanged",
      execution: "not-entered" } });
    const journal = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const phase = journal.find(entry => entry.type === "custom" && entry.customType === "agent-desktop-plan-execution"
      && entry.data?.phaseId === phaseId);
    if (typeof phase?.data?.refinementText !== "string") {
      throw new Error(`Missing durable native refinement phase ${phaseId}: ${JSON.stringify(journal.filter(entry => entry.type === "custom"))}`);
    }
    expect(phase?.data?.refinementText).toContain("Refinement feedback on the plan:");
    expect(phase?.data?.refinementText).toContain("Keep the reviewed section exact.");
    expect(phase?.data?.refinementText).toEndWith("\n\nAlso preserve the runtime boundary.");
    expect((await session.getPlan()).review?.status).toBe("deciding");
  } finally {
    await session?.dispose().catch(() => {}); await runtime.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 90_000);

test("failed native compaction is reported, survives worker reload, and still dispatches the approved Plan", async () => {
  const { root, cwd, runtime } = await createBoundaryRuntime("compact-failed");
  let session: WorkerSession | undefined;
  try {
    session = await runtime.create({ cwd, model: { provider: "plan-runtime", id: "controlled" } });
    const state = await enterAndWriteReview(session, "failed-compact-plan.md", "Execute even though compaction fails.");
    const prepared = await session.preparePlanDecision("compact-failed", command(session, state,
      { action: "approve", context: "compact" }));
    expect(prepared.receipt).toMatchObject({ outcome: "applied", planExit: "completed", execution: "not-entered",
      compaction: { outcome: "failed", message: expect.stringContaining("controlled worker compaction failure before provider transport") } });
    if (typeof prepared.execution?.phaseId !== "string") throw new Error(`Missing compact execution phase: ${JSON.stringify(prepared)}`);
    const phaseId = prepared.execution.phaseId, sessionFile = session.sessionFile;
    await session.dispose(); session = undefined;
    session = await runtime.open({ sessionFile });
    const execution = session.startPlanExecution(phaseId);
    const accepted = await execution.accepted;
    expect(accepted).toMatchObject({ kind: "native-plan-message" }); await execution.completion;
    const journal = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const entry = journal.find(item => item.id === accepted!.entryId);
    expect(JSON.stringify(entry?.message?.content)).toContain("Execute even though compaction fails.");
  } finally {
    await session?.dispose().catch(() => {}); await runtime.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 90_000);

test("cancelled fresh and save decisions report completed Plan exit without creating a replacement", async () => {
  const { root, cwd, runtime } = await createBoundaryRuntime("new-session-cancel");
  let session: WorkerSession | undefined;
  try {
    session = await runtime.create({ cwd, model: { provider: "plan-runtime", id: "controlled" } });
    const originalId = session.id, originalFile = session.sessionFile;
    let state = await enterAndWriteReview(session, "cancelled-fresh-plan.md", "Cancel fresh transition after Plan exits.");
    const fresh = await session.preparePlanDecision("cancel-fresh", command(session, state, { action: "approve", context: "fresh" }));
    expect(fresh.receipt).toMatchObject({ outcome: "cancelled", planExit: "completed", transition: "unchanged", execution: "not-entered" });
    expect(fresh.transition).toBeUndefined(); expect(session.id).toBe(originalId); expect(session.sessionFile).toBe(originalFile);
    expect(await session.getPlan()).toMatchObject({ mode: "off", review: null });

    state = await enterAndWriteReview(session, "cancelled-save-plan.md", "Save before the cancelled transition.");
    const destination = path.join(cwd, "CANCELLED_SAVE_PLAN.md");
    const saved = await session.preparePlanDecision("cancel-save", command(session, state, { action: "save", destination }));
    expect(saved.receipt).toMatchObject({ outcome: "cancelled", planExit: "completed", artifact: "written",
      savedDestination: destination, transition: "unchanged", execution: "not-requested" });
    expect(saved.transition).toBeUndefined(); expect(session.id).toBe(originalId); expect(session.sessionFile).toBe(originalFile);
    expect(await session.getPlan()).toMatchObject({ mode: "off", review: null });
    expect(await readFile(destination, "utf8")).toBe("# Native Plan\nSave before the cancelled transition.\n");
  } finally {
    await session?.dispose().catch(() => {}); await runtime.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 90_000);
