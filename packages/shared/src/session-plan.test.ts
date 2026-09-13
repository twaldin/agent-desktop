import { expect, test } from "bun:test";
import { MAX_PLAN_CONTENT_BYTES, parsePlanDecisionJournalReceipt, parsePlanDecisionReceipt, parsePlanExecutionRetryRequest, parsePlanMutationRequest, parseSessionPlanResponse,
  type PlanReview, type SessionPlan, type SessionPlanResponse } from "./session-plan";
const revision = "a".repeat(64);
const ticket = { epoch: "worker-1", nativeSessionId: "native-1", revision };
const request = { sessionId: "session-1", ticket, reviewId: "review-1", reviewRevision: revision };
const review: PlanReview = { id: "review-1", revision, title: "Original plan", reference: "local://original-plan.md", content: "# Plan\n", status: "ready", canKeepContext: true };
const planValue: SessionPlan = { ticket, mode: "active", enabled: true, canToggle: true, review, executionChoices: [] };
const response: SessionPlanResponse = { protocolVersion: 1, hostId: "home", sessionId: "session-1", value: planValue };

test("Plan response binds host/session and clones the full native review rather than retaining response aliases", () => {
  const raw = structuredClone(response), parsed = parseSessionPlanResponse(raw, "home", "session-1");
  raw.value!.review!.content = "foreign edits"; raw.value!.ticket.epoch = "replacement";
  expect(parsed.value?.review?.content).toBe("# Plan\n"); expect(parsed.value?.ticket.epoch).toBe("worker-1");
  parsed.value!.review!.title = "client edit"; expect(raw.value!.review!.title).toBe("Original plan");
  expect(() => parseSessionPlanResponse(response, "work", "session-1")).toThrow("owner");
  expect(() => parseSessionPlanResponse(response, "home", "replacement")).toThrow("owner");
  expect(() => parseSessionPlanResponse({ ...response, value: null }, "home", "session-1")).toThrow("availability");
});

test("Plan execution retries contain only durable owner identities and expose continuation without a live review", () => {
  const retry = { sessionId: "destination", originSessionId: "session-1", originalCommandId: "approve-1", expectedAttemptId: "retry-1" };
  expect(parsePlanExecutionRetryRequest(retry)).toEqual(retry);
  for (const malformed of [{ ...retry, phaseId: "private" }, { ...retry, expectedAttemptId: "bad/id" }, { ...retry, sessionId: "" }])
    expect(() => parsePlanExecutionRetryRequest(malformed)).toThrow();
  const continuation = { originSessionId: "session-1", executionOwnerId: "destination", originalCommandId: "approve-1",
    latestAttemptId: "retry-1", state: "ready" as const };
  const parsed = parseSessionPlanResponse({ protocolVersion: 1, hostId: "home", sessionId: "destination", value: null,
    unavailable: "not loaded", executionContinuation: continuation }, "home", "destination");
  expect(parsed.executionContinuation).toEqual(continuation);
  expect(() => parseSessionPlanResponse({ ...response, executionContinuation: continuation }, "home", "session-1")).not.toThrow();
  expect(() => parseSessionPlanResponse({ ...response, sessionId: "foreign", executionContinuation: continuation }, "home", "foreign")).toThrow("continuation owner");
});

test("Plan decisions require exact artifact identity and cannot smuggle a read path or fields from another branch", () => {
  for (const context of ["fresh", "compact", "keep"] as const) {
    expect(parsePlanMutationRequest({ ...request, mutation: { action: "approve", context } }).mutation).toEqual({ action: "approve", context });
  }
  expect(() => parsePlanMutationRequest({ ...request, reviewRevision: "stale", mutation: { action: "approve", context: "fresh" } })).toThrow("revision");
  expect(() => parsePlanMutationRequest({ ...request, mutation: { action: "approve", context: "keep", destination: "/tmp/foreign" } })).toThrow("keys");
  expect(() => parsePlanMutationRequest({ ...request, readPath: "/tmp/foreign", mutation: { action: "edit", content: "new" } })).toThrow("keys");
  const parsed = parsePlanMutationRequest({ ...request, mutation: { action: "save", destination: "plans/approved.md" } });
  expect(parsed.mutation).toEqual({ action: "save", destination: "plans/approved.md" });
  expect(parsePlanMutationRequest({ ...request, mutation: { action: "refine", text: "" } }).mutation).toEqual({ action: "refine", text: "" });
});

