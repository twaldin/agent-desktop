import { useEffect, useRef, useState } from "react";
import type { ComposerAction, DesktopBridge, NativeMcpCatalog, NativeMcpDetail, NativeMcpMutation, NativePlugin, NativePluginCatalog, NativePluginMutation, WorkspaceTarget } from "@agent-desktop/shared";
import { Icon } from "./Icons";
import { readMcpServerForm } from "./mcp-server-form";
import { McpServerForm } from "./McpServerForm";
import { NativePluginDirectory } from "./NativePluginDirectory";
import { PluginAcquisition } from "./PluginAcquisition";
import { SessionMcp } from "./SessionMcp";
import "./native-integrations.css";

function message(error: unknown): string { return error instanceof Error ? error.message : "The owning host could not complete this request."; }
export function pluginSettingDisabled(plugin: NativePlugin, connected: boolean, saving: boolean): boolean {
  return !connected || saving || !plugin.canSetSettings;
}
export function applyCatalogResponse<T>(currentEpoch: number, responseEpoch: number, value: T): T | undefined {
  return currentEpoch === responseEpoch ? value : undefined;
}
export function mcpTransportLabel(transport: string | undefined): string {
  return transport === "stdio" || transport === "http" || transport === "sse" ? transport : "Unknown transport";
}

export interface NativeIntegrationsProps {
  bridge: DesktopBridge;
  hostId: string;
  hostName: string;
  connected: boolean;
  target?: WorkspaceTarget;
  page: "plugins" | "mcp";
  onTrySkill?(action: ComposerAction): void;
  onClose(): void;
  onBrowse?(tab?:"plugins"|"skills"): void;
  initialPluginId?: string;
  initialMarketplace?: { name?: string; add?: boolean };
  onPageChange?(page: "plugins" | "mcp"): void;
  sessionIdle?: boolean;
}

