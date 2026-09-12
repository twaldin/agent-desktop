import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons";
import type { HostOption } from "./host-catalog";
import "./profile-menu.css";

export interface ProfileMenuProps {
  hosts: HostOption[];
  activeHostId?: string;
  hostName: string;
  connectionLabel: string;
  /** App-level live connection to the active host; the avatar dot follows this, never discovery availability. */
  connected: boolean;
  onSelectHost(hostId: string): void;
  onSettings(): void;
  onConnections(): void;
  onBuildStatus(): void;
  onRefresh(): Promise<void> | void;
  triggerId?: string;
}

const menuWidth = 258;
const itemSelector = '[role^="menuitem"]:not(:disabled)';

/** Initials from the real host name; never a photo or an account identity. */
function initials(name: string) {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const text = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "").slice(0, 2);
  return text.toUpperCase() || "?";
}
function hue(name: string) {
  let value = 0;
  for (const char of name) value = (value * 31 + char.codePointAt(0)!) % 360;
  return value;
}
const availabilityLabel = { available: undefined, unavailable: "Unavailable", offline: "Offline" } as const;

export function ProfileMenu({ hosts, activeHostId, hostName, connectionLabel, connected, onSelectHost, onSettings, onConnections, onBuildStatus, onRefresh, triggerId = "active-host" }: ProfileMenuProps) {
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), mounted = useRef(false);
  const focusLast = useRef(false);
  const [open, setOpen] = useState(false), [position, setPosition] = useState<CSSProperties>(), [refreshing, setRefreshing] = useState(false), [refreshError, setRefreshError] = useState<string>();
  const active = hosts.some(host => host.hostId !== undefined && host.hostId === activeHostId);
  const avatar = { "--profile-hue": hue(hostName) } as CSSProperties;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open || !position) return;
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>(itemSelector) ?? [])];
    (focusLast.current ? items.at(-1) : items[0])?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) close(false); };
    const dismiss = () => close(false);
    addEventListener("pointerdown", outside);
    addEventListener("resize", dismiss);
    return () => { removeEventListener("pointerdown", outside); removeEventListener("resize", dismiss); };
  }, [open, Boolean(position)]);

  function close(restore = true) {
    setOpen(false);
    setPosition(undefined);
    if (restore) queueMicrotask(() => trigger.current?.focus({ preventScroll: true }));
  }
  function show(last = false) {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    focusLast.current = last;
    setRefreshError(undefined);
    setPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - menuWidth - 8)), bottom: innerHeight - rect.top + 4, maxHeight: Math.max(160, rect.top - 12) });
    setOpen(true);
  }
  function triggerKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Escape" && open) { event.preventDefault(); close(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const last = event.key === "ArrowUp";
    if (!open) { show(last); return; }
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>(itemSelector) ?? [])];
    (last ? items.at(-1) : items[0])?.focus({ preventScroll: true });
  }
  function menuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>(itemSelector) ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : index < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
    items[next]?.scrollIntoView({ block: "nearest" });
  }
  function selectHost(host: HostOption) {
    if (!host.hostId) return;
    close();
    if (host.hostId !== activeHostId) onSelectHost(host.hostId);
  }
  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(undefined);
    try { await onRefresh(); }
    catch (cause) { if (mounted.current) setRefreshError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setRefreshing(false); }
  }
  function action(run: () => void) { close(); run(); }

  const savedOnly = Boolean(activeHostId) && !active;
  return <>
    <button ref={trigger} id={triggerId} type="button" className="profile-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => { if (open) close(); else show(); }} onKeyDown={triggerKey}>
      <span className="profile-avatar" data-connection={connected ? "online" : "offline"} style={avatar} aria-hidden="true">{initials(hostName)}</span>
      <span className="profile-trigger-name">{hostName}</span>
      <span className="sr-only">{connectionLabel}</span>
    </button>
    {open && position && createPortal(<div ref={menu} className="profile-menu" role="menu" aria-label="Profile menu" style={position} onKeyDown={menuKey}
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== trigger.current) close(false); }}>
      <div className="profile-menu-identity">
        <span className="profile-avatar" data-connection={connected ? "online" : "offline"} style={avatar} aria-hidden="true">{initials(hostName)}</span>
        <strong>{hostName}</strong>
        <span>{connectionLabel}</span>
      </div>
      <hr/>
      {savedOnly && <button type="button" role="menuitemradio" aria-checked="true" disabled><Icon name="laptop"/><span>{hostName}</span><span className="profile-menu-accessory">Not discovered</span><Icon name="check" className="profile-menu-check"/></button>}
      {hosts.map(host => {
        const current = host.hostId !== undefined && host.hostId === activeHostId;
        const accessory = availabilityLabel[host.availability] ?? (host.local ? "This machine" : undefined);
        return <button key={host.key} type="button" role="menuitemradio" aria-checked={current} disabled={!host.hostId} title={host.error} onClick={() => selectHost(host)}>
          <Icon name="laptop"/><span>{host.name}</span>{accessory && <span className="profile-menu-accessory">{accessory}</span>}{current && <Icon name="check" className="profile-menu-check"/>}
        </button>;
      })}
      {!hosts.length && !savedOnly && <p className="profile-menu-status" role="status">No machines discovered.</p>}
      <hr/>
      <button type="button" role="menuitem" aria-busy={refreshing} onClick={() => void refresh()}><Icon name="refresh"/><span>{refreshing ? "Refreshing machines…" : refreshError ? "Retry refresh" : "Refresh machines"}</span></button>
      {refreshError && <p className="profile-menu-status profile-menu-error" role="alert">{refreshError}</p>}
      <button type="button" role="menuitem" onClick={() => action(onConnections)}><Icon name="globe"/><span>Connections</span></button>
      <button type="button" role="menuitem" onClick={() => action(onSettings)}><Icon name="settings"/><span>Settings</span><kbd>⌘,</kbd></button>
      <button type="button" role="menuitem" onClick={() => action(onBuildStatus)}><Icon name="question"/><span>Build status</span></button>
    </div>, document.body)}
  </>;
}
