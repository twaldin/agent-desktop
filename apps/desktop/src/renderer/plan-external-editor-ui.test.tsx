import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import type { PlanDocumentSection, PlanDocumentSummary } from "../../../../packages/shared/src/plan-document";
import type { PlanExternalEditorObservation, PlanExternalEditorRequest } from "../../../../packages/shared/src/plan-external-editor";
import type { PlanReviewInput } from "./plan-review-model";
import { PlanReviewModel } from "./plan-review-model";
import { PlanReviewWithExternalEditor } from "./PlanExternalEditor";
import { PlanReviewPanelView } from "./PlanReviewPanel";
import { PlanDocumentReview } from "./PlanDocumentReview";
import type { PlanEditorPorts } from "./plan-external-editor-state";

type Slot = { deps?: readonly unknown[]; value?: unknown; cleanup?: () => void };
const same = (left: readonly unknown[], right: readonly unknown[]) => left.length === right.length
  && left.every((value, index) => Object.is(value, right[index]));
function hooks() {
  const slots: Slot[] = []; let cursor = 0, pending: Array<{ index: number; deps: readonly unknown[]; effect: () => void | (() => void) }> = [];
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } })
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = {
    useState<T>(initial: T | (() => T)) { const index = cursor++; if (!(index in slots)) slots[index] = { value: typeof initial === "function" ? (initial as () => T)() : initial };
      return [slots[index]!.value as T, (next: T | ((prior: T) => T)) => { slots[index]!.value = typeof next === "function" ? (next as (prior: T) => T)(slots[index]!.value as T) : next; }] as const; },
    useRef<T>(initial: T) { const index = cursor++; if (!(index in slots)) slots[index] = { value: { current: initial } }; return slots[index]!.value; },
    useLayoutEffect(effect: () => void | (() => void), deps: readonly unknown[]) { const index = cursor++, prior = slots[index];
      if (!prior?.deps || !same(prior.deps, deps)) { prior?.cleanup?.(); const cleanup = effect(); slots[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }; } },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) { const index = cursor++, prior = slots[index];
      if (!prior?.deps || !same(prior.deps, deps)) pending.push({ index, deps, effect }); },
    useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { cursor++; return snapshot(); },
  };
  return { render<T>(component: () => T): T { cursor = 0; pending = []; const prior = internals.H; internals.H = dispatcher;
      let tree: T; try { tree = component(); } finally { internals.H = prior; }
      for (const item of pending) slots[item.index]?.cleanup?.();
      for (const item of pending) { const cleanup = item.effect(); slots[item.index] = { deps: item.deps, cleanup: typeof cleanup === "function" ? cleanup : undefined }; }
      return tree; },
    dispose() { for (const slot of slots) slot?.cleanup?.(); } };
}

type Props = { children?: unknown; disabled?: boolean; title?: string; value?: string; "aria-label"?: string;
  onClick?: () => void; onChange?: (event: { target: { value: string } }) => void };
function elements(value: unknown): React.ReactElement<Props>[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!React.isValidElement<Props>(value)) return [];
  return [value, ...elements(value.props.children)];
}
function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  return React.isValidElement<Props>(value) ? text(value.props.children) : "";
}
function button(tree: unknown, label: string) {
  const result = elements(tree).find(node => node.type === "button" && text(node) === label);
  if (!result?.props.onClick) throw new Error(`Missing ${label} button`);
  return result;
}
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
const document: PlanDocumentSummary = { documentRevision: "document-one", renderColumns: 96, canUndo: false, feedback: "",
  sections: [{ sectionId: "section-one", level: 1, title: "Section one", annotationCount: 0 }], toc: ["section-one"] };
const section: PlanDocumentSection = { documentRevision: "document-one", renderColumns: 96, sectionId: "section-one", level: 1,
  title: "Section one", annotationCount: 0, rows: [{ rowId: "row-one", text: "Native row", truncated: false, annotationIds: [] }], annotations: [] };
