import { Effort } from "@oh-my-pi/pi-ai";
import { expect, test } from "bun:test";
import { projectSessionPlan } from "./plan-state";
import type { NativePlanSnapshot, NativePlanReview } from "./plan-controller";

const review: NativePlanReview = { id: "proposal-1", revision: "a".repeat(64), title: "Plan", reference: "local://plan.md",
  content: "# Actual reviewed bytes", documentRevision: "document-1", status: "dismissed", canKeepContext: true,
  document: { documentRevision: "document-1", renderColumns: 120, canUndo: false, feedback: "",
    sections: [{ sectionId: "section-1", level: 1, title: "Actual reviewed bytes", annotationCount: 0 }], toc: [] } };
const snapshot: NativePlanSnapshot = {
  nativeSessionId: "native-1", sessionFile: "/owner/session.jsonl", mode: "active", journalMode: "plan", restorationRequired: false,
  proposalHandlerOwned: true, model: { provider: "provider", id: "planner" }, thinking: Effort.High, pendingModelChange: false,
  restoration: "captured-before-entry", busy: false, canToggle: true,
  review: { id: review.id, revision: review.revision, documentRevision: review.documentRevision, title: review.title,
    reference: review.reference, status: review.status, canKeepContext: review.canKeepContext },
  executionChoices: [{ role: "default", provider: "provider", modelId: "executor", thinking: Effort.High }],
};

test("Plan state preserves a dismissed review and actual role choices without retaining mutable native aliases", () => {
  const owned = structuredClone(snapshot), input = structuredClone(review);
  const state = projectSessionPlan({ epoch: "worker-a", snapshot: owned, review: input, enabled: true });
  expect(state.review?.status).toBe("dismissed"); expect(state.review?.content).toBe(input.content);
  expect(state.review?.document).toEqual(input.document);
  expect(state.executionChoices).toEqual([{ role: "default", provider: "provider", modelId: "executor", thinking: Effort.High }]);
  owned.executionChoices[0]!.modelId = "foreign"; input.content = "foreign";
  input.document.sections[0]!.title = "foreign";
  expect(state.executionChoices[0]?.modelId).toBe("executor"); expect(state.review?.content).toBe(review.content);
  expect(state.review?.document?.sections[0]?.title).toBe("Actual reviewed bytes");
  state.executionChoices[0]!.role = "client"; expect(owned.executionChoices[0]?.role).toBe("default");
});

test("Plan admission tickets change with native ownership and busy/role changes, and mixed review revisions are refused", () => {
  const input = { epoch: "worker-a", snapshot, review, enabled: true };
  const before = projectSessionPlan(input);
  const reopened = projectSessionPlan({ ...input, epoch: "worker-b" });
  expect(reopened.ticket).not.toEqual(before.ticket);
  const busy = projectSessionPlan({ ...input, busyReason: "Compaction is settling." });
  expect(busy.canToggle).toBe(false); expect(busy.ticket.revision).not.toBe(before.ticket.revision);
  const roleChanged = projectSessionPlan({ ...input, snapshot: { ...snapshot, executionChoices: [] } });
  expect(roleChanged.ticket.revision).not.toBe(before.ticket.revision);
  const document = { ...review.document, documentRevision: "document-2" };
  const documentChanged = projectSessionPlan({ ...input,
    snapshot: { ...snapshot, review: { ...snapshot.review!, documentRevision: document.documentRevision } },
    review: { ...review, documentRevision: document.documentRevision, document } });
  expect(documentChanged.ticket.revision).not.toBe(before.ticket.revision);
  expect(() => projectSessionPlan({ ...input,
    review: { ...review, documentRevision: "document-2", document: { ...review.document, documentRevision: "document-2" } } })).toThrow("changed");
  expect(() => projectSessionPlan({ ...input, review: { ...review, revision: "b".repeat(64) } })).toThrow("changed");
  expect(() => projectSessionPlan({ ...input, review: undefined })).toThrow("changed");
});
