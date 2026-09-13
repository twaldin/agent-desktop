import { expect, test } from "bun:test";
import React from "react";
import type { PlanDocumentAction, PlanDocumentSection, PlanDocumentSummary } from "../../../../packages/shared/src/plan-document";
import { PlanDocumentReview } from "./PlanDocumentReview";
import type { PlanReviewModel } from "./plan-review-model";

type Slot = { deps?: readonly unknown[]; value?: unknown; cleanup?: () => void };
const same = (left: readonly unknown[], right: readonly unknown[]) => left.length === right.length
  && left.every((value, index) => Object.is(value, right[index]));

/** Actual component with the repository's controlled React dispatcher. It
 * models committed hooks and callbacks without claiming mounted UI behavior. */
function driver() {
  const slots: Slot[] = []; let cursor = 0;
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } })
    .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = {
    useState<T>(initial: T | (() => T)) {
      const index = cursor++; if (!(index in slots)) slots[index] = { value: typeof initial === "function" ? (initial as () => T)() : initial };
      return [slots[index]!.value as T, (next: T | ((old: T) => T)) => {
        slots[index]!.value = typeof next === "function" ? (next as (old: T) => T)(slots[index]!.value as T) : next;
      }] as const;
    },
    useRef<T>(initial: T) { const index = cursor++; if (!(index in slots)) slots[index] = { value: { current: initial } }; return slots[index]!.value; },
    useLayoutEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = cursor++, previous = slots[index];
      if (!previous?.deps || !same(previous.deps, deps)) {
        previous?.cleanup?.(); const cleanup = effect(); slots[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
      }
    },
  };
  return {
    render(props: Parameters<typeof PlanDocumentReview>[0]) {
      cursor = 0; const previous = internals.H; internals.H = dispatcher;
      try { return PlanDocumentReview(props); } finally { internals.H = previous; }
    },
    dispose() { for (const slot of slots) slot.cleanup?.(); },
  };
}

