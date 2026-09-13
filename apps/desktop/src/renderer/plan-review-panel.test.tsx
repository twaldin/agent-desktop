import { expect, test } from "bun:test";
import React from "react";
import { PlanExecutionContinuationControl, PlanReviewPanelView } from "./PlanReviewPanel";
import { PierreSourceEditor, type PierreSourceEditorProps } from "./PierreSourceEditor";
import { MarkdownText } from "./MarkdownText";
import { PlanReviewModel, type PlanReviewInput, type PlanReviewPorts } from "./plan-review-model";
import type { PlanDecisionReceipt, PlanMutationRequest } from "../../../../packages/shared/src/session-plan";

type Props = { children?: unknown; disabled?: boolean; hidden?: boolean; value?: string; text?: string; label?: string; active?: boolean;
  "aria-label"?: string; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void; onSave?: () => void;
  onKeyDown?: (event: { key: string; defaultPrevented: boolean; nativeEvent: { isComposing: boolean }; preventDefault(): void; stopPropagation(): void }) => void };
function nodes(input: unknown): React.ReactElement<Props>[] {
  if (Array.isArray(input)) return input.flatMap(nodes);
  if (!React.isValidElement<Props>(input)) return [];
  return [input, ...nodes(input.props.children)];
}
function button(tree: unknown, label: string) {
  const node = nodes(tree).find(node => node.type === "button" && (node.props.children === label || node.props["aria-label"] === label));
  if (!node) throw new Error(`Missing button ${label}`); return node;
}
function fixture() {
  let input: PlanReviewInput = { owner: { hostId: "home", sessionId: "session" }, connected: true, fresh: true, open: true, executionChoices: [],
    plan: { ticket: { epoch: "epoch", nativeSessionId: "native", revision: "a".repeat(64) }, mode: "active", enabled: true, canToggle: true,
      executionChoices: [], review: { id: "review", revision: "b".repeat(64), title: "Native plan", reference: "local://feature-plan.md",
        content: "# Native plan\n", status: "ready", canKeepContext: false, keepContextReason: "Native context usage is above 95%." } } };
  const requests: PlanMutationRequest[] = [], operations: string[] = [];
  const ports: PlanReviewPorts = { mutate: async (_owner, request) => { requests.push(request); return {
    commandId: "command", reviewId: request.reviewId, reviewRevision: request.reviewRevision, action: request.mutation.action,
    outcome: "cancelled", artifact: "unchanged", transition: "unchanged", execution: "not-requested",
  }; }, dismiss: async () => { operations.push("dismiss"); }, reopen: async () => { operations.push("reopen"); }, refresh: async () => { operations.push("refresh"); } };
  const model = new PlanReviewModel(input, ports);
  return { model, requests, operations, get input() { return input; }, configure(next: PlanReviewInput) { input = next; model.configure(next, ports); },
    render: () => PlanReviewPanelView({ model, view: model.getSnapshot(), id: "test-plan", ownerLabel: "Home Mac" }) };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test("actual panel event path uses existing Markdown/Pierre and preserves controlled text through preview", async () => {
  const f = fixture(); let tree = f.render();
  expect(nodes(tree).find(node => node.type === MarkdownText)?.props.text).toBe("# Native plan\n");
  const edit = nodes(tree).find(node => node.type === "button" && Array.isArray(node.props.children) && node.props.children.includes("Edit Markdown"))!;
  edit.props.onClick!(); tree = f.render(); const editor = nodes(tree).find(node => node.type === PierreSourceEditor)!;
  expect(editor.props.active).toBe(true); expect(editor.props.label).toBe("Plan Markdown");
  if (!React.isValidElement<PierreSourceEditorProps>(editor)) throw new Error("Missing actual Pierre editor element");
  editor.props.onChange("# Edited\n"); button(f.render(), "Preview").props.onClick!();
  expect(nodes(f.render()).find(node => node.type === MarkdownText)?.props.text).toBe("# Edited\n");
  button(f.render(), "Save edits").props.onClick!(); await flush(); expect(f.requests[0]?.mutation).toEqual({ action: "edit", content: "# Edited\n" });
});

test("all approval contexts are present and native keep eligibility is enforced", async () => {
  for (const [label, context] of [["Approve · new context", "fresh"], ["Approve · compact context", "compact"]] as const) {
    const f = fixture(); button(f.render(), label).props.onClick!(); await flush(); expect(f.requests[0]?.mutation).toEqual({ action: "approve", context });
  }
  const f = fixture(); expect(button(f.render(), "Approve · keep context").props.disabled).toBe(true);
  button(f.render(), "Approve · keep context").props.onClick!(); await flush(); expect(f.requests).toHaveLength(0);
  expect(nodes(f.render()).some(node => node.props.children === "Native context usage is above 95%.")).toBe(true);
});

test("continue/refine, explicit destination and dismiss/reopen run real injected callbacks", async () => {
  const f = fixture(); button(f.render(), "Continue planning").props.onClick!(); await flush();
  expect(f.requests[0]?.mutation).toEqual({ action: "refine", text: "" });
  nodes(f.render()).find(node => node.type === "textarea")!.props.onChange!({ target: { value: "Preserve the existing model" } });
  button(f.render(), "Refine plan").props.onClick!(); await flush(); expect(f.requests[1]?.mutation).toEqual({ action: "refine", text: "Preserve the existing model" });
  nodes(f.render()).find(node => node.type === "input")!.props.onChange!({ target: { value: "plans/reviewed.md" } });
  button(f.render(), "Save plan and start new session").props.onClick!(); await flush(); expect(f.requests[2]?.mutation).toEqual({ action: "save", destination: "plans/reviewed.md" });
  button(f.render(), "Dismiss plan review").props.onClick!(); await flush(); expect(f.operations).toEqual(["dismiss"]);
  f.configure({ ...f.input, open: false }); button(f.render(), "Reopen plan review").props.onClick!(); await flush(); expect(f.operations).toEqual(["dismiss", "reopen"]);
});

test("missing platform operations are visible and partial native failure offers status with no review", async () => {
  const f = fixture(); expect(button(f.render(), "Copy unavailable").props.disabled).toBe(true);
  expect(button(f.render(), "External editor unavailable").props.disabled).toBe(true);
  f.configure({ ...f.input, plan: { ...f.input.plan, review: null, reconciliationRequired: true }, receipt: {
    commandId: "partial-save", reviewId: "review", reviewRevision: "b".repeat(64), action: "save", outcome: "unknown",
    artifact: "written", savedDestination: "plans/saved.md", transition: "unknown", execution: "not-requested",
  } });
  expect(nodes(f.render()).some(node => node.props.children === "Plan saved to plans/saved.md")).toBe(true);
  expect(nodes(f.render()).some(node => node.props.children === "The session transition is not confirmed.")).toBe(true);
  button(f.render(), "Check original action status").props.onClick!(); await flush(); expect(f.operations).toEqual(["refresh"]); expect(f.requests).toHaveLength(0);
});

test("panel Escape preserves IME and child popup ownership, then dismisses without losing local edits", async () => {
  const f = fixture(); f.model.setText("Unsaved plan edits"); let prevented = 0;
  const event = { key: "Escape", defaultPrevented: false, nativeEvent: { isComposing: true },
    preventDefault() { prevented++; }, stopPropagation() {} };
  nodes(f.render())[0]!.props.onKeyDown!(event); await flush(); expect(f.operations).toEqual([]);
  nodes(f.render())[0]!.props.onKeyDown!({ ...event, nativeEvent: { isComposing: false }, defaultPrevented: true }); await flush(); expect(f.operations).toEqual([]);
  nodes(f.render())[0]!.props.onKeyDown!({ ...event, nativeEvent: { isComposing: false } }); await flush();
  expect(f.operations).toEqual(["dismiss"]); expect(prevented).toBe(1); expect(f.model.getSnapshot().draft?.text).toBe("Unsaved plan edits");
});


test("continuation controls work without a review and never offer retry for unknown or entered input", async () => {
  const ready = { originSessionId: "original", executionOwnerId: "destination", originalCommandId: "original-command", latestAttemptId: "original-command", state: "ready" as const };
  const attempts: unknown[] = [], opens: unknown[] = []; let reads = 0;
  const base = { owner: { hostId: "home", sessionId: "destination" }, executionContinuation: ready, fresh: true, pending: false, uncertain: false, loading: false };
  const render = (view = base) => PlanExecutionContinuationControl({ view, connected: true,
    retry: async expected => { attempts.push(expected); }, refresh: async () => { reads++; }, openOwner: expected => { opens.push(expected); } });
  button(render(), "Retry original Plan input").props.onClick!(); await flush(); expect(attempts).toEqual([ready]);
  button(render(), "Check Plan execution status").props.onClick!(); await flush(); expect(reads).toBe(1);
  button(render({ ...base, owner: { hostId: "home", sessionId: "original" } }), "Open approved conversation").props.onClick!(); expect(opens).toEqual([ready]);
  for (const state of ["unknown", "entered", "pending"] as const) {
    const tree = PlanExecutionContinuationControl({ view: { ...base, executionContinuation: { ...ready, state } }, connected: true,
      retry: async () => { throw new Error("Not callable"); }, refresh: async () => {}, openOwner: () => {} });
    expect(nodes(tree).some(node => node.type === "button" && node.props.children === "Retry original Plan input")).toBe(false);
  }
  expect(button(render({ ...base, uncertain: true }), "Retry original Plan input").props.disabled).toBe(true);
});

function receiptText(tree: unknown): string[] {
  return nodes(tree).flatMap(node => typeof node.props.children === "string" ? [node.props.children] : []);
}
const decision = (fields: Partial<PlanDecisionReceipt> = {}): PlanDecisionReceipt => ({
  commandId: "confirmed-decision", reviewId: "review", reviewRevision: "b".repeat(64), action: "approve",
  outcome: "applied", artifact: "unchanged", transition: "unchanged", execution: "entered", ...fields,
});

test("receipt reports failed compaction and retained Plan model even after review closes", () => {
  for (const closed of [false, true]) {
    const f = fixture();
    const receipt = { ...decision(), compaction: { outcome: "failed" as const, message: "Context summary failed: controlled native error" } };
    f.configure({ ...f.input, plan: { ...f.input.plan, review: closed ? null : f.input.plan.review }, receipt });
    const text = receiptText(f.render());
    expect(text).toContain("Compaction failed.");
    expect(text).toContain("Context summary failed: controlled native error");
    expect(text).toContain("The original context and Plan model were retained. The selected execution role was not applied.");
    expect(text).toContain("Execution was admitted. Follow its progress in the conversation.");
    expect(text).not.toContain("Context was compacted.");
  }
});

test("cancelled fresh and save receipts separate completed Plan exit from replacement and saved artifact", () => {
  for (const action of ["approve", "save"] as const) {
    const f = fixture();
    const receipt = { ...decision({ action, outcome: "cancelled", execution: "not-requested", artifact: action === "save" ? "written" : "unchanged",
      ...(action === "save" ? { savedDestination: "plans/native-saved.md" } : {}) }), planExit: "completed" as const };
    f.configure({ ...f.input, plan: { ...f.input.plan, mode: "off", review: null }, receipt });
    const text = receiptText(f.render());
    expect(text).toContain("Action cancelled");
    expect(text).toContain("Plan mode exited and the review closed.");
    expect(text).toContain("No replacement session was created.");
    expect(text.some(value => value.includes("current session has not changed"))).toBe(false);
    expect(text.includes("Plan saved to plans/native-saved.md")).toBe(action === "save");
    expect(text).not.toContain("Execution was admitted. Follow its progress in the conversation.");
  }
});

test("unknown Plan exit is visible without a review and status does not replay a decision", async () => {
  const f = fixture();
  const receipt = { ...decision({ outcome: "unknown", transition: "unknown", execution: "not-requested" }), planExit: "unknown" as const };
  f.configure({ ...f.input, plan: { ...f.input.plan, review: null }, receipt });
  expect(receiptText(f.render())).toContain("Whether Plan mode exited and the review closed is unknown.");
  button(f.render(), "Check original action status").props.onClick!(); await flush();
  expect(f.operations).toEqual(["refresh"]); expect(f.requests).toHaveLength(0);
});

test("legacy receipts do not invent Plan exit or compaction effects", () => {
  const f = fixture();
  f.configure({ ...f.input, plan: { ...f.input.plan, review: null }, receipt: decision({ action: "save", outcome: "cancelled", artifact: "written", savedDestination: "legacy.md", execution: "not-requested" }) });
  const text = receiptText(f.render());
  expect(text).toContain("Plan saved to legacy.md"); expect(text).toContain("No replacement session was created.");
  expect(text.some(value => /Plan mode exited|Plan model were retained|Compaction|Context was compacted|current session has not changed/.test(value))).toBe(false);
});
