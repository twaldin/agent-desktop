import { DapSettings } from "./DapSettings";
import { LspSettings } from "./LspSettings";
import { SshToolSettings } from "./SshToolSettings";
import { ModelPicker } from "./ModelPicker";
import { useEffect, useMemo, useReducer, useState } from "react";
import type { DesktopBridge, ModelDefinitionPath, OmpModelDefinitions, OmpModelDefinitionsMutation, OmpModelDefinitionsSnapshot, OmpModelCapabilities, OmpSessionControlMutation, OmpSessionControls, OmpSettingDescriptor, OmpSettingOptions, OmpSettingState, OmpSettingsCatalog, OmpSettingsSnapshot, SessionSummary, SettingJson, SettingValueSchema, WorkspaceTarget } from "@agent-desktop/shared";
import { Icon } from "./Icons";
import { NativeSwitch } from "./NativeSwitch";
import "./native-settings.css";

type Scope = "global" | "project" | "session";
type ControlInput = OmpSessionControlMutation extends infer Mutation ? Mutation extends { expectedRevision: string } ? Omit<Mutation, "expectedRevision"> : never : never;
type SettingsBridge = Pick<DesktopBridge, "getSettingsCatalog" | "getSettings" | "setSetting" | "getSettingOptions" | "getModelCapabilities" | "getSessionControls" | "setSessionControl" | "getModelDefinitions" | "setModelDefinitions" | "subscribe">;
interface Edit { value: SettingJson; revision: string; error?: string; intent?: "default-model" }
const editKey = (scope: Scope, path: string) => `${scope}:${path}`;
const safeKey = (key: string) => !["__proto__", "prototype", "constructor"].includes(key);
const record = (value: unknown): value is Record<string, SettingJson> => !!value && typeof value === "object" && !Array.isArray(value);
export function nativeSettingMatches(value: unknown, schema: SettingValueSchema): boolean {
  if (typeof value === "number" && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum || schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum || schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum)) return false;
  switch (schema.kind) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "enum": return typeof value === "string" && schema.values.includes(value);
    case "array": return Array.isArray(value) && value.every(item => nativeSettingMatches(item, schema.item));
    case "map": return record(value) && Object.entries(value).every(([key, item]) => safeKey(key) && nativeSettingMatches(item, schema.value));
    case "object": return record(value) && Object.keys(value).every(key => safeKey(key) && Object.hasOwn(schema.fields, key)) && Object.entries(schema.fields).every(([key, field]) => value[key] === undefined ? !!field.optional : nativeSettingMatches(value[key], field.schema));
    case "union": return schema.alternatives.some(option => nativeSettingMatches(value, option));
    case "json": return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || Array.isArray(value) && value.every(item => nativeSettingMatches(item, schema)) || record(value) && Object.entries(value).every(([key, item]) => safeKey(key) && nativeSettingMatches(item, schema));
    default: return false;
  }
}
export function nativeSettingSeed(schema: SettingValueSchema): SettingJson {
  switch (schema.kind) {
    case "string": return "";
    case "number": return 0;
    case "boolean": return false;
    case "enum": return schema.values[0] ?? "";
    case "array": return [];
    case "map": return {};
    case "object": return Object.fromEntries(Object.entries(schema.fields).filter(([, field]) => !field.optional).map(([key, field]) => [key, nativeSettingSeed(field.schema)]));
    case "union": return nativeSettingSeed(schema.alternatives[0]);
    case "json": return null;
    default: throw new Error("This native schema has no supported editor.");
  }
}
function failure(error: unknown): string { return error instanceof Error ? error.message : "The owning host could not complete this request."; }

/** In-memory edits only. Reconnects and conflicting host writes never discard or
 * silently rebase an edit; the user must review and accept the new revision. */
