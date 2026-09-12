import { KeepAwakeSettings } from "./KeepAwakeSettings";
import type { PreferencesState } from "./preferences-state";
import { DeviceAccessSettings } from "./DeviceAccessSettings";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DesktopBridge, DiscoveredHost, HostIdentity, NetworkState } from "../../../../packages/shared/src/protocol";
import type { HostOption } from "./host-catalog";
import { Icon } from "./Icons";
import "./connections-settings.css";

export interface ConnectionsSettingsProps {
  bridge?: Pick<DesktopBridge, "getDeviceAccess" | "updateDeviceAccess" | "subscribeDeviceAccess" | "getKeepAwakeStatus" | "subscribeKeepAwakeStatus">;
  preferences?: PreferencesState;
  hosts: HostOption[];
  network?: NetworkState;
  networkError?: string;
  localHost?: HostIdentity;
  activeHostId?: string;
  onSelectHost(hostId: string): void;
  onRefresh(): Promise<void> | void;
}
type View = "this-mac" | "other-devices";
const views: readonly [View, string][] = [["this-mac", "Control this Mac"], ["other-devices", "Control other devices"]];
const platformNames: Record<string, string> = { darwin: "macOS", macos: "macOS", linux: "Linux", win32: "Windows", windows: "Windows", ios: "iOS", android: "Android" };
const clock = (timestamp: number) => new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

interface Status { tone: HostOption["availability"]; label: string; error?: string }
/** `available` is the catalog's merged verdict (a live connection or a successful discovery probe);
 * it does not by itself prove an authenticated connection, so the label is Available, not Connected. */
function statusOf(option: HostOption): Status {
  if (option.availability === "available") return { tone: "available", label: "Available" };
  if (option.availability === "offline") return { tone: "offline", label: "Offline", error: option.error };
  return { tone: "unavailable", label: "Unavailable", error: option.error };
}
interface Detail { name: string; status: Status; rows: { label: string; value?: string }[] }
function detailOf(option: HostOption, network: NetworkState | undefined, localHost: HostIdentity | undefined, active: boolean): Detail {
  // A node is joined by its own id or by the app identity it advertised; never by display name.
  const node: DiscoveredHost | undefined = option.local ? undefined : network?.hosts.find(node => (option.nodeId !== undefined && node.nodeId === option.nodeId) || (option.hostId !== undefined && node.host?.id === option.hostId));
  const identity = option.local ? localHost : node?.host;
  const platform = identity?.platform ?? node?.platform;
  const status = statusOf(option);
  return { name: option.name, status, rows: [
    { label: "Status", value: [status.label, active ? "in use" : undefined, status.error].filter(Boolean).join(" · ") },
    { label: "Machine", value: identity?.name ?? (option.local ? undefined : node?.name) },
    { label: "Platform", value: platform ? platformNames[platform.toLowerCase()] ?? platform : undefined },
    { label: "Architecture", value: identity?.architecture },
    { label: option.local ? "Tailnet address" : "Address", value: option.local ? network?.listenAddress : node?.origin },
    { label: "Tailscale node", value: option.local ? network?.ownNodeId : node?.nodeId },
    { label: "Host ID", value: option.hostId },
    { label: "Catalog", value: option.cached ? "Cached on this device" : "Not loaded" },
    { label: "Last discovery", value: network && network.checkedAt > 0 ? clock(network.checkedAt) : undefined },
  ] };
}

