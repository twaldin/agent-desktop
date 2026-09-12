import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesktopBridge, DeviceAccessChange, DeviceAccessState, NetworkState } from "../../../../packages/shared/src/protocol";
import { parseDeviceAccessPolicy } from "../../../../packages/shared/src/device-access";
import { NativeSwitch } from "./NativeSwitch";
import { Icon } from "./Icons";

type Bridge = Pick<DesktopBridge, "getDeviceAccess" | "updateDeviceAccess" | "subscribeDeviceAccess">;
export function DeviceAccessSettings({ bridge, network, localHostId, onRefresh, refreshing }: { bridge?: Bridge; network?: NetworkState; localHostId?: string; onRefresh?(): Promise<void>; refreshing?: boolean }) {
  const [state, setState] = useState<DeviceAccessState>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<string>();
  const mounted = useRef(false), generation = useRef(0), submitting = useRef(false);
  const read = useCallback(async () => {
    const request = ++generation.current;
    try {
      if (!bridge?.getDeviceAccess) throw new Error("Restart the app with the current host to manage device access.");
      const next = await bridge.getDeviceAccess();
      if (localHostId && next.hostId !== localHostId) throw new Error("Device access belongs to a different machine.");
      parseDeviceAccessPolicy(next.policy);
      if (typeof next.supported !== "boolean") throw new Error("The host returned invalid device access capabilities.");
      if (mounted.current && request === generation.current) { setState(next); setError(undefined); }
    } catch (cause) { if (mounted.current && request === generation.current) { setError(cause instanceof Error ? cause.message : String(cause)); } }
  }, [bridge, localHostId]);
  useEffect(() => {
    mounted.current = true;
    void read();
    const unsubscribe = bridge?.subscribeDeviceAccess?.(() => { void read(); });
    const focus = () => { void read(); };
    window.addEventListener("focus", focus);
    return () => { mounted.current = false; generation.current++; unsubscribe?.(); window.removeEventListener("focus", focus); };
  }, [bridge, read]);
  const change = async (change: DeviceAccessChange) => {
    if (submitting.current || !state?.supported || !bridge?.updateDeviceAccess) return;
    submitting.current = true;
    setPending(change.type === "availability" ? "availability" : change.nodeId); setError(undefined); setNotice(undefined);
    generation.current++; // Older reads cannot overwrite a completed local save.
    try {
      await bridge.updateDeviceAccess({ expectedRevision: state.policy.revision, change });
      await read();
      if (mounted.current && change.type === "device" && change.allowed) setAdding(false);
      if (mounted.current) setNotice(change.type === "device" ? change.allowed ? "Device access allowed" : "Revoked device access" : undefined);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      await read(); // Show the current owner policy after a conflict; never retry the mutation.
      if (mounted.current) setError(message);
    } finally { submitting.current = false; if (mounted.current) setPending(undefined); }
  };
  useEffect(() => { if (state && !state.policy.enabled) setAdding(false); }, [state?.policy.enabled]);
  const revoked = new Set(state?.policy.revokedNodeIds);
  const eligible = network?.hosts ?? [];
  const allowed = eligible.filter(device => !revoked.has(device.nodeId));
  const disabled = pending !== undefined || error !== undefined || !state?.supported || !bridge?.updateDeviceAccess;
  const deviceRow = (nodeId: string, name: string, allowed: boolean) => <li className="connections-row" key={nodeId}>
    <Icon name="laptop" className="connections-row-icon"/>
    <div className="connections-row-body"><strong className="truncate">{name}</strong><span className="connections-row-status">{allowed ? "Allowed device" : "Access revoked"}</span></div>
    <button type="button" className="secondary-button connections-access-button" disabled={disabled} aria-label={`${allowed ? "Revoke access" : "Allow access"} for ${name}`} onClick={() => void change({ type: "device", nodeId, allowed: !allowed })}>
      {pending === nodeId && <span className="spinner" aria-hidden="true"/>}{allowed ? "Revoke access" : "Allow access"}
    </button>
  </li>;
  return <section className="connections-section connections-access" aria-label="Devices that can control this Mac">
    <div className="connections-section-heading"><h2>Devices that can control this Mac</h2>{state?.policy.enabled && <div className="connections-access-actions"><button type="button" className="icon-button small connections-refresh" aria-label="Refresh" title="Refresh" disabled={pending !== undefined || refreshing} onClick={() => { void read(); void onRefresh?.(); }}><Icon name="refresh"/></button><button type="button" className="connections-add-button" disabled={disabled} onClick={() => setAdding(true)}>Add</button></div>}</div>
    <div className="connections-card"><ul className="connections-list">
      <li className="connections-row"><div className="connections-row-body"><strong>Allow connections</strong></div><NativeSwitch label="Allow connections" checked={state?.policy.enabled ?? false} disabled={disabled} onChange={enabled => void change({ type: "availability", enabled })}/></li>
      {state?.policy.enabled && <>
        {allowed.map(device => deviceRow(device.nodeId, device.name, true))}
        {!allowed.length && <li className="connections-row"><span className="connections-row-status">Add device to control this Mac remotely</span></li>}
      </>}
    </ul></div>
    {adding && <AddDeviceDialog onClose={() => setAdding(false)} busy={pending !== undefined}>
      <p>Devices on your Tailscale account can connect unless you revoke their access. Every connection still requires a valid, untagged Tailscale device identity.</p>
      {[...revoked].length ? <ul className="connections-list">{[...revoked].map(nodeId => deviceRow(nodeId, eligible.find(device => device.nodeId === nodeId)?.name ?? nodeId, false))}</ul>
        : <p>Devices on your Tailscale account are discovered automatically. Run Agent Desktop on another connected device, then refresh the device list.</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </AddDeviceDialog>}
    {!state && !error && <p className="connections-discovery-note" role="status">Loading device access…</p>}
    {state && !state.supported && <p className="connections-discovery-note">Tailscale discovery is disabled for this host.</p>}
    {error && <div className="inline-error" role="alert"><p>{error}</p><button type="button" className="secondary-button" disabled={pending !== undefined} onClick={() => void read()}>Refresh</button></div>}
    {notice && <p className="connections-discovery-note" role="status">{notice}</p>}
  </section>;
}

function AddDeviceDialog({ children, onClose, busy }: { children: React.ReactNode; onClose(): void; busy: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!, opener = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={ref} className="connections-detail connections-add-dialog" aria-label="Add device" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="connections-detail-heading"><h2>Add device</h2><button type="button" className="icon-button small" disabled={busy} aria-label="Close add device" onClick={onClose}><Icon name="close"/></button></div>
    {children}
  </dialog>;
}
