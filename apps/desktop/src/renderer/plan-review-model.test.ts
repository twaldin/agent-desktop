import { expect, test } from "bun:test";
import { parsePlanMutationRequest, type PlanDecisionReceipt, type PlanMutationRequest } from "../../../../packages/shared/src/session-plan";
import { PlanReviewNotSubmitted, PlanReviewModel, type PlanReviewInput, type PlanReviewPorts } from "./plan-review-model";

const digest = (letter: string) => letter.repeat(64);
function input(): PlanReviewInput {
  const executionChoices = [{ role: "balanced", provider: "fixture", modelId: "balanced", selected: true },
    { role: "careful", provider: "fixture", modelId: "careful", default: true }];
  return { owner: { hostId: "home", sessionId: "desktop" }, connected: true, fresh: true, open: true, executionChoices,
    plan: { ticket: { epoch: "epoch", nativeSessionId: "native", revision: digest("a") }, mode: "active", enabled: true, canToggle: true,
      executionChoices, defaultExecutionRole: "careful", review: { id: "review", revision: digest("b"), title: "Plan", reference: "local://plan.md",
        content: "# Original\n", status: "ready", canKeepContext: true } } };
}
function receipt(request: PlanMutationRequest, values: Partial<PlanDecisionReceipt> = {}): PlanDecisionReceipt {
  return { commandId: "command", reviewId: request.reviewId, reviewRevision: request.reviewRevision, action: request.mutation.action,
    outcome: "applied", artifact: request.mutation.action === "edit" ? "written" : "unchanged", transition: "unchanged",
    execution: request.mutation.action === "approve" || request.mutation.action === "refine" ? "entered" : "not-requested", ...values };
}
function fixture() {
  let current = input(); const calls: PlanMutationRequest[] = [], refreshes: unknown[] = [];
  let answer!: (value: PlanDecisionReceipt) => void, reject!: (cause: Error) => void;
  const ports: PlanReviewPorts = { mutate: async (_owner, request) => {
    calls.push(parsePlanMutationRequest(request)); return new Promise((resolve, fail) => { answer = resolve; reject = fail; });
  }, dismiss: async () => {}, reopen: async () => {}, refresh: async (owner, original) => { refreshes.push({ owner, original }); } };
  const model = new PlanReviewModel(current, ports);
  return { model, ports, calls, refreshes, answer: (values: Partial<PlanDecisionReceipt> = {}) => answer(receipt(calls.at(-1)!, values)),
    reject: () => reject(new Error("Response lost")), get input() { return current; },
    configure(next: PlanReviewInput) { current = next; model.configure(current, ports); } };
}

test("decision captures original ticket/review and actual native default while a later owner remains untouched", async () => {
  const f = fixture(), pending = f.model.mutate("approve", "compact");
  expect(f.calls[0]).toEqual({ sessionId: "desktop", ticket: f.input.plan.ticket, reviewId: "review", reviewRevision: digest("b"),
    mutation: { action: "approve", context: "compact", executionRole: "careful" } });
  const next = input(); next.owner = { hostId: "work", sessionId: "other" };
  f.configure(next); f.model.setFeedback("Keep this owner's feedback"); f.answer(); await pending;
  expect(f.model.getSnapshot().draft?.feedback).toBe("Keep this owner's feedback");
  expect(f.model.getSnapshot().draft?.receipt).toBeUndefined();
});

test("acknowledged edit adopts only confirmed content/revision and preserves edits made while saving", async () => {
  const f = fixture(); f.model.setText("# Saved\n"); const pending = f.model.mutate("edit");
  f.model.setText("# Newer local edit\n"); f.answer(); await pending;
  expect(f.model.getSnapshot().blockedReason).toContain("Refresh");
  f.configure({ ...f.input, plan: { ...f.input.plan, review: { ...f.input.plan.review!, revision: digest("c"), content: "# Saved\n" } } });
  expect(f.model.getSnapshot().draft?.text).toBe("# Newer local edit\n");
  expect(f.model.getSnapshot().draft?.base.revision).toBe(digest("c")); expect(f.model.getSnapshot().dirty).toBe(true);
  await f.model.mutate("approve", "fresh"); expect(f.calls).toHaveLength(1);
});

test("ambiguous loss offers original-command read reconciliation and never retries the mutation", async () => {
  const f = fixture(), pending = f.model.mutate("approve", "keep"); f.reject(); await pending;
  expect(f.model.getSnapshot().draft?.uncertain).toBe(true);
  await f.model.mutate("approve", "keep"); expect(f.calls).toHaveLength(1);
  await f.model.auxiliary("refresh");
  expect(f.refreshes).toEqual([{ owner: f.input.owner, original: { request: f.calls[0], receipt: undefined } }]);
  expect(f.model.getSnapshot().draft?.uncertain).toBe(true);
  f.configure({ ...f.input, receipt: receipt(f.calls[0]!, { outcome: "cancelled", execution: "not-entered" }) });
  expect(f.model.getSnapshot().draft?.uncertain).toBe(false);
});

