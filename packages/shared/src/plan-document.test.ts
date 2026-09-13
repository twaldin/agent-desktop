import { expect, test } from "bun:test";
import { MAX_PLAN_DOCUMENT_BYTES, parsePlanDocumentAction, parsePlanDocumentSection, parsePlanDocumentSummary,
  type PlanDocumentSection, type PlanDocumentSummary } from "./plan-document";

const selection = { documentRevision: "owner-document-3", renderColumns: 80, sectionId: "native-section-2" };
const section: PlanDocumentSection = { ...selection, title: "Original section", level: 2, annotationCount: 2,
  rows: [{ rowId: "native-row-1", text: "Wrapped native context", truncated: false, annotationIds: ["line-note"] }],
  annotations: [{ annotationId: "section-note", note: "Keep this section", target: { kind: "section" } },
    { annotationId: "line-note", note: "Explain this step", target: { kind: "line", rowId: "native-row-1" } }] };
const summary: PlanDocumentSummary = { documentRevision: selection.documentRevision, renderColumns: 80, canUndo: true, feedback: "Native feedback",
  sections: [{ sectionId: "preamble", level: 0, title: "", annotationCount: 0 },
    { sectionId: selection.sectionId, level: 2, title: "Original section", annotationCount: 2 }], toc: [selection.sectionId] };

test("A late section reply cannot cross a document mutation, selected section, or rendering width", () => {
  expect(parsePlanDocumentSection(section, selection).rows[0]?.text).toBe("Wrapped native context");
  for (const changed of [{ documentRevision: "owner-document-4" }, { sectionId: "native-section-3" }, { renderColumns: 120 }]) {
    expect(() => parsePlanDocumentSection(section, { ...selection, ...changed })).toThrow("section owner");
  }
});

test("Native rows and annotations are isolated in both directions across the wire", () => {
  const raw = structuredClone(section), parsed = parsePlanDocumentSection(raw, selection);
  raw.rows[0]!.annotationIds.push("foreign"); raw.annotations[1]!.note = "Caller mutation";
  expect(parsed.rows[0]!.annotationIds).toEqual(["line-note"]);
  expect(parsed.annotations[1]!.note).toBe("Explain this step");
  parsed.rows[0]!.text = "Receiver mutation";
  parsed.annotations[1]!.target = { kind: "line", rowId: "foreign" };
  expect(raw.rows[0]!.text).toBe("Wrapped native context");
  expect(raw.annotations[1]!.target).toEqual({ kind: "line", rowId: "native-row-1" });
});

test("Malformed row ownership is refused rather than attaching feedback to a convenient row", () => {
  const variants = [
    { ...section, rows: [...section.rows, ...section.rows] },
    { ...section, annotations: [...section.annotations, ...section.annotations] },
    { ...section, rows: [{ ...section.rows[0]!, annotationIds: ["section-note"] }] },
    { ...section, rows: [{ ...section.rows[0]!, annotationIds: [] }] },
    { ...section, annotations: [section.annotations[0]!, { ...section.annotations[1]!, target: { kind: "line", rowId: "another-section-row" } }] },
  ];
  for (const malformed of variants) expect(() => parsePlanDocumentSection(malformed, selection)).toThrow();
});

test("Sparse or foreign outlines and rows are rejected before consumers can acknowledge them", () => {
  expect(() => parsePlanDocumentSummary({ ...summary, sections: new Array(1) })).toThrow();
  expect(() => parsePlanDocumentSummary({ ...summary, toc: ["preamble"] })).toThrow("outline owner");
  expect(() => parsePlanDocumentSummary({ ...summary, toc: [selection.sectionId, selection.sectionId] })).toThrow("duplicate identity");
  expect(() => parsePlanDocumentSection({ ...section, rows: new Array(1) }, selection)).toThrow();
  const parsed = parsePlanDocumentSummary(summary);
  parsed.sections[1]!.title = "Changed consumer"; parsed.toc.length = 0;
  expect(summary.sections[1]!.title).toBe("Original section"); expect(summary.toc).toEqual([selection.sectionId]);
});

test("Document actions carry the captured owner revision and native IDs, never client paths or source offsets", () => {
  const action = { kind: "annotate", expectedDocumentRevision: selection.documentRevision,
    target: { kind: "line", sectionId: selection.sectionId, rowId: "native-row-1" }, note: "Keep `original`\ncontext" } as const;
  expect(parsePlanDocumentAction(action)).toEqual(action);
  expect(() => parsePlanDocumentAction({ ...action, expectedDocumentRevision: undefined })).toThrow();
  expect(() => parsePlanDocumentAction({ ...action, target: { ...action.target, sourceLine: 8 } })).toThrow("keys");
  expect(() => parsePlanDocumentAction({ ...action, path: "/another/plan.md" })).toThrow("keys");
  expect(() => parsePlanDocumentAction({ ...action, note: " \n " })).toThrow("empty annotation");
});

test("Escaped UTF-8 projection limits refuse the whole response without silently truncating context", () => {
  // Each individual note is within its bound; their combined escaped payload is not.
  const note = "\t".repeat(490_000);
  const huge = { ...section, annotationCount: 3, rows: [], annotations: [1, 2, 3].map(id => ({
    annotationId: `note-${id}`, note, target: { kind: "section" as const },
  })) };
  expect(new TextEncoder().encode(JSON.stringify(huge)).length).toBeGreaterThan(MAX_PLAN_DOCUMENT_BYTES);
  expect(() => parsePlanDocumentSection(huge, selection)).toThrow("projection size");
  expect(huge.annotations[0]!.note.length).toBe(490_000);
});
