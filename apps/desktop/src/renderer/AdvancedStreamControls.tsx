import { useEffect, useId, useMemo, useReducer } from "react";
import type { DesktopBridge, OmpStreamField } from "@agent-desktop/shared";
import { AdvancedStreamState, type StreamEdit } from "./advanced-stream-state";
import "./advanced-stream-controls.css";

const labels: Record<OmpStreamField, string> = { temperature: "Temperature", topP: "Top P", maxTokens: "Output token limit" };
const fields: OmpStreamField[] = ["temperature", "topP", "maxTokens"];
export interface AdvancedStreamControlsProps {
  bridge: DesktopBridge;
  hostId: string;
  localHostId?: string;
  sessionId?: string;
  connected: boolean;
  disabled: boolean;
}
export function AdvancedStreamControls(props: AdvancedStreamControlsProps) {
  const { bridge, hostId, localHostId, sessionId, connected, disabled } = props;
  const data = useMemo(() => sessionId ? new AdvancedStreamState(bridge, hostId, sessionId) : undefined, [bridge, hostId, sessionId]);
  const [, redraw] = useReducer(value => value + 1, 0);
  const id = useId();
  useEffect(() => {
    if (!data) return;
    const unsubscribe = data.subscribe(redraw); data.start(localHostId); data.setConnected(connected);
    return () => { unsubscribe(); data.stop(); };
  }, [data, connected, localHostId]);
  const snapshot = data?.controls?.advancedStream;
  const availableFields = snapshot?.fields ? Object.values(snapshot.fields).some(field => field.supported) : snapshot?.supported;
  const blocked = disabled || !connected || !data || data.loading || data.saving || !!data.error || !availableFields;
  return <details className="advanced-stream-controls">
    <summary>Advanced sampling & output</summary>
    <div className="advanced-stream-panel">
      {!sessionId ? <p>Start or select a conversation to adjust sampling and the output limit.</p> : <>
        <div className="advanced-stream-heading"><strong>Native stream controls</strong><button type="button" disabled={!connected || data?.loading || data?.saving} onClick={() => void data?.refresh()}>Reload</button></div>
        {!connected && <p role="status">Owning host offline. Last reported values may be stale; unsaved edits are retained and will not be sent automatically.</p>}
        {data?.loading && <p role="status">Loading native session controls…</p>}
        {data?.error && <p role="alert">{data.error} Reload before saving; your edits are retained.</p>}
        {snapshot ? <>
          {(!snapshot.fields || !availableFields) && <p>{snapshot.reason}</p>}
          {snapshot.model && <p className="advanced-stream-model">{snapshot.model.provider} / {snapshot.model.id} · {snapshot.model.api}</p>}
          <p>Applies to this conversation’s current model.</p>
          {snapshot.outputLimitConflict && <p role="alert">Saved output limit {snapshot.outputLimitConflict.saved} exceeds the current native model limit of {snapshot.outputLimitConflict.maximum}. Your saved value is retained. Change the output limit or choose Follow native session and save before sending.</p>}
          {disabled && <p role="status">Controls are read-only while a turn is running or the session is archived.</p>}
          {availableFields && fields.map(field => {
            const edit = data?.edits.get(field);
            const configured = snapshot.selection[field];
            const action = edit?.action ?? (configured === undefined ? "inherit" : configured === null ? "provider-default" : "set");
            const text = edit?.text ?? (typeof configured === "number" ? String(configured) : "");
            const currentModel = snapshot.model;
            const modelChanged = !!edit && (!currentModel || currentModel.provider !== edit.model.provider || currentModel.id !== edit.model.id || currentModel.api !== edit.model.api);
            const stale = !!edit && edit.revision !== data?.controls?.revision;
            const native = snapshot.native[field];
            const capability = snapshot.fields?.[field];
            const available = capability?.supported ?? snapshot.supported;
            const label = field === "maxTokens" && snapshot.outputBudgetNote ? "Requested output budget" : labels[field];
            return <div className="advanced-stream-row" key={field}>
              <label htmlFor={`${id}-${field}-mode`}>{label}</label>
              <select id={`${id}-${field}-mode`} disabled={blocked || modelChanged} value={action} onChange={event => data?.edit(field, event.target.value as StreamEdit["action"], text)}>
                <option value="inherit">Follow native session</option>
                {field !== "maxTokens" && <option value="provider-default" disabled={!available}>Provider default (omit)</option>}
                <option value="set" disabled={!available}>Custom value</option>
              </select>
              {action === "set" && <input aria-label={`${label} value`} type="number" inputMode={field === "maxTokens" ? "numeric" : "decimal"}
                min={capability?.minimum ?? (field === "maxTokens" ? 1 : 0)} max={capability ? capability.maximum ?? undefined : field === "temperature" ? 2 : field === "topP" ? 1 : native ?? undefined} step={field === "maxTokens" ? 1 : "any"}
                value={text} disabled={blocked || modelChanged || !available} onChange={event => data?.edit(field, "set", event.target.value)}/>}
              {capability && <p role={available ? undefined : "status"}>{capability.reason}{!available && configured !== undefined ? " Your saved value is retained but is not applied here. Choose Follow native session to clear it." : ""}</p>}
              <small>Native baseline: {native === null ? "provider default / omitted" : native}. {field === "maxTokens" ? snapshot.outputBudgetNote ?? "Includes the native model’s output budget; resetting restores its default limit." : "Follow preserves native session sampling; provider default explicitly omits this parameter when available."}</small>
              {edit && <div className="advanced-stream-edit-actions">
                <button type="button" disabled={blocked || stale || modelChanged || !available && action !== "inherit"} onClick={() => void data?.save(field)}>{data?.saving ? "Saving…" : "Save"}</button>
                <button type="button" disabled={data?.saving} onClick={() => data?.discard(field)}>Discard edit</button>
                {stale && !modelChanged && <button type="button" disabled={blocked} onClick={() => data?.rebase(field)}>Use refreshed revision</button>}
              </div>}
              {modelChanged ? <p role="alert">This edit belongs to {edit?.model.provider}/{edit?.model.id}. Restore that session model or discard the edit; it cannot be applied to this model.</p>
                : stale && <p role="status">Native controls changed. Review the refreshed values before explicitly rebasing this edit.</p>}
              {edit?.error && <p role="alert">{edit.error}</p>}
            </div>;
          })}
        </> : !data?.loading && !data?.error && <p>{data?.controls ? "These controls are not available from this host." : "Native session controls have not been loaded."}</p>}
        {data?.receipt && <p role="status">{data.receipt}</p>}
      </>}
    </div>
  </details>;
}
