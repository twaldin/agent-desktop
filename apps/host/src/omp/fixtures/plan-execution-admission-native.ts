// Controlled native Plan message-admission fixture. All provider transport is
// intercepted in memory; HOME, config, journal, and workspace are disposable.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

const directory = process.argv[2]!;
assert.equal(process.env.HOME, directory);
const agentDir = path.join(directory, "agent"), cwd = path.join(directory, "project");
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
const consumedEffect = path.join(directory, "plan-consumed.effect"), thrownEffect = path.join(directory, "plan-thrown.effect");
const config = "extensions: []\ndefaultThinkingLevel: low\n";
const configPath = path.join(agentDir, "config.yml"); await writeFile(configPath, config);
await writeFile(path.join(agentDir, "models.yml"), JSON.stringify({ providers: { "plan-admission": {
  api: "openai-completions", baseUrl: "https://plan-admission.invalid/v1", auth: "none", models: [{
    id: "controlled", name: "Controlled Plan admission", reasoning: false, input: ["text"], contextWindow: 128000,
    maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }],
} } }));

let requestCount = 0;
let holdNext = false;
let held: ReturnType<typeof Promise.withResolvers<void>> | undefined;
let reached: ReturnType<typeof Promise.withResolvers<void>> | undefined;
const response = () => new Response(
  `data: ${JSON.stringify({ id: `plan_${requestCount}`, object: "chat.completion.chunk", choices: [{ index: 0,
    delta: { role: "assistant", content: "Controlled Plan response." }, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ id: `plan_${requestCount}`, object: "chat.completion.chunk", choices: [{ index: 0,
    delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
  { headers: { "content-type": "text/event-stream" } });
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const request = new Request(input, init), url = new URL(request.url);
  assert.equal(url.origin, "https://plan-admission.invalid"); assert.equal(request.method, "POST");
  requestCount++;
  if (holdNext) {
    holdNext = false; held = Promise.withResolvers<void>(); reached?.resolve();
    await Promise.race([held.promise, new Promise<never>((_, reject) => request.signal.addEventListener("abort",
      () => reject(new DOMException("Controlled native abort", "AbortError")), { once: true }))]);
  }
  return response();
}, { preconnect: () => { throw new Error("Preconnect is disabled in the Plan admission fixture"); } }) as typeof fetch;

const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
const { writeDeviceDispatch } = await import("@oh-my-pi/pi-coding-agent/tools/resolve");
const { NativePlanController } = await import("../plan-controller");
const { NativePlanExecutionAdmission, NativePlanMessageAdmissionError } = await import("../plan-execution-admission");
const storage = await discoverAuthStorage(agentDir), settings = await Settings.loadReadOnly({ agentDir, cwd });
const registry = new ModelRegistry(storage, path.join(agentDir, "models.yml"), { settings });
const manager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
const created = await createAgentSession({ agentDir, cwd, settings, authStorage: storage, modelRegistry: registry,
  agentRegistry: new AgentRegistry(), sessionManager: manager, model: registry.find("plan-admission", "controlled"),
  extensions: [pi => {
    pi.registerCommand("plan-consumed", { description: "Consume a controlled Plan command without a model message",
      handler: async () => { await writeFile(consumedEffect, "consumed\n"); } });
    pi.registerCommand("plan-effect-throw", { description: "Perform a controlled effect before rejecting Plan admission",
      handler: async () => { await writeFile(thrownEffect, "effect-before-error\n"); throw new Error("controlled Plan command failure after effect"); } });
  }], hasUI: false, interactivePrompts: false, deferUsageReserveConfirmation: true });
await manager.ensureOnDisk();
const admission = new NativePlanExecutionAdmission(created.session, manager);
const messageFor = (entryId: string): AgentMessage => {
  const entry = manager.getBranch().find(entry => entry.id === entryId);
  assert.equal(entry?.type, "message");
  if (!entry || entry.type !== "message") throw new Error("Native Plan admission entry was unavailable.");
  return entry.message;
};
const text = (message: ReturnType<typeof messageFor>) => {
  if (!("content" in message)) throw new Error("Native Plan admission message has no content.");
  return typeof message.content === "string" ? message.content
    : message.content.flatMap(part => "text" in part && typeof part.text === "string" ? [part.text] : []).join("");
};

try {
  const localCommand = admission.start({ attribution: "approval", prompt: "/plan-consumed exact arguments" });
  const localReceipt = await localCommand.accepted; await localCommand.completion;
  assert.equal(await readFile(consumedEffect, "utf8"), "consumed\n");

  const thrownCommand = admission.start({ attribution: "refinement", prompt: "/plan-effect-throw" });
  const [thrownAdmission, thrownCompletion] = await Promise.all([
    thrownCommand.accepted.then(value => ({ status: "fulfilled" as const, value }), error => ({ status: "rejected" as const, error })),
    thrownCommand.completion.then(() => ({ status: "fulfilled" as const }), error => ({ status: "rejected" as const, error })),
  ]);
  assert.equal(await readFile(thrownEffect, "utf8"), "effect-before-error\n");

  const gateOriginalFlush = manager.flush.bind(manager), flushReached = Promise.withResolvers<void>(), releaseFlushGate = Promise.withResolvers<void>();
  let holdFlush = true, current = true;
  manager.flush = async (...args) => {
    if (holdFlush) { holdFlush = false; flushReached.resolve(); await releaseFlushGate.promise; }
    return gateOriginalFlush(...args);
  };
  const stale = admission.start({ attribution: "approval", prompt: "Admission loses its owner during durable flush.",
    assertCurrent: () => { if (!current) throw new Error("controlled Plan owner changed during flush"); } });
  await flushReached.promise; current = false; releaseFlushGate.resolve();
  const staleCompletion = await stale.completion.then(() => ({ status: "fulfilled" as const }), error => ({ status: "rejected" as const, error }));
  const staleAdmission = await Promise.race([
    stale.accepted.then(value => ({ status: "fulfilled" as const, value }), error => ({ status: "rejected" as const, error })),
    Bun.sleep(250).then(() => ({ status: "timeout" as const })),
  ]);
  manager.flush = gateOriginalFlush;

  const approval = admission.start({ attribution: "approval", prompt: "Execute the approved native Plan." });
  const approvalReceipt = await approval.accepted; assert.ok(approvalReceipt); await approval.completion;
  const approvalMessage = messageFor(approvalReceipt.entryId); assert.equal(approvalMessage?.role, "developer");
  assert.equal(approvalMessage && "synthetic" in approvalMessage ? approvalMessage.synthetic : undefined, true);
  assert.equal(approvalMessage && "attribution" in approvalMessage ? approvalMessage.attribution : undefined, "agent");
  assert.equal(text(approvalMessage), "Execute the approved native Plan.");

  const refinement = admission.start({ attribution: "refinement", prompt: "Refine the native Plan with this feedback." });
  const refinementReceipt = await refinement.accepted; assert.ok(refinementReceipt); await refinement.completion;
  const refinementMessage = messageFor(refinementReceipt.entryId); assert.equal(refinementMessage?.role, "user");
  assert.notEqual(refinementMessage && "synthetic" in refinementMessage ? refinementMessage.synthetic : undefined, true);
  assert.equal(refinementMessage && "attribution" in refinementMessage ? refinementMessage.attribution : undefined, "user");
  assert.equal(text(refinementMessage), "Refine the native Plan with this feedback.");

  holdNext = true; reached = Promise.withResolvers<void>();
  const foreground = created.session.prompt("Controlled foreground turn"); await reached.promise;
  const queued = admission.start({ attribution: "approval", prompt: "Queued approved native Plan." });
  let acceptedEarly = false; void queued.accepted.then(() => { acceptedEarly = true; }); await Promise.resolve();
  assert.equal(acceptedEarly, false); held!.resolve(); await foreground;
  const queuedReceipt = await queued.accepted; assert.ok(queuedReceipt); await queued.completion;
  const queuedMessage = messageFor(queuedReceipt.entryId); assert.equal(queuedMessage?.role, "developer");
  assert.equal(queuedMessage && "synthetic" in queuedMessage ? queuedMessage.synthetic : undefined, true);
  assert.equal(text(queuedMessage), "Queued approved native Plan.");

  holdNext = true; reached = Promise.withResolvers<void>();
  const removalForeground = created.session.prompt("Controlled queue-removal foreground turn"); await reached.promise;
  const removed = admission.start({ attribution: "approval", prompt: "Removed approved native Plan." });
  await new Promise(resolve => setTimeout(resolve, 0));
  const followUps = created.session.agent.peekFollowUpQueue();
  const removedMessage = followUps.find(message => message.role === "developer" && "synthetic" in message && message.synthetic === true);
  assert.ok(removedMessage); created.session.agent.replaceQueues([...created.session.agent.peekSteeringQueue()],
    followUps.filter(message => message !== removedMessage));
  held!.resolve(); await removalForeground;
  assert.equal(await removed.accepted, null); await removed.completion;

  const controller = new NativePlanController(created.session, manager, { assertOwner() {}, confirmExit: async () => true });
  await controller.enter();
  const writeTool = created.session.getToolByName("write"); assert.ok(writeTool);
  const write = (url: string, content: string) => writeTool.execute(`plan-admission-${Date.now()}`, { path: url, content });
  await write("local://fast-plan.md", "# Fast Plan\nOriginal review\n");
  const initialProposal = await write("xd://propose", "fast-plan");
  controller.observeEvent({ type: "tool_execution_end", toolCallId: "initial-proposal", toolName: "write", result: initialProposal });
  await controller.settleAfterTurn();
  const initialReview = controller.readReview(); assert.ok(initialReview);
  const refinementPhase = await controller.prepareRefinement({ reviewId: initialReview.id,
    reviewRevision: initialReview.revision, documentRevision: initialReview.document.documentRevision, text: "Produce the revised Plan." });
  assert.equal(refinementPhase.kind, "admission");
  if (refinementPhase.kind !== "admission") throw new Error("Expected a native refinement phase.");
  await controller.claimExecution({ phaseId: refinementPhase.phaseId });
  await write("local://fast-next-plan.md", "# Fast Next Plan\nRevised review\n");
  const fastProposal = await write("xd://propose", "fast-next-plan");
  assert.equal(writeDeviceDispatch("write", fastProposal)?.tool, "propose");

  const originalFlush = manager.flush.bind(manager), flushStarted = Promise.withResolvers<void>(), releaseFlush = Promise.withResolvers<void>();
  let holdAdmissionFlush = true;
  manager.flush = async (...args) => {
    if (holdAdmissionFlush) { holdAdmissionFlush = false; flushStarted.resolve(); await releaseFlush.promise; }
    return originalFlush(...args);
  };
  const originalAbort = created.session.abort.bind(created.session), proposalAbortStarted = Promise.withResolvers<void>();
  const releaseProposalAbort = Promise.withResolvers<void>(); let holdProposalAbort = true;
  created.session.abort = async (...args) => {
    if (holdProposalAbort) { holdProposalAbort = false; proposalAbortStarted.resolve(); await releaseProposalAbort.promise; }
    return originalAbort(...args);
  };
  const admissionEntryListener = manager.onEntryAppended; let triggerFastProposal = true;
  manager.onEntryAppended = entry => {
    admissionEntryListener?.(entry);
    if (triggerFastProposal && entry.type === "message" && entry.message.role === "user") {
      triggerFastProposal = false;
      controller.observeEvent({ type: "tool_execution_end", toolCallId: "fast-proposal", toolName: "write", result: fastProposal });
    }
  };
  holdNext = true; reached = Promise.withResolvers<void>();
  const fastRun = admission.start({ attribution: "refinement", prompt: "Produce the revised Plan." });
  await Promise.all([flushStarted.promise, proposalAbortStarted.promise]);
  releaseFlush.resolve(); const fastReceipt = await fastRun.accepted; assert.ok(fastReceipt);
  let settlementFinished = false;
  const settlement = controller.settleExecutionAdmission({ phaseId: refinementPhase.phaseId, outcome: "entered" })
    .then(value => { settlementFinished = true; return value; });
  await Promise.resolve(); assert.equal(settlementFinished, false, "settlement must join the active proposal operation");
  releaseProposalAbort.resolve();
  const [settled, completion] = await Promise.all([settlement, fastRun.completion.then(() => "fulfilled", () => "rejected")]);
  assert.equal(settled.reconciliationRequired, false); assert.equal(controller.readReview()?.reference, "local://fast-next-plan.md");
  assert.ok(completion === "fulfilled" || completion === "rejected", "native abort completion must settle without a timeout");
  manager.onEntryAppended = admissionEntryListener; manager.flush = originalFlush; created.session.abort = originalAbort;
  await controller.dispose();

  holdNext = true; reached = Promise.withResolvers<void>();
  const interrupted = admission.start({ attribution: "approval", prompt: "Interrupted approved native Plan." });
  const interruptedReceipt = await interrupted.accepted; assert.ok(interruptedReceipt); await reached.promise;
  await interrupted.abort();
  assert.equal(messageFor(interruptedReceipt.entryId)?.role, "developer");

  const local = localReceipt as unknown as { kind?: string; entryId?: string } | null;
  assert.equal(local?.kind, "native-plan-command"); assert.equal(typeof local?.entryId, "string");
  const commandEntry = manager.getEntries().find(entry => entry.id === local!.entryId);
  assert.deepEqual(commandEntry, { id: local!.entryId, parentId: commandEntry?.parentId, timestamp: commandEntry?.timestamp,
    type: "custom", customType: "agent-desktop-plan-local-command", data: { version: 1, attribution: "approval",
      command: "/plan-consumed exact arguments", nativeSessionId: created.session.sessionId } });
  assert.equal(thrownAdmission.status, "rejected");
  if (thrownAdmission.status !== "rejected") throw new Error("A failed local Plan command cannot be retried as an unaccepted input.");
  assert.ok(thrownAdmission.error instanceof NativePlanMessageAdmissionError); assert.equal(thrownCompletion.status, "rejected");
  assert.equal(staleCompletion.status, "rejected"); assert.equal(staleAdmission.status, "rejected");
  if (staleAdmission.status === "rejected") assert.ok(staleAdmission.error instanceof NativePlanMessageAdmissionError);

  await admission.dispose();
  assert.throws(() => admission.start({ attribution: "approval", prompt: "Rejected after disposal" }), /closed/);
  assert.equal(requestCount, 8);
  assert.equal(await readFile(configPath, "utf8"), config);
  console.log(JSON.stringify({ requestCount, approval: approvalMessage?.role, refinement: refinementMessage?.role,
      queued: queuedMessage?.role, removed: "not-entered", fastProposalSerialized: true,
    interrupted: messageFor(interruptedReceipt.entryId)?.role, localCommand: local!.kind, effectFailure: thrownAdmission.status,
    staleFlush: staleAdmission.status,
    configUnchanged: true,
    unknownErrorCode: new NativePlanMessageAdmissionError().code }));
} finally {
  held?.resolve();
  try { await admission.dispose(); } finally { await created.session.dispose(); storage.close(); }
}