test("external revision conflict retains local text and needs explicit discard; offline edits never dispatch", async () => {
  const f = fixture(); f.model.setText("local draft"); f.model.setFeedback("retained feedback");
  f.configure({ ...f.input, plan: { ...f.input.plan, review: { ...f.input.plan.review!, revision: digest("c"), content: "host edit" } } });
  expect(f.model.getSnapshot().conflict).toBe(true); expect(f.model.getSnapshot().draft?.text).toBe("local draft");
  await f.model.mutate("edit"); expect(f.calls).toHaveLength(0);
  f.model.discardEdits(); expect(f.model.getSnapshot().draft?.text).toBe("host edit"); expect(f.model.getSnapshot().draft?.feedback).toBe("retained feedback");
  f.configure({ ...f.input, connected: false }); f.model.setText("offline draft"); await f.model.mutate("edit");
  expect(f.calls).toHaveLength(0); expect(f.model.getSnapshot().draft?.text).toBe("offline draft");
});

test("singleton cannot impose a model override and unavailable explicit choices require correction", async () => {
  const f = fixture(); f.configure({ ...f.input, executionChoices: [f.input.executionChoices[1]!] });
  const pending = f.model.mutate("approve", "fresh"); expect(f.calls[0]?.mutation).toEqual({ action: "approve", context: "fresh" });
  f.answer({ outcome: "cancelled", execution: "not-entered" }); await pending;
  f.model.setRole("removed"); await f.model.mutate("approve", "fresh"); expect(f.calls).toHaveLength(1);
  expect(f.model.getSnapshot().draft?.error).toContain("no longer available");
});

test("empty native refinement sends no invented feedback; later feedback edits survive admission", async () => {
  const f = fixture(); const first = f.model.mutate("refine");
  expect(f.calls[0]?.mutation).toEqual({ action: "refine", text: "" });
  f.answer({ execution: "not-requested" }); await first;
  f.model.setFeedback("Original feedback"); const second = f.model.mutate("refine"); f.model.setFeedback("New feedback while waiting");
  f.answer({ commandId: "second" }); await second;
  expect(f.model.getSnapshot().draft?.feedback).toBe("New feedback while waiting");
});

test("native partial reconciliation remains read-only even before a review exists", async () => {
  const f = fixture(); f.configure({ ...f.input, plan: { ...f.input.plan, review: null, reconciliationRequired: true, warning: "Partial native mode transition" } });
  await f.model.auxiliary("refresh"); expect(f.refreshes).toHaveLength(1); expect(f.calls).toHaveLength(0);
  expect(f.model.getSnapshot().blockedReason).toContain("reconciliation");
});


test("a proven local pre-dispatch refusal preserves edits and remains retryable without inventing a receipt", async () => {
  const f = fixture(); let refused = true;
  f.model.configure(f.input, { ...f.ports, mutate: async (owner, request) => {
    if (refused) throw new PlanReviewNotSubmitted("Recovery record could not be saved");
    return f.ports.mutate(owner, request);
  } });
  f.model.setText("Keep these edits"); await f.model.mutate("edit");
  expect(f.calls).toHaveLength(0); expect(f.model.getSnapshot().draft?.uncertain).toBe(false);
  expect(f.model.getSnapshot().draft?.text).toBe("Keep these edits"); expect(f.model.getSnapshot().draft?.receipt).toBeUndefined();
  refused = false; const pending = f.model.mutate("edit"); expect(f.calls).toHaveLength(1); f.answer(); await pending;
});


test("only exact original failure evidence releases an uncertain edited draft; stale evidence cannot release its next attempt", async () => {
  const f = fixture(); f.model.setText("Local plan edit");
  const pending = f.model.mutate("edit"), original = f.calls[0]!; f.reject(); await pending;
  const failure = { owner: f.input.owner, commandId: "refused-command", request: original, message: "Host refused before effects" };
  f.configure({ ...f.input, failure: { ...failure, request: { ...original, mutation: { action: "edit", content: "Different edit" } } } });
  expect(f.model.getSnapshot().draft?.uncertain).toBe(true);
  f.configure({ ...f.input, failure: { ...failure, owner: { ...failure.owner, hostId: "another-host" } } });
  expect(f.model.getSnapshot().draft?.uncertain).toBe(true);
  f.configure({ ...f.input, failure });
  expect(f.model.getSnapshot().draft?.uncertain).toBe(false);
  expect(f.model.getSnapshot().draft?.error).toBe("Host refused before effects");
  expect(f.model.getSnapshot().draft?.receipt).toBeUndefined();
  expect(f.model.getSnapshot().draft?.text).toBe("Local plan edit");
  const next = f.model.mutate("edit"); expect(f.calls).toHaveLength(2); f.reject(); await next;
  f.configure({ ...f.input, failure });
  expect(f.model.getSnapshot().draft?.uncertain).toBe(true);
});

