/** Wire projection of the native Plan document owner. IDs and rendered rows
 * come from OMP; clients neither parse those IDs nor calculate native hashes. */
export interface PlanDocumentSectionSummary {
  sectionId: string; level: number; title: string; annotationCount: number;
}
export interface PlanDocumentSummary {
  documentRevision: string; renderColumns: number; canUndo: boolean; feedback: string;
  sections: PlanDocumentSectionSummary[]; toc: string[];
}
export interface PlanDocumentRow { rowId: string; text: string; truncated: boolean; annotationIds: string[] }
export interface PlanDocumentAnnotation {
  annotationId: string; note: string;
  target: { kind: "section" } | { kind: "line"; rowId: string };
}
export interface PlanDocumentSection extends PlanDocumentSectionSummary {
  documentRevision: string; renderColumns: number; rows: PlanDocumentRow[]; annotations: PlanDocumentAnnotation[];
}
export type PlanDocumentAction =
  | { kind: "delete-section"; expectedDocumentRevision: string; sectionId: string }
  | { kind: "annotate"; expectedDocumentRevision: string;
      target: { kind: "section"; sectionId: string } | { kind: "line"; sectionId: string; rowId: string }; note: string }
  | { kind: "undo"; expectedDocumentRevision: string };
export interface PlanDocumentSelection {
  documentRevision: string; renderColumns: number; sectionId: string;
}

