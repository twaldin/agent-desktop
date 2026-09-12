import type {
  DesktopBridge,
  NativeSshCatalog,
  NativeSshDetail,
  NativeSshHost,
  NativeSshMutation,
  WorkspaceTarget,
} from "@agent-desktop/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icons";
import "./ssh-tool-settings.css";

type SshToolBridge = Pick<DesktopBridge, "getSshHosts" | "getSshHostDetail" | "mutateSshHost" | "subscribe">;

export interface SshToolSettingsProps {
  bridge: SshToolBridge;
  hostId: string;
  hostName: string;
  target?: WorkspaceTarget;
  connected: boolean;
  localHostId?: string;
}

type KnownConfig = {
  host: string;
  username: string;
  port: string;
  keyPath: string;
  description: string;
  compat: boolean;
};

type Surface =
  | { kind: "detail"; host: NativeSshHost; detail: NativeSshDetail | null; loading: boolean; error: string | null; stale: boolean }
  | { kind: "edit"; host: NativeSshHost; raw: Record<string, unknown>; values: KnownConfig; baseRevision: string; error: string | null; stale: boolean }
  | { kind: "add"; scope: "user" | "project"; name: string; values: KnownConfig; baseRevision: string; error: string | null; stale: boolean }
  | { kind: "remove"; host: NativeSshHost; baseRevision: string; error: string | null; stale: boolean };

const emptyConfig = (): KnownConfig => ({ host: "", username: "", port: "", keyPath: "", description: "", compat: false });
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
const sameTarget = (a?: WorkspaceTarget, b?: WorkspaceTarget) => JSON.stringify(a) === JSON.stringify(b);
const stringField = (config: Record<string, unknown>, key: string) => {
  const value = config[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
};
const configValues = (config: Record<string, unknown>): KnownConfig => ({
  host: stringField(config, "host"),
  username: stringField(config, "username"),
  port: stringField(config, "port"),
  keyPath: stringField(config, "keyPath") || stringField(config, "key"),
  description: stringField(config, "description"),
  compat: config.compat === true || config.compat === 1 || ["true", "yes", "1", "on"].includes(String(config.compat).toLowerCase()),
});

function buildConfig(raw: Record<string, unknown>, values: KnownConfig): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw, host: values.host.trim(), compat: values.compat };
  for (const key of ["username", "keyPath", "description"] as const) {
    const value = values[key].trim();
    if (value) next[key] = value;
    else delete next[key];
  }
  const port = values.port.trim();
  if (port) next.port = Number(port);
  else delete next.port;
  return next;
}

function validation(values: KnownConfig, name?: string): string | null {
  if (name !== undefined && !/^[A-Za-z0-9_.-]{1,100}$/.test(name.trim())) return "Use 1–100 letters, numbers, dots, dashes or underscores for the name.";
  if (!values.host.trim()) return "Host is required.";
  if (values.port.trim() && (!/^\d+$/.test(values.port.trim()) || Number(values.port) < 1 || Number(values.port) > 65535)) return "Port must be a number from 1 to 65535.";
  return null;
}

