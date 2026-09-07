import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComposerAction, ComposerActionsCatalog } from "../../../../packages/shared/src/composer-actions";
import type { DesktopBridge, NativeMarketplaceCatalog, NativePluginCatalog, NativeSkillInventory, OmpSettingsSnapshot, OmpSettingsMutation, SettingsScope, WorkspaceTarget } from "@agent-desktop/shared";
import { assertComposerOwner, targetIdentity } from "./composer-autocomplete";
import { Icon } from "./Icons";
import { NativeSkillDialog } from "./NativeSkillDialog";
import { skillToggleState, skillEnabledMutation } from "./skill-settings";
import "./native-plugin-directory.css";

export interface NativePluginDirectoryProps {
  bridge: DesktopBridge;
  hostId: string;
  hostName: string;
  connected: boolean;
  target?: WorkspaceTarget;
  initialTab?: "plugins" | "skills";
  restoreFocusLabel?: string;
  embeddedSkills?: boolean;
  search?: string;
  refreshKey?: number;
  onTabChange?(tab: "plugins" | "skills"): void;
  onManage(pluginId?: string): void;
  onMarketplace(name?: string): void;
  onTrySkill?(action: ComposerAction): void;
  onClose(): void;
}

type Catalogs = { plugins: NativePluginCatalog | null; marketplaces: NativeMarketplaceCatalog | null; composer: ComposerActionsCatalog | null; inventory: NativeSkillInventory | null; settings: OmpSettingsSnapshot | null };
type CatalogStatus = { plugins: "unknown" | "available" | "unavailable"; marketplaces: "unknown" | "available" | "unavailable"; composer: "unknown" | "available" | "unavailable" };
type SkillState = { inventory?: boolean; owner: string; revision?: string; action: ComposerAction; loading: boolean; content?: string; error?: string };
const emptyCatalogs = (): Catalogs => ({ plugins: null, marketplaces: null, composer: null, inventory: null, settings: null });
const emptyStatus = (): CatalogStatus => ({ plugins: "unknown", marketplaces: "unknown", composer: "unknown" });
const errorText = (error: unknown): string => error instanceof Error ? error.message : "The owning host could not load this directory.";

function sourceLabel(action: ComposerAction): string {
  return action.source.path ? `${action.source.label} · ${action.source.path}` : action.source.label;
}