export function NativeIntegrations({ bridge, hostId, hostName, connected, target, page, onClose, onPageChange, onBrowse, onTrySkill, initialPluginId, initialMarketplace, sessionIdle = false }: NativeIntegrationsProps) {
  const [skills,setSkills]=useState(false),[skillsRefresh,setSkillsRefresh]=useState(0);
  const [actionsRoot,setActionsRoot]=useState<HTMLDivElement|null>(null);
  const [marketplaces,setMarketplaces]=useState(Boolean(initialMarketplace)),[addMcp,setAddMcp]=useState(false);
  useEffect(()=>{if(page==='mcp'){setMarketplaces(false);setSkills(false);}},[page]);
  const [plugins, setPlugins] = useState<NativePluginCatalog | null>(null);
  const [mcp, setMcp] = useState<NativeMcpCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, updateSaving] = useState(false);
  const savingRef = useRef(false);
  const setSaving = (value: boolean) => { savingRef.current = value; if (value) { epoch.current++; setLoading(false); } updateSaving(value); };
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(initialPluginId ?? null);
  const [liveMcp, setLiveMcp] = useState(false);
  const epoch = useRef(0);
  const targetKey = JSON.stringify(target);
  const reload = async () => {
    if (!connected || savingRef.current) return;
    const current = ++epoch.current;
    setLoading(true); setError(null);
    try {
      const value = page === "plugins" ? await bridge.getPlugins(target, hostId) : await bridge.getMcpServers(target, hostId);
      const accepted = applyCatalogResponse(epoch.current, current, value);
      if (accepted) page === "plugins" ? setPlugins(accepted as NativePluginCatalog) : setMcp(accepted as NativeMcpCatalog);
    } catch (cause) { if (current === epoch.current) setError(message(cause)); }
    finally { if (current === epoch.current) setLoading(false); }
  };
  useEffect(() => {
    // A write belongs to the old context; its fenced completion must not keep
    // the new host/project (or a reconnected view) permanently disabled.
    setSaving(false); setSelected(initialPluginId ?? null); setLiveMcp(false); setPlugins(null); setMcp(null); setQuery("");
    void reload(); return () => { epoch.current++; };
  }, [page, hostId, targetKey, connected]);
  useEffect(() => bridge.subscribe(event => {
    if (!connected || (event.hostId ?? hostId) !== hostId) return;
    if (event.type === "settings" || event.type === "state") void reload();
  }), [bridge, connected, hostId, page, targetKey]);
  const plugin = plugins?.plugins.find(item => item.id === selected);
  return <section className="settings-page native-integrations" aria-label={page === "plugins" ? "Plugins" : "MCP servers"}>
    <div className="integration-content">
    <header className="integration-heading"><div><h1>Plugins</h1><p>Manage plugins, skills, and MCPs on {hostName}</p></div><div className="integration-header-actions">{onBrowse&&<button className="secondary-button" onClick={()=>onBrowse()}>Browse directory</button>}<div ref={setActionsRoot}/><button className="icon-button" aria-label="Reload integrations" title="Reload integrations" disabled={!connected || loading || saving} onClick={() => {setSkillsRefresh(x=>x+1);void reload();}}><Icon name="refresh"/></button></div></header>
    <div className="integration-navigation"><div role="tablist" aria-label="Integrations"><button role="tab" aria-selected={page === "plugins" && !marketplaces && !skills} onClick={() => { setMarketplaces(false); setSkills(false); onPageChange?.("plugins"); }}>Plugins{plugins ? ` ${plugins.plugins.length}` : ""}</button><button role="tab" aria-selected={page === "mcp"} onClick={() => {setAddMcp(false);onPageChange?.("mcp");}}>MCPs{mcp ? ` ${mcp.servers.length}` : ""}</button><button role="tab" aria-selected={page === "plugins" && skills} onClick={()=>{setMarketplaces(false);setSkills(true);onPageChange?.("plugins");}}>Skills</button><button role="tab" aria-selected={page === "plugins" && marketplaces} onClick={()=>{setMarketplaces(true);setSkills(false);onPageChange?.("plugins");}}>Marketplace</button></div><label className="integration-search"><Icon name="search"/><input type="search" aria-label={page === "plugins" ? marketplaces ? "Search marketplaces" : skills ? "Search skills" : "Search plugins" : "Search MCP servers"} placeholder={page === "plugins" ? marketplaces ? "Search marketplaces" : skills ? "Search skills" : "Search plugins" : "Search MCP servers"} value={query} onChange={event => setQuery(event.target.value)}/></label></div>
    {!connected && <div className="connection-banner" role="status">This machine is disconnected. Changes require reconnection.</div>}
    {error && <div className="inline-error settings-error" role="alert">{error}</div>}
    {page === "plugins" ? <PluginAcquisition key={`${hostId}:${targetKey}`} bridge={bridge} hostId={hostId} target={target} connected={connected} visible={marketplaces} initialMarketplace={initialMarketplace?.name} initialAdd={initialMarketplace?.add} query={query} actionsRoot={actionsRoot} onMcp={()=>{setAddMcp(true);onPageChange?.("mcp");}} onInstalledChanged={()=>void reload()}>{skills ? <NativePluginDirectory key={`${hostId}:${targetKey}`} embeddedSkills onTrySkill={onTrySkill} initialTab="skills" search={query} refreshKey={skillsRefresh} bridge={bridge} hostId={hostId} hostName={hostName} target={target} connected={connected} onManage={()=>setSkills(false)} onMarketplace={()=>{setSkills(false);setMarketplaces(true);}} onClose={()=>setSkills(false)}/> : <PluginPage catalog={plugins ? {...plugins, plugins:plugins.plugins.filter(p => `${p.name} ${p.title} ${p.description ?? ""}`.toLowerCase().includes(query.toLowerCase()))} : null} selected={plugin} connected={connected} saving={saving} setSaving={setSaving} setCatalog={setPlugins} setError={setError} bridge={bridge} target={target} hostId={hostId} onSelect={setSelected}/>}</PluginAcquisition> : liveMcp && target && "sessionId" in target ? <SessionMcp bridge={bridge} hostId={hostId} sessionId={target.sessionId} target={target} connected={connected} idle={sessionIdle} mutationPending={saving} query={query} onBack={() => setLiveMcp(false)}/> : <McpPage initialAdd={addMcp} key={`${hostId}:${targetKey}`} catalog={mcp ? {...mcp, servers:mcp.servers.filter(s => s.name.toLowerCase().includes(query.toLowerCase()))} : null} connected={connected} saving={saving} setSaving={setSaving} setCatalog={setMcp} setError={setError} bridge={bridge} target={target} hostId={hostId} onLive={() => setLiveMcp(true)}/>}
    </div>
  </section>;
}