function planInput(fields: Partial<Pick<PlanReviewInput, "connected" | "fresh" | "open">> = {}): PlanReviewInput {
  return { owner: { hostId: "home", sessionId: "session" }, connected: true, fresh: true, open: true, executionChoices: [], ...fields,
    plan: { ticket: { epoch: "worker", nativeSessionId: "native", revision: "a".repeat(64) }, mode: "active", enabled: true,
      canToggle: true, executionChoices: [], review: { id: "review", revision: "b".repeat(64), title: "Native plan",
        reference: "local://PLAN.md", content: "# Plan\n", status: "ready", canKeepContext: true, document } } };
}
const listedRequest: PlanExternalEditorRequest = { requestId: "10000000-0000-0000-0000-000000000001",
  controlEpoch: "20000000-0000-0000-0000-000000000002", sessionId: "session",
  ticket: { epoch: "worker", nativeSessionId: "native", revision: "a".repeat(64) }, reviewId: "review",
  reviewRevision: "b".repeat(64), documentRevision: "document-one", edit: { kind: "plan" } };
const unknownJob = (): PlanExternalEditorObservation => ({ protocolVersion: 1, hostId: "home", request: listedRequest, state: "settled",
  terminalId: "30000000-0000-0000-0000-000000000003", result: { outcome: "unknown", message: "Inspect the original editor." } });
function fixture(options: { available?: boolean; jobs?: PlanExternalEditorObservation[] } = {}) {
  const calls = { starts: [] as PlanExternalEditorRequest[], statuses: [] as PlanExternalEditorRequest[],
    cancels: [] as PlanExternalEditorRequest[], recoveries: [] as PlanExternalEditorRequest[], terminals: [] as string[] };
  const bridge: PlanEditorPorts["bridge"] = {
    getPlanEditorCapabilities: async () => ({ protocolVersion: 1, hostId: "home", controlEpoch: listedRequest.controlEpoch,
      available: options.available ?? true, ...((options.available ?? true) ? {} : { reason: "No configured editor." }) }),
    listPlanEditors: async () => ({ protocolVersion: 1, hostId: "home", sessionId: "session", items: options.jobs ?? [] }),
    startPlanEditor: async request => { calls.starts.push(request); return { protocolVersion: 1, hostId: "home", request, state: "settled",
      result: { outcome: "applied", receipt: { commandId: request.requestId, reviewId: request.reviewId,
        reviewRevision: request.reviewRevision, action: request.edit.kind === "plan" ? "edit" : "document", outcome: "applied",
        artifact: "written", transition: "unchanged", execution: "not-requested" } } }; },
    getPlanEditorStatus: async request => { calls.statuses.push(request); return unknownJob(); },
    cancelPlanEditor: async request => { calls.cancels.push(request); return unknownJob(); },
    recoverPlanEditor: async request => { calls.recoveries.push(request); return { observation: unknownJob(), content: "retained output" }; },
  };
  const values = new Map<string, string>();
  const ports: PlanEditorPorts = { bridge, storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } },
    openTerminal: (_host, _session, terminalId) => { calls.terminals.push(terminalId); }, refreshPlan: async () => {}, copy: async () => {} };
  return { calls, ports };
}
function mounted(input: PlanReviewInput, ports: PlanEditorPorts) {
  const review = new PlanReviewModel(input, { mutate: async () => { throw new Error("Decision not expected"); }, dismiss: async () => {},
    reopen: async () => {}, refresh: async () => {}, readDocumentSection: async () => section });
  const driver = hooks(); let current = input;
  const render = () => driver.render(() => {
    const shell = PlanReviewWithExternalEditor({ model: review, view: review.getSnapshot(), id: "plan", ports });
    return PlanReviewPanelView(shell.props);
  });
  return { review, render, dispose: driver.dispose, configure(next: PlanReviewInput) { current = next; review.configure(current, {
    mutate: async () => { throw new Error("Decision not expected"); }, dismiss: async () => {}, reopen: async () => {}, refresh: async () => {},
    readDocumentSection: async () => section }); } };
}

test("configured editor action is disabled offline, stale, dirty, and when the owning host reports unavailable", async () => {
  for (const [input, title] of [[planInput({ connected: false }), "Reconnect"], [planInput({ fresh: false }), "Refresh and open"]] as const) {
    const f = fixture(), component = mounted(input, f.ports);
    try { const control = button(component.render(), "Edit in configured editor"); expect(control.props.disabled).toBe(true); expect(control.props.title).toContain(title); }
    finally { component.dispose(); }
  }
  const dirtyFixture = fixture(), dirty = mounted(planInput(), dirtyFixture.ports);
  try { dirty.review.setText("# Local edit\n"); const control = button(dirty.render(), "Edit in configured editor");
    expect(control.props.disabled).toBe(true); expect(control.props.title).toContain("Save or discard"); } finally { dirty.dispose(); }
  const unavailableFixture = fixture({ available: false }), unavailable = mounted(planInput(), unavailableFixture.ports);
  try { unavailable.render(); await settle(); const control = button(unavailable.render(), "Edit in configured editor");
    expect(control.props.disabled).toBe(true); expect(control.props.title).toBe("No configured editor."); } finally { unavailable.dispose(); }
});