export function NativePluginDirectory({ bridge, hostId, hostName, connected, target: inputTarget, initialTab = "plugins", onTabChange, restoreFocusLabel, embeddedSkills = false, search, refreshKey, onTrySkill, onManage, onMarketplace, onClose }: NativePluginDirectoryProps) {
  const targetKey = targetIdentity(inputTarget);
  // App snapshots can recreate an equivalent target without changing its owner.
  const target = useMemo(() => inputTarget, [targetKey]);
  const owner = `${hostId}:${targetKey}`;
  const ownerRef = useRef(owner);
  const loadEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const mounted = useRef(true);
  const skillOpener = useRef<string | null>(null);
  const root = useRef<HTMLElement | null>(null);
  const focusRestored = useRef(false);
  const [tab, setTab] = useState<"plugins" | "skills">(initialTab);
  const [query, setQuery] = useState("");
  const [catalogState, setCatalogState] = useState<{ owner: string; value: Catalogs; status: CatalogStatus }>(() => ({ owner, value: emptyCatalogs(), status: emptyStatus() }));
  const [scope, setScope] = useState<SettingsScope>(target ? "project" : "global");
  const [saving, setSaving] = useState(false), savingRef = useRef(false), writeEpoch = useRef(0);
  const [saveNotice,setSaveNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skill, setSkill] = useState<SkillState | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    const ticket = ++loadEpoch.current;
    setLoading(true);
    setError(null);
    const inventoryRequest = bridge.getSkillInventory?.(target, refresh, hostId) ?? Promise.resolve(null);
    const responses = await Promise.allSettled([
      bridge.getPlugins(target, hostId),
      bridge.getMarketplaceCatalog(target, hostId),
      inventoryRequest.then(value => value ? null : bridge.getComposerActions?.(target, refresh, hostId) ?? Promise.reject(new Error("Update the owning host to load native skills."))),
      inventoryRequest,
      bridge.getSkillInventory ? bridge.getSettings(target, hostId) : Promise.resolve(null),
    ]);
    if (!mounted.current || ticket !== loadEpoch.current || ownerRef.current !== owner) return;
    const next: Catalogs = { plugins: responses[0].status === "fulfilled" ? responses[0].value : null, marketplaces: responses[1].status === "fulfilled" ? responses[1].value : null, composer: responses[2].status === "fulfilled" ? responses[2].value : null, inventory: responses[3].status === "fulfilled" ? responses[3].value : null, settings: responses[4].status === "fulfilled" ? responses[4].value : null };
    if (responses[2].status === "fulfilled" && !next.composer && !next.inventory) responses[2] = { status: "rejected", reason: new Error("Update the owning host to load native skills.") };
    if (next.composer) {
      try { assertComposerOwner(next.composer, hostId, target); }
      catch (cause) { next.composer = null; responses[2] = { status: "rejected", reason: cause }; }
    }
    if (next.inventory) {
      try { assertComposerOwner(next.inventory, hostId, target); if(next.settings && next.settings.cwd !== next.inventory.cwd) throw new Error("Skill settings belong to a different workspace."); }
      catch(cause) { next.inventory=null;next.settings=null;responses[3]={status:"rejected",reason:cause}; }
    }
    setCatalogState(current => {
      const prior = current.owner === owner ? current : { owner, value: emptyCatalogs(), status: emptyStatus() };
      return { owner, value: {
        plugins: responses[0].status === "fulfilled" ? next.plugins : prior.value.plugins,
        marketplaces: responses[1].status === "fulfilled" ? next.marketplaces : prior.value.marketplaces,
        composer: responses[2].status === "fulfilled" ? next.composer : prior.value.composer,
        inventory: responses[3].status === "fulfilled" ? next.inventory : prior.value.inventory,
        settings: responses[4].status === "fulfilled" && responses[3].status === "fulfilled" ? next.settings : null,
      }, status: {
        plugins: responses[0].status === "fulfilled" ? "available" : prior.value.plugins ? "available" : "unavailable",
        marketplaces: responses[1].status === "fulfilled" ? "available" : prior.value.marketplaces ? "available" : "unavailable",
        composer: responses[2].status === "fulfilled" ? "available" : prior.value.composer ? "available" : "unavailable",
      } };
    });
    const failures = responses.filter(result => result.status === "rejected") as PromiseRejectedResult[];
    setError(failures.length ? failures.map(result => errorText(result.reason)).filter((value, index, all) => all.indexOf(value) === index).join(" ") : null);
    setLoading(false);
  }, [bridge, hostId, owner, target]);

  useEffect(() => {
    mounted.current = true;
    if (ownerRef.current !== owner) {
      ownerRef.current = owner;
      writeEpoch.current++;savingRef.current=false;setSaving(false);
      loadEpoch.current++;
      detailEpoch.current++;
      setCatalogState({ owner, value: emptyCatalogs(), status: emptyStatus() });
      setSkill(null);setScope(target ? "project" : "global");setSaveNotice(null);
      setQuery("");
      setError(null);
    }
    if (connected) void load(false);
    else {
      loadEpoch.current++;
      detailEpoch.current++;
      setLoading(false);
      setSkill(current => current?.owner === owner && current.loading ? { ...current, loading: false, error: `${hostName} is offline.` } : current);
    }
    return () => { loadEpoch.current++; detailEpoch.current++; };
  }, [connected, hostName, load, owner, refreshKey]);
  useEffect(() => bridge.subscribe(event => {
    if (event.type === "settings" && connected && (event.hostId ?? hostId) === hostId && !savingRef.current) void load(true);
  }), [bridge, hostId, connected, load]);
  useEffect(() => () => { mounted.current = false; loadEpoch.current++; detailEpoch.current++; }, []);

  useEffect(() => {
    if (focusRestored.current || !restoreFocusLabel || loading) return;
    const frame = requestAnimationFrame(() => {
      const candidate = [...(root.current?.querySelectorAll<HTMLElement>("button[aria-label]") ?? [])].find(item => item.getAttribute("aria-label") === restoreFocusLabel);
      if (candidate) { focusRestored.current = true; candidate.focus(); }
    });
    return () => cancelAnimationFrame(frame);
  }, [restoreFocusLabel, loading, catalogState]);

  const catalogs = catalogState.owner === owner ? catalogState.value : emptyCatalogs();
  const statuses = catalogState.owner === owner ? catalogState.status : emptyStatus();
  const pluginStatus = catalogs.plugins ? "available" : connected ? statuses.plugins : "unavailable";
  const marketplaceStatus = catalogs.marketplaces ? "available" : connected ? statuses.marketplaces : "unavailable";
  const skillCatalog = catalogs.inventory ?? catalogs.composer;
  const skillStatus = skillCatalog ? "available" : connected ? statuses.composer : "unavailable";
  const ownedSkill = skill?.owner === owner ? skill : null;
  const restoreSkillFocus = () => {
    const ticket = detailEpoch.current, id = skillOpener.current;
    requestAnimationFrame(() => {
      if (!mounted.current || ownerRef.current !== owner || detailEpoch.current !== ticket || root.current?.querySelector("dialog[open]")) return;
      const opener = [...(root.current?.querySelectorAll<HTMLButtonElement>("button[data-skill-id]") ?? [])].find(item => item.dataset.skillId === id);
      (opener ?? root.current)?.focus();
    });
  };
  useEffect(() => {
    if (!ownedSkill?.revision || !skillCatalog || ownedSkill.revision === skillCatalog.revision) return;
    detailEpoch.current++;
    setSkill(null);
    setError("The skill catalog changed. Open the skill again to read its current file.");
    restoreSkillFocus();
  }, [skillCatalog?.revision, ownedSkill?.revision]);
  const installed = catalogs.plugins?.plugins ?? [];
  const marketplaceRows = useMemo(() => (catalogs.marketplaces?.marketplaces ?? []).flatMap(marketplace => marketplace.plugins.map(plugin => ({ marketplace, plugin }))), [catalogs.marketplaces]);
  const normalizedQuery = (search ?? query).trim().toLocaleLowerCase();
  const visibleMarketplace = marketplaceRows.filter(({ marketplace, plugin }) => !normalizedQuery || `${plugin.name} ${plugin.description ?? ""} ${marketplace.name}`.toLocaleLowerCase().includes(normalizedQuery));
  const visibleSkills = (skillCatalog?.skills ?? []).filter(item => !normalizedQuery || `${item.name} ${item.description} ${item.source.label}`.toLocaleLowerCase().includes(normalizedQuery));
  const installedIds = useMemo(() => new Set(catalogs.marketplaces?.installed.map(item => item.id) ?? []), [catalogs.marketplaces]);

  const openSkill = async (action: ComposerAction) => {
    skillOpener.current = action.id;
    const catalog = skillCatalog;
    const inventory = Boolean(catalogs.inventory);
    const read = bridge.getSkillDetail;
    setSkill({ inventory, owner, revision: catalog?.revision, action, loading: true });
    if (!catalog || !read) { setSkill({ inventory, owner, revision: catalog?.revision, action, loading: false, error: "Update the owning host to read this skill." }); return; }
    const ticket = ++detailEpoch.current;
    try {
      const value = await read(target, action.id, catalog.revision, hostId, inventory);
      if (!mounted.current || ticket !== detailEpoch.current || ownerRef.current !== owner) return;
      assertComposerOwner(value, hostId, target);
      if (value.revision !== catalog.revision || value.skillId !== action.id || typeof value.content !== "string") {
        throw new Error("The skill response belongs to a different host, workspace, or catalog revision.");
      }
      setSkill({ inventory, owner, revision: catalog?.revision, action, loading: false, content: value.content });
    } catch (cause) {
      if (mounted.current && ticket === detailEpoch.current && ownerRef.current === owner) setSkill({ inventory, owner, revision: catalog?.revision, action, loading: false, error: errorText(cause) });
    }
  };
  const changeSetting = async (mutation: OmpSettingsMutation) => {
    if (!connected || savingRef.current || !catalogs.inventory || !catalogs.settings) return;
    const ticket=++writeEpoch.current;
    loadEpoch.current++;setLoading(false);savingRef.current=true;setSaving(true);setError(null);setSaveNotice(null);
    const own=owner;
    try {
      await bridge.setSetting(mutation,target,hostId);
      if(!mounted.current || ownerRef.current!==own || writeEpoch.current!==ticket)return;
      setSaveNotice("Saved. New sessions use this configuration; loaded sessions keep their current skills.");
      await load(true);
    } catch(cause) {
      if(mounted.current && ownerRef.current===own && writeEpoch.current===ticket) {setError(`Could not confirm the skill setting. Refresh before another change. ${errorText(cause)}`);setCatalogState(current=>({...current,value:{...current.value,settings:null}}));}
    } finally {if(mounted.current && ownerRef.current===own && writeEpoch.current===ticket){savingRef.current=false;setSaving(false);}}
  };
  const toggle = (action: ComposerAction, enabled: boolean) => {
    try { if(catalogs.settings) void changeSetting(skillEnabledMutation(catalogs.settings,action.name,enabled,scope)); }
    catch(cause){setError(errorText(cause));}
  };
  const toggleView = (action: ComposerAction) => {
    try { return catalogs.settings ? skillToggleState(catalogs.settings,action.name,scope) : null; }
    catch { return null; }
  };
  const closeSkill = () => {
    detailEpoch.current++;
    setSkill(null);
    restoreSkillFocus();
  };
  const changeTab = (next: "plugins" | "skills") => {
    detailEpoch.current++;
    setSkill(null);
    if (next !== tab) onTabChange?.(next);
    setTab(next);
  };

  return <section ref={root} tabIndex={-1} onPointerDown={()=>{focusRestored.current=true;}} onKeyDown={()=>{focusRestored.current=true;}} className={`native-plugin-directory ${embeddedSkills ? "plugin-settings-skills" : ""}`} aria-label={embeddedSkills ? "Native skills" : "Native plugin directory"}>
    {!embeddedSkills && <header className="plugin-directory-toolbar">
      <div role="tablist" aria-label="Plugin directory sections">
        <button role="tab" aria-selected={tab === "plugins"} onClick={() => changeTab("plugins")}>Plugins</button>
        <button role="tab" aria-selected={tab === "skills"} onClick={() => changeTab("skills")}>Skills</button>
      </div>
      <div className="plugin-directory-actions">
        <button className="icon-button" aria-label="Refresh plugin directory" title="Refresh" disabled={!connected || loading || saving} onClick={() => { detailEpoch.current++; setSkill(null); void load(true); }}><Icon name="refresh" /></button>
        <button className="secondary-button" aria-label="Manage plugins" disabled={!connected} onClick={() => onManage()}>Manage</button>
        <button className="primary-button" aria-label="Add marketplace" disabled={!connected} onClick={() => onMarketplace()}>Add marketplace</button>
        <button className="icon-button" aria-label="Close plugin directory" title="Close" onClick={onClose}><Icon name="close" /></button>
      </div>
    </header>}
    <main className="plugin-directory-content">
        {!embeddedSkills && <><div className="plugin-directory-title"><div><h1>{tab === "plugins" ? "Plugins" : "Skills"}</h1><p>{tab === "plugins" ? "Extend native OMP with installed and marketplace plugins." : "Inspect skills available to this workspace."}</p></div><span>{hostName}</span></div>
        <label className="plugin-directory-search"><Icon name="search" /><span className="sr-only">Search {tab}</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={`Search ${tab}`} /></label></>}
        {!connected && <p role="status" className="plugin-directory-offline">{catalogs.plugins || catalogs.marketplaces || catalogs.composer ? `Offline · showing cached data from ${hostName}` : `${hostName} is offline.`}</p>}
        {loading && <p role="status">Loading {tab}…</p>}
        {catalogState.owner === owner && error && <p role="alert" className="inline-error">{error}</p>}
        {tab === "skills" && <details className="skill-configuration"><summary>Skill settings · {scope==="global"?"User":"This project"}</summary><label>Apply changes to <select aria-label="Skill settings scope" value={scope} disabled={saving} onChange={event=>setScope(event.target.value as SettingsScope)}><option value="global">User on {hostName}</option>{target&&<option value="project">This project</option>}</select></label>{catalogs.inventory&&catalogs.settings ? <><p>Project lists replace user lists. Changes apply to new sessions.</p>{(["skills.enabled","skills.enableSkillCommands"] as const).map(path=>{const entry=catalogs.settings!.entries.find(item=>item.path===path);return <label key={path}><input type="checkbox" checked={entry?.[scope]===undefined ? scope==="global" ? true : entry?.effective===true : entry[scope]===true} disabled={!connected||saving||loading||typeof entry?.effective!=="boolean"} onChange={event=>void changeSetting({expectedRevision:catalogs.settings!.revision,scope,path,operation:"set",value:event.target.checked})}/>{path==="skills.enabled"?"Enable skills":"Enable skill commands"}</label>;})}</> : <p>Refresh or update the owning host to manage native skill settings.</p>}</details>}
        {saveNotice&&tab==="skills"&&<p role="status" className="skill-save-notice">{saveNotice}</p>}
        {tab === "plugins" ? <>
          <section className="plugin-installed" aria-labelledby="plugin-installed-heading"><div className="plugin-section-heading"><h2 id="plugin-installed-heading">Installed</h2><button className="icon-button" aria-label="Manage installed plugins" disabled={!connected} onClick={() => onManage()}><Icon name="sliders" /></button></div>
            {installed.length ? <div className="plugin-chip-list">{installed.map(plugin => <button key={`${plugin.id}:${plugin.scope}`} className="plugin-chip" title={`${plugin.title} · ${plugin.scope}`} aria-label={`Manage ${plugin.title}`} onClick={() => onManage(plugin.id)}><span aria-hidden="true">{plugin.title.trim().slice(0, 1).toLocaleUpperCase() || "P"}</span></button>)}</div> : !loading && <p className="integration-placeholder">{pluginStatus === "unavailable" ? "Installed plugin catalog unavailable." : pluginStatus === "available" ? "No native plugins installed." : "Loading installed plugins…"}</p>}
          </section>
          <section className="plugin-marketplace" aria-labelledby="plugin-marketplace-heading"><div className="plugin-section-heading"><h2 id="plugin-marketplace-heading">Marketplace plugins</h2><small>{marketplaceStatus === "available" ? `${visibleMarketplace.length} configured` : marketplaceStatus === "unavailable" ? "Unavailable" : "Loading"}</small></div>
            {visibleMarketplace.length ? <div className="plugin-directory-grid">{visibleMarketplace.map(({ marketplace, plugin }) => { const id = `${plugin.name}@${marketplace.name}`; const installedPlugin = installedIds.has(id); return <button key={id} aria-label={`Browse ${plugin.name} in ${marketplace.name}`} className="plugin-directory-row" onClick={() => onMarketplace(marketplace.name)}><span className="plugin-tile" aria-hidden="true">{plugin.name.trim().slice(0, 1).toLocaleUpperCase() || "P"}</span><span><strong>{plugin.name}</strong><small>{plugin.description ?? plugin.version ?? "Native marketplace plugin"}</small><em>{marketplace.name} · {installedPlugin ? "Installed" : plugin.installable ? "Available" : plugin.unavailabilityReason ?? "Unavailable"}</em></span></button>; })}</div> : !loading && <p className="integration-placeholder">{marketplaceStatus === "unavailable" ? "Marketplace catalog unavailable." : normalizedQuery ? "No configured marketplace plugins match this search." : marketplaceStatus === "available" ? "No configured marketplace plugins available." : "Loading marketplace plugins…"}</p>}
          </section>
        </> : <section className="plugin-skills" aria-label={embeddedSkills ? "Workspace skills" : undefined} aria-labelledby={embeddedSkills ? undefined : "plugin-skills-heading"}>{!embeddedSkills && <div className="plugin-section-heading"><h2 id="plugin-skills-heading">Workspace skills</h2><small>{skillStatus === "available" ? `${visibleSkills.length} skills` : skillStatus === "unavailable" ? "Unavailable" : "Loading"}</small></div>}
          {visibleSkills.length ? <div className="plugin-directory-grid">{visibleSkills.map(action => {const view=toggleView(action);return <div key={action.id} className="skill-managed-row"><button data-skill-id={action.id} className="plugin-directory-row" title={action.reason??sourceLabel(action)} onClick={() => void openSkill(action)}><span className="plugin-tile skill" aria-hidden="true"><Icon name="skill"/></span><span><strong>{action.name}{action.availability==="disabled"&&<em className="skill-disabled-badge">Disabled</em>}</strong><small>{action.description}</small></span><em className="skill-source-label" title={sourceLabel(action)}>{action.source.label}</em></button>{catalogs.inventory&&<button role="switch" className="skill-enabled-switch" aria-label={`Enable ${action.name}`} aria-checked={view ? !view.scopedDisabled : false} title={view?.warning??`Enable in ${scope==="global"?"user":"project"} configuration. Changes apply to new sessions.`} disabled={!connected||loading||saving||!view} onClick={()=>toggle(action,Boolean(view?.scopedDisabled))}><span/></button>}</div>;})}</div> : !loading && <p className="integration-placeholder">{skillStatus === "unavailable" ? "Skill catalog unavailable." : normalizedQuery ? "No skills match this search." : skillStatus === "available" ? "No native skills are available for this workspace." : "Loading skills…"}</p>}
        </section>}
    </main>
    {ownedSkill && <NativeSkillDialog key={`${owner}:${ownedSkill.action.id}`} action={ownedSkill.action} content={ownedSkill.content} loading={ownedSkill.loading} error={ownedSkill.error} onTry={onTrySkill ? ()=>onTrySkill(ownedSkill.action) : undefined} onClose={closeSkill} onDisposed={restoreSkillFocus} openExternal={url=>bridge.openExternal(url)}/>}
  </section>;
}