function documentFixture() {
  const f = fixture();
  const document = { documentRevision: "native-document-1", renderColumns: 80, canUndo: true, feedback: "",
    sections: [{ sectionId: "section-1", level: 1, title: "Implementation", annotationCount: 0 }], toc: ["section-1"] };
  f.configure({ ...f.input, plan: { ...f.input.plan, review: { ...f.input.plan.review!, document } } });
  const section = { sectionId: "section-1", documentRevision: document.documentRevision, renderColumns: 80,
    level: 1, title: "Implementation", annotationCount: 0,
    rows: [{ rowId: "wrapped-native-row", text: "Original rendered context", truncated: false, annotationIds: [] }], annotations: [] };
  return { ...f, get input() { return f.input; }, document, section };
}

test("a held section is rejected after owner, width, revision, readiness, or connection changes", async () => {
  for (const change of ["host", "width", "revision", "status", "closed", "offline"] as const) {
    const f = documentFixture(); let finish!: (value: typeof f.section) => void;
    const ports = { ...f.ports, readDocumentSection: async () => new Promise<typeof f.section>(resolve => { finish = resolve; }) };
    f.model.configure(f.input, ports);
    const pending = f.model.readDocumentSection("section-1");
    const next = structuredClone(f.input);
    if (change === "host") next.owner.hostId = "other";
    if (change === "width") next.plan.review!.document!.renderColumns = 100;
    if (change === "revision") next.plan.review!.document!.documentRevision = "native-document-2";
    if (change === "status") next.plan.review!.status = "dismissed";
    if (change === "closed") next.open = false;
    if (change === "offline") next.connected = false;
    f.model.configure(next, ports); finish(f.section);
    await expect(pending).rejects.toThrow("original Plan document changed");
    expect(f.calls).toHaveLength(0);
  }
});

test("an original section remains usable and a line annotation submits only native IDs and captured width", async () => {
  const f = documentFixture();
  f.model.configure(f.input, { ...f.ports, readDocumentSection: async (_owner, request) => {
    expect(request.selection).toEqual({ documentRevision: "native-document-1", renderColumns: 80, sectionId: "section-1" });
    return f.section;
  } });
  const selected = await f.model.readDocumentSection("section-1");
  const pending = f.model.mutateDocument({ kind: "annotate", expectedDocumentRevision: selected.documentRevision,
    target: { kind: "line", sectionId: selected.sectionId, rowId: selected.rows[0]!.rowId }, note: "Preserve this condition" });
  expect(f.calls[0]?.mutation).toEqual({ action: "document", renderColumns: 80, documentAction: {
    kind: "annotate", expectedDocumentRevision: "native-document-1", target: { kind: "line", sectionId: "section-1", rowId: "wrapped-native-row" }, note: "Preserve this condition",
  } });
  f.answer(); await pending;
  expect(f.model.getSnapshot().draft?.receipt?.outcome).toBe("applied");
  expect(f.model.getSnapshot().draft?.text).toBe("# Original\n");
});

test("invalid and stale annotations are visible local refusals, preserving edits without a command", async () => {
  const f = documentFixture();
  await f.model.mutateDocument({ kind: "annotate", expectedDocumentRevision: f.document.documentRevision,
    target: { kind: "section", sectionId: "section-1" }, note: "x".repeat(500_001) });
  expect(f.model.getSnapshot().draft?.error).toBeTruthy();
  expect(f.model.getSnapshot().draft?.uncertain).toBe(false);
  expect(f.calls).toHaveLength(0);
  await f.model.mutateDocument({ kind: "undo", expectedDocumentRevision: "old-document" });
  expect(f.model.getSnapshot().draft?.error).toContain("document changed");
  f.model.setText("Unsubmitted Markdown");
  await f.model.mutateDocument({ kind: "delete-section", expectedDocumentRevision: f.document.documentRevision, sectionId: "section-1" });
  expect(f.model.getSnapshot().draft?.text).toBe("Unsubmitted Markdown");
  expect(f.model.getSnapshot().draft?.error).toContain("Save or discard");
  expect(f.calls).toHaveLength(0);
});

test("lost document receipts stay uncertain and reconcile only the original annotation", async () => {
  const f = documentFixture();
  const action = { kind: "annotate" as const, expectedDocumentRevision: f.document.documentRevision,
    target: { kind: "section" as const, sectionId: "section-1" }, note: "Original note" };
  const pending = f.model.mutateDocument(action); const original = f.calls[0]!; f.reject(); await pending;
  expect(f.model.getSnapshot().draft?.uncertain).toBe(true);
  await f.model.mutateDocument(action); expect(f.calls).toHaveLength(1);
  const failure = { owner: f.input.owner, commandId: "original-document-command", request: { ...original,
    mutation: { action: "document" as const, renderColumns: 80, documentAction: { ...action, note: "Different note" } } }, message: "Preflight refused" };
  f.configure({ ...f.input, failure }); expect(f.model.getSnapshot().draft?.uncertain).toBe(true);
  f.configure({ ...f.input, failure: { ...failure, request: original } });
  expect(f.model.getSnapshot().draft?.uncertain).toBe(false);
  expect(f.model.getSnapshot().draft?.error).toBe("Preflight refused");
  expect(f.model.getSnapshot().draft?.receipt).toBeUndefined();
});
