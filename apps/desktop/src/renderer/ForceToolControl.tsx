import { useEffect, useId, useRef, useState } from "react";
import { forcePhaseLabel, forceRecoveryReason, forceToolReason, sameForceTicket,
  type ForceToolOwner, type ForceToolPorts, type ForceToolRecovery, type ForceToolState, type ForceToolView } from "./force-tool-state";
import { useForceTool } from "./use-force-tool";
import "./force-tool.css";

export interface ForceToolControlProps {
  owner: ForceToolOwner; ports: ForceToolPorts; connected: boolean; active: boolean;
  ownerLabel?: string;
  draftText: string; recovery?: ForceToolRecovery;
}
export function ForceToolControl(props: ForceToolControlProps) {
  const { state, view } = useForceTool(props.owner, props.ports, props);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!open) return;
    const target = panel.current?.querySelector<HTMLElement>("select:not(:disabled)") ?? panel.current?.querySelector<HTMLElement>("textarea,button:not(:disabled)");
    target?.focus({ preventScroll: true });
    // Outside pointer dismissal leaves focus with the clicked destination.
    const outside = (event: PointerEvent) => {
      if (root.current && !event.composedPath().includes(root.current)) setOpen(false);
    };
    // Disabled controls can move focus to the body while a request settles.
    // Escape still belongs to this open surface and restores its trigger.
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); close();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  useEffect(() => { setOpen(false); }, [props.owner.hostId, props.owner.sessionId, props.active]);
  return <section ref={root} className="force-tool-control" aria-label="Native force tool">
    <button type="button" ref={trigger} className="composer-selection-trigger" aria-expanded={open} aria-controls={id}
      onClick={() => { if (open) close(); else { setOpen(true); void state.refresh(); } }}>Force next tool</button>
    {!!view.snapshot?.directives.length && <span className="force-tool-count" role="status">{view.snapshot.directives.length} pending</span>}
    {(view.recovery && !view.recoveryResolved && view.recovery.receipt.prompt !== "recorded" || view.uncertain) && !open && <span className="force-tool-attention" role="status">Force request needs attention</span>}
    {open && <div ref={panel} id={id} className="force-tool-panel"><ForceToolPanel state={state} view={view} owner={props.owner} ownerLabel={props.ownerLabel} id={id} onClose={close}/></div>}
  </section>;
}

/** Pure rendering seam: controlled component tests do not claim real App or
 * provider acceptance. The state methods own every action guard. */