function PluginPage({ catalog, selected, connected, saving, setSaving, setCatalog, setError, bridge, target, hostId, onSelect }: { catalog: NativePluginCatalog | null; selected?: NativePlugin; connected: boolean; saving: boolean; setSaving: (v: boolean) => void; setCatalog: (v: NativePluginCatalog) => void; setError: (v: string | null) => void; bridge: DesktopBridge; target?: WorkspaceTarget; hostId: string; onSelect: (id: string) => void }) {
  const epochForMutations = useRef(0);
  useEffect(() => () => { epochForMutations.current++; }, [hostId, JSON.stringify(target), connected]);
  const mutate = async (mutation: NativePluginMutation): Promise<boolean> => { const requestEpoch = epochForMutations.current; setSaving(true); setError(null); try { const value = await bridge.mutatePlugin(target, mutation, hostId); if (requestEpoch === epochForMutations.current) setCatalog(value); return requestEpoch === epochForMutations.current; } catch (cause) { if (requestEpoch === epochForMutations.current) setError(message(cause)); return false; } finally { if (requestEpoch === epochForMutations.current) setSaving(false); } };
  return <div className="integration-layout"><aside className={`integration-list ${selected ? "integration-list-hidden" : ""}`} aria-label="Installed plugins">{!catalog && <p role="status">{connected ? "Loading plugins…" : "Plugin catalog unavailable offline."}</p>}{catalog?.plugins.length === 0 && <p className="integration-placeholder">No plugins found in this native configuration.</p>}{catalog?.plugins.map(plugin => <button key={plugin.id} className={plugin.id === selected?.id ? "selected" : ""} onClick={() => onSelect(plugin.id)}><Icon name="folder"/><span><strong>{plugin.title || plugin.name}</strong><small>{plugin.version} · {plugin.scope}{plugin.shadowed ? " · Shadowed" : ""}</small></span><i className={plugin.enabled ? "on" : ""}/></button>)}</aside><main className="integration-detail">{selected ? <><button className="integration-back" type="button" onClick={() => onSelect("")}><Icon name="browserBack"/> Plugins</button><div className="integration-title"><div><h2>{selected.title || selected.name}</h2><p>{selected.description || "Native OMP plugin"}</p></div>{selected.canToggle ? <label className="integration-toggle"><input type="checkbox" checked={selected.enabled} disabled={!connected || saving} onChange={event => void mutate({ expectedRevision: catalog!.revision, pluginId: selected.id, operation: "enabled", enabled: event.target.checked })}/> Enabled</label> : <span className="integration-note">{selected.configurationReason || "Managed by native OMP configuration"}</span>}</div><p className="integration-scope">Applies to {selected.scope === "project" ? "this project" : "new sessions"}. Saved changes affect future native sessions.</p>{selected.features.length > 0 && <section className="integration-section"><div className="integration-list-heading"><h3>Features</h3>{selected.canSetFeatures && <button className="native-reset" type="button" disabled={!connected || saving || selected.enabledFeatures === null} onClick={() => void mutate({expectedRevision:catalog!.revision,pluginId:selected.id,operation:"features",features:null})}>Use defaults</button>}</div>{selected.features.map(feature => <label className="integration-check" key={feature.name}><input type="checkbox" checked={(selected.enabledFeatures ?? selected.features.filter(item => item.default).map(item => item.name)).includes(feature.name)} disabled={!connected || saving || !selected.canSetFeatures} onChange={event => { const current = new Set(selected.enabledFeatures ?? selected.features.filter(item => item.default).map(item => item.name)); if (event.target.checked) current.add(feature.name); else current.delete(feature.name); void mutate({ expectedRevision: catalog!.revision, pluginId: selected.id, operation: "features", features: [...current] }); }}/><span><strong>{feature.name}</strong>{feature.description && <small>{feature.description}</small>}</span></label>)}</section>}{selected.settings.length > 0 && <section className="integration-section"><h3>Settings</h3>{!selected.canSetSettings && <p className="integration-note">{selected.configurationReason || "This plugin’s settings are read-only in the current native host."}</p>}{selected.settings.map(setting => <PluginSettingEditor key={`${selected.id}:${setting.key}`} plugin={selected} setting={setting} catalog={catalog!} connected={connected} saving={saving} mutate={mutate}/>)}</section>}</> : null}</main></div>;
}