export class NativeSettingsState {
  catalog: OmpSettingsCatalog | null = null;
  snapshot: OmpSettingsSnapshot | null = null;
  controls: OmpSessionControls | null = null;
  models: OmpModelCapabilities[] = [];
  modelsLoaded = false;
  loading = false;
  loadingModels = false;
  saving = false;
  error: string | null = null;
  saveError: string | null = null;
  modelError: string | null = null;
  controlError: string | null = null;
  edits = new Map<string, Edit>();
  #listeners = new Set<() => void>();
  #refresh?: Promise<void>;
  #again = false;
  #modelsAgain = false;
  #epoch = 0;
  readonly definitions: NativeModelDefinitionsState;
  constructor(readonly bridge: SettingsBridge, readonly hostId: string, readonly target?: WorkspaceTarget, readonly sessionId?: string) { this.definitions = new NativeModelDefinitionsState(bridge, hostId); }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  notify = () => { for (const listener of this.#listeners) listener(); };
  revision(scope: Scope): string { return (scope === "session" ? this.controls?.revision : this.snapshot?.revision) ?? ""; }
  edit(scope: Scope, path: string, value: SettingJson): void {
    const key = editKey(scope, path), old = this.edits.get(key);
    this.edits.set(key, { value, revision: old?.revision ?? this.revision(scope) }); this.notify();
  }
  editDefaultModel(scope: Exclude<Scope, "session">, model: string | undefined): void {
    const key = editKey(scope, "modelRoles"), old = this.edits.get(key);
    if (old && old.intent !== "default-model") { old.error = "Discard or save the existing advanced model role edit before changing the default model."; this.notify(); return; }
    const saved = this.snapshot?.entries.find(item => item.path === "modelRoles");
    const local = scope === "global" ? saved?.global : saved?.project;
    const basis = old?.intent === "default-model" ? old.value : local;
    this.edits.set(key, { value: updateDefaultModelRole(basis, model), revision: old?.revision ?? this.revision(scope), intent: "default-model" }); this.notify();
  }
  rebaseDefaultModel(scope: Exclude<Scope, "session">): void {
    const edit = this.edits.get(editKey(scope, "modelRoles"));
    if (!edit || edit.intent !== "default-model" || !record(edit.value)) return;
    const saved = this.snapshot?.entries.find(item => item.path === "modelRoles"), local = scope === "global" ? saved?.global : saved?.project;
    const selected = Object.hasOwn(edit.value, "default") && typeof edit.value.default === "string" ? edit.value.default : undefined;
    edit.value = updateDefaultModelRole(local, selected);
    edit.revision = this.revision(scope); edit.error = undefined; this.notify();
  }
  discard(scope: Scope, path: string): void { this.edits.delete(editKey(scope, path)); this.notify(); }
  rebase(scope: Scope, path: string): void {
    const edit = this.edits.get(editKey(scope, path));
    if (edit) { edit.revision = this.revision(scope); edit.error = undefined; this.notify(); }
  }
  refresh(): Promise<void> {
    if (this.saving || this.#refresh) { this.#again = true; return this.#refresh ?? Promise.resolve(); }
    this.loading = true; this.notify();
    this.#refresh = (async () => {
      do {
        this.#again = false;
        const epoch = this.#epoch;
        const results = await Promise.allSettled([
          this.catalog ? Promise.resolve(this.catalog) : this.bridge.getSettingsCatalog(this.hostId),
          this.bridge.getSettings(this.target, this.hostId),
          this.sessionId ? this.bridge.getSessionControls(this.sessionId, this.hostId) : Promise.resolve(null),
        ]);
        if (epoch !== this.#epoch) { this.#again = true; continue; }
        const [catalog, snapshot, controls] = results;
        if (catalog.status === "fulfilled") this.catalog = catalog.value;
        if (snapshot.status === "fulfilled") this.snapshot = snapshot.value;
        if (controls.status === "fulfilled") this.controls = controls.value;
        this.error = [catalog, snapshot].filter(result => result.status === "rejected").map(result => failure((result as PromiseRejectedResult).reason)).join(" · ") || null;
        this.controlError = controls.status === "rejected" ? failure(controls.reason) : null;
        this.notify();
      } while (this.#again && !this.saving);
    })().finally(() => { this.#refresh = undefined; this.loading = false; this.notify(); });
    return this.#refresh;
  }
  async loadModels(refresh = false): Promise<void> {
    if (this.loadingModels) { this.#modelsAgain ||= refresh; return; }
    if (this.modelsLoaded && !refresh) return;
    this.loadingModels = true; this.modelError = null; this.notify();
    try {
      do {
        this.#modelsAgain = false;
        this.models = await this.bridge.getModelCapabilities(this.target, refresh, this.hostId); this.modelsLoaded = true;
        refresh = this.#modelsAgain;
      } while (this.#modelsAgain);
    }
    catch (error) { this.modelError = failure(error); }
    finally { this.loadingModels = false; this.notify(); }
  }
  async save(scope: Scope, descriptor: OmpSettingDescriptor, reset = false): Promise<void> {
    if (this.saving) return;
    const key = editKey(scope, descriptor.path), edit = this.edits.get(key);
    if (!reset && (!edit || !nativeSettingMatches(edit.value, descriptor.schema))) {
      if (edit) edit.error = `Enter a valid ${descriptor.type} value before saving.`;
      this.notify(); return;
    }
    const revision = reset ? this.revision(scope) : edit!.revision;
    this.saving = true; this.#epoch++; this.saveError = null; this.notify();
    try {
      if (scope === "session") {
        if (!this.sessionId) throw new Error("Select an existing session.");
        this.controls = await this.bridge.setSessionControl(this.sessionId, { expectedRevision: revision, operation: reset ? "clear-override" : "override", path: descriptor.path, ...(!reset ? { value: edit!.value } : {}) } as OmpSessionControlMutation, this.hostId);
      } else {
        if (scope === "project" && !this.target) throw new Error("Select a project or session for project settings.");
        this.snapshot = await this.bridge.setSetting({ expectedRevision: revision, scope, path: descriptor.path, operation: reset ? "reset" : "set", ...(!reset ? { value: edit!.value } : {}) }, this.target, this.hostId);
      }
      this.edits.delete(key);
      // A successful compare-and-set proves these simultaneous local edits were
      // based on this exact preceding revision. Only those edits can be rebased.
      for (const [name, other] of this.edits) if ((scope === "session" ? name.startsWith("session:") : !name.startsWith("session:")) && other.revision === revision) other.revision = this.revision(scope);
    } catch (error) {
      if (edit) edit.error = failure(error); else this.saveError = failure(error);
      this.#again = true;
    } finally {
      this.saving = false; this.#epoch++; this.notify();
      if (this.#again) await this.refresh();
    }
  }
  async mutateControl(mutation: ControlInput): Promise<void> {
    if (this.saving || !this.controls || !this.sessionId) return;
    this.saving = true; this.#epoch++; this.controlError = null; this.saveError = null; this.notify();
    try { this.controls = await this.bridge.setSessionControl(this.sessionId, { ...mutation, expectedRevision: this.controls.revision } as OmpSessionControlMutation, this.hostId); }
    catch (error) { this.saveError = failure(error); this.#again = true; }
    finally { this.saving = false; this.#epoch++; this.notify(); if (this.#again) await this.refresh(); }
  }
}

export interface NativeSettingsProps {
  bridge: DesktopBridge; hostId: string; hostName: string; connected: boolean; localHostId?: string;
  target?: WorkspaceTarget; session?: SessionSummary | null;
}
export function NativeSettings(props: NativeSettingsProps) {
  const { bridge, hostId, connected, session, target, localHostId } = props;
  const targetKey = JSON.stringify(target);
  const data = useMemo(() => new NativeSettingsState(bridge, hostId, target, session?.id), [bridge, hostId, targetKey, session?.id]);
  const [, redraw] = useReducer(value => value + 1, 0);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const [scope, setScope] = useState<Scope>("global");
  useEffect(() => data.subscribe(redraw), [data]);
  useEffect(() => { if (connected) void data.refresh(); }, [data, connected]);
  useEffect(() => { if (connected && session) void data.refresh(); }, [data, connected, session?.model?.provider, session?.model?.id]);
  useEffect(() => bridge.subscribe(event => {
    if (!connected || (event.hostId ?? localHostId) !== hostId) return;
    if (event.type === "settings" || event.type === "accounts") { void data.refresh(); if (tab === "models") { void data.loadModels(true); if (data.definitions.bundle) void data.definitions.refresh(); } }
  }), [bridge, connected, data, hostId, localHostId, tab]);
  useEffect(() => { if (connected && tab === "models") void data.loadModels(); }, [data, connected, tab]);
  useEffect(() => { if (scope === "session" && !session || scope === "project" && !target) setScope("global"); }, [scope, session, targetKey]);
  const searching = !!query.trim();
  const descriptors = filterNativeSettings(data.catalog?.settings ?? [], query, tab);
  const tabs = [...(data.catalog?.tabs ?? [])];
  for (const id of new Set(data.catalog?.settings.map(setting => setting.tab))) if (!tabs.some(item => item.id === id)) tabs.push({ id, label: title(id), icon: "settings" });
  const groups = [...new Set([...(data.catalog?.groups[tab] ?? []), ...descriptors.map(setting => setting.group)])].filter(group => descriptors.some(setting => setting.group === group));
  const states = new Map((scope === "session" ? data.controls?.settings : data.snapshot?.entries)?.map(state => [state.path, state]));
  const writable = connected && !data.saving && !!data.revision(scope);
  return <section className="settings-page native-settings" aria-label="Native OMP settings">
    <div className="native-settings-scroll"><div className="native-settings-column">
    <header className="native-page-header"><h1>Configuration</h1><p>OMP settings on {props.hostName}</p></header>
    {!connected && <div className="connection-banner" role="status">This machine is disconnected. Your edits stay here; saving requires reconnection.</div>}
    {data.error && <div className="inline-error settings-error" role="alert">{data.error}</div>}
    {data.saveError && <div className="inline-error settings-error" role="alert">{data.saveError}</div>}
    <div className="native-toolbar">
      <label className="native-category"><span className="sr-only">Native settings category</span><select aria-label="Native settings category" value={tab} onChange={event => { setTab(event.target.value); setQuery(""); }}><option value="dap-adapters">Debugger adapters</option><option value="lsp-servers">Language servers</option><option value="ssh">SSH hosts</option><option value="models">Session &amp; models</option><option value="all">All settings</option>{tabs.map(item => <option key={item.id} value={item.id}>{item.label} · {data.catalog?.settings.filter(setting => setting.tab === item.id).length}</option>)}</select></label>
      <label className="native-search"><Icon name="search"/><input type="search" aria-label="Search all native settings" placeholder="Search all settings" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <button className="icon-button native-refresh" disabled={!connected || data.loading || data.saving} onClick={() => { void data.refresh(); if (tab === "models") void data.loadModels(true); }} title={data.loading ? "Refreshing…" : "Reload saved values"} aria-label={data.loading ? "Refreshing…" : "Reload saved values"}><Icon name="refresh"/></button>
    </div>
    {(!["ssh", "lsp-servers", "dap-adapters"].includes(tab) || searching) && <div className="native-scope-bar"><label>Scope<select aria-label="Native settings scope" value={scope} onChange={event => setScope(event.target.value as Scope)}><option value="global">Host defaults</option><option value="project" disabled={!target}>Project configuration</option><option value="session" disabled={!session}>This session</option></select></label><span>{scope === "session" ? `Session overrides for ${session?.title ?? "this session"}` : scope === "project" ? "Project values override host defaults" : "Applies to new sessions on this host"}</span><span className="native-count">{data.catalog?.settings.length ?? "…"} core settings{data.edits.size > 0 ? ` · ${data.edits.size} unsaved` : ""}</span></div>}
      <main className="native-content" aria-busy={data.loading || data.saving}>
        {tab === "dap-adapters" && !searching ? <DapSettings key={`${hostId}:${targetKey}`} bridge={bridge} localHostId={localHostId} hostId={hostId} hostName={props.hostName} target={target} connected={connected}/> : tab === "lsp-servers" && !searching ? <LspSettings key={`${hostId}:${targetKey}`} bridge={bridge} localHostId={localHostId} hostId={hostId} hostName={props.hostName} target={target} connected={connected}/> : tab === "ssh" && !searching ? <SshToolSettings key={`${hostId}:${targetKey}`} bridge={bridge} localHostId={localHostId} hostId={hostId} hostName={props.hostName} target={target} connected={connected}/> : tab === "models" && !searching ? <NativeModels data={data} session={session} connected={connected} scope={scope} writable={writable}/> : <>
          <div className="native-section-heading"><h2>{searching ? `Results for “${query}”` : tab === "all" ? "All native settings" : tabs.find(item => item.id === tab)?.label}</h2><p>{scope === "session" ? "Model, thinking and service tiers persist in native history. Permission-mode changes persist on the owning host and require a compatible host version; other supported settings apply until this worker closes." : "Saving writes the selected native scope. Existing sessions keep their current settings; use This session for supported live overrides."}</p></div>
          {!data.catalog && <p role="status">{data.loading ? "Loading the host’s native schema…" : "Reload to read the native settings schema."}</p>}
          {groups.map(group => {
            const settings = descriptors.filter(setting => setting.group === group);
            const ordinary = settings.filter(setting => !setting.advanced), advanced = settings.filter(setting => setting.advanced);
            const rows = (items: OmpSettingDescriptor[]) => items.map(descriptor => <NativeSettingRow key={`${scope}:${descriptor.path}`} descriptor={descriptor} state={states.get(descriptor.path)} scope={scope} data={data} writable={writable} searching={searching}/>);
            return <section className="native-group" key={group}><h3>{title(group)}</h3>{ordinary.length > 0 && <div className="native-settings-card">{rows(ordinary)}</div>}{advanced.length > 0 && <details className="native-advanced" open={searching || undefined}><summary>Advanced · {advanced.length}</summary><div className="native-settings-card">{rows(advanced)}</div></details>}</section>;
          })}
          {data.catalog && !descriptors.length && <p>No native settings match this search.</p>}
        </>}
        {(!["ssh", "lsp-servers", "dap-adapters"].includes(tab) || searching) && <details className="native-coverage"><summary>Coverage and native behavior</summary><p>All {data.catalog?.settings.length ?? 484} core schema entries are listed. Terminal controls configure the native terminal UI; they do not style this desktop. Model/provider definitions have a separate native schema editor. Extension-defined settings and custom terminal surfaces still need dedicated adapters.</p><p>Reset writes the native default at the chosen scope. It does not remove a project override. Native process overlays remain read-only effective values. Free-form fields expose typed values because upstream does not define a narrower schema.</p><p>Native handled slash commands may finish without recording a user prompt; their separate completion receipt remains an integration gap.</p></details>}
      </main>
    </div></div>
  </section>;
}
export function filterNativeSettings(settings: OmpSettingDescriptor[], query: string, tab: string): OmpSettingDescriptor[] {
  const search = query.trim().toLowerCase();
  return settings.filter(setting => search ? `${setting.path} ${setting.label} ${setting.description ?? ""} ${setting.tab} ${setting.group}`.toLowerCase().includes(search) : tab === "all" || setting.tab === tab);
}
export function updateDefaultModelRole(value: SettingJson | undefined, model: string | undefined): Record<string, SettingJson> {
  const roles = record(value) ? structuredClone(value) : {};
  if (model === undefined) delete roles.default;
  else roles.default = model;
  return roles;
}
function savedDefaultRole(value: SettingJson | undefined): SettingJson | undefined {
  return record(value) ? value.default : undefined;
}
function title(value: string): string { return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll(".", " / ").replace(/^./, char => char.toUpperCase()); }
function display(value: SettingJson | undefined): string { return value === undefined ? "Not set" : typeof value === "string" ? value || "Empty string" : JSON.stringify(value); }

export function NativeSettingRow({ descriptor: d, state, scope, data, writable, searching }: { descriptor: OmpSettingDescriptor; state?: OmpSettingState; scope: Scope; data: NativeSettingsState; writable: boolean; searching?: boolean }) {
  const [options, setOptions] = useState<OmpSettingOptions | null>(null);
  const [optionError, setOptionError] = useState<string | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const edit = data.edits.get(editKey(scope, d.path));
  const supported = scope === "session" ? !!data.controls?.runtimeMutablePaths.includes(d.path) : d.scopes.includes(scope);
  const actual = scope === "global" ? state?.global : scope === "project" ? state?.project : state?.effective;
  const saved = scope === "session" && !data.controls?.overrides.includes(d.path) ? undefined : actual;
  const initial = actual !== undefined ? actual : state?.effective !== undefined ? state.effective : d.defaultValue !== undefined ? d.defaultValue : nativeSettingSeed(d.schema);
  const value = edit ? edit.value : d.credential ? nativeSettingSeed(d.schema) : initial;
  const obsolete = !!edit && edit.revision !== data.revision(scope);
  const disabled = !writable || !supported;
  const change = (next: SettingJson) => data.edit(scope, d.path, next);
  const compound = !["boolean", "number", "enum", "string"].includes(d.schema.kind);
  return <article className={`native-setting ${edit ? "native-dirty" : ""} ${compound ? "native-setting-compound" : ""}`} data-setting-path={d.path}>
    <div className="native-setting-main">
      <div className="native-setting-summary">
        <div className="native-setting-title"><h4>{d.label}</h4>{edit && <span className="account-badge">Unsaved</span>}</div>
    {d.description && <p>{d.description}</p>}
    {d.warning && <p className="native-warning">{d.warning}</p>}
    {d.applicability === "native-terminal" && <p className="native-note">Native terminal setting · desktop appearance is configured separately.</p>}
    {!supported && <p className="native-note">{scope === "session" ? "Configure at host or project scope for new sessions." : "This native setting supports host scope only."}</p>}
        {d.credential && <p className="native-note">Write-only · {state?.configured ? "Configured" : "Not configured"}</p>}
      </div>
      <div className="native-setting-controls">
    <div className="native-editor">{d.schema.kind === "boolean" ? <NativeSwitch label={d.label} checked={value === true} disabled={disabled} onChange={change}/> : <NativeValueField schema={d.schema} value={value} onChange={change} label={d.label} disabled={disabled} secret={d.credential} options={options?.options ?? d.options}/>}</div>
      </div>
    </div>
    {d.dynamicOptions && <div className="native-options"><button className="secondary-button" disabled={!writable || loadingOptions} onClick={async () => { setLoadingOptions(true); setOptionError(null); try { setOptions(await data.bridge.getSettingOptions(d.path, data.target, data.hostId)); } catch (error) { setOptionError(failure(error)); } finally { setLoadingOptions(false); } }}>{loadingOptions ? "Loading choices…" : "Load native choices"}</button>{options?.extensionCoverage === "requires-session-registry" && <span>Extension choices require the session registry adapter.</span>}{optionError && <p role="alert">{optionError}</p>}</div>}
    {(edit?.error || obsolete) && <div className="native-edit-error" role="alert">{edit?.error && <p>{edit.error}</p>}{obsolete && <><p>The saved revision changed. Your edit is preserved above; compare it with the current saved value before retrying.</p><button className="secondary-button" disabled={!writable} onClick={() => data.rebase(scope, d.path)}>Use current revision for this edit</button></>}</div>}
    {edit && <div className="native-row-actions"><button className="primary-button" disabled={disabled || obsolete} onClick={() => void data.save(scope, d)}>Save{scope === "session" ? " override" : ""}</button><button className="secondary-button" disabled={data.saving} onClick={() => data.discard(scope, d.path)}>Discard edit</button></div>}
    <details className="native-setting-details" open={obsolete || searching || undefined}><summary>Native details</summary><div className="native-value-meta">{d.credential ? <span>Write-only · {state?.configured ? "Configured" : "Not configured"}{scope !== "session" ? ` · ${scope === "global" ? state?.globalConfigured ? "Saved at host scope" : "No saved host value" : state?.projectConfigured ? "Saved at project scope" : "No saved project value"}` : ""}</span> : <><span>{scope === "session" ? "Override" : "Saved"}: <code>{display(saved)}</code></span><span>Effective: <code>{display(state?.effective)}</code> · {state?.origin ?? "unavailable"}</span></>}</div><dl><dt>Setting path</dt><dd><code>{d.path}</code></dd><dt>Applied</dt><dd>{d.application === "terminal-only" ? "Native terminal UI" : "New sessions; supported session overrides apply immediately"}</dd>{d.condition && <><dt>Native UI condition</dt><dd>{d.condition} · shown here so it remains configurable</dd></>}{!d.credential && <><dt>Native default</dt><dd><code>{display(d.defaultValue)}</code></dd></>}<dt>Metadata</dt><dd>{d.metadataSource === "native-ui" ? "Native UI descriptor" : "Native schema; generated label"}</dd><dt>Source</dt><dd>OMP {d.source.version} · {d.source.commit.slice(0, 12)}</dd></dl><div className="native-row-actions"><button className="native-reset" disabled={disabled || scope === "session" && !data.controls?.overrides.includes(d.path)} onClick={() => void data.save(scope, d, true)}>{scope === "session" ? "Clear session override" : "Reset to native default"}</button></div></details>
  </article>;
}

interface FieldProps { concealed?: ModelDefinitionPath[]; onClearConcealed?(path: ModelDefinitionPath): void; schema: SettingValueSchema; value: SettingJson; onChange(value: SettingJson): void; label: string; disabled?: boolean; secret?: boolean; options?: OmpSettingOptions["options"] }
export function NativeValueField(props: FieldProps) {
  const { schema, value, onChange, label, disabled, options } = props;
  const secret = props.secret || schema.writeOnly;
  if (schema.kind === "boolean") return <label className="native-checkbox"><input type="checkbox" checked={value === true} disabled={disabled} onChange={event => onChange(event.target.checked)}/><span>{label}: {value === true ? "On" : "Off"}</span></label>;
  if (schema.kind === "number") return <input className="text-field" type="number" step="any" min={schema.minimum} max={schema.maximum} aria-label={label} value={typeof value === "number" || typeof value === "string" ? value : ""} disabled={disabled} onChange={event => onChange(event.target.value === "" ? "" : Number(event.target.value))}/>;
  if (schema.kind === "enum" || schema.kind === "string" && options?.length) {
    const choices = options?.length ? options : schema.kind === "enum" ? schema.values.map(item => ({ value: item, label: item })) : [];
    return <select aria-label={label} disabled={disabled} value={typeof value === "string" ? value : ""} onChange={event => onChange(event.target.value)}>{!choices.some(item => item.value === value) && <option value={typeof value === "string" ? value : ""}>{typeof value === "string" && value ? `${value} (saved value)` : "Choose a value"}</option>}{choices.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>;
  }
  if (schema.kind === "string") return secret ? <input className="text-field" aria-label={label} type="password" value={typeof value === "string" ? value : ""} disabled={disabled} onChange={event => onChange(event.target.value)} autoComplete="new-password" spellCheck={false} data-1p-ignore data-lpignore="true"/> : <textarea className="text-field" aria-label={label} rows={typeof value === "string" && value.includes("\n") ? 3 : 1} value={typeof value === "string" ? value : ""} disabled={disabled} onChange={event => onChange(event.target.value)} spellCheck={false}/>;
  if (schema.kind === "array") {
    const items = Array.isArray(value) ? value : [];
    return <fieldset className="native-compound" disabled={disabled}><legend>{label}</legend>{items.map((item, index) => <div className="native-array-item" key={index}><span className="native-item-index">{index + 1}</span><NativeValueField schema={schema.item} value={item} onChange={next => onChange(items.map((old, i) => i === index ? next : old))} label={`${label} item ${index + 1}`} secret={secret} {...concealedChild(props, index)}/><div className="native-item-actions"><button type="button" aria-label={`Move ${label} item ${index + 1} up`} disabled={index === 0} onClick={() => { const next = [...items]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onChange(next); }}>↑</button><button type="button" aria-label={`Move ${label} item ${index + 1} down`} disabled={index === items.length - 1} onClick={() => { const next = [...items]; [next[index], next[index + 1]] = [next[index + 1], next[index]]; onChange(next); }}>↓</button><button type="button" aria-label={`Remove ${label} item ${index + 1}`} onClick={() => onChange(items.filter((_, i) => i !== index))}>Remove</button></div></div>)}<button className="secondary-button" type="button" onClick={() => onChange([...items, nativeSettingSeed(schema.item)])}>Add item</button></fieldset>;
  }
  if (schema.kind === "map") return <NativeMapField {...props} schema={schema}/>;
  if (schema.kind === "object") {
    const items = record(value) ? value : {};
    return <fieldset className="native-compound" disabled={disabled}><legend>{label}</legend>{Object.entries(schema.fields).map(([key, field]) => {
      const opaque = props.concealed?.some(path => path[0] === key);
      const exists = Object.hasOwn(items, key);
      return <div key={key} className="native-object-field"><div className="native-field-heading"><span>{title(key)}{field.optional ? " (optional)" : ""}{field.schema.writeOnly ? " · write-only" : ""}</span>{field.optional && <button type="button" className="native-reset" onClick={() => {
        const next = { ...items };
        if (exists) { delete next[key]; props.onClearConcealed?.([key]); }
        else next[key] = nativeSettingSeed(field.schema);
        onChange(next);
      }}>{exists ? "Remove field" : opaque ? "Replace saved value" : "Set field"}</button>}</div>
        {opaque && !exists && <div className="native-concealed"><span>Saved value is concealed and retained.</span><button type="button" className="native-reset" onClick={() => props.onClearConcealed?.([key])}>Clear saved value</button></div>}
        {(exists || !field.optional) && <NativeValueField schema={field.schema} value={items[key] ?? nativeSettingSeed(field.schema)} onChange={next => onChange({ ...items, [key]: next })} label={`${label} ${key}`} secret={secret} {...concealedChild(props, key)}/>}</div>;
    })}</fieldset>;
  }
  if (schema.kind === "union") return <NativeUnionField {...props} schema={schema}/>;
  if (schema.kind === "json") return <NativeJsonField {...props}/>;
  return <p role="alert">This native schema shape has no supported editor. This field cannot be saved.</p>;
}
function NativeMapField(props: FieldProps & { schema: Extract<SettingValueSchema, { kind: "map" }> }) {
  const { schema, value, onChange, label, disabled } = props;
  const secret = props.secret || schema.writeOnly;
  const [newKey, setNewKey] = useState("");
  const items = record(value) ? value : {};
  const invalidKey = !newKey || !safeKey(newKey) || Object.hasOwn(items, newKey);
  return <fieldset className="native-compound" disabled={disabled}><legend>{label}</legend>{Object.entries(items).map(([key, item]) => <div key={key} className="native-map-item"><div className="native-field-heading"><code>{key}</code><button className="native-reset" type="button" aria-label={`Remove ${label} entry ${key}`} onClick={() => { const next = { ...items }; delete next[key]; onChange(next); }}>Remove entry</button></div><NativeValueField schema={schema.value} value={item} onChange={next => onChange({ ...items, [key]: next })} label={`${label} ${key}`} secret={secret} {...concealedChild(props, key)}/></div>)}<div className="native-map-add"><input className="text-field" aria-label={`${label} new entry name`} value={newKey} onChange={event => setNewKey(event.target.value)} placeholder="Entry name"/><button className="secondary-button" type="button" disabled={invalidKey} onClick={() => { onChange({ ...items, [newKey]: nativeSettingSeed(schema.value) }); setNewKey(""); }}>Add entry</button></div>{newKey && invalidKey && <p className="native-note">Use a unique entry name. Reserved object keys are not supported.</p>}</fieldset>;
}
function concealedChild(props: FieldProps, key: string | number): Pick<FieldProps, "concealed" | "onClearConcealed"> {
  return { concealed: props.concealed?.filter(path => path[0] === key).map(path => path.slice(1)), onClearConcealed: path => props.onClearConcealed?.([key, ...path]) };
}
function NativeUnionField(props: FieldProps & { schema: Extract<SettingValueSchema, { kind: "union" }> }) {
  const { schema, value, onChange, label, disabled } = props;
  const selected = Math.max(0, schema.alternatives.findIndex(option => nativeSettingMatches(value, option)));
  return <div className="native-union"><select aria-label={`${label} value format`} value={selected} disabled={disabled} onChange={event => onChange(nativeSettingSeed(schema.alternatives[Number(event.target.value)]))}>{schema.alternatives.map((option, index) => <option key={index} value={index}>{title(option.kind)}</option>)}</select><NativeValueField {...props} schema={schema.alternatives[selected]} options={undefined}/></div>;
}
function NativeJsonField(props: FieldProps) {
  const { value, onChange, label, disabled } = props;
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "map" : typeof value;
  const schemas: Record<string, SettingValueSchema> = { string: { kind: "string" }, number: { kind: "number" }, boolean: { kind: "boolean" }, array: { kind: "array", item: { kind: "json" } }, map: { kind: "map", value: { kind: "json" } } };
  return <div className="native-json"><p className="native-note">Free-form native value · no narrower upstream schema</p><select aria-label={`${label} value type`} value={kind} disabled={disabled} onChange={event => onChange(event.target.value === "null" ? null : nativeSettingSeed(schemas[event.target.value]))}>{["null", "string", "number", "boolean", "array", "map"].map(item => <option key={item} value={item}>{title(item)}</option>)}</select>{kind !== "null" && <NativeValueField {...props} schema={schemas[kind]} secret={props.secret || props.schema.writeOnly} options={undefined}/>}</div>;
}

export function DefaultModelSetting({ data, scope, writable }: { data: NativeSettingsState; scope: Scope; writable: boolean }) {
  if (scope === "session") return null;
  const descriptor = data.catalog?.settings.find(item => item.path === "modelRoles"), state = data.snapshot?.entries.find(item => item.path === "modelRoles");
  if (!descriptor) return null;
  const local = scope === "global" ? state?.global : state?.project;
  const configured = savedDefaultRole(local), inherited = savedDefaultRole(state?.effective);
  const edit = data.edits.get(editKey(scope, "modelRoles"));
  const selected = typeof edit?.value === "object" ? savedDefaultRole(edit.value) : configured;
  const stale = Boolean(edit && edit.revision !== data.revision(scope));
  const simple = typeof selected === "string" ? selected : "";
  const known = data.models.some(model => `${model.provider}/${model.id}` === simple);
  const choose = (value: string) => data.editDefaultModel(scope, value || undefined);
  const reset = () => data.editDefaultModel(scope, undefined);
  return <section className="settings-card native-default-model" aria-label="Default model for new sessions"><h3>Default model for new sessions</h3><p>Sets the native default role at this scope. Current sessions and account selection do not change.</p>
    <label className="native-labeled-control">Model<ModelPicker label="Default model for new sessions" value={simple} disabled={!writable} options={[
      { value: "", label: scope === "project" ? "Inherit host default" : "Native fallback" },
      ...(!known && simple ? [{ value: simple, label: `${simple} (saved, unavailable)` }] : []),
      ...data.models.map(model => ({ value: `${model.provider}/${model.id}`, provider: model.provider, label: model.name, detail: model.id })),
    ]} onChange={choose}/></label>
    {configured !== undefined && typeof configured !== "string" && <p className="native-note">Advanced saved default: <code>{display(configured)}</code>. Choosing a model replaces only this default role.</p>}
    {configured === undefined && inherited !== undefined && <p className="native-note">Effective inherited default: <code>{display(inherited)}</code></p>}
    <div className="native-row-actions"><button className="secondary-button" disabled={!edit || data.saving} onClick={() => data.discard(scope, "modelRoles")}>Discard edit</button><button className="native-reset" disabled={!writable || selected === undefined} onClick={reset}>{scope === "project" ? "Inherit host default" : "Use native fallback"}</button>{stale && <button className="secondary-button" onClick={() => edit?.intent === "default-model" ? data.rebaseDefaultModel(scope) : data.rebase(scope, "modelRoles")}>Review current revision</button>}<button className="primary-button" disabled={!writable || !edit || stale} onClick={() => void data.save(scope, descriptor)}>Save default</button></div>
    {stale && <p className="inline-error" role="alert">The saved settings changed while this default was being edited. Review the current revision before saving.</p>}
    {edit?.error && <p className="inline-error" role="alert">{edit.error}</p>}
  </section>;
}
function NativeModels({ data, session, connected, scope, writable: settingsWritable }: { data: NativeSettingsState; session?: SessionSummary | null; connected: boolean; scope: Scope; writable: boolean }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const controls = data.controls;
  const currentKey = controls?.model ? `${controls.model.provider}/${controls.model.id}` : "";
  const models = data.models.filter(item => !query || `${item.provider}/${item.id} ${item.name}`.toLowerCase().includes(query.toLowerCase()));
  const model = models.find(item => `${item.provider}/${item.id}` === (selected || currentKey)) ?? models[0];
  const writable = connected && !data.saving && !!controls;
  return <section className="native-models"><NativeDefinitions data={data.definitions} connected={connected} onSaved={() => { void data.loadModels(true); void data.refresh(); }}/><h2>Session & models</h2><DefaultModelSetting data={data} scope={scope} writable={settingsWritable}/><p>Model capabilities come from this host’s native registry. Configuration is not a provider health check.</p>{data.modelError && <p className="inline-error" role="alert">{data.modelError}</p>}{data.controlError && <p className="inline-error" role="alert">{data.controlError}</p>}
    {session ? <div className="settings-card"><h3>{session.title}</h3>{controls ? <><div className="native-labeled-control">Session model<ModelPicker label="Session model" value={currentKey} disabled={!writable || data.loadingModels} options={[
      ...(!currentKey ? [{value: "", label: "No model selected", disabled: true}] : []),
      ...(currentKey && !data.models.some(item => `${item.provider}/${item.id}` === currentKey) ? [{value: currentKey, label: `${currentKey} (saved selection)`}] : []),
      ...data.models.map(item => ({value: `${item.provider}/${item.id}`, provider: item.provider, detail: `${item.id} · ${item.contextWindow?.toLocaleString() ?? "Unknown"} context`, disabled: item.capabilities.disabledInSettings === true,
        label: `${item.name}${item.capabilities.disabledInSettings === true ? " · disabled" : item.capabilities.available === false ? " · unavailable" : ""}`})),
    ]} onChange={value => { const next = data.models.find(item => `${item.provider}/${item.id}` === value); if (next) void data.mutateControl({ operation: "model", model: { provider: next.provider, id: next.id } }); }}/></div><label className="native-labeled-control">Thinking<select aria-label="Session thinking" disabled={!writable} value={controls.thinkingLevel ?? ""} onChange={event => void data.mutateControl({ operation: "thinking", level: event.target.value || undefined })}><option value="">Native default</option>{[...new Set([...(controls.capabilities?.thinkingSelectors ?? []), ...(controls.thinkingLevel ? [controls.thinkingLevel] : [])])].map(level => <option key={level} value={level}>{level}</option>)}</select></label>{Object.entries(controls.capabilities?.serviceTierOptions ?? {}).map(([family, tiers]) => <label className="native-labeled-control" key={family}>{title(family)} service tier<select aria-label={`${family} session service tier`} disabled={!writable} value={controls.serviceTiers[family] ?? ""} onChange={event => void data.mutateControl({ operation: "service-tier", family: family as "openai" | "anthropic" | "google", tier: (event.target.value || undefined) as "auto" | "default" | "flex" | "scale" | "priority" | undefined })}><option value="">Native default</option>{tiers.filter(tier => tier !== "none").map(tier => <option key={tier} value={tier}>{tier}</option>)}</select></label>)}<p className="native-note">Model, thinking and service tiers persist in this session. Permission, context, compression, retry, tool and thinking-budget overrides are under This session scope.</p></> : <p>Session controls have not loaded.</p>}</div> : <p className="native-note">Select a session to change its model, thinking, service tiers and runtime settings.</p>}
    <div className="native-section-heading"><h3>Model capability browser</h3><span>{data.loadingModels ? "Loading native models…" : `${data.models.length} models`}</span></div><input className="text-field" type="search" aria-label="Search model capabilities" placeholder="Search provider or model" value={query} onChange={event => setQuery(event.target.value)}/><select aria-label="Inspect model capabilities" value={model ? `${model.provider}/${model.id}` : ""} onChange={event => setSelected(event.target.value)}><option value="" disabled>Select a model</option>{models.map(item => <option key={`${item.provider}/${item.id}`} value={`${item.provider}/${item.id}`}>{item.provider} / {item.name}</option>)}</select>
    {model && <div className="settings-card native-capabilities"><h3>{model.name}</h3><dl><dt>Provider / model</dt><dd>{model.provider}/{model.id}</dd><dt>API</dt><dd>{model.api}</dd><dt>Context / output tokens</dt><dd>{model.contextWindow ?? "Undeclared"} / {model.maxTokens ?? "Undeclared"}</dd><dt>Inputs</dt><dd>{model.input.join(", ")}</dd><dt>Tools</dt><dd>{model.supportsTools ? "Supported" : "Unsupported"}</dd></dl>{Object.entries({ Thinking: model.thinking, Capabilities: model.capabilities, Compatibility: model.compatibility }).map(([name, value]) => value && <details key={name}><summary>{name}</summary><NativeMetadata value={value}/></details>)}{model.unmappedCapabilityFields.length > 0 && <p className="native-warning">Fields awaiting explicit adapters: {model.unmappedCapabilityFields.join(", ")}</p>}<p className="native-note">Credential-bearing fields are withheld: {model.excludedSensitiveFields.join(", ")}. Use Native model definitions above to edit declared provider/model fields and structured compatibility overrides. This capability snapshot is read-only.</p></div>}
  </section>;
}
function NativeMetadata({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <span>{value.map(item => typeof item === "object" ? JSON.stringify(item) : String(item)).join(", ") || "None"}</span>;
  if (!value || typeof value !== "object") return <span>{value === undefined ? "Undeclared" : String(value)}</span>;
  return <dl>{Object.entries(value).map(([key, item]) => <div key={key}><dt>{key}</dt><dd><NativeMetadata value={item}/></dd></div>)}</dl>;
}

function definitionValue(document: unknown, path: ModelDefinitionPath): SettingJson | undefined {
  let value = document;
  for (const part of path) { if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined; value = (value as Record<string | number, unknown>)[part]; }
  return value as SettingJson | undefined;
}
export function definitionFieldSchema(schema: SettingValueSchema, path: ModelDefinitionPath): SettingValueSchema {
  let current = schema;
  for (const part of path) {
    if (current.kind === "object" && typeof part === "string" && current.fields[part]) current = current.fields[part].schema;
    else if (current.kind === "map" && typeof part === "string") current = current.value;
    else if (current.kind === "array" && typeof part === "number") current = current.item;
    else throw new Error("The native schema does not expose this model definition path.");
  }
  return current;
}
const pathStarts = (path: ModelDefinitionPath, prefix: ModelDefinitionPath) => prefix.every((part, index) => path[index] === part);
function duplicateModelIds(models: SettingJson[]): boolean {
  const seen = new Set<string>();
  for (const model of models) if (record(model) && typeof model.id === "string") {
    if (seen.has(model.id)) return true;
    seen.add(model.id);
  }
  return false;
}
interface ModelEdit { path: ModelDefinitionPath; value: SettingJson; revision: string; dirty: boolean; fresh: boolean; cleared: ModelDefinitionPath[]; originalId?: string; ambiguousOriginalId?: boolean }
export class NativeModelDefinitionsState {
  bundle: OmpModelDefinitions | null = null;
  edit: ModelEdit | null = null;
  loading = false;
  saving = false;
  error: string | null = null;
  actionError: string | null = null;
  #listeners = new Set<() => void>();
  #pending?: Promise<void>;
  #again = false;
  #epoch = 0;
  constructor(readonly bridge: Pick<DesktopBridge, "getModelDefinitions" | "setModelDefinitions">, readonly hostId: string) {}
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  notify = () => { for (const listener of this.#listeners) listener(); };
  refresh(): Promise<void> {
    if (this.#pending || this.saving) { this.#again = true; return this.#pending ?? Promise.resolve(); }
    this.loading = true; this.notify();
    this.#pending = (async () => {
      do {
        this.#again = false; const epoch = this.#epoch;
        try { const bundle = await this.bridge.getModelDefinitions(this.hostId); if (epoch !== this.#epoch) { this.#again = true; continue; } this.bundle = bundle; this.error = null; }
        catch (error) { this.error = failure(error); }
        this.notify();
      } while (this.#again && !this.saving);
    })().finally(() => { this.#pending = undefined; this.loading = false; this.notify(); });
    return this.#pending;
  }
  begin(path: ModelDefinitionPath, fresh = false): boolean {
    if (this.edit?.dirty || this.saving || !this.bundle) return false;
    const existing = definitionValue(this.bundle.snapshot.document, path);
    const schema = definitionFieldSchema(this.bundle.catalog.schema, path);
    const originalId = record(existing) && typeof existing.id === "string" ? existing.id : undefined;
    const siblings = path[2] === "models" && typeof path[3] === "number" ? definitionValue(this.bundle.snapshot.document, path.slice(0, 3)) : undefined;
    const ambiguousOriginalId = originalId !== undefined && Array.isArray(siblings) && siblings.filter(model => record(model) && model.id === originalId).length > 1;
    this.edit = { path, value: structuredClone(existing ?? nativeSettingSeed(schema)), revision: this.bundle.snapshot.revision, fresh, dirty: fresh, cleared: [], originalId, ambiguousOriginalId };
    this.actionError = null; this.notify(); return true;
  }
  change(value: SettingJson): void { if (this.edit) { this.edit.value = value; this.edit.dirty = true; this.actionError = null; this.notify(); } }
  clear(relative: ModelDefinitionPath): void {
    if (!this.edit) return;
    const absolute = [...this.edit.path, ...relative];
    if (!this.bundle || definitionValue(this.bundle.snapshot.document, absolute) === undefined && !this.bundle.snapshot.concealed.some(field => pathStarts(field.path, absolute))) return;
    this.edit.cleared = this.edit.cleared.filter(path => !pathStarts(path, absolute));
    if (!this.edit.cleared.some(path => pathStarts(absolute, path))) this.edit.cleared.push(absolute);
    this.edit.dirty = true; this.notify();
  }
  discard(): void { this.edit = null; this.actionError = null; this.notify(); }
  rebase(): void {
    if (!this.edit || !this.bundle) return;
    const edit = this.edit, snapshot = this.bundle.snapshot;
    if (edit.path[2] === "models" && typeof edit.path[3] === "number") {
      const models = definitionValue(snapshot.document, edit.path.slice(0, 3));
      const list = Array.isArray(models) ? models : [];
      if (!edit.fresh && (edit.ambiguousOriginalId || list.filter(model => record(model) && model.id === edit.originalId).length > 1)) {
        this.actionError = "Duplicate native model IDs prevent safely locating this edited row after a change. Your edit is retained; discard it and select the exact current row before editing again."; this.notify(); return;
      }
      const index = edit.fresh ? list.length : list.findIndex(model => record(model) && model.id === edit.originalId);
      if (index < 0) { this.actionError = "This native model was removed. Discard the edit or create a new model explicitly."; this.notify(); return; }
      const old = [...edit.path]; edit.path = [...old.slice(0, 3), index];
      edit.cleared = edit.cleared.map(path => pathStarts(path, old) ? [...edit.path, ...path.slice(old.length)] : path);
    }
    edit.cleared = edit.cleared.filter(path => definitionValue(snapshot.document, path) !== undefined || snapshot.concealed.some(field => pathStarts(field.path, path)));
    edit.revision = snapshot.revision; this.actionError = null; this.notify();
  }
  concealed(): ModelDefinitionPath[] {
    if (!this.bundle || !this.edit) return [];
    const edit = this.edit;
    return this.bundle.snapshot.concealed.filter(field => pathStarts(field.path, edit.path) && !edit.cleared.some(path => pathStarts(field.path, path))).map(field => field.path.slice(edit.path.length));
  }
  async save(): Promise<boolean> {
    if (!this.edit || !this.edit.dirty || !this.bundle || this.saving) return false;
    const edit = this.edit;
    if (edit.revision !== this.bundle.snapshot.revision) { this.actionError = "Review current saved values before using their revision for this edit."; this.notify(); return false; }
    const changes: OmpModelDefinitionsMutation["changes"] = [
      ...edit.cleared.map(path => ({ path, operation: "remove" as const })),
      { path: edit.path, operation: "set", value: edit.value },
    ];
    return this.#mutate({ expectedRevision: edit.revision, changes });
  }
  async remove(path: ModelDefinitionPath): Promise<boolean> {
    if (this.edit?.dirty || !this.bundle || this.saving) return false;
    return this.#mutate({ expectedRevision: this.bundle.snapshot.revision, changes: [{ path, operation: "remove" }] });
  }
  async reorder(provider: string, index: number, direction: -1 | 1): Promise<boolean> {
    if (!this.bundle || this.edit?.dirty || this.saving) return false;
    const path = ["providers", provider, "models"];
    const value = definitionValue(this.bundle.snapshot.document, path);
    if (!Array.isArray(value) || index + direction < 0 || index + direction >= value.length) return false;
    if (duplicateModelIds(value)) { this.actionError = "Duplicate native model IDs prevent safe reordering. Edit the exact rows to give them distinct IDs first."; this.notify(); return false; }
    const models = [...value]; [models[index], models[index + direction]] = [models[index + direction], models[index]];
    return this.#mutate({ expectedRevision: this.bundle.snapshot.revision, changes: [{ path, operation: "set", value: models }] });
  }
  async #mutate(mutation: OmpModelDefinitionsMutation): Promise<boolean> {
    this.saving = true; this.actionError = null; this.#epoch++; this.notify(); let succeeded = false;
    try { const snapshot = await this.bridge.setModelDefinitions(mutation, this.hostId); this.bundle = { catalog: this.bundle!.catalog, snapshot }; this.edit = null; succeeded = true; }
    catch (error) { this.actionError = failure(error); this.#again = true; }
    finally { this.saving = false; this.#epoch++; this.notify(); if (this.#again) await this.refresh(); }
    return succeeded;
  }
}

function NativeDefinitions({ data, connected, onSaved }: { data: NativeModelDefinitionsState; connected: boolean; onSaved(): void }) {
  const [, redraw] = useReducer(value => value + 1, 0);
  const [provider, setProvider] = useState("");
  const [newProvider, setNewProvider] = useState("");
  const [overrideId, setOverrideId] = useState("");
  const [remove, setRemove] = useState<ModelDefinitionPath | null>(null);
  useEffect(() => data.subscribe(redraw), [data]);
  useEffect(() => { if (connected) void data.refresh(); }, [data, connected]);
  const providersValue = data.bundle?.snapshot.document.providers;
  const providers = record(providersValue) ? providersValue : {};
  const providerId = Object.hasOwn(providers, provider) ? provider : Object.keys(providers)[0];
  const selected = providerId && record(providers[providerId]) ? providers[providerId] as Record<string, SettingJson> : undefined;
  const models = Array.isArray(selected?.models) ? selected.models : [];
  const ambiguousModels = duplicateModelIds(models);
  const overrides = record(selected?.modelOverrides) ? selected.modelOverrides : {};
  const mutable = connected && !data.saving && !!data.bundle;
  const canNavigate = mutable && !data.edit?.dirty;
  const run = async (operation: Promise<boolean>) => { if (await operation) onSaved(); setRemove(null); };
  return <section className="native-definitions settings-card" aria-label="Native model definitions"><div className="native-definition-heading"><div><h2>Native model definitions</h2><p>Custom providers, models and compatibility overrides on this host.</p></div><button className="secondary-button" disabled={!connected || data.loading || data.saving} onClick={() => void data.refresh()}>{data.loading ? "Reloading…" : "Reload definitions"}</button></div>
    {data.error && <p className="inline-error" role="alert">{data.error}</p>}{data.actionError && <p className="inline-error" role="alert">{data.actionError}</p>}
    {data.bundle && <>
      <p className="native-note">Host scope · {data.bundle.snapshot.sourcePath}. Changes apply when discovery refreshes and to new sessions; existing workers keep their loaded definitions.</p>
      <label className="native-labeled-control">Configured provider<select aria-label="Configured model provider" value={providerId ?? ""} disabled={!canNavigate} onChange={event => { setProvider(event.target.value); data.discard(); setRemove(null); }}><option value="" disabled>No custom provider definitions</option>{Object.keys(providers).map(id => <option value={id} key={id}>{id}</option>)}</select></label>
      <div className="native-definition-add"><input className="text-field" aria-label="New model provider identifier" placeholder="New provider identifier" value={newProvider} disabled={!canNavigate} onChange={event => setNewProvider(event.target.value)}/><button className="secondary-button" disabled={!canNavigate || !newProvider || !safeKey(newProvider) || Object.hasOwn(providers, newProvider)} onClick={() => { data.begin(["providers", newProvider], true); setNewProvider(""); }}>Add provider</button></div>
      {selected && <><div className="native-row-actions"><button className="secondary-button" disabled={!canNavigate} onClick={() => data.begin(["providers", providerId])}>Edit provider configuration</button><button className="native-reset" disabled={!canNavigate} onClick={() => setRemove(["providers", providerId])}>Remove provider definition</button></div>
        <details className="native-definition-list" open><summary>Custom models · {models.length}</summary>{ambiguousModels && <p className="native-warning">Duplicate IDs: edit each exact row to give it a distinct ID before reordering. Saved concealed values stay with their row.</p>}{models.map((model, index) => <div className="native-definition-row" key={index}><div><strong>{record(model) ? String(model.name ?? model.id) : `Model ${index + 1}`}</strong><code>{record(model) ? String(model.id) : "Undeclared"}</code></div><div><button className="secondary-button" disabled={!canNavigate} onClick={() => data.begin(["providers", providerId, "models", index])}>Edit model</button><button className="native-reset" aria-label={`Move model ${index + 1} up`} disabled={!canNavigate || ambiguousModels || index === 0} onClick={() => void run(data.reorder(providerId, index, -1))}>↑</button><button className="native-reset" aria-label={`Move model ${index + 1} down`} disabled={!canNavigate || ambiguousModels || index === models.length - 1} onClick={() => void run(data.reorder(providerId, index, 1))}>↓</button><button className="native-reset" disabled={!canNavigate} onClick={() => setRemove(["providers", providerId, "models", index])}>Remove</button></div></div>)}<button className="secondary-button" disabled={!canNavigate} onClick={() => data.begin(["providers", providerId, "models", models.length], true)}>Add custom model</button></details>
        <details className="native-definition-list"><summary>Bundled-model overrides · {Object.keys(overrides).length}</summary>{Object.keys(overrides).map(id => <div className="native-definition-row" key={id}><code>{id}</code><div><button className="secondary-button" disabled={!canNavigate} onClick={() => data.begin(["providers", providerId, "modelOverrides", id])}>Edit override</button><button className="native-reset" disabled={!canNavigate} onClick={() => setRemove(["providers", providerId, "modelOverrides", id])}>Remove</button></div></div>)}<div className="native-definition-add"><input className="text-field" aria-label="Model selector for a new override" placeholder="Native model selector" value={overrideId} disabled={!canNavigate} onChange={event => setOverrideId(event.target.value)}/><button className="secondary-button" disabled={!canNavigate || !overrideId || !safeKey(overrideId) || Object.hasOwn(overrides, overrideId)} onClick={() => { data.begin(["providers", providerId, "modelOverrides", overrideId], true); setOverrideId(""); }}>Add override</button></div></details>
      </>}
      {remove && <div className="native-edit-error" role="alert"><p>Remove this native definition and its saved concealed values: {remove.map(String).join(" / ")}?</p><button className="secondary-button" onClick={() => setRemove(null)}>Cancel</button><button className="secondary-button text-danger" disabled={!canNavigate} onClick={() => void run(data.remove(remove))}>Remove definition</button></div>}
      {data.edit && <NativeDefinitionEditor data={data} writable={mutable} onSaved={onSaved}/>}
      {data.bundle.snapshot.unsupportedPaths.length > 0 && <p className="native-warning">Undeclared fields are retained on disk without exposing their values: {data.bundle.snapshot.unsupportedPaths.map(path => path.map(String).join(" / ")).join(", ")}</p>}
      <details className="native-setting-details"><summary>Native validation and persistence</summary>{data.bundle.catalog.rules.map(rule => <p key={rule}>{rule}</p>)}<p>{data.bundle.snapshot.format === "legacy-json" ? "The legacy JSON file remains unchanged on read. Saving creates native models.yml and keeps the legacy file." : "Saving preserves the native symlink target, mode and owner, using a file lock and synced atomic replacement."}</p></details>
    </>}
  </section>;
}
export function NativeDefinitionEditor({ data, writable, onSaved }: { data: NativeModelDefinitionsState; writable: boolean; onSaved(): void }) {
  const edit = data.edit, bundle = data.bundle;
  if (!edit || !bundle) return null;
  let schema = definitionFieldSchema(bundle.catalog.schema, edit.path);
  // Separate model/override lists retain stable identities and explicit deletion
  // actions. Their existing values stay in the compound provider edit payload.
  if (edit.path.length === 2 && schema.kind === "object") schema = { ...schema, fields: Object.fromEntries(Object.entries(schema.fields).filter(([key]) => !["models", "modelOverrides"].includes(key))) };
  const basicNames = ["id", "name", "baseUrl", "api", "auth", "apiKey", "input", "reasoning", "contextWindow", "maxTokens", "supportsTools"];
  const sections = schema.kind === "object" ? [
    { label: "Model/provider fields", advanced: false, schema: { ...schema, fields: Object.fromEntries(Object.entries(schema.fields).filter(([key]) => basicNames.includes(key))) } },
    { label: "Advanced compatibility, thinking and routing", advanced: true, schema: { ...schema, fields: Object.fromEntries(Object.entries(schema.fields).filter(([key]) => !basicNames.includes(key))) } },
  ] : [{ label: "Native definition", advanced: false, schema }];
  const obsolete = edit.revision !== bundle.snapshot.revision;
  const saved = definitionValue(bundle.snapshot.document, edit.path);
  return <div className="native-definition-editor"><h3>{edit.fresh ? "Create" : "Edit"} {edit.path.map(String).join(" / ")}</h3>{edit.dirty && <p className="native-note">Unsaved definition · save or discard before switching definitions.</p>}
    {sections.map(section => {
      const control = <NativeValueField schema={section.schema} value={edit.value} label={section.label} disabled={!writable} concealed={data.concealed()} onClearConcealed={path => data.clear(path)} onChange={value => data.change(value)}/>;
      return section.advanced ? <details key={section.label} className="native-definition-advanced"><summary>{section.label}</summary>{control}</details> : <div key={section.label}>{control}</div>;
    })}
    {edit.cleared.length > 0 && <p className="native-warning">Explicitly clearing saved values: {edit.cleared.map(path => path.map(String).join(" / ")).join(", ")}. Replacement values entered above will be saved after clearing.</p>}
    {obsolete && <div className="native-edit-error" role="alert"><p>Saved definitions changed. Your edit remains above. Review the current saved values before retrying; concealed values remain hidden.</p><details><summary>Current saved values</summary><NativeMetadata value={saved}/></details><button className="secondary-button" disabled={!writable} onClick={() => data.rebase()}>Use current revision for this definition</button></div>}
    <div className="native-row-actions"><button className="primary-button" disabled={!writable || !edit.dirty || obsolete} onClick={async () => { if (await data.save()) onSaved(); }}>{data.saving ? "Saving native definition…" : "Save native definition"}</button><button className="secondary-button" disabled={data.saving} onClick={() => data.discard()}>Discard definition edit</button></div>
  </div>;
}
