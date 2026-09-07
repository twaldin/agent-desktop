import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceQueryResult } from "@agent-desktop/shared";
import { Icon } from "./Icons";
import type { WorkspaceState } from "./workspace-state";
import "./workspace-file-open.css";

type OpenOptions = Extract<WorkspaceQueryResult, { type: "file.open-options" }>;

/** The viewing client never substitutes its own applications or filesystem for the owner. */
export function WorkspaceFileOpen({ data, path, active, disabled }: {
  data: Pick<WorkspaceState, "connected" | "query" | "mutate" | "canSaveCopy" | "saveCopy" | "cacheWarning" | "errors">; path: string; active: boolean; disabled: boolean;
}) {
  const [options, setOptions] = useState<OpenOptions>();
  const [loading, setLoading] = useState(false), [error, setError] = useState<string>();
  const [opened, setOpened] = useState(false), [launching, setLaunching] = useState(false);
  const [position, setPosition] = useState<CSSProperties>();
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const mounted = useRef(true), epoch = useRef(0), launchPending = useRef(false);
  const request = useRef<Promise<OpenOptions | undefined> | undefined>(undefined);
  const lastRead = useRef(0), currentOptions = useRef<OpenOptions | undefined>(undefined);
  const close = (restore = true) => { setOpened(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current++; };
  }, []);
  useEffect(() => {
    epoch.current++; request.current = undefined; lastRead.current = 0; currentOptions.current = undefined;
    setOptions(undefined); setError(undefined); setLoading(false); setOpened(false);
  }, [data, path, data.connected, active]);
  useEffect(() => { if (!active) close(false); }, [active]);
  const load = (force = false): Promise<OpenOptions | undefined> => {
    if (!data.connected) return Promise.resolve(undefined);
    if (request.current) return request.current;
    if (!force && currentOptions.current && Date.now() - lastRead.current < 5_000) return Promise.resolve(currentOptions.current);
    const ownEpoch = epoch.current;
    setLoading(true); setError(undefined);
    const pending = data.query({ type: "file.open-options", path }).then(value => {
      if (value.type !== "file.open-options" || value.path !== path) throw new Error("The host returned Open options for a different file.");
      if (!mounted.current || epoch.current !== ownEpoch) return undefined;
      currentOptions.current = value; lastRead.current = Date.now(); setOptions(value);
      return value;
    }).catch(cause => {
      if (mounted.current && epoch.current === ownEpoch) {
        currentOptions.current = undefined; setOptions(undefined);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      return undefined;
    }).finally(() => {
      if (request.current === pending) request.current = undefined;
      if (mounted.current && epoch.current === ownEpoch) setLoading(false);
    });
    request.current = pending; return pending;
  };
  const open = async (targetId?: string) => {
    if (launchPending.current || disabled || !data.connected || !active) return;
    launchPending.current = true; setLaunching(true);
    const ownEpoch = epoch.current;
    close();
    try {
      const available = await load();
      if (!mounted.current || epoch.current !== ownEpoch || !available || !data.connected) return;
      const selected = targetId ?? available.preferredTargetId ?? "fileManager";
      if (!available.targets.some(target => target.id === selected)) { setError(available.availabilityReason ?? "This application is no longer available on the file’s host."); return; }
      // The reference editor opens the current host file without forcing a save first.
      // Its existing autosave and durable mutation queue remain responsible for edits.
      const admitted = await data.mutate({ type: "file.open", path, targetId: selected });
      if (!admitted && mounted.current && epoch.current === ownEpoch) setError(data.cacheWarning ?? data.errors.action ?? "A pending workspace action must finish before this file can be opened.");
    } catch (cause) {
      if (mounted.current && epoch.current === ownEpoch) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      launchPending.current = false;
      if (mounted.current) setLaunching(false);
    }
  };
  const saveCopy = async () => {
    if (launchPending.current || !active || !data.connected || !data.canSaveCopy) return;
    launchPending.current = true; setLaunching(true); setError(undefined); close();
    const ownEpoch = epoch.current;
    try { await data.saveCopy(path); }
    catch (cause) {
      if (mounted.current && epoch.current === ownEpoch) setError(`Could not save a copy. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { launchPending.current = false; if (mounted.current) setLaunching(false); }
  };
  useLayoutEffect(() => {
    if (!opened || !trigger.current) return;
    const anchor = trigger.current;
    const measure = () => {
      const rect = anchor.getBoundingClientRect(), width = Math.min(170, innerWidth - 16);
      setPosition({ left: Math.max(8, Math.min(rect.right - width, innerWidth - width - 8)), top: rect.bottom + 4, width, maxHeight: Math.max(40, innerHeight - rect.bottom - 12) });
    };
    measure();
    const outside = (event: Event) => { if (!menu.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(false); };
    const resize = () => close(false);
    addEventListener("pointerdown", outside); addEventListener("focusin", outside); addEventListener("resize", resize);
    return () => { removeEventListener("pointerdown", outside); removeEventListener("focusin", outside); removeEventListener("resize", resize); };
  }, [opened]);
  useEffect(() => {
    if (!opened || !position || !menu.current) return;
    // Keep the first keyboard action usable even when discovery completes after opening.
    if (document.activeElement === trigger.current || document.activeElement === menu.current || document.activeElement === document.body) {
      (menu.current.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? menu.current).focus({ preventScroll: true });
    }
  }, [opened, Boolean(position), options, error, loading]);
  const preferred = options?.targets.find(target => target.id === (options.preferredTargetId ?? "fileManager"));
  const blocked = disabled || launching || !data.connected;
  return <div className="workspace-file-open"
    onPointerEnter={event => { if (event.currentTarget.contains(event.target as Node)) void load(); }}
    onFocus={event => {
      // React portal events bubble through this component, but menu focus must not rediscover apps.
      if (event.currentTarget.contains(event.target as Node) && !event.currentTarget.contains(event.relatedTarget as Node)) void load();
    }}>
    <div className="workspace-file-open-split">
      <button type="button" className="workspace-file-open-primary" aria-label={preferred ? `Open in ${preferred.label}` : "Open"}
        title={!data.connected ? "Reconnect to open this file on its host" : options?.availabilityReason ?? (preferred ? `Open in ${preferred.label} on this file’s host` : "Open on this file’s host")}
        disabled={blocked || Boolean(options && !preferred)} onClick={() => void open()}>
        <Icon name={preferred?.kind === "terminal" ? "terminal" : preferred?.kind === "editor" ? "compose" : "folder"}/><span>Open</span>
      </button>
      <button ref={trigger} type="button" className="workspace-file-open-options" aria-label="Open options" title="Open options" aria-haspopup="menu" aria-expanded={opened}
        disabled={launching || !active} onClick={() => { if (opened) close(); else { setOpened(true); void load(true); } }}
        onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpened(true); void load(true); } }}><Icon name="chevron"/></button>
    </div>
    {error && !opened && <span className="workspace-file-open-error" role="alert">{error}</span>}
    {opened && active && position && createPortal(<div ref={menu} style={position} className="workspace-file-open-menu" role="menu" aria-label="Open options" tabIndex={-1}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key === "Tab") { close(false); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
        if (!items.length) return;
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (index + 1) % items.length : (index < 0 ? items.length - 1 : (index + items.length - 1) % items.length);
        items[next]?.focus({ preventScroll: true }); items[next]?.scrollIntoView({ block: "nearest" });
      }}>
      {!data.connected ? <p role="status">Reconnect to see applications on this file’s host.</p> : loading && !options ? <p role="status">Loading available apps…</p> : null}
      {error && <><p role="alert">{error}</p><button type="button" role="menuitem" disabled={loading} onClick={() => void load(true)}>Try again</button></>}
      {data.connected && options?.targets.filter(target => target.kind !== "file-manager").map(target => <button key={target.id} type="button" role="menuitem" disabled={blocked}
        onClick={() => void open(target.id)}><Icon name={target.kind === "terminal" ? "terminal" : "compose"}/><span>{target.label}</span></button>)}
      {data.connected && options?.targets.some(target => target.id === "fileManager") && <>
        {options.targets.some(target => target.kind !== "file-manager") && <div role="separator"/>}
        <button type="button" role="menuitem" disabled={blocked} onClick={() => void open("fileManager")}><span>Open in folder</span></button>
      </>}
      {data.connected && options && !options.targets.length && <p role="status">{options.availabilityReason ?? "No supported applications are available on this host."}</p>}
      <button type="button" role="menuitem" disabled={!data.connected || launching || !data.canSaveCopy}
        title={!data.canSaveCopy ? "Save as is unavailable in this desktop build" : !data.connected ? "Reconnect to copy this file" : undefined}
        onClick={() => void saveCopy()}><span>Save as…</span></button>
    </div>, document.body)}
  </div>;
}
