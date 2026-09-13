import { useLayoutEffect, useRef, useState } from "react";
import type { PlanDocumentSection, PlanDocumentSummary } from "../../../../packages/shared/src/plan-document";
import type { PlanReviewModel } from "./plan-review-model";
import "./plan-document-review.css";

const PAGE_ROWS = 200;
/** OMP owns these section and rendered-row identities. The rich Markdown
 * preview is presentation; its source positions never identify annotations. */
export function PlanDocumentReview({ document, model, disabled, ownerKey }: {
  document: PlanDocumentSummary; model: PlanReviewModel; disabled: boolean; ownerKey: string;
}) {
  const [section, setSection] = useState<PlanDocumentSection>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [rowId, setRowId] = useState<string>();
  const notes = useRef(new Map<string, string>());
  const [noteDraft, setNoteDraft] = useState({ ownerKey, text: "" });
  const note = noteDraft.ownerKey === ownerKey ? noteDraft.text : notes.current.get(ownerKey) ?? "";
  const setNote = (text: string) => { notes.current.set(ownerKey, text); setNoteDraft({ ownerKey, text }); };
  const [page, setPage] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [open, setOpen] = useState(false);
  const generation = useRef(0);
  const outline = useRef<HTMLSelectElement>(null);
  const current = useRef({ ownerKey, revision: document.documentRevision, disabled });
  useLayoutEffect(() => {
    current.current = { ownerKey, revision: document.documentRevision, disabled };
    generation.current++; setPending(undefined); setSection(undefined); setRowId(undefined); setDeleting(false); setPage(0); setError(undefined);
    setNoteDraft({ ownerKey, text: notes.current.get(ownerKey) ?? "" });
    // Preserve each original owner's note across refresh and navigation.
  }, [ownerKey, document.documentRevision, document.renderColumns, disabled]);
  useLayoutEffect(() => () => { generation.current++; }, []);
  const select = async (sectionId: string) => {
    const token = ++generation.current;
    setPending(sectionId); setError(undefined); setSection(undefined); setRowId(undefined); setDeleting(false); setPage(0);
    try {
      const result = await model.readDocumentSection(sectionId);
      if (generation.current === token && !current.current.disabled && current.current.ownerKey === ownerKey
        && current.current.revision === document.documentRevision) setSection(result);
    } catch (cause) {
      if (generation.current === token) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (generation.current === token) setPending(undefined); }
  };
  const selected = section?.documentRevision === document.documentRevision && section.renderColumns === document.renderColumns ? section : undefined;
  const inactive = disabled || !!pending || deleting;
  const annotate = async () => {
    if (!selected || inactive || !note.trim()) return;
    const sent = note;
    const receipt = await model.mutateDocument({ kind: "annotate", expectedDocumentRevision: document.documentRevision,
      target: rowId ? { kind: "line", sectionId: selected.sectionId, rowId } : { kind: "section", sectionId: selected.sectionId }, note: sent });
    if (receipt?.outcome === "applied" && notes.current.get(ownerKey) === sent) {
      notes.current.set(ownerKey, "");
      if (current.current.ownerKey === ownerKey) setNoteDraft({ ownerKey, text: "" });
    }
  };
  const headings = new Map(document.sections.map(item => [item.sectionId, item]));
  const rows = selected?.rows.slice(page * PAGE_ROWS, (page + 1) * PAGE_ROWS) ?? [];
  const pages = Math.ceil((selected?.rows.length ?? 0) / PAGE_ROWS);
  return <section className="plan-document-review" aria-label="Plan sections and annotations" onKeyDown={event => {
    if (event.key === "Escape" && deleting) { event.preventDefault(); event.stopPropagation(); setDeleting(false); outline.current?.focus(); }
  }}>
    <div className="plan-document-actions">
      <button type="button" aria-expanded={open} onClick={() => { setOpen(value => !value); setDeleting(false); }}>Sections and annotations</button>
      <button type="button" disabled={inactive || !document.canUndo} onClick={() => void model.mutateDocument({ kind: "undo", expectedDocumentRevision: document.documentRevision })}>Undo plan change</button>
    </div>
    {open && <>
      <label className="plan-document-outline">Plan section
        <select ref={outline} aria-label="Plan section" value={selected?.sectionId ?? pending ?? ""} disabled={disabled || deleting}
          onChange={event => { if (event.target.value) void select(event.target.value); }}>
          <option value="" disabled>Choose a section</option>
          {document.toc.map(id => { const item = headings.get(id)!; return <option key={id} value={id}>{"— ".repeat(Math.max(0, item.level - 1))}{item.title}{item.annotationCount ? ` (${item.annotationCount} notes)` : ""}</option>; })}
          {document.sections.filter(item => !document.toc.includes(item.sectionId)).map(item => <option key={item.sectionId} value={item.sectionId}>{item.title || "Preamble"}{item.annotationCount ? ` (${item.annotationCount} notes)` : ""}</option>)}
        </select>
      </label>
      {pending && <p role="status">Reading the native Plan section…</p>}
      {error && <p role="alert">{error}</p>}
      {selected && <>
        <div className="plan-document-actions"><strong>{selected.title || "Preamble"}</strong>
          <button type="button" disabled={inactive || !document.toc.includes(selected.sectionId)} onClick={() => setDeleting(true)}>Delete section…</button></div>
        {deleting && <div role="group" aria-label="Confirm deleting Plan section" className="plan-document-confirmation">
          <p role="alert">Delete “{selected.title}” and its nested sections from the plan? You can undo this change.</p>
          <button type="button" autoFocus disabled={disabled} onClick={() => { setDeleting(false); outline.current?.focus(); }}>Cancel</button>
          <button type="button" disabled={disabled} onClick={() => void model.mutateDocument({ kind: "delete-section", expectedDocumentRevision: document.documentRevision, sectionId: selected.sectionId })}>Delete section and nested sections</button>
        </div>}
        <p className="plan-document-caption">Choose a rendered line for a line note, or annotate the whole section. OMP renders these lines at {selected.renderColumns} columns.</p>
        <button type="button" aria-pressed={!rowId} disabled={inactive} onClick={() => setRowId(undefined)}>Annotate whole section</button>
        <div className="plan-document-rows" role="group" aria-label="OMP rendered lines">
          {rows.map((row, index) => <button key={row.rowId} type="button" aria-pressed={rowId === row.rowId} disabled={inactive}
            aria-label={`Rendered line ${page * PAGE_ROWS + index + 1}: ${row.text}${row.truncated ? " (truncated context)" : ""}`}
            onClick={() => setRowId(row.rowId)}><span aria-hidden="true">{page * PAGE_ROWS + index + 1}</span><code>{row.text || "(blank line)"}{row.truncated ? "…" : ""}</code>{row.annotationIds.length > 0 && <span>{row.annotationIds.length} notes</span>}</button>)}
        </div>
        {pages > 1 && <nav className="plan-document-actions" aria-label="Rendered line pages">
          <button type="button" disabled={page === 0 || inactive} onClick={() => { setPage(value => value - 1); setRowId(undefined); }}>Previous lines</button>
          <span>Rows {page * PAGE_ROWS + 1}–{Math.min((page + 1) * PAGE_ROWS, selected.rows.length)} of {selected.rows.length}</span>
          <button type="button" disabled={page + 1 >= pages || inactive} onClick={() => { setPage(value => value + 1); setRowId(undefined); }}>Next lines</button>
        </nav>}
        {selected.annotations.length > 0 && <ul className="plan-document-notes" aria-label="Saved Plan annotations">{selected.annotations.map(annotation => <li key={annotation.annotationId}>
          <strong>{annotation.target.kind === "section" ? "Section note" : "Line note"}</strong><p>{annotation.note}</p>
        </li>)}</ul>}
      </>}
      <label className="plan-document-note">{rowId ? "Line annotation" : "Section annotation"}
        <textarea value={note} disabled={disabled || deleting} onChange={event => setNote(event.target.value)} placeholder="What should change?"/></label>
      <button type="button" disabled={inactive || !selected || !note.trim()} onClick={() => void annotate()}>Add annotation</button>
      {document.feedback && <details className="plan-document-feedback"><summary>Refinement feedback</summary><pre>{document.feedback}</pre></details>}
    </>}
  </section>;
}