test("Native role selection and unresolved effects cannot be replaced with optimistic client defaults", () => {
  const choices = [{ role: "default", provider: "provider", modelId: "actual", selected: false, default: true }];
  const value = { ...response.value, executionChoices: choices, defaultExecutionRole: "default" };
  expect(parseSessionPlanResponse({ ...response, value }, "home", "session-1").value?.executionChoices).toEqual(choices);
  expect(() => parseSessionPlanResponse({ ...response, value: { ...value, defaultExecutionRole: "foreign" } }, "home", "session-1")).toThrow("default execution role");
  expect(() => parseSessionPlanResponse({ ...response, value: { ...value, reconciliationRequired: true } }, "home", "session-1")).toThrow("toggle availability");
  const unresolved = parseSessionPlanResponse({ ...response, value: { ...value, canToggle: false, reconciliationRequired: true,
    review: { ...review, status: "unknown" } } }, "home", "session-1");
  expect(unresolved.value?.review?.status).toBe("unknown"); expect(unresolved.value?.canToggle).toBe(false);
});

test("Review content is never truncated to fit transport, and unsafe keep-context availability must explain its refusal", () => {
  expect(() => parsePlanMutationRequest({ ...request, mutation: { action: "edit", content: "é".repeat(MAX_PLAN_CONTENT_BYTES / 2 + 1) } })).toThrow("text");
  const large = { ...response, value: { ...response.value, review: { ...review, canKeepContext: false } } };
  expect(() => parseSessionPlanResponse(large, "home", "session-1")).toThrow("keep-context reason");
  expect(parseSessionPlanResponse({ ...large, value: { ...large.value, review: { ...large.value.review, keepContextReason: "Context exceeds the execution model limit." } } }, "home", "session-1").value?.review?.canKeepContext).toBe(false);
});

test("Saved artifact and fresh identity receipts preserve partial unknowns without claiming execution or a clean success", () => {
  const saved = { commandId: "save-1", reviewId: "review-1", reviewRevision: revision, action: "save", outcome: "unknown", artifact: "written", transition: "unknown", execution: "not-requested", savedDestination: "/owner/plans/saved.md" } as const;
  expect(parsePlanDecisionReceipt(saved, "save-1")).toEqual(saved);
  expect(() => parsePlanDecisionReceipt(saved, "save-2")).toThrow("command owner");
  expect(() => parsePlanDecisionReceipt({ ...saved, outcome: "applied" }, "save-1")).toThrow("unknown effect");
  expect(() => parsePlanDecisionReceipt({ ...saved, transition: "new-session" }, "save-1")).toThrow("destination identity");
  expect(() => parsePlanDecisionReceipt({ ...saved, execution: "entered" }, "save-1")).toThrow("unexpected execution");
  const fresh = { ...saved, action: "approve", artifact: "unchanged", transition: "new-session", destinationSessionId: "new-owner", execution: "not-entered", savedDestination: undefined };
  expect(parsePlanDecisionReceipt(fresh, "save-1").destinationSessionId).toBe("new-owner");
  expect(parsePlanDecisionReceipt({ ...fresh, transition: "unknown" }, "save-1").destinationSessionId).toBe("new-owner");
  expect(parsePlanDecisionReceipt({ ...saved, artifact: "unknown" }, "save-1").savedDestination).toBe("/owner/plans/saved.md");
  expect(() => parsePlanDecisionReceipt({ ...fresh, transition: "unchanged" }, "save-1")).toThrow("destination identity");
  expect(() => parsePlanDecisionReceipt({ ...saved, artifact: "unchanged" }, "save-1")).toThrow("saved artifact");
});