export function SshToolSettings({ bridge, hostId, hostName, target, connected, localHostId }: SshToolSettingsProps) {
  const [catalog, setCatalog] = useState<NativeSshCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [surface, setSurface] = useState<Surface | null>(null);
  const [operation, setOperation] = useState(false);
  const catalogRevision = useRef<string | null>(null);
  const ownerEpoch = useRef(0);
  const readSequence = useRef(0);
  const detailSequence = useRef(0);
  const operationGuard = useRef(false);
  const operationSequence = useRef(0);
  const refreshQueued = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const container = useRef<HTMLElement | null>(null);
  const restoreFocus = useCallback(() => {
    const epoch = ownerEpoch.current, original = opener.current;
    requestAnimationFrame(() => {
      const root = container.current;
      if (epoch !== ownerEpoch.current || !root?.isConnected || root.querySelector("dialog[open]")) return;
      const surviving = original?.isConnected && !original.matches(":disabled") ? original
        : root.querySelector<HTMLButtonElement>(".ssh-tool-row-main:not(:disabled)")
          ?? root.querySelector<HTMLButtonElement>(".ssh-tool-add:not(:disabled)");
      surviving?.focus({ preventScroll: true });
    });
  }, []);
  const targetKey = useMemo(() => JSON.stringify(target), [target]);

  const markSurfaceRevision = useCallback((next: NativeSshCatalog) => {
    setSurface(current => current && "baseRevision" in current && current.baseRevision !== next.revision
      ? { ...current, stale: true }
      : current?.kind === "detail" && current.detail && current.detail.revision !== next.revision
        ? { ...current, stale: true }
        : current);
  }, []);

  const load = useCallback(async () => {
    if (!connected) return;
    if (operationGuard.current) { refreshQueued.current = true; return; }
    const epoch = ownerEpoch.current;
    const sequence = ++readSequence.current;
    setLoading(true);
    setError(null);
    try {
      const next = await bridge.getSshHosts(target, hostId);
      if (epoch !== ownerEpoch.current || sequence !== readSequence.current) return;
      catalogRevision.current = next.revision;
      setCatalog(next);
      markSurfaceRevision(next);
    } catch (cause) {
      if (epoch === ownerEpoch.current && sequence === readSequence.current) setError(failure(cause));
    } finally {
      if (epoch === ownerEpoch.current && sequence === readSequence.current) setLoading(false);
    }
  }, [bridge, connected, hostId, markSurfaceRevision, targetKey]);

  useEffect(() => {
    ownerEpoch.current++;
    readSequence.current++;
    detailSequence.current++;
    operationSequence.current++;
    operationGuard.current = false;
    refreshQueued.current = false;
    catalogRevision.current = null;
    setCatalog(null);
    setSurface(null);
    setOperation(false);
    setError(null);
    return () => { ownerEpoch.current++; readSequence.current++; detailSequence.current++; operationSequence.current++; };
  }, [bridge, hostId, targetKey]);

  useEffect(() => {
    if (connected) { void load(); return; }
    ownerEpoch.current++;
    readSequence.current++;
    detailSequence.current++;
    operationSequence.current++;
    setLoading(false);
    setOperation(false);
    if (operationGuard.current) setSurface(current => current ? { ...current, error: "The connection changed while saving. Reload and review the saved target before trying again.", stale: true } : current);
    operationGuard.current = false;
  }, [connected, load]);

  useEffect(() => bridge.subscribe(event => {
    if (!connected || event.type !== "settings") return;
    if ((event.hostId ?? localHostId) !== hostId) return;
    if (event.target !== undefined && !sameTarget(event.target, target)) return;
    void load();
  }), [bridge, connected, hostId, load, localHostId, targetKey]);

  const close = useCallback(() => {
    if (operationGuard.current) return;
    detailSequence.current++;
    setSurface(null);
    restoreFocus();
  }, [restoreFocus]);

  const openDetail = useCallback(async (host: NativeSshHost, element: HTMLElement, revision = catalog?.revision) => {
    if (!revision || operationGuard.current) return;
    opener.current = element;
    const epoch = ownerEpoch.current;
    const sequence = ++detailSequence.current;
    setSurface({ kind: "detail", host, detail: null, loading: true, error: null, stale: false });
    try {
      const detail = await bridge.getSshHostDetail(target, { hostId: host.id, expectedRevision: revision }, hostId);
      if (epoch !== ownerEpoch.current || sequence !== detailSequence.current) return;
      setSurface({ kind: "detail", host: detail.host, detail, loading: false, error: null, stale: catalogRevision.current !== null && detail.revision !== catalogRevision.current });
    } catch (cause) {
      if (epoch === ownerEpoch.current && sequence === detailSequence.current) setSurface({ kind: "detail", host, detail: null, loading: false, error: failure(cause), stale: false });
    }
  }, [bridge, catalog?.revision, hostId, targetKey]);

  const reloadSurface = useCallback(async () => {
    const latest = catalog;
    if (!latest || !surface || operationGuard.current) return;
    if (surface.kind === "add") {
      setSurface({ ...surface, baseRevision: latest.revision, stale: false, error: null });
      return;
    }
    const host = surface.host;
    const epoch = ownerEpoch.current;
    const sequence = ++detailSequence.current;
    setSurface(current => current ? { ...current, error: null } : current);
    try {
      const detail = await bridge.getSshHostDetail(target, { hostId: host.id, expectedRevision: latest.revision }, hostId);
      if (epoch !== ownerEpoch.current || sequence !== detailSequence.current) return;
      if (surface.kind === "edit") setSurface({ kind: "edit", host: detail.host, raw: detail.config, values: configValues(detail.config), baseRevision: detail.revision, error: null, stale: false });
      else if (surface.kind === "remove") setSurface({ kind: "remove", host: detail.host, baseRevision: detail.revision, error: null, stale: false });
      else setSurface({ kind: "detail", host: detail.host, detail, loading: false, error: null, stale: false });
    } catch (cause) {
      if (epoch === ownerEpoch.current && sequence === detailSequence.current) setSurface(current => current ? { ...current, error: failure(cause) } : current);
    }
  }, [bridge, catalog, hostId, surface, targetKey]);

  const mutate = useCallback(async (mutation: NativeSshMutation) => {
    if (!connected || operationGuard.current) return;
    operationGuard.current = true;
    const operationId = ++operationSequence.current;
    readSequence.current++;
    setLoading(false);
    refreshQueued.current = false;
    setOperation(true);
    setSurface(current => current ? { ...current, error: null } : current);
    const epoch = ownerEpoch.current;
    try {
      const next = await bridge.mutateSshHost(target, mutation, hostId);
      if (epoch !== ownerEpoch.current) return;
      catalogRevision.current = next.revision;
      setCatalog(next);
      setSurface(null);
      restoreFocus();
    } catch (cause) {
      if (epoch === ownerEpoch.current) {
        setSurface(current => current ? { ...current, error: failure(cause), stale: true } : current);
        refreshQueued.current = true;
      }
    } finally {
      if (epoch === ownerEpoch.current && operationId === operationSequence.current) {
        setOperation(false);
        operationGuard.current = false;
        if (refreshQueued.current) { refreshQueued.current = false; void load(); }
      }
    }
  }, [bridge, connected, hostId, load, restoreFocus, targetKey]);

  const beginAdd = (element: HTMLElement) => {
    if (!catalog || operationGuard.current) return;
    opener.current = element;
    setSurface({ kind: "add", scope: target ? "project" : "user", name: "", values: emptyConfig(), baseRevision: catalog.revision, error: null, stale: false });
  };

  const beginEdit = (detail: NativeSshDetail) => setSurface({
    kind: "edit", host: detail.host, raw: detail.config, values: configValues(detail.config), baseRevision: detail.revision, error: null, stale: catalog?.revision !== detail.revision,
  });

  return <section ref={container} className="ssh-tool-settings" aria-label="SSH tool targets">
    <div className="ssh-tool-heading">
      <div><h2>SSH tool targets</h2><p>Run remote commands and access files with OMP on {hostName}.</p></div>
      <div className="ssh-tool-heading-actions">
        <button className="icon-button small" type="button" aria-label="Reload SSH tool targets" title="Reload" disabled={!connected || loading || operation} onClick={() => void load()}>{loading ? <span className="spinner"/> : <Icon name="refresh"/>}</button>
        <button className="secondary-button ssh-tool-add" type="button" disabled={!connected || !catalog || operation} onClick={event => beginAdd(event.currentTarget)}><Icon name="plus"/>Add</button>
      </div>
    </div>
    {!connected && <div className="connection-banner" role="status">This machine is disconnected. Saved SSH targets are unavailable.</div>}
    {error && <div className="inline-error ssh-tool-error" role="alert"><span>{error}</span><button className="secondary-button" type="button" disabled={!connected || loading} onClick={() => void load()}>Reload</button></div>}
    {catalog?.warnings.map((warning, index) => <div className="ssh-tool-warning" role="status" key={`${index}:${warning}`}>{warning}</div>)}
    {!catalog && connected && !error && <p className="ssh-tool-empty" role="status">{loading ? "Loading SSH tool targets…" : "Reload to read saved SSH tool targets."}</p>}
    {catalog && catalog.hosts.length === 0 && <div className="ssh-tool-card ssh-tool-empty"><Icon name="terminal"/><p>No SSH tool targets are configured.</p><button className="secondary-button" type="button" disabled={!connected || operation} onClick={event => beginAdd(event.currentTarget)}>Add SSH target</button></div>}
    {catalog && catalog.hosts.length > 0 && <div className="ssh-tool-card"><ul className="ssh-tool-list">{catalog.hosts.map(host => <li className="ssh-tool-row" key={host.id}>
      <Icon name="terminal" className="ssh-tool-row-icon"/>
      <button className="ssh-tool-row-main" type="button" disabled={!connected || operation} onClick={event => void openDetail(host, event.currentTarget)}>
        <strong>{host.name}{host.shadowed && <span className="ssh-tool-badge">Shadowed</span>}</strong>
        <span>{host.scope === "project" ? "Project" : "User"} · {host.source}{!host.editable ? " · Read only" : ""}</span>
      </button>
      <button className="icon-button small ssh-tool-row-action" type="button" aria-label={`View ${host.name}`} disabled={!connected || operation} onClick={event => void openDetail(host, event.currentTarget)}><Icon name="more"/></button>
    </li>)}</ul></div>}
    {surface && <SshDialog surface={surface} connected={connected} busy={operation} refreshing={loading} hasProject={!!target} onChange={setSurface} onClose={close} onReload={() => void reloadSurface()} onEdit={beginEdit} onMutate={mutation => void mutate(mutation)}/>} 
  </section>;
}