export function ConnectionsSettings({ preferences, bridge, hosts, network, networkError, localHost, activeHostId, onSelectHost, onRefresh }: ConnectionsSettingsProps) {
  const id = useId();
  const [view, setView] = useState<View>("this-mac");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const [detail, setDetail] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true); setRefreshError(undefined);
    try { await onRefresh(); } catch (cause) { if (mounted.current) setRefreshError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setRefreshing(false); }
  };
  const others = hosts.filter(option => !option.local);
  const shown = detail === undefined ? undefined : hosts.find(option => option.key === detail);
  const discovery = refreshing && !network ? "Checking Tailscale…"
    : !network ? "Tailscale status is not known yet."
    : network.status === "connecting" ? "Tailscale is connecting…"
    : network.status === "unavailable" ? network.error ?? "Tailscale is unavailable on this Mac."
    : `Other devices reach this Mac as ${network.ownName ?? "this node"}${network.listenAddress ? ` at ${network.listenAddress}` : ""}.`;
  const checked = network && network.checkedAt > 0 ? `Checked ${clock(network.checkedAt)}` : undefined;
  const refreshButton = <button type="button" className="icon-button small connections-refresh" aria-label="Refresh devices" title="Refresh devices" aria-busy={refreshing} disabled={refreshing} onClick={() => void refresh()}>{refreshing ? <span className="spinner" aria-hidden="true"/> : <Icon name="refresh"/>}</button>;
  const problems = (networkError || refreshError) && <div className="inline-error" role="alert"><p>{refreshError ?? networkError}</p><button type="button" className="secondary-button" disabled={refreshing} onClick={() => void refresh()}>Retry</button></div>;
  const tabKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = views.findIndex(([value]) => value === view);
    const next = event.key === "ArrowRight" ? (index + 1) % views.length : event.key === "ArrowLeft" ? (index + views.length - 1) % views.length : event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); setView(views[next]![0]);
    event.currentTarget.querySelector<HTMLButtonElement>(`#${CSS.escape(`${id}-tab-${views[next]![0]}`)}`)?.focus();
  };
  const row = (option: HostOption) => {
    const active = option.hostId !== undefined && option.hostId === activeHostId;
    const status = statusOf(option);
    return <li className="connections-row" key={option.key}>
      <Icon name="laptop" className="connections-row-icon"/>
      <div className="connections-row-body">
        <strong><span className="truncate">{option.name}</span>{active && <span className="connections-badge">In use</span>}</strong>
        <span className="connections-row-status" title={status.error}><i className={`connections-dot ${status.tone}`} aria-hidden="true"/><span className="truncate">{status.label}{status.error && ` · ${status.error}`}</span></span>
      </div>
      <RowMenu label={`${option.name} actions`} items={[
        { id: "details", label: "Details", onSelect: () => setDetail(option.key) },
        { id: "use", label: option.local ? "Use this Mac" : "Use this machine", disabled: !option.hostId || active, hint: active ? "Already in use" : option.hostId ? undefined : "This device has not identified its app service yet", onSelect: () => { if (option.hostId) onSelectHost(option.hostId); } },
      ]}/>
    </li>;
  };
  return <section className="settings-page connections-settings" aria-label="Connections settings">
    <div className="connections-scroll"><div className="connections-column">
      <header className="settings-header connections-header"><h1>Connections</h1></header>
      <div className="connections-tabs" role="tablist" aria-label="Connections view" onKeyDown={tabKeys}>
        {views.map(([value, label]) => <button key={value} id={`${id}-tab-${value}`} type="button" role="tab" aria-selected={view === value} aria-controls={`${id}-panel-${value}`} tabIndex={view === value ? 0 : -1} onClick={() => setView(value)}>{label}</button>)}
      </div>
      {view === "this-mac" ? <div id={`${id}-panel-this-mac`} role="tabpanel" aria-labelledby={`${id}-tab-this-mac`}>
        {problems}
        <DeviceAccessSettings bridge={bridge} network={network} localHostId={localHost?.id} onRefresh={refresh} refreshing={refreshing}/>
        <KeepAwakeSettings bridge={bridge} preferences={preferences}/>
        <p className="connections-discovery-note">{discovery}{checked && ` ${checked}`}</p>
      </div> : <div id={`${id}-panel-other-devices`} role="tabpanel" aria-labelledby={`${id}-tab-other-devices`}>
        {problems}
        <Section title="Devices you can use from this Mac" meta={checked} actions={refreshButton}>{others.length ? <ul className="connections-list">{others.map(row)}</ul>
          : <div className="connections-empty"><Icon name="laptop"/><p>{network?.status === "unavailable" ? network.error ?? "Tailscale is unavailable on this Mac, so other devices cannot be discovered." : network?.status === "connected" ? "No other devices you own are online on your tailnet." : refreshing ? "Looking for devices on your tailnet…" : "Other devices have not been discovered yet."}</p><button type="button" className="secondary-button" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh"}</button></div>}
        </Section>
      </div>}
    </div></div>
    {shown && <DeviceDetails detail={detailOf(shown, network, localHost, shown.hostId !== undefined && shown.hostId === activeHostId)} onClose={() => setDetail(undefined)}/>}
  </section>;
}