type Props = { children?: unknown; value?: string; disabled?: boolean; "aria-label"?: string; "aria-pressed"?: boolean;
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
function button(tree: React.ReactElement, label: string) {
  const found = elements(tree).find(node => node.type === "button" && text(node) === label);
  if (!found?.props.onClick) throw new Error(`Missing ${label} button`);
  return found;
}
function labelledButton(tree: React.ReactElement, label: string) {
  const found = elements(tree).find(node => node.type === "button" && node.props["aria-label"] === label);
  if (!found?.props.onClick) throw new Error(`Missing ${label} button`);
  return found;
}
function control(tree: React.ReactElement, type: "select" | "textarea", label?: string) {
  const found = elements(tree).find(node => node.type === type && (!label || node.props["aria-label"] === label));
  if (!found?.props.onChange) throw new Error(`Missing ${type} control`);
  return found;
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const summary = (revision = "document-one", renderColumns = 80): PlanDocumentSummary => ({
  documentRevision: revision, renderColumns, canUndo: true, feedback: "",
  sections: [{ sectionId: "section-one", level: 1, title: "Section one", annotationCount: 0 },
    { sectionId: "section-two", level: 1, title: "Section two", annotationCount: 0 }],
  toc: ["section-one", "section-two"],
});
const section = (rows = 2, revision = "document-one"): PlanDocumentSection => ({
  documentRevision: revision, renderColumns: 80, sectionId: "section-one", level: 1, title: "Section one", annotationCount: 0,
  rows: Array.from({ length: rows }, (_, index) => ({ rowId: `row-${index + 1}`, text: `Rendered row ${index + 1}`, truncated: false, annotationIds: [] })),
  annotations: [],
});
function model(read: (sectionId: string) => Promise<PlanDocumentSection>, mutations: PlanDocumentAction[]) {
  return { readDocumentSection: read, mutateDocument: async (action: PlanDocumentAction) => {
    mutations.push(action); return { outcome: "applied" };
  } } as unknown as PlanReviewModel;
}

test("selects an owned native section and sends exact whole-section and rendered-row annotation identities", async () => {
  const mutations: PlanDocumentAction[] = [], reads: string[] = [], held = Promise.withResolvers<PlanDocumentSection>();
  const d = driver(), props = { document: summary(), model: model(async id => { reads.push(id); return held.promise; }, mutations), disabled: false, ownerKey: "owner-one" };
  try {
    let tree = d.render(props); button(tree, "Sections and annotations").props.onClick!(); tree = d.render(props);
    control(tree, "select", "Plan section").props.onChange!({ target: { value: "section-one" } });
    tree = d.render(props); expect(elements(tree).some(node => node.props["aria-label"] === "Plan section" && node.props.disabled)).toBe(false);
    expect(elements(tree).some(node => node.type === "p" && node.props.children === "Reading the native Plan section…")).toBe(true);
    expect(reads).toEqual(["section-one"]); held.resolve(section()); await settle();

    tree = d.render(props); control(tree, "textarea").props.onChange!({ target: { value: "Whole section note" } });
    tree = d.render(props); button(tree, "Add annotation").props.onClick!(); await settle();
    expect(mutations[0]).toEqual({ kind: "annotate", expectedDocumentRevision: "document-one",
      target: { kind: "section", sectionId: "section-one" }, note: "Whole section note" });

    tree = d.render(props); labelledButton(tree, "Rendered line 2: Rendered row 2").props.onClick!();
    control(d.render(props), "textarea").props.onChange!({ target: { value: "Rendered line note" } });
    tree = d.render(props); button(tree, "Add annotation").props.onClick!(); await settle();
    expect(mutations[1]).toEqual({ kind: "annotate", expectedDocumentRevision: "document-one",
      target: { kind: "line", sectionId: "section-one", rowId: "row-2" }, note: "Rendered line note" });
  } finally { d.dispose(); }
});

test("requires delete confirmation, preserves cancellation, and forwards native undo", async () => {
  const mutations: PlanDocumentAction[] = [], d = driver();
  const props = { document: summary(), model: model(async () => section(), mutations), disabled: false, ownerKey: "owner-one" };
  try {
    let tree = d.render(props); button(tree, "Sections and annotations").props.onClick!(); tree = d.render(props);
    control(tree, "select", "Plan section").props.onChange!({ target: { value: "section-one" } }); await settle();
    tree = d.render(props); button(tree, "Delete section…").props.onClick!(); tree = d.render(props);
    expect(elements(tree).some(node => node.props["aria-label"] === "Confirm deleting Plan section")).toBe(true);
    button(tree, "Cancel").props.onClick!(); expect(mutations).toEqual([]);
    tree = d.render(props); button(tree, "Delete section…").props.onClick!(); tree = d.render(props);
    button(tree, "Delete section and nested sections").props.onClick!(); await settle();
    button(d.render(props), "Undo plan change").props.onClick!(); await settle();
    expect(mutations).toEqual([
      { kind: "delete-section", expectedDocumentRevision: "document-one", sectionId: "section-one" },
      { kind: "undo", expectedDocumentRevision: "document-one" },
    ]);
  } finally { d.dispose(); }
});

test("keeps unsent notes per owner through projection refresh and read error while discarding a late prior-owner section", async () => {
  const mutations: PlanDocumentAction[] = [], held = Promise.withResolvers<PlanDocumentSection>();
  let rejectRead = false;
  const d = driver(), firstModel = model(() => held.promise, mutations);
  try {
    let props = { document: summary(), model: firstModel, disabled: false, ownerKey: "owner-one" };
    let tree = d.render(props); button(tree, "Sections and annotations").props.onClick!(); tree = d.render(props);
    control(tree, "textarea").props.onChange!({ target: { value: "Unsent local note" } });
    control(d.render(props), "select", "Plan section").props.onChange!({ target: { value: "section-one" } });
    props = { ...props, ownerKey: "owner-two", document: summary("document-two"),
      model: model(async () => { if (rejectRead) throw new Error("Controlled section refusal"); return section(2, "document-two"); }, mutations) };
    tree = d.render(props); held.resolve(section()); await settle(); tree = d.render(props);
    expect(control(tree, "textarea").props.value).toBe("");
    expect(elements(tree).some(node => node.props["aria-label"] === "OMP rendered lines")).toBe(false);

    control(tree, "textarea").props.onChange!({ target: { value: "Owner two note" } }); tree = d.render(props);
    rejectRead = true; control(tree, "select", "Plan section").props.onChange!({ target: { value: "section-one" } }); await settle();
    tree = d.render(props); expect(control(tree, "textarea").props.value).toBe("Owner two note");
    expect(elements(tree).some(node => node.type === "p" && node.props.children === "Controlled section refusal")).toBe(true);

    props = { ...props, ownerKey: "owner-one", document: summary(), model: firstModel };
    tree = d.render(props); expect(control(tree, "textarea").props.value).toBe("Unsent local note");
  } finally { d.dispose(); }
});

test("a late successful mutation for the prior owner cannot clear the current owner's identical unsent note", async () => {
  const held = Promise.withResolvers<{ outcome: "applied" }>(), d = driver();
  const first = { readDocumentSection: async () => section(), mutateDocument: () => held.promise } as unknown as PlanReviewModel;
  const second = model(async () => section(2, "document-two"), []);
  try {
    let props = { document: summary(), model: first, disabled: false, ownerKey: "owner-one" };
    let tree = d.render(props); button(tree, "Sections and annotations").props.onClick!(); tree = d.render(props);
    control(tree, "select", "Plan section").props.onChange!({ target: { value: "section-one" } }); await settle();
    tree = d.render(props); control(tree, "textarea").props.onChange!({ target: { value: "Identical unsent note" } });
    button(d.render(props), "Add annotation").props.onClick!();

    props = { document: summary("document-two"), model: second, disabled: false, ownerKey: "owner-two" };
    tree = d.render(props); control(tree, "textarea").props.onChange!({ target: { value: "Identical unsent note" } });
    held.resolve({ outcome: "applied" }); await settle();
    expect(control(d.render(props), "textarea").props.value).toBe("Identical unsent note");
  } finally { d.dispose(); }
});

test("page navigation clears the prior rendered-row annotation target", async () => {
  const mutations: PlanDocumentAction[] = [], d = driver();
  const props = { document: summary(), model: model(async () => section(201), mutations), disabled: false, ownerKey: "owner-one" };
  try {
    let tree = d.render(props); button(tree, "Sections and annotations").props.onClick!(); tree = d.render(props);
    control(tree, "select", "Plan section").props.onChange!({ target: { value: "section-one" } }); await settle();
    tree = d.render(props); labelledButton(tree, "Rendered line 1: Rendered row 1").props.onClick!();
    tree = d.render(props); expect(text(elements(tree).find(node => node.type === "label" && text(node).startsWith("Line annotation")))).toContain("Line annotation");
    button(tree, "Next lines").props.onClick!(); tree = d.render(props);
    expect(elements(tree).some(node => node.props["aria-label"] === "Rendered line 201: Rendered row 201")).toBe(true);
    expect(text(elements(tree).find(node => node.type === "label" && text(node).startsWith("Section annotation")))).toContain("Section annotation");
  } finally { d.dispose(); }
});