function SshDialog({ surface, connected, busy, refreshing, hasProject, onChange, onClose, onReload, onEdit, onMutate }: {
  surface: Surface;
  connected: boolean;
  busy: boolean;
  refreshing: boolean;
  hasProject: boolean;
  onChange(next: Surface): void;
  onClose(): void;
  onReload(): void;
  onEdit(detail: NativeSshDetail): void;
  onMutate(mutation: NativeSshMutation): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    node.showModal();
    requestAnimationFrame(() => (node.querySelector<HTMLElement>("[data-autofocus]") ?? node).focus());
    return () => { if (node.open) node.close(); };
  }, []);
  useEffect(() => { requestAnimationFrame(() => (dialog.current?.querySelector<HTMLElement>("[data-autofocus]") ?? dialog.current)?.focus()); }, [surface.kind]);
  const title = surface.kind === "add" ? "Add SSH target" : surface.kind === "edit" ? `Edit ${surface.host.name}` : surface.kind === "remove" ? `Remove ${surface.host.name}?` : surface.host.name;
  const updateValues = (patch: Partial<KnownConfig>) => {
    if (surface.kind === "edit" || surface.kind === "add") onChange({ ...surface, values: { ...surface.values, ...patch }, error: null });
  };
  const submit = () => {
    if (surface.kind !== "edit" && surface.kind !== "add") return;
    const invalid = validation(surface.values, surface.kind === "add" ? surface.name : undefined);
    if (invalid) { onChange({ ...surface, error: invalid }); return; }
    if (surface.stale) return;
    if (surface.kind === "add") onMutate({ operation: "add", expectedRevision: surface.baseRevision, scope: surface.scope, name: surface.name.trim(), config: buildConfig({}, surface.values) });
    else onMutate({ operation: "update", expectedRevision: surface.baseRevision, hostId: surface.host.id, config: buildConfig(surface.raw, surface.values) });
  };
  return <dialog ref={dialog} tabIndex={-1} className="ssh-tool-dialog" aria-labelledby="ssh-tool-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} onClick={event => { if (event.target !== event.currentTarget || busy) return; const box = event.currentTarget.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose(); }}>
    <div className="ssh-tool-dialog-heading"><Icon name="terminal"/><h2 id="ssh-tool-dialog-title">{title}</h2><button className="icon-button small" type="button" aria-label="Close SSH target" disabled={busy} onClick={onClose}><Icon name="close"/></button></div>
    {surface.error && <div className="inline-error" role="alert">{surface.error}</div>}
    {surface.stale && <div className="ssh-tool-stale" role="alert"><span>Saved SSH targets changed. Review the latest value before making this change.</span><button className="secondary-button" type="button" disabled={!connected || busy || refreshing} onClick={onReload}>{refreshing ? "Reloading…" : "Review latest"}</button></div>}
    {surface.kind === "detail" && <DetailContent surface={surface} connected={connected} busy={busy} onReload={onReload} onEdit={onEdit} onChange={onChange}/>} 
    {(surface.kind === "edit" || surface.kind === "add") && <form className="ssh-tool-form" onSubmit={event => { event.preventDefault(); submit(); }}><fieldset disabled={busy}>
      {surface.kind === "add" && <><label>Name<input data-autofocus name="name" autoComplete="off" value={surface.name} onChange={event => onChange({ ...surface, name: event.target.value, error: null })}/></label><label>Scope<select aria-label="SSH target scope" value={surface.scope} onChange={event => onChange({ ...surface, scope: event.target.value as "user" | "project", error: null })}><option value="user">User configuration</option><option value="project" disabled={!hasProject}>This project</option></select></label></>}
      {surface.kind === "edit" && <label>Name<input value={surface.host.name} disabled/><span className="ssh-tool-help">Target names cannot be renamed. Add a new target to use a different name.</span></label>}
      <label>Host<input data-autofocus={surface.kind === "edit" ? true : undefined} name="host" autoComplete="off" value={surface.values.host} onChange={event => updateValues({ host: event.target.value })}/></label>
      <div className="ssh-tool-form-pair"><label>Username<input name="username" autoComplete="off" value={surface.values.username} onChange={event => updateValues({ username: event.target.value })}/></label><label>Port<input name="port" inputMode="numeric" autoComplete="off" value={surface.values.port} onChange={event => updateValues({ port: event.target.value })}/></label></div>
      <label>Identity file path<input name="keyPath" autoComplete="off" placeholder="~/.ssh/id_ed25519" value={surface.values.keyPath} onChange={event => updateValues({ keyPath: event.target.value })}/><span className="ssh-tool-help">Only the path is saved and displayed. Private key contents are never read here.</span></label>
      <label>Description<input name="description" autoComplete="off" value={surface.values.description} onChange={event => updateValues({ description: event.target.value })}/></label>
      <label className="ssh-tool-check"><input type="checkbox" checked={surface.values.compat} onChange={event => updateValues({ compat: event.target.checked })}/><span>Compatibility mode</span></label>
      <div className="ssh-tool-dialog-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={!connected || surface.stale}>{busy ? "Saving…" : surface.kind === "add" ? "Add target" : "Save changes"}</button></div>
    </fieldset></form>}
    {surface.kind === "remove" && <div className="ssh-tool-confirm"><p>This removes <strong>{surface.host.name}</strong> from its {surface.host.scope} configuration. A shadowed target from another source may become active.</p><div className="ssh-tool-dialog-actions"><button data-autofocus className="secondary-button" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="danger-button" type="button" disabled={!connected || busy || surface.stale} onClick={() => onMutate({ operation: "remove", expectedRevision: surface.baseRevision, hostId: surface.host.id })}>{busy ? "Removing…" : "Remove target"}</button></div></div>}
  </dialog>;
}