export const MAX_PLAN_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_PLAN_DOCUMENT_ROWS = 20_000;
export const MAX_PLAN_DOCUMENT_ANNOTATIONS = 1_000;
export const MAX_PLAN_ANNOTATION_BYTES = 500_000;
const encoder = new TextEncoder();
function invalid(field: string): never { throw new Error(`Invalid native Plan document ${field}.`); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("object");
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid("keys");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || !empty && !value.length || typeof value === "string"
    && (value.includes("\0") || encoder.encode(value).byteLength > max)) return invalid("text");
  return value;
}
export function parsePlanDocumentId(value: unknown): string { return text(value, 256); }
export function parsePlanRenderColumns(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 20 || Number(value) > 240) return invalid("render columns");
  return Number(value);
}
function integer(value: unknown, max: number): number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max ? Number(value) : invalid("integer");
}
function bool(value: unknown): boolean { return typeof value === "boolean" ? value : invalid("boolean"); }
function array<T>(value: unknown, max: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) return invalid("array");
  // Array.from visits holes too: sparse unknown input is never acknowledged.
  return Array.from(value, parse);
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) invalid("duplicate identity");
}
function bounded<T>(value: T): T {
  if (encoder.encode(JSON.stringify(value)).byteLength > MAX_PLAN_DOCUMENT_BYTES) return invalid("projection size");
  return value;
}
function sectionSummary(value: unknown): PlanDocumentSectionSummary {
  const v = record(value, ["sectionId", "level", "title", "annotationCount"]);
  return { sectionId: parsePlanDocumentId(v.sectionId), level: integer(v.level, 6), title: text(v.title, MAX_PLAN_DOCUMENT_BYTES, true),
    annotationCount: integer(v.annotationCount, MAX_PLAN_DOCUMENT_ANNOTATIONS) };
}
function selection(value: Record<string, unknown>): PlanDocumentSelection {
  return { documentRevision: parsePlanDocumentId(value.documentRevision), renderColumns: parsePlanRenderColumns(value.renderColumns),
    sectionId: parsePlanDocumentId(value.sectionId) };
}
export function parsePlanDocumentSelection(value: unknown): PlanDocumentSelection {
  return selection(record(value, ["documentRevision", "renderColumns", "sectionId"]));
}
export function parsePlanDocumentSummary(value: unknown): PlanDocumentSummary {
  const v = record(value, ["documentRevision", "renderColumns", "canUndo", "feedback", "sections", "toc"]);
  const sections = array(v.sections, MAX_PLAN_DOCUMENT_ROWS, sectionSummary);
  const toc = array(v.toc, MAX_PLAN_DOCUMENT_ROWS, parsePlanDocumentId);
  unique(sections.map(section => section.sectionId)); unique(toc);
  const headings = new Set(sections.filter(section => section.level > 0).map(section => section.sectionId));
  if (toc.some(id => !headings.has(id))) return invalid("outline owner");
  if (sections.reduce((total, section) => total + section.annotationCount, 0) > MAX_PLAN_DOCUMENT_ANNOTATIONS)
    return invalid("annotation count");
  return bounded({ documentRevision: parsePlanDocumentId(v.documentRevision), renderColumns: parsePlanRenderColumns(v.renderColumns),
    canUndo: bool(v.canUndo), feedback: text(v.feedback, MAX_PLAN_DOCUMENT_BYTES, true), sections, toc });
}
export function parsePlanDocumentSection(value: unknown, expected: PlanDocumentSelection): PlanDocumentSection {
  const v = record(value, ["documentRevision", "renderColumns", "sectionId", "level", "title", "annotationCount", "rows", "annotations"]);
  const owner = selection(v), captured = parsePlanDocumentSelection(expected);
  if (owner.documentRevision !== captured.documentRevision || owner.renderColumns !== captured.renderColumns || owner.sectionId !== captured.sectionId)
    return invalid("section owner");
  const summary = sectionSummary({ sectionId: v.sectionId, level: v.level, title: v.title, annotationCount: v.annotationCount });
  const rows = array(v.rows, MAX_PLAN_DOCUMENT_ROWS, raw => {
    const row = record(raw, ["rowId", "text", "truncated", "annotationIds"]);
    const annotationIds = array(row.annotationIds, MAX_PLAN_DOCUMENT_ANNOTATIONS, parsePlanDocumentId); unique(annotationIds);
    return { rowId: parsePlanDocumentId(row.rowId), text: text(row.text, MAX_PLAN_DOCUMENT_BYTES, true), truncated: bool(row.truncated), annotationIds };
  });
  const annotations = array<PlanDocumentAnnotation>(v.annotations, MAX_PLAN_DOCUMENT_ANNOTATIONS, raw => {
    const annotation = record(raw, ["annotationId", "note", "target"]), target = record(annotation.target, ["kind", "rowId"]);
    let parsed: PlanDocumentAnnotation["target"];
    if (target.kind === "section") { record(target, ["kind"]); parsed = { kind: "section" }; }
    else if (target.kind === "line") parsed = { kind: "line", rowId: parsePlanDocumentId(target.rowId) };
    else return invalid("annotation target");
    return { annotationId: parsePlanDocumentId(annotation.annotationId), note: text(annotation.note, MAX_PLAN_ANNOTATION_BYTES), target: parsed };
  });
  unique(rows.map(row => row.rowId)); unique(annotations.map(annotation => annotation.annotationId));
  if (summary.annotationCount !== annotations.length) return invalid("annotation count");
  const rowIds = new Set(rows.map(row => row.rowId));
  const byId = new Map(annotations.map(annotation => [annotation.annotationId, annotation]));
  for (const annotation of annotations) {
    if (annotation.target.kind === "line" && !rowIds.has(annotation.target.rowId)) return invalid("annotation row");
  }
  for (const row of rows) for (const id of row.annotationIds) {
    const annotation = byId.get(id);
    if (!annotation || annotation.target.kind !== "line" || annotation.target.rowId !== row.rowId) return invalid("row annotation");
  }
  for (const annotation of annotations) if (annotation.target.kind === "line") {
    const rowId = annotation.target.rowId;
    if (!rows.find(row => row.rowId === rowId)?.annotationIds.includes(annotation.annotationId)) return invalid("missing row annotation");
  }
  return bounded({ ...summary, ...owner, rows, annotations });
}
export function parsePlanDocumentAction(value: unknown): PlanDocumentAction {
  const v = record(value, ["kind", "expectedDocumentRevision", "sectionId", "target", "note"]);
  const expectedDocumentRevision = parsePlanDocumentId(v.expectedDocumentRevision);
  if (v.kind === "undo") { record(v, ["kind", "expectedDocumentRevision"]); return { kind: "undo", expectedDocumentRevision }; }
  if (v.kind === "delete-section") {
    record(v, ["kind", "expectedDocumentRevision", "sectionId"]);
    return { kind: "delete-section", expectedDocumentRevision, sectionId: parsePlanDocumentId(v.sectionId) };
  }
  if (v.kind === "annotate") {
    record(v, ["kind", "expectedDocumentRevision", "target", "note"]);
    const t = record(v.target, ["kind", "sectionId", "rowId"]), sectionId = parsePlanDocumentId(t.sectionId);
    const note = text(v.note, MAX_PLAN_ANNOTATION_BYTES);
    if (!note.trim()) return invalid("empty annotation");
    if (t.kind === "section") {
      record(t, ["kind", "sectionId"]); return { kind: "annotate", expectedDocumentRevision, target: { kind: "section", sectionId }, note };
    }
    if (t.kind === "line") return { kind: "annotate", expectedDocumentRevision, target: { kind: "line", sectionId, rowId: parsePlanDocumentId(t.rowId) }, note };
  }
  return invalid("action");
}