test("listed job controls use the original request and hiding or unmounting never cancels it", async () => {
  const f = fixture({ jobs: [unknownJob()] }), component = mounted(planInput(), f.ports);
  try {
    component.render(); await settle(); let tree = component.render();
    button(tree, "Check original job").props.onClick!(); await settle();
    tree = component.render(); button(tree, "Cancel original editor").props.onClick!(); await settle();
    tree = component.render(); button(tree, "Recover edited text").props.onClick!(); await settle();
    expect(f.calls.statuses).toEqual([listedRequest]); expect(f.calls.cancels).toEqual([listedRequest]); expect(f.calls.recoveries).toEqual([listedRequest]);
    component.configure(planInput({ open: false })); component.render();
  } finally { component.dispose(); }
  expect(f.calls.cancels).toEqual([listedRequest]);
});

test("section and rendered-line editor buttons forward native identities, current note, and rendered width", async () => {
  const f = fixture(), component = mounted(planInput(), f.ports), documentDriver = hooks();
  try {
    component.render(); await settle(); const panel = component.render();
    const documentElement = elements(panel).find(node => node.type === PlanDocumentReview);
    if (!documentElement) throw new Error("Missing Plan document review");
    let tree = documentDriver.render(() => PlanDocumentReview(documentElement.props as Parameters<typeof PlanDocumentReview>[0]));
    button(tree, "Sections and annotations").props.onClick!();
    tree = documentDriver.render(() => PlanDocumentReview(documentElement.props as Parameters<typeof PlanDocumentReview>[0]));
    elements(tree).find(node => node.type === "select")!.props.onChange!({ target: { value: "section-one" } }); await settle();
    tree = documentDriver.render(() => PlanDocumentReview(documentElement.props as Parameters<typeof PlanDocumentReview>[0]));
    elements(tree).find(node => node.type === "textarea")!.props.onChange!({ target: { value: "Section note" } });
    button(documentDriver.render(() => PlanDocumentReview(documentElement.props as Parameters<typeof PlanDocumentReview>[0])), "Write annotation in configured editor").props.onClick!(); await settle();
    expect(f.calls.starts[0]?.edit).toEqual({ kind: "annotation", target: { kind: "section", sectionId: "section-one" }, note: "Section note", renderColumns: 96 });

    tree = documentDriver.render(() => PlanDocumentReview(documentElement.props as Parameters<typeof PlanDocumentReview>[0]));
    elements(tree).find(node => node.type === "button" && node.props["aria-label"] === "Rendered line 1: Native row")!.props.onClick!();
    tree = documentDriver.render(() => PlanDocumentReview(documentElement.props as Parameters<typeof PlanDocumentReview>[0]));
    elements(tree).find(node => node.type === "textarea")!.props.onChange!({ target: { value: "Line note" } });
    button(documentDriver.render(() => PlanDocumentReview(documentElement.props as Parameters<typeof PlanDocumentReview>[0])), "Write annotation in configured editor").props.onClick!(); await settle();
    expect(f.calls.starts[1]?.edit).toEqual({ kind: "annotation", target: { kind: "line", sectionId: "section-one", rowId: "row-one" }, note: "Line note", renderColumns: 96 });
  } finally { documentDriver.dispose(); component.dispose(); }
});

test("editor controls expose named regions and bounded narrow-layout styles", async () => {
  const f = fixture({ jobs: [unknownJob()] }), component = mounted(planInput(), f.ports);
  try { component.render(); await settle(); const tree = component.render();
    expect(elements(tree).some(node => node.props["aria-label"] === "Configured Plan editor")).toBe(true);
    expect(elements(tree).some(node => node.props["aria-label"] === "Original editor jobs")).toBe(true);
    const css = readFileSync(new URL("./plan-external-editor.css", import.meta.url), "utf8");
    expect(css).toContain("min-width: 0"); expect(css).toContain("flex-wrap:wrap"); expect(css).toContain("overflow-wrap:anywhere"); expect(css).toContain("max-height:35vh");
  } finally { component.dispose(); }
});