function DetailContent({ surface, connected, busy, onReload, onEdit, onChange }: {
  surface: Extract<Surface, { kind: "detail" }>;
  connected: boolean;
  busy: boolean;
  onReload(): void;
  onEdit(detail: NativeSshDetail): void;
  onChange(next: Surface): void;
}) {
  if (surface.loading) return <p className="ssh-tool-dialog-status" role="status">Loading saved target…</p>;
  if (!surface.detail) return <div className="ssh-tool-dialog-status"><p>The saved target could not be loaded.</p><button data-autofocus className="secondary-button" type="button" disabled={!connected || busy} onClick={onReload}>Reload target</button></div>;
  const { detail } = surface;
  const values = configValues(detail.config);
  const extra = Object.keys(detail.config).filter(key => !["host", "username", "port", "keyPath", "key", "description", "compat"].includes(key)).length;
  return <>
    <dl className="ssh-tool-detail-list">
      <div><dt>Scope</dt><dd>{detail.host.scope === "project" ? "Project" : "User"}</dd></div>
      <div><dt>Source</dt><dd>{detail.host.source}</dd></div>
      <div><dt>Host</dt><dd>{values.host || "Not set"}</dd></div>
      <div><dt>Username</dt><dd>{values.username || "Default"}</dd></div>
      <div><dt>Port</dt><dd>{values.port || "Default"}</dd></div>
      <div><dt>Identity file</dt><dd>{values.keyPath || "Default"}</dd></div>
      <div><dt>Description</dt><dd>{values.description || "None"}</dd></div>
      <div><dt>Compatibility mode</dt><dd>{values.compat ? "On" : "Off"}</dd></div>
      {extra > 0 && <div><dt>Additional saved fields</dt><dd>{extra} preserved</dd></div>}
    </dl>
    {!detail.host.editable && <p className="ssh-tool-readonly" role="status">This target comes from a discovered legacy SSH source and is read only here.</p>}
    <div className="ssh-tool-dialog-actions">
      {detail.host.editable && <><button data-autofocus className="secondary-button" type="button" disabled={!connected || busy || surface.stale} onClick={() => onEdit(detail)}>Edit</button><button className="danger-link" type="button" disabled={!connected || busy || surface.stale} onClick={() => onChange({ kind: "remove", host: detail.host, baseRevision: detail.revision, error: null, stale: false })}>Remove…</button></>}
    </div>
  </>;
}
