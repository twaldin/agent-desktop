import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { DesktopBridge } from "@agent-desktop/shared";
import type { TreeMutationResult, TreeTicket } from "../../../../packages/shared/src/session-tree";
import { SessionTreeEditState, type TreeEditOwner } from "./session-tree-edit";
import type { SessionTreeState, SessionTreeView } from "./use-session-tree";
import { Icon } from "./Icons";
import { ComposerEditor, type ComposerEditorHandle } from "./ComposerEditor";
import "./session-tree.css";

export function SessionTreeHistory({ state, view, connected, onClose, onNavigate, onRestore, onResetContext }: {
  state: SessionTreeState; view: SessionTreeView; connected: boolean; onClose(): void;
  onRestore(commandId: string): void;
  onNavigate(targetId: string, summarize: boolean, customInstructions?: string): void;
  /** Hands the whole context reset to the owner, which confirms it and runs the native command. */
  onResetContext?(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState(""), [filter, setFilter] = useState("messages"), [selected, select] = useState<string>();
  const [summary, setSummary] = useState("none"), [instructions, setInstructions] = useState(""), [label, setLabel] = useState("");
  const [localError, setLocalError] = useState<string>();
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const entries = view.value?.entries ?? [], selectedEntry = entries.find(entry => entry.id === selected);
  const depths = new Map<string, number>(); entries.forEach(entry => depths.set(entry.id, entry.parentId ? (depths.get(entry.parentId) ?? 0) + 1 : 0));
  const rows = entries.filter(entry => (filter === "all" || filter === "labeled" && entry.label || filter === "user" && entry.kind === "user" || filter === "messages" && !entry.kind.startsWith("metadata:") && !["model_change", "thinking_level_change", "service_tier_change", "label"].includes(entry.kind))
    && `${entry.label ?? ""}\n${entry.kind}\n${entry.text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const blocked = !connected || !view.fresh || view.pending || view.uncertain || !!view.value?.reconciliationRequired || !!view.value?.busyReason;
  async function saveLabel() {
    if (!selected || !view.value) return;
    try { await state.mutate(view.owner, { sessionId: view.owner.sessionId, ticket: view.value.ticket, mutation: { action: "label", targetId: selected, label: label || null } }); }
    catch (cause) { setLocalError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return <dialog ref={dialog} className="app-dialog session-tree-history" aria-labelledby="history-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-header session-tree-heading"><h2 id="history-title">Conversation history</h2><button type="button" className="icon-button" aria-label="Close conversation history" onClick={onClose}><Icon name="close"/></button></div>
    <p className="session-tree-note">Navigate the native OMP tree. Earlier branches remain in this conversation.</p>
    <div className="session-tree-search"><input type="search" autoFocus aria-label="Search conversation history" placeholder="Search history" value={query} onChange={event => setQuery(event.target.value)}/><select aria-label="History filter" value={filter} onChange={event => setFilter(event.target.value)}><option value="messages">Messages</option><option value="user">Your messages</option><option value="labeled">Labeled</option><option value="all">All native entries</option></select></div>
    {view.loading && <p role="status">Loading native history…</p>}
    {!connected && <p role="status">Offline · reconnect to navigate.</p>}
    {(localError || view.error || view.readError || view.unavailable || view.value?.busyReason) && <p className="inline-error" role="alert">{localError || view.error || view.readError || view.unavailable || view.value?.busyReason}</p>}
    {view.original && <p role="status">The original history command is {view.receipt?.state ?? "pending"}. Check status before making another change.</p>}
    <ul className="session-tree-list" aria-label="Native conversation branches">{rows.map(entry => <li key={entry.id}>
      <button type="button" aria-pressed={selected === entry.id} data-entry-id={entry.id} data-active-branch={entry.active} style={{ paddingInlineStart: `${12 + Math.min(depths.get(entry.id) ?? 0, 8) * 12}px` }} onClick={() => { select(entry.id); setLabel(entry.label ?? ""); setLocalError(undefined); }}>
        <span className="session-tree-node" aria-hidden="true">{view.value?.leafId === entry.id ? "●" : entry.active ? "│" : "├"}</span>
        <span className="session-tree-row-text"><strong>{entry.label || (entry.kind === "user" ? "You" : entry.kind === "assistant" ? "Assistant" : entry.kind)}</strong><span>{entry.text || `${entry.kind} entry`}</span>{entry.imageCount > 0 && <small>{entry.imageCount} image{entry.imageCount === 1 ? "" : "s"}</small>}</span>
        {view.value?.leafId === entry.id && <small>Current</small>}
      </button>
    </li>)}</ul>
    {!view.loading && !rows.length && <p>{entries.length ? "No matching entries." : "No entries in this conversation."}</p>}
    {selectedEntry && <div className="session-tree-selection"><label>Label<input value={label} maxLength={4096} onChange={event => setLabel(event.target.value)}/></label><button type="button" className="secondary-button" disabled={blocked} onClick={() => void saveLabel()}>Save label</button></div>}
    {selectedEntry && <label className="session-tree-summary">Branch summary<select aria-label="Branch summary" value={summary} onChange={event => setSummary(event.target.value)}><option value="none">No summary</option><option value="summary">Summarize</option><option value="custom">Summarize with custom prompt</option></select></label>}
    {selectedEntry && summary === "custom" && <textarea aria-label="Custom summary instructions" placeholder="Instructions for the native branch summary" value={instructions} onChange={event => setInstructions(event.target.value)}/>}
    {view.value?.recoveredDraft && <button type="button" className="secondary-button" disabled={!connected || view.pending} onClick={() => onRestore(view.value!.recoveredDraft!.commandId)}>Resume preserved edit</button>}
    <div className="dialog-footer"><button type="button" className="secondary-button" disabled={!connected || view.loading || view.pending} onClick={() => void state.refresh()}>Refresh{view.original ? " original status" : ""}</button>
      {onResetContext && <button type="button" className="secondary-button" disabled={blocked || !view.value || !view.resetSupported} title={view.resetSupported ? undefined : "The owning host and desktop must both support clearing native context."} onClick={onResetContext}>Clear context</button>}
      <button type="button" className="primary-button" disabled={blocked || !selectedEntry} onClick={() => { if (selected) onNavigate(selected, summary !== "none", summary === "custom" ? instructions : undefined); }}>{selectedEntry?.editable ? "Edit from here" : "Continue from here"}</button></div>
  </dialog>;
}

/** Presentation only: the owner holds the immutable reset intent, guards it and runs the
 * native command. This dialog never reads the latest ticket or draft and never dispatches. */
export function SessionTreeResetContext({ busy, disabled, error, onClose, onConfirm }: {
  busy: boolean; disabled: boolean; error?: string; onClose(): void; onConfirm(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  const close = () => { if (!busy) onClose(); };
  return <dialog ref={dialog} className="app-dialog session-tree-history" aria-labelledby="reset-context-title" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="dialog-header session-tree-heading"><h2 id="reset-context-title">Clear context</h2><button type="button" className="icon-button" aria-label="Close clear context" disabled={busy} onClick={close}><Icon name="close"/></button></div>
    <p className="session-tree-note">Clears the active context this conversation sends to the model. The native history stays in this conversation and remains readable here.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {busy && <p role="status">Clearing the active context…</p>}
    <div className="dialog-footer"><button type="button" className="secondary-button" disabled={busy} onClick={close}>Cancel</button>
      <button type="button" className="primary-button" disabled={busy || disabled} onClick={onConfirm}>Clear context</button></div>
  </dialog>;
}

export function SessionTreeEdit({ owner, initialText, imageCount, bridge, connected, prepared, originalTicket, onClose, onSent, onStop }: {
  owner: TreeEditOwner; initialText: string; imageCount: number; bridge: DesktopBridge; connected: boolean; prepared?: TreeMutationResult; originalTicket?: TreeTicket;
  onClose(): void; onSent(): void; onStop(): void;
}) {
  const state = useMemo(() => new SessionTreeEditState(owner, initialText, imageCount, bridge, localStorage, prepared, originalTicket), [owner.hostId, owner.sessionId, owner.targetId]);
  useEffect(() => { state.configure(connected); return () => state.disconnect(); }, [state, connected]);
  const view = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  const input = useRef<ComposerEditorHandle>(null);
  useEffect(() => { input.current?.focus(); }, [state]);
  useEffect(() => { if (view.sent) onSent(); }, [view.sent]);
  return <form className="session-tree-inline-edit" aria-label="Edit previous message" onSubmit={event => { event.preventDefault(); void state.send(); }}>
    <ComposerEditor inputRef={input} inputId={`history-edit-${owner.sessionId}-${owner.targetId}`} ariaLabel="Edit message" scope={JSON.stringify(owner)} text={view.text} placeholder="Edit message" disabled={view.busy || view.uncertain} onChange={value => state.update({ text: value.text })} onKeyDown={event => {
      if (event.key === "Escape" && !view.busy) { event.preventDefault(); state.cancel(); onClose(); }
      else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void state.send(); }
    }}/>

    {view.imageCount > 0 && <span className="session-tree-note">{view.imageCount} original image{view.imageCount === 1 ? "" : "s"} retained</span>}
    {!view.prepared && <div className="session-tree-inline-summary"><label><input type="checkbox" checked={view.summarize} disabled={view.busy || view.uncertain} onChange={event => state.update({ summarize: event.target.checked })}/>Summarize the previous branch</label>{view.summarize && <input aria-label="Custom summary instructions" placeholder="Custom summary instructions (optional)" value={view.customInstructions} disabled={view.busy || view.uncertain} onChange={event => state.update({ customInstructions: event.target.value })}/>}</div>}
    {view.error && <p className="inline-error" role="alert">{view.error}</p>}
    {view.busy && <p role="status">{view.prepared ? "Submitting edited message…" : "Preparing native history…"}</p>}
    <div className="session-tree-edit-actions"><button className="secondary-button" type="button" disabled={view.busy} onClick={() => { state.cancel(); onClose(); }}>{view.prepared || view.uncertain ? "Close · edit retained" : "Cancel"}</button>
      {view.error && !view.uncertain && <button className="secondary-button" type="button" disabled={!connected || view.busy} onClick={() => void state.reviewCurrent()}>Use current branch</button>}
      {(view.uncertain || view.prepared) && <button className="secondary-button" type="button" disabled={!connected || view.busy} onClick={() => void state.inspect()}>Check original command</button>}
      {view.busy ? <button className="secondary-button" type="button" onClick={() => { state.stop(); onStop(); }}>Stop</button> : <button className="primary-button" aria-label="Send edited message" type="submit" disabled={!connected || view.uncertain || !view.text.trim() && !view.imageCount}>Send</button>}
    </div>
  </form>;
}