function PluginSettingEditor({ plugin, setting, catalog, connected, saving, mutate }: { plugin: NativePlugin; setting: NativePlugin["settings"][number]; catalog: NativePluginCatalog; connected: boolean; saving: boolean; mutate(mutation: NativePluginMutation): Promise<boolean> }) {
  const [value, setValue] = useState<string | number | boolean>(setting.value ?? setting.default ?? (setting.type === "boolean" ? false : setting.type === "number" ? 0 : ""));
  useEffect(() => setValue(setting.value ?? setting.default ?? (setting.type === "boolean" ? false : setting.type === "number" ? 0 : "")), [plugin.id, setting.key, setting.value, setting.default]);
  const disabled = pluginSettingDisabled(plugin, connected, saving);
  const save = async () => { if (await mutate({ expectedRevision: catalog.revision, pluginId: plugin.id, operation: "setting", key: setting.key, value }) && setting.secret) setValue(""); };
  const reset = async () => { if (await mutate({ expectedRevision: catalog.revision, pluginId: plugin.id, operation: "reset-setting", key: setting.key })) setValue(""); };
  return <div className="integration-setting"><span>{setting.key}<small>{setting.description || (setting.secret ? "Secret value" : "Native plugin setting")}</small></span><div className="integration-setting-control">{setting.type === "boolean" ? <input aria-label={`${setting.key} value`} type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={event => setValue(event.target.checked)}/> : setting.type === "enum" ? <select aria-label={`${setting.key} value`} value={String(value)} disabled={disabled} onChange={event => setValue(event.target.value)}>{(setting.values ?? []).map(option => <option key={option} value={option}>{option}</option>)}</select> : <input aria-label={`${setting.key} value`} className="text-field" type={setting.secret ? "password" : setting.type === "number" ? "number" : "text"} value={setting.secret && !value ? "" : String(value)} placeholder={setting.secret ? (setting.configured ? "Configured · enter to replace" : "Not configured") : undefined} min={setting.min} max={setting.max} step={setting.step} disabled={disabled} onChange={event => setValue(setting.type === "number" ? Number(event.target.value) : event.target.value)}/>}<button className="secondary-button" type="button" disabled={disabled} onClick={() => void save()}>Save</button>{setting.configured && <button className="native-reset" type="button" disabled={disabled} onClick={() => void reset()}>Reset</button>}</div></div>;
}