test("Plan read receipts bind the exact original command and keep pending, failed, and unknown outcomes distinct", () => {
  const applied = { commandId: "decision-1", reviewId: "review-1", reviewRevision: revision, action: "edit", outcome: "applied",
    artifact: "written", transition: "unchanged", execution: "not-requested" } as const;
  const mutation = { type: "session.plan.mutate" as const, receipt: applied };
  expect(parsePlanDecisionJournalReceipt({ commandId: "decision-1", state: "succeeded", value: mutation }, "decision-1").value).toEqual(mutation);
  const unknown = { ...applied, action: "approve" as const, outcome: "unknown" as const, artifact: "unknown" as const,
    transition: "unknown" as const, execution: "unknown" as const };
  expect(parsePlanDecisionJournalReceipt({ commandId: "decision-1", state: "unknown", value: { type: "session.plan.mutate", receipt: unknown } }, "decision-1").value)
    .toEqual({ type: "session.plan.mutate", receipt: unknown });
  const control = { type: "session.plan.control" as const, state: planValue };
  expect(parsePlanDecisionJournalReceipt({ commandId: "decision-1", state: "succeeded", value: control }, "decision-1").value).toEqual(control);
  for (const state of ["absent", "pending", "failed", "unknown"] as const)
    expect(parsePlanDecisionJournalReceipt({ commandId: "decision-1", state }, "decision-1")).toEqual({ commandId: "decision-1", state });
  expect(() => parsePlanDecisionJournalReceipt({ commandId: "other", state: "pending" }, "decision-1")).toThrow("owner");
  expect(() => parsePlanDecisionJournalReceipt({ commandId: "decision-1", state: "succeeded" }, "decision-1")).toThrow("missing");
  expect(() => parsePlanDecisionJournalReceipt({ commandId: "decision-1", state: "failed", value: mutation }, "decision-1")).toThrow("state");
  const withReceipt = { ...response, decisionReceipt: { commandId: "decision-1", state: "succeeded", value: mutation } };
  expect(parseSessionPlanResponse(withReceipt, "home", "session-1", "decision-1").decisionReceipt?.value).toEqual(mutation);
  expect(() => parseSessionPlanResponse(withReceipt, "home", "session-1")).toThrow("unsolicited");
  expect(() => parseSessionPlanResponse(response, "home", "session-1", "decision-1")).toThrow();
});

test("Journal transport preserves compaction failure independently from approved execution and copies its nested outcome", () => {
  const receipt = { commandId: "compact-1", reviewId: "review-1", reviewRevision: revision, action: "approve", outcome: "applied",
    artifact: "unchanged", transition: "unchanged", execution: "entered", planExit: "completed",
    compaction: { outcome: "failed", message: "Native compaction failed" } } as const;
  const raw = structuredClone(receipt);
  const parsed = parsePlanDecisionJournalReceipt({ commandId: receipt.commandId, state: "succeeded",
    value: { type: "session.plan.mutate", receipt: raw } }, receipt.commandId);
  expect(parsed.value).toEqual({ type: "session.plan.mutate", receipt });
  if (parsed.value?.type !== "session.plan.mutate") throw new Error("Missing mutation receipt");
  parsed.value.receipt.compaction!.message = "Changed client copy";
  expect(raw.compaction.message).toBe("Native compaction failed");
  Object.assign(raw.compaction, { outcome: "ok", message: "Changed transport copy" });
  expect(parsed.value.receipt.compaction).toEqual({ outcome: "failed", message: "Changed client copy" });
});

test("Cancelled replacement can retain a completed Plan exit and saved artifact without inventing a destination", () => {
  const cancelled = { commandId: "cancel-1", reviewId: "review-1", reviewRevision: revision, action: "save", outcome: "cancelled",
    artifact: "written", transition: "unchanged", execution: "not-requested", planExit: "completed", savedDestination: "plans/saved.md" } as const;
  expect(parsePlanDecisionReceipt(cancelled, cancelled.commandId)).toEqual(cancelled);
  const { planExit: _exit, ...legacy } = cancelled;
  expect(parsePlanDecisionReceipt(legacy, legacy.commandId)).toEqual(legacy);
  expect(parsePlanDecisionReceipt({ ...cancelled, outcome: "unknown", planExit: "unknown" }, cancelled.commandId).planExit).toBe("unknown");
  expect(() => parsePlanDecisionReceipt({ ...cancelled, planExit: "unknown" }, cancelled.commandId)).toThrow("unknown Plan exit");
});

test("Plan effect fields reject foreign action payloads and malformed nested outcomes", () => {
  const receipt = { commandId: "effect-1", reviewId: "review-1", reviewRevision: revision, action: "approve", outcome: "applied",
    artifact: "unchanged", transition: "unchanged", execution: "not-entered" } as const;
  for (const fields of [
    { compaction: { outcome: "failed", error: "unparsed" } }, { compaction: { outcome: "unknown" } },
    { compaction: { outcome: "failed", message: 1 } }, { planExit: "exited" },
    { action: "refine", compaction: { outcome: "failed" } }, { action: "edit", planExit: "completed", execution: "not-requested" },
  ]) expect(() => parsePlanDecisionReceipt({ ...receipt, ...fields }, receipt.commandId)).toThrow();
});
