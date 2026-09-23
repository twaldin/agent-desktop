import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "./Icons";
import { NativeSessionImportState, type NativeImportReadBridge } from "./native-session-import-state";
import "./session-tree.css";

export function NativeSessionImportDialog({ hostId, hostName, connected, admissionAvailable=false,bridge, onClose,onImported }: {
  hostId: string; hostName: string; connected: boolean; admissionAvailable?:boolean;bridge: NativeImportReadBridge; onClose(): void;onImported?(sessionId:string):void;
}) {
  const model = useMemo(() => new NativeSessionImportState(hostId, bridge,{get length(){return localStorage.length},key:index=>localStorage.key(index),getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)}), [hostId, bridge]);
  const view = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const dialog = useRef<HTMLDialogElement>(null), [query, setQuery] = useState("");
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  useEffect(() => { model.configure(connected,admissionAvailable); if (connected) void model.refresh(); return () => model.configure(false); }, [model, connected,admissionAvailable]);
  const folded = query.trim().toLocaleLowerCase();
  const rows = view.candidates.filter(row => !folded || [row.title, row.recordedCwd, row.sourcePath].some(value => value?.toLocaleLowerCase().includes(folded)));
  const inspection = view.inspection;
  return <dialog ref={dialog} className="app-dialog session-tree-history" aria-labelledby="native-import-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="dialog-header session-tree-heading"><h2 id="native-import-title">Native sessions · {hostName}</h2><button type="button" className="icon-button" aria-label="Close native sessions" onClick={onClose}><Icon name="close"/></button></div>
    <p className="session-tree-note">Inspect original OMP sessions on this host before importing. Reading does not open a writer or copy the conversation.</p>
    <input className="text-field" aria-label="Filter native sessions" placeholder="Filter by title or original path" value={query} onChange={event => setQuery(event.target.value)}/>
    {!view.connected && <p role="status">Reconnect to {hostName} to inspect an original session. Cached rows cannot be imported.</p>}
    {view.loading && <p role="status">{view.loading === "list" ? "Reading native sessions…" : "Inspecting the original file…"}</p>}
    {view.error && <p className="inline-error" role="alert">{view.error}</p>}
    <ul className="session-tree-list" aria-label="Original native sessions">{rows.map(row => <li key={row.candidateId}>
      <button type="button" aria-pressed={view.selected === row.candidateId} disabled={!view.connected || !view.fresh || view.loading === "list"||!!view.operation} title={row.sourcePath} onClick={() => void model.inspect(row.candidateId)}>
        <span className="session-tree-row-text"><strong>{row.title || row.nativeId || "Unreadable native session"}</strong><span>{row.recordedCwd || row.sourcePath}</span>
          <small>{row.issue || `${row.messageCountEstimate === undefined ? "" : `About ${row.messageCountEstimate} saved ${row.messageCountEstimate===1?"message":"messages"} · `}${row.persistedStatus ? `Saved state: ${row.persistedStatus}` : "Saved state unavailable"}`}</small></span>
      </button>
    </li>)}</ul>
    {!view.loading && !rows.length && <p>{view.candidates.length ? "No matching native sessions." : view.fresh ? "No native sessions were found in this host's profile." : "Refresh to inspect this host's native sessions."}</p>}
    {inspection && <section className="session-tree-selection" aria-label="Original session inspection"><div>
      <p><strong>Original file</strong><br/>{inspection.originalFile}</p>
      <p><strong>Working directory</strong><br/>{inspection.canonicalCwd || inspection.recordedCwd || "Unavailable"}</p>
      <p>{inspection.messages} {inspection.messages===1?"message":"messages"} · {inspection.entries} native {inspection.entries===1?"entry":"entries"}</p>
      {inspection.issues.map(issue => <p className="inline-error" key={issue}>{issue}</p>)}
      <p role="status">{inspection.writeAdmission.reason === "source-invalid" ? "Resolve the source issues before importing this original." : "Inspection alone does not grant writable ownership of this original."}</p>
      {view.admissionAvailable&&!inspection.issues.length&&!model.unresolved&&view.preparation?.state!=="ready"&&<button type="button" className="secondary-button" disabled={!!view.operation} onClick={()=>void model.prepare()}>Review original import</button>}
      {!view.admissionAvailable&&<p>This host does not yet support writable original-session admission.</p>}
    </div></section>}
    {view.operation&&<p role="status">{view.operation==="prepare"?"Checking the original writer’s participation…":view.operation==="admit"?"Importing the original session…":"Checking the saved import outcome…"}</p>}
    {view.preparation?.state==="refused"&&<p role="alert" className="inline-error">{view.preparation.message}</p>}
    {view.preparation?.state==="ready"&&<section aria-label="Confirm original import"><h3>Continue this original session?</h3>
      <p>This keeps its native identity, history and working directory on {hostName}. Import proceeds only if the participating external runner has released the original. It will not create a copy.</p>
      <p>{view.preparation.original.originalFile}</p>
      <button type="button" className="primary-button" disabled={!view.admissionAvailable||!!view.operation} onClick={()=>void model.confirm()}>Import original session</button>
    </section>}
    {view.savedCommands.length>1&&<label>Saved import request<select className="text-field" value={view.saved?.commandId??""} disabled={!!view.operation} onChange={event=>model.selectRecovery(event.target.value)}>{view.savedCommands.map(saved=><option key={saved.commandId} value={saved.commandId}>{saved.preparation.original.originalFile} · {saved.commandId}</option>)}</select></label>}
    {view.saved&&<section aria-label="Saved import outcome"><p>Import command: <code>{view.saved.commandId}</code></p>
      {!view.outcome&&<p role="status">An earlier import request is saved. Check its outcome before submitting another import.</p>}
      {view.outcome?.state==="pending"&&<p role="status">The original import is still pending. Closing this dialog does not cancel it.</p>}
      {view.outcome?.state==="absent"&&<p role="status">The host has no saved outcome for this command. An explicit retry uses the same command and preparation.</p>}
      {view.outcome?.state==="refused"&&<p role="status">Import was not admitted: {view.outcome.message}</p>}
      {view.outcome?.state==="unknown"&&<p className="inline-error" role="alert">The import outcome is unknown. {view.outcome.message} Do not open a replacement writer.</p>}
      {view.outcome?.state==="imported"&&<><p role="status">The original conversation was imported.</p><button type="button" className="primary-button" disabled={!view.connected||!onImported} onClick={()=>{if(view.outcome?.state==="imported")onImported?.(view.outcome.original.sessionId)}}>Open imported conversation</button></>}
      <button type="button" className="secondary-button" disabled={!view.connected||!!view.operation} onClick={()=>void model.checkOutcome()}>Check import outcome</button>
      {view.outcome?.state==="absent"&&<button type="button" className="secondary-button" disabled={!view.admissionAvailable||!!view.operation} onClick={()=>void model.retryUnseen()}>Retry original import</button>}
    </section>}
    <div className="dialog-footer"><button type="button" className="secondary-button" onClick={onClose}>Close</button><button type="button" className="secondary-button" disabled={!view.connected || !!view.loading||!!view.operation} onClick={() => void model.refresh()}>Refresh native sessions</button></div>
  </dialog>;
}