function McpPage({ initialAdd=false, catalog, connected, saving, setSaving, setCatalog, setError, bridge, target, hostId, onLive }: { initialAdd?: boolean; catalog: NativeMcpCatalog | null; connected: boolean; saving: boolean; setSaving: (v: boolean) => void; setCatalog: (v: NativeMcpCatalog) => void; setError: (v: string | null) => void; bridge: DesktopBridge; target?: WorkspaceTarget; hostId: string; onLive?(): void }) {
  const [showAdd, setShowAdd] = useState(initialAdd); const [formOpened, setFormOpened] = useState(initialAdd);
  const [editing, setEditing] = useState(false); const [detail, setDetail] = useState<NativeMcpDetail | null>(null); const [detailLoading, setDetailLoading] = useState(false);
  const epochForMutations = useRef(0); const detailEpoch = useRef(0); const addButton = useRef<HTMLButtonElement>(null); const detailOpener = useRef<HTMLButtonElement | null>(null);
  const targetKey = JSON.stringify(target);
  useEffect(() => () => { epochForMutations.current++; detailEpoch.current++; }, [hostId, targetKey, connected]);
  useEffect(() => { if (!connected) setDetailLoading(false); }, [connected]);
  const mutate = async (mutation: NativeMcpMutation): Promise<boolean> => { const requestEpoch = epochForMutations.current; setSaving(true); setError(null); try { const value = await bridge.mutateMcpServer(target, mutation, hostId); if (requestEpoch === epochForMutations.current) setCatalog(value); return requestEpoch === epochForMutations.current; } catch (cause) { if (requestEpoch === epochForMutations.current) setError(message(cause)); return false; } finally { if (requestEpoch === epochForMutations.current) setSaving(false); } };
  const closeDetails = () => { detailEpoch.current++; setEditing(false); setDetail(null); setDetailLoading(false); setError(null); requestAnimationFrame(() => detailOpener.current?.isConnected ? detailOpener.current.focus() : addButton.current?.focus()); };
  const openDetails = async (serverId: string, opener: HTMLButtonElement) => {
    if (!catalog || !connected || saving) return;
    detailOpener.current = opener; const epoch = ++detailEpoch.current;
    setEditing(true); setDetail(null); setDetailLoading(true); setError(null);
    try {
      const value = await bridge.getMcpServerDetail(target, {serverId, expectedRevision:catalog.revision}, hostId);
      if (value.server.id !== serverId || value.revision !== catalog.revision || value.server.editable !== true) throw new Error("Mismatched MCP detail response.");
      readMcpServerForm(value.config); // Unsupported native fields fail without crashing the settings page.
      if (detailEpoch.current === epoch) setDetail(value);
    } catch { if (detailEpoch.current === epoch) setError("This MCP configuration could not be opened. Go back, reload the catalog, and try again."); }
    finally { if (detailEpoch.current === epoch) setDetailLoading(false); }
  };
  const docs = () => { void bridge.openExternal("https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md").catch(cause => setError(message(cause))); };
  return <div className="mcp-layout">
    <section className="mcp-catalog" hidden={showAdd || editing}>
      <div className="integration-list-heading"><h2>MCP servers</h2><div className="integration-heading-actions">{onLive && target && "sessionId" in target && <button className="secondary-button" type="button" disabled={!connected} onClick={onLive}>Live session state</button>}<button ref={addButton} className="primary-button" disabled={!connected || saving || !catalog} onClick={() => { setFormOpened(true); setShowAdd(true); }}>Add MCP</button></div></div>
      {!catalog && <p role="status">{connected ? "Loading MCP servers…" : "MCP catalog unavailable offline."}</p>}
      {catalog?.servers.map(server => <article className="mcp-row" key={server.id} data-server-id={server.id}><div><strong>{server.name}</strong><small>{mcpTransportLabel(server.transport)}{server.shadowed ? " · Shadowed" : ""} · {server.scope} · {server.source}</small></div><label><input type="checkbox" checked={server.enabled} disabled={!connected || saving} onChange={event => void mutate({ expectedRevision: catalog.revision, operation: "enabled", serverId: server.id, enabled: event.target.checked })}/> Enabled</label>
        {server.editable && <button className="secondary-button" type="button" disabled={!connected || saving} aria-label={`Settings for ${server.name}`} onClick={event => void openDetails(server.id,event.currentTarget)}>Settings</button>}
        {server.removable && !server.editable && <button className="secondary-button" disabled={!connected || saving} onClick={() => { if (window.confirm(`Remove MCP server “${server.name}”?`)) void mutate({ expectedRevision: catalog.revision, operation: "remove", serverId: server.id }); }}>Remove</button>}
      </article>)}
    </section>
    {formOpened && <div hidden={!showAdd}><button className="integration-back" type="button" disabled={saving} onClick={() => { setShowAdd(false); setError(null); requestAnimationFrame(() => addButton.current?.focus()); }}><Icon name="browserBack"/> Back</button>
      <McpServerForm active={showAdd} disabled={!connected || saving || !catalog} hasProject={Boolean(target)} onError={setError} onDocs={docs}
        onSave={async input => { if (!catalog || input.operation !== "add") return false; const success = await mutate({ ...input, expectedRevision: catalog.revision }); if (success) { setShowAdd(false); setFormOpened(false); requestAnimationFrame(() => addButton.current?.focus()); } return success; }}/>
    </div>}
    {editing && <div><button className="integration-back" type="button" disabled={saving} onClick={closeDetails}><Icon name="browserBack"/> Back</button>
      {detailLoading && <p role="status">Loading MCP configuration…</p>}{!detailLoading && !detail && <p className="integration-note">Go back and open the server settings again to read its current configuration.</p>}
      {detail && <McpServerForm key={`${detail.server.id}:${detail.revision}`} initial={detail} active disabled={!connected || saving} hasProject={Boolean(target)} onError={setError} onDocs={docs}
        onUninstall={() => { if (window.confirm(`Uninstall MCP server “${detail.server.name}”?`)) void mutate({operation:"remove",serverId:detail.server.id,expectedRevision:detail.revision}).then(ok => { if(ok) closeDetails(); }); }}
        onSave={async input => { if (input.operation !== "update") return false; const success = await mutate({...input,expectedRevision:detail.revision}); if(success) closeDetails(); return success; }}/> }
    </div>}
  </div>;
}
