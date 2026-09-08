import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons";
import { TranscriptTableIcon } from "./TranscriptTableIcons";
import { copyTranscriptTable } from "./transcript-table-copy";
import "./transcript-markdown-table.css";

/** Transcript table controls operate on this table's original source and rendered cells. */
export function TranscriptMarkdownTable({ children, markdownSource, allowWideBlocks = false }: { children: ReactNode; markdownSource: string; allowWideBlocks?: boolean }) {
  const table = useRef<HTMLTableElement>(null), expand = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false), [portalTarget, setPortalTarget] = useState<HTMLElement>();
  const [copyState, setCopyState] = useState<"idle" | "pending" | "copied" | "failed">("idle"), [copyError, setCopyError] = useState<string>();
  const mounted = useRef(true), copying = useRef(false), currentSource = useRef(markdownSource), reset = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const beganOnBlankViewport = useRef(false);
  currentSource.current = markdownSource;
  useEffect(() => { mounted.current = true; setPortalTarget(table.current?.ownerDocument.body); return () => { mounted.current = false; clearTimeout(reset.current); }; }, []);
  useEffect(() => { clearTimeout(reset.current); setCopyState("idle"); setCopyError(undefined); }, [markdownSource]);
  useEffect(() => { if (!allowWideBlocks) setOpen(false); }, [allowWideBlocks]);
  useEffect(() => {
    const node = dialog.current;
    if (open && node && !node.open) node.showModal();
    if (!open && node?.open) node.close();
  }, [open, portalTarget]);
  const close = () => { setOpen(false); requestAnimationFrame(() => expand.current?.focus({preventScroll:true})); };
  const copy = async () => {
    if (copying.current || !table.current || copyState === "copied") return;
    copying.current = true; clearTimeout(reset.current); setCopyState("pending"); setCopyError(undefined);
    const source = markdownSource;
    try {
      await copyTranscriptTable(table.current, source);
      if (mounted.current && currentSource.current === source) {
        setCopyState("copied"); reset.current = setTimeout(() => { if (mounted.current) setCopyState("idle"); }, 2000);
      }
    } catch (cause) {
      if (mounted.current && currentSource.current === source) { setCopyState("failed"); setCopyError(cause instanceof Error ? cause.message : "Could not copy this table."); }
    } finally { copying.current = false; }
  };
  const copyLabel = copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed · retry" : "Copy table";
  return <div className="transcript-markdown-table" data-markdown-table="true" data-wide-block={allowWideBlocks ? "" : undefined} tabIndex={-1}>
    <div className="markdown-table-scroll" role="region" aria-label="Markdown table" tabIndex={0}><div className="markdown-table-wrapper"><table ref={table} dir="auto">{children}</table></div></div>
    <div className="markdown-table-actions" data-markdown-copy="exclude"><div className="markdown-table-action-group">
      {allowWideBlocks && <button ref={expand} type="button" aria-label="Expand table" title="Expand table" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><TranscriptTableIcon name="expand"/></button>}
      <button type="button" aria-label={copyLabel} title={copyLabel} aria-busy={copyState === "pending"} disabled={copyState === "pending"} onClick={() => void copy()}>{copyState === "copied" ? <Icon name="check"/> : <TranscriptTableIcon name="copy"/>}</button>
    </div></div>
    {copyError && <p className="markdown-table-copy-error" role="alert" data-markdown-copy="exclude">{copyError} <button type="button" onClick={() => void copy()}>Retry</button></p>}
    {portalTarget && open && createPortal(<dialog ref={dialog} className="transcript-table-dialog" aria-label="Table preview" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <button type="button" className="icon-button transcript-table-close" aria-label="Close table preview" title="Close table preview" onClick={close}><Icon name="close"/></button>
      <div className="transcript-table-preview-viewport" onPointerDown={event => { beganOnBlankViewport.current = event.target === event.currentTarget; }} onClick={event => { if (beganOnBlankViewport.current && event.target === event.currentTarget) close(); beganOnBlankViewport.current = false; }}>
        <div className="transcript-markdown transcript-table-preview"><div className="markdown-table-scroll" role="region" aria-label="Expanded Markdown table" tabIndex={0}><div className="markdown-table-preview-body"><table dir="auto">{children}</table><div className="markdown-table-bottom-mask" aria-hidden="true"/></div><div className="markdown-table-end-mask" aria-hidden="true"/></div></div>
      </div>
    </dialog>, portalTarget)}
  </div>;
}