function Section({ title, meta, actions, children }: { title: string; meta?: string; actions?: ReactNode; children: ReactNode }) {
  return <section className="connections-section" aria-label={title}>
    <div className="connections-section-heading"><h2>{title}</h2>{meta && <span className="connections-checked">{meta}</span>}{actions}</div>
    <div className="connections-card">{children}</div>
  </section>;
}

interface MenuItem { id: string; label: string; disabled?: boolean; hint?: string; onSelect(): void }
const menuWidth = 190, menuHeight = 84;
/** Portaled and fixed so the card's scroll container never clips it; flips above the trigger near the bottom edge. */
function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [position, setPosition] = useState<CSSProperties>();
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const close = (restore = true) => { setPosition(undefined); if (restore) trigger.current?.focus({ preventScroll: true }); };
  const show = () => {
    const rect = trigger.current?.getBoundingClientRect(); if (!rect) return;
    const below = rect.bottom + 4 + menuHeight <= innerHeight - 8;
    setPosition({ left: Math.max(8, Math.min(rect.right - menuWidth, innerWidth - menuWidth - 8)), ...(below ? { top: rect.bottom + 4 } : { bottom: innerHeight - rect.top + 4 }) });
  };
  useEffect(() => {
    if (!position) return;
    const frame = requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>("button:enabled")?.focus({ preventScroll: true }));
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) close(false); };
    const dismiss = () => close(false);
    addEventListener("pointerdown", outside); addEventListener("resize", dismiss); addEventListener("scroll", dismiss, true);
    return () => { cancelAnimationFrame(frame); removeEventListener("pointerdown", outside); removeEventListener("resize", dismiss); removeEventListener("scroll", dismiss, true); };
  }, [Boolean(position)]);
  return <div className="connections-row-menu">
    <button ref={trigger} type="button" className="icon-button small" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={Boolean(position)} onClick={() => position ? close(false) : show()}><Icon name="more"/></button>
    {position && createPortal(<div ref={menu} className="action-menu connections-action-menu" role="menu" aria-label={label} style={position}
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) close(false); }}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:enabled")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}>
      {items.map(item => <button key={item.id} type="button" role="menuitem" disabled={item.disabled} title={item.hint} onClick={() => { close(); item.onSelect(); }}>{item.label}</button>)}
    </div>, document.body)}
  </div>;
}

/** Read-only projection of discovery and catalog metadata; nothing here writes to a host. */
function DeviceDetails({ detail, onClose }: { detail: Detail; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useLayoutEffect(() => {
    const panel = dialog.current!, opener = document.activeElement;
    panel.showModal(); panel.querySelector<HTMLButtonElement>('[aria-label="Close device details"]')?.focus({ preventScroll: true });
    return () => { if (panel.open) panel.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={dialog} className="connections-detail" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>
    <div className="connections-detail-heading"><h2 id={titleId}><Icon name="laptop"/><span className="truncate">{detail.name}</span></h2><button type="button" className="icon-button small" aria-label="Close device details" title="Close" onClick={onClose}><Icon name="close"/></button></div>
    <span className="connections-detail-status"><i className={`connections-dot ${detail.status.tone}`} aria-hidden="true"/>{detail.status.label}</span>
    <dl>{detail.rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd className={row.value === undefined ? "unknown" : undefined}>{row.value ?? "Unknown"}</dd></div>)}</dl>
  </dialog>;
}
