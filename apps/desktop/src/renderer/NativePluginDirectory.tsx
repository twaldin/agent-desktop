import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComposerAction, ComposerActionsCatalog } from "../../../../packages/shared/src/composer-actions";
import type { DesktopBridge, NativeMarketplaceCatalog, NativePluginCatalog, WorkspaceTarget } from "@agent-desktop/shared";
import { assertComposerOwner, targetIdentity } from "./composer-autocomplete";
import { Icon } from "./Icons";
import { NativeSkillDialog } from "./NativeSkillDialog";
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

type Catalogs = { plugins: NativePluginCatalog | null; marketplaces: NativeMarketplaceCatalog | null; composer: ComposerActionsCatalog | null };
type CatalogStatus = { plugins: "unknown" | "available" | "unavailable"; marketplaces: "unknown" | "available" | "unavailable"; composer: "unknown" | "available" | "unavailable" };
type SkillState = { owner: string; revision?: string; action: ComposerAction; loading: boolean; content?: string; error?: string };
const emptyCatalogs = (): Catalogs => ({ plugins: null, marketplaces: null, composer: null });
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skill, setSkill] = useState<SkillState | null>(null);

  const load = useCallback(async (refresh: boolean) => {
    const ticket = ++loadEpoch.current;
    setLoading(true);
    setError(null);
    const responses = await Promise.allSettled([
      bridge.getPlugins(target, hostId),
      bridge.getMarketplaceCatalog(target, hostId),
      bridge.getComposerActions?.(target, refresh, hostId) ?? Promise.reject(new Error("Update the owning host to load native skills.")),
    ]);
    if (!mounted.current || ticket !== loadEpoch.current || ownerRef.current !== owner) return;
    const next: Catalogs = { plugins: responses[0].status === "fulfilled" ? responses[0].value : null, marketplaces: responses[1].status === "fulfilled" ? responses[1].value : null, composer: responses[2].status === "fulfilled" ? responses[2].value : null };
    if (responses[2].status === "fulfilled" && !next.composer) responses[2] = { status: "rejected", reason: new Error("Update the owning host to load native skills.") };
    if (next.composer) {
      try { assertComposerOwner(next.composer, hostId, target); }
      catch (cause) { next.composer = null; responses[2] = { status: "rejected", reason: cause }; }
    }
    setCatalogState(current => {
      const prior = current.owner === owner ? current : { owner, value: emptyCatalogs(), status: emptyStatus() };
      return { owner, value: {
        plugins: responses[0].status === "fulfilled" ? next.plugins : prior.value.plugins,
        marketplaces: responses[1].status === "fulfilled" ? next.marketplaces : prior.value.marketplaces,
        composer: responses[2].status === "fulfilled" ? next.composer : prior.value.composer,
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
      loadEpoch.current++;
      detailEpoch.current++;
      setCatalogState({ owner, value: emptyCatalogs(), status: emptyStatus() });
      setSkill(null);
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
  const skillStatus = catalogs.composer ? "available" : connected ? statuses.composer : "unavailable";
  const ownedSkill = skill?.owner === owner ? skill : null;
  const restoreSkillFocus = () => {
    const ticket = detailEpoch.current, id = skillOpener.current;
    requestAnimationFrame(() => {
      if (!mounted.current || ownerRef.current !== owner || detailEpoch.current !== ticket) return;
      const opener = [...(root.current?.querySelectorAll<HTMLButtonElement>("button[data-skill-id]") ?? [])].find(item => item.dataset.skillId === id);
      (opener ?? root.current)?.focus();
    });
  };
  useEffect(() => {
    if (!ownedSkill?.revision || !catalogs.composer || ownedSkill.revision === catalogs.composer.revision) return;
    detailEpoch.current++;
    setSkill(null);
    setError("The skill catalog changed. Open the skill again to read its current file.");
    restoreSkillFocus();
  }, [catalogs.composer?.revision, ownedSkill?.revision]);
  const installed = catalogs.plugins?.plugins ?? [];
  const marketplaceRows = useMemo(() => (catalogs.marketplaces?.marketplaces ?? []).flatMap(marketplace => marketplace.plugins.map(plugin => ({ marketplace, plugin }))), [catalogs.marketplaces]);
  const normalizedQuery = (search ?? query).trim().toLocaleLowerCase();
  const visibleMarketplace = marketplaceRows.filter(({ marketplace, plugin }) => !normalizedQuery || `${plugin.name} ${plugin.description ?? ""} ${marketplace.name}`.toLocaleLowerCase().includes(normalizedQuery));
  const visibleSkills = (catalogs.composer?.skills ?? []).filter(item => !normalizedQuery || `${item.name} ${item.description} ${item.source.label}`.toLocaleLowerCase().includes(normalizedQuery));
  const installedIds = useMemo(() => new Set(catalogs.marketplaces?.installed.map(item => item.id) ?? []), [catalogs.marketplaces]);

  const openSkill = async (action: ComposerAction) => {
    skillOpener.current = action.id;
    const catalog = catalogs.composer;
    const read = bridge.getSkillDetail;
    setSkill({ owner, revision: catalog?.revision, action, loading: true });
    if (!catalog || !read) { setSkill({ owner, revision: catalog?.revision, action, loading: false, error: "Update the owning host to read this skill." }); return; }
    const ticket = ++detailEpoch.current;
    try {
      const value = await read(target, action.id, catalog.revision, hostId);
      if (!mounted.current || ticket !== detailEpoch.current || ownerRef.current !== owner) return;
      assertComposerOwner(value, hostId, target);
      if (value.revision !== catalog.revision || value.skillId !== action.id || typeof value.content !== "string") {
        throw new Error("The skill response belongs to a different host, workspace, or catalog revision.");
      }
      setSkill({ owner, revision: catalog?.revision, action, loading: false, content: value.content });
    } catch (cause) {
      if (mounted.current && ticket === detailEpoch.current && ownerRef.current === owner) setSkill({ owner, revision: catalog?.revision, action, loading: false, error: errorText(cause) });
    }
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
        <button className="icon-button" aria-label="Refresh plugin directory" title="Refresh" disabled={!connected || loading} onClick={() => { detailEpoch.current++; setSkill(null); void load(true); }}><Icon name="refresh" /></button>
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
        {tab === "plugins" ? <>
          <section className="plugin-installed" aria-labelledby="plugin-installed-heading"><div className="plugin-section-heading"><h2 id="plugin-installed-heading">Installed</h2><button className="icon-button" aria-label="Manage installed plugins" disabled={!connected} onClick={() => onManage()}><Icon name="sliders" /></button></div>
            {installed.length ? <div className="plugin-chip-list">{installed.map(plugin => <button key={`${plugin.id}:${plugin.scope}`} className="plugin-chip" title={`${plugin.title} · ${plugin.scope}`} aria-label={`Manage ${plugin.title}`} onClick={() => onManage(plugin.id)}><span aria-hidden="true">{plugin.title.trim().slice(0, 1).toLocaleUpperCase() || "P"}</span></button>)}</div> : !loading && <p className="integration-placeholder">{pluginStatus === "unavailable" ? "Installed plugin catalog unavailable." : pluginStatus === "available" ? "No native plugins installed." : "Loading installed plugins…"}</p>}
          </section>
          <section className="plugin-marketplace" aria-labelledby="plugin-marketplace-heading"><div className="plugin-section-heading"><h2 id="plugin-marketplace-heading">Marketplace plugins</h2><small>{marketplaceStatus === "available" ? `${visibleMarketplace.length} configured` : marketplaceStatus === "unavailable" ? "Unavailable" : "Loading"}</small></div>
            {visibleMarketplace.length ? <div className="plugin-directory-grid">{visibleMarketplace.map(({ marketplace, plugin }) => { const id = `${plugin.name}@${marketplace.name}`; const installedPlugin = installedIds.has(id); return <button key={id} aria-label={`Browse ${plugin.name} in ${marketplace.name}`} className="plugin-directory-row" onClick={() => onMarketplace(marketplace.name)}><span className="plugin-tile" aria-hidden="true">{plugin.name.trim().slice(0, 1).toLocaleUpperCase() || "P"}</span><span><strong>{plugin.name}</strong><small>{plugin.description ?? plugin.version ?? "Native marketplace plugin"}</small><em>{marketplace.name} · {installedPlugin ? "Installed" : plugin.installable ? "Available" : plugin.unavailabilityReason ?? "Unavailable"}</em></span></button>; })}</div> : !loading && <p className="integration-placeholder">{marketplaceStatus === "unavailable" ? "Marketplace catalog unavailable." : normalizedQuery ? "No configured marketplace plugins match this search." : marketplaceStatus === "available" ? "No configured marketplace plugins available." : "Loading marketplace plugins…"}</p>}
          </section>
        </> : <section className="plugin-skills" aria-label={embeddedSkills ? "Workspace skills" : undefined} aria-labelledby={embeddedSkills ? undefined : "plugin-skills-heading"}>{!embeddedSkills && <div className="plugin-section-heading"><h2 id="plugin-skills-heading">Workspace skills</h2><small>{skillStatus === "available" ? `${visibleSkills.length} available` : skillStatus === "unavailable" ? "Unavailable" : "Loading"}</small></div>}
          {visibleSkills.length ? <div className="plugin-directory-grid">{visibleSkills.map(action => <button key={action.id} data-skill-id={action.id} className="plugin-directory-row" onClick={() => void openSkill(action)}><span className="plugin-tile skill" aria-hidden="true"><Icon name="skill"/></span><span><strong>{action.name}</strong><small>{action.description}</small><em title={sourceLabel(action)}>{action.source.label} · {action.availability}</em></span></button>)}</div> : !loading && <p className="integration-placeholder">{skillStatus === "unavailable" ? "Skill catalog unavailable." : normalizedQuery ? "No skills match this search." : skillStatus === "available" ? "No native skills are available for this workspace." : "Loading skills…"}</p>}
        </section>}
    </main>
    {ownedSkill && <NativeSkillDialog key={`${owner}:${ownedSkill.action.id}`} action={ownedSkill.action} content={ownedSkill.content} loading={ownedSkill.loading} error={ownedSkill.error} onTry={onTrySkill ? ()=>onTrySkill(ownedSkill.action) : undefined} onClose={closeSkill} openExternal={url=>bridge.openExternal(url)}/>}
  </section>;
}
