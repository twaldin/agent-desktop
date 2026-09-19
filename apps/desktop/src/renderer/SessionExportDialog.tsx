import { useEffect, useRef, useState } from "react";
import type { DesktopBridge, SessionExportTheme } from "@agent-desktop/shared";
import { SessionExportState } from "./session-export-state";
export function SessionExportDialog({ bridge, hostId, sessionId, commandId, connected, onClose }: { bridge: DesktopBridge; hostId: string; sessionId: string; commandId?: string; connected: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), mounted = useRef(true);
  const [data] = useState(() => { try { return new SessionExportState(bridge, hostId, sessionId, localStorage, commandId); } catch { return null; } });
  const [, render] = useState(0), [theme, setTheme] = useState<SessionExportTheme>("web"), [saving, setSaving] = useState(false), [saveError, setSaveError] = useState<string>();
  const refresh = () => { if (mounted.current) render(n => n + 1); };
  useEffect(() => {
    mounted.current = true; dialog.current?.showModal();
    if (connected && data) { void data.inspect().finally(refresh); refresh(); }
    return () => { mounted.current = false; dialog.current?.close(); };
  }, [connected, data]);
  async function action(run: () => Promise<void>) { const promise = run(); refresh(); await promise; refresh(); }
  async function save(openAfter: boolean) {
    if (!data?.status?.receipt || !bridge.saveSessionExport) return;
    setSaving(true); setSaveError(undefined);
    try { await bridge.saveSessionExport(data.status.receipt, openAfter); }
    catch (error) { if (mounted.current) setSaveError(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setSaving(false); }
  }
  const status = data?.status, disabled = !connected || !data || !data.status || data.busy || saving;
  return <dialog ref={dialog} className="app-dialog" aria-labelledby="session-export-title" onCancel={onClose}>
    <div className="dialog-header"><h2 id="session-export-title">Export conversation</h2><button className="icon-button" aria-label="Close export" onClick={onClose}>×</button></div>
    <p>Export the saved conversation as native OMP HTML, including its tool output.</p>
    <label className="field-label" htmlFor="session-export-theme">HTML theme</label>
    <select id="session-export-theme" className="text-field" value={theme} disabled={disabled || data?.unresolved} onChange={event => setTheme(event.target.value as SessionExportTheme)}>
      <option value="web">OMP web themes</option><option value="user">Native user themes</option>
    </select>
    <p role="status">{!connected ? "Reconnect to the owning host to export or inspect." : data?.busy ? "Checking native export…" : status?.state === "complete" ? `HTML ready · ${status.receipt!.bytes.toLocaleString()} bytes` : status?.state === "unknown" ? "The outcome is unknown. Inspect the original request; it will not be exported again." : status?.state === "pending" ? "The original export is pending. Inspect for its receipt." : status?.state === "absent" && data?.pending ? "The host has not seen the original request. Retry sends that same request." : "Choose a theme, then export."}</p>
    {(saveError || data?.error || status?.message || !data) && <p className="inline-error" role="alert">{saveError || data?.error || status?.message || "The saved export request cannot be read. It was preserved; no export was sent."}</p>}
    <div className="dialog-footer">
      <button className="secondary-button" disabled={!connected || !data || data.busy || saving} onClick={() => void action(() => data!.inspect())}>Inspect</button>
      {status?.receipt && <><button className="secondary-button" disabled={disabled} onClick={() => void save(false)}>Save as…</button><button className="secondary-button" disabled={disabled} onClick={() => void save(true)}>Save and open…</button></>}
      <button className="primary-button" disabled={disabled || data?.unresolved} onClick={() => void action(() => data!.run(theme))}>{status?.state === "absent" && data?.pending ? "Retry original request" : status?.state === "complete" ? "Export again" : "Export HTML"}</button>
    </div>
  </dialog>;
}