export function ForceToolPanel({ state, view, ownerLabel, id, onClose }: {
  state: ForceToolState; view: ForceToolView; owner: ForceToolOwner; ownerLabel?: string; id: string; onClose(): void;
}) {
  const native = view.snapshot, reason = forceToolReason(view), recoveryReason = forceRecoveryReason(view);
  const inputDisabled = !view.connected || !view.active || !view.fresh || !!view.mutation || !!view.uncertain;
  const selectedMissing = !!view.selectedTool && !native?.tools.some(tool => tool.name === view.selectedTool);
  return <>
    <header><strong>Force next tool</strong><button type="button" aria-label="Close force tool" onClick={onClose}>Close</button></header>
    <p className="force-tool-owner">{ownerLabel ?? "Current conversation"}</p>
    <div className="force-tool-refresh"><span>{view.connected ? view.loading ? "Refreshing native state…" : view.fresh ? "Current native state" : "State needs refresh" : "Offline · cached state"}</span>
      <button type="button" disabled={!view.connected || !view.active || view.loading || !!view.mutation} onClick={() => void state.refresh()}>Refresh</button></div>
    {native?.model && <p className="force-tool-model">{native.model.provider} / {native.model.id}<br/><small>{native.model.api}</small></p>}
    {native && <p role="status" className={`force-tool-capability force-tool-${native.availability.state}`}>
      <strong>{native.availability.state === "supported" ? "Named tool requests available" : native.availability.state === "degraded" ? "Native forcing is limited" : "Native forcing unavailable"}</strong><br/>{native.availability.reason}
    </p>}
    {native?.availability.thinkingNote && <p>{native.availability.thinkingNote}</p>}
    {view.unavailable && <p role="status">{view.unavailable}</p>}
    <label htmlFor={`${id}-tool`}>Active native tool</label>
    <select id={`${id}-tool`} value={view.selectedTool} disabled={inputDisabled || !native?.tools.length}
      onChange={event => state.select(event.target.value)}>
      <option value="">Choose a tool</option>
      {selectedMissing && <option value={view.selectedTool} disabled>{view.selectedTool} — no longer active</option>}
      {native?.tools.map(tool => <option key={tool.name} value={tool.name} disabled={!tool.available || /\s/.test(tool.name)}>
        {tool.name}{!tool.available ? ` — ${tool.reason ?? "unavailable"}` : /\s/.test(tool.name) ? " — unsupported command spelling" : ""}
      </option>)}
    </select>
    {native && !native.tools.length && <p>No tools are active in this native session.</p>}
    <label htmlFor={`${id}-prompt`}>Optional prompt</label>
    <textarea id={`${id}-prompt`} rows={3} value={view.prompt} onChange={event => state.setPrompt(event.target.value)}
      placeholder="Leave empty to prepare the tool for a later turn"/>
    <p className="force-tool-help">Add the native command to the composer, then send it when ready. Pending force requests belong to this worker and are not restored after it restarts.</p>
    {native && view.selectedTool && !sameForceTicket(view.selectionTicket, native) && <button type="button" disabled={inputDisabled} onClick={() => state.reviewSelection()}>Review refreshed selection</button>}
    {view.sourceDraft !== view.latestDraft && <div role="status"><p>The composer changed. Your optional prompt was retained.</p><button type="button" onClick={() => state.reviewDraft()}>Use current composer text</button></div>}
    {reason && <p className="force-tool-help">{reason}</p>}
    <button type="button" className="force-tool-primary" disabled={!!reason} onClick={() => { if (state.prepare()) onClose(); }}>Add to composer</button>
    {!!native?.directives.length && <div className="force-tool-queue"><strong>Owning worker queue</strong><ul>{native.directives.map(directive => <li key={directive.id}>
      <div><b>{directive.toolName}</b><span>{forcePhaseLabel[directive.phase]}{directive.requeued ? " · requeued by native OMP" : ""}</span></div>
      <button type="button" disabled={!state.canCancel(directive)} aria-label={`Remove pending force for ${directive.toolName}`}
        onClick={() => void state.cancel(directive.id)}>Remove</button>
    </li>)}</ul><small>A completed request is not proof that the tool executed.</small></div>}
    {view.recovery && <div className="force-tool-recovery"><strong>Previous force request</strong>
      <p>{view.recovery.receipt.message ?? `Tool request: ${view.recovery.receipt.arm}. Optional prompt: ${view.recovery.receipt.prompt}.`}</p>
      {recoveryReason && <p>{recoveryReason}</p>}
      <button type="button" disabled={!!recoveryReason} onClick={() => void state.recover()}>Send remaining prompt</button>
      <small>Sends the original remaining prompt through its pending force. It does not add another force request or replace current composer edits.</small>
    </div>}
    {view.uncertain && <div role="status"><p>{view.uncertain === "cancel" ? "Cancellation" : "Prompt recovery"} needs a confirmed receipt. No new request will be created.</p>
      <button type="button" disabled={!view.connected || !view.active || !!view.mutation} onClick={() => void state.checkPending()}>Check original operation</button></div>}
    {view.mutation && <p role="status">{view.mutation === "cancel" ? "Removing pending sequence…" : "Sending remaining prompt…"}</p>}
    {view.notice && <p role="status">{view.notice}</p>}
    {view.error && <p role="alert">{view.error}</p>}
  </>;
}
