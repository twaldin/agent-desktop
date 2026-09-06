import { useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { DesktopBridge, LocalEnvironmentAction, LocalEnvironmentCatalogItem, LocalEnvironmentConfig, LocalEnvironmentIcon, LocalEnvironmentPlatform, Project } from "@agent-desktop/shared";
import { LocalEnvironmentState } from "./local-environment-state";
import { offlineCache } from "./offline-cache";
import { Icon } from "./Icons";
import { EnvironmentSummary } from "./EnvironmentSummary";
import { ActionIcon } from "./EnvironmentActions";
import "./local-environment-settings.css";

type ScriptKind = "setup" | "cleanup";
const platforms: Array<"default" | LocalEnvironmentPlatform> = ["default", "darwin", "linux", "win32"];
const platformLabel = (platform: typeof platforms[number]) => platform === "default" ? "Default" : platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux";

export interface LocalEnvironmentSettingsProps {
  bridge: DesktopBridge;
  hostId: string;
  localHostId?: string;
  hostName: string;
  connected: boolean;
  projects: Project[];
  initialProjectId?: string;
  onSelectProject?(projectId: string): void;
  onAddProject?(): void;
  onClose(): void;
}

export function LocalEnvironmentSettings({ bridge, hostId, localHostId, hostName, connected, projects, initialProjectId, onSelectProject, onAddProject, onClose }: LocalEnvironmentSettingsProps) {
  const [, redraw] = useReducer(value => value + 1, 0);
  const [selectedProjectId, setSelectedProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const states = useRef(new Map<string, LocalEnvironmentState>());
  const previousInitial = useRef(initialProjectId);
  useEffect(() => {
    const changedInitial = previousInitial.current !== initialProjectId;
    previousInitial.current = initialProjectId;
    if (changedInitial && projects.some(project => project.id === initialProjectId)) setSelectedProjectId(initialProjectId!);
    else if (!projects.some(project => project.id === selectedProjectId)) setSelectedProjectId(projects.find(project => project.id === initialProjectId)?.id ?? projects[0]?.id ?? "");
  }, [initialProjectId, projects, selectedProjectId]);
  const section = useRef<HTMLElement>(null);
  const [rawEditor, setRawEditor] = useState(false);
  const selected = projects.find(project => project.id === selectedProjectId);
  const projectStates = useMemo(() => projects.map(project => {
    const key = `${hostId}:${project.id}`;
    let value = states.current.get(key);
    if (!value) { value = new LocalEnvironmentState(bridge, hostId, project.id, offlineCache, localHostId); states.current.set(key, value); }
    return value;
  }), [bridge, hostId, localHostId, projects]);
  const state = projectStates.find(state => state.projectId === selectedProjectId);
  useEffect(() => {
    const off = projectStates.map(state => { const off = state.subscribe(redraw); state.start(); void state.restore(); return off; });
    return () => { off.forEach(stop => stop()); projectStates.forEach(state => state.stop()); };
  }, [projectStates]);
  useEffect(() => { projectStates.forEach(state => state.setConnected(connected)); }, [projectStates, connected]);
  const [scriptPlatforms, setScriptPlatforms] = useState<Record<ScriptKind, typeof platforms[number]>>({ setup: "default", cleanup: "default" });
  useEffect(() => { setRawEditor(Boolean(state?.editor && !state.config)); }, [state, state?.selected, state?.view]);
  useEffect(() => {
    if (!state?.restored) return;
    const frame = requestAnimationFrame(() => {
      const selector = state.editor ? state.view === "summary" ? ".environment-summary-edit button" : state.config ? ".local-environment-field input" : ".local-environment-repair textarea" : ".environment-project-add";
      section.current?.querySelector<HTMLElement>(selector)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [state, state?.selected, state?.view, state?.restored]);
  if (!state || !selected) return <section ref={section} className="settings-page local-environment-settings" aria-label="Environments settings"><header className="settings-header local-environment-header"><button className="icon-button" type="button" onClick={onClose} aria-label="Back to settings"><Icon name="browserBack" /></button><div><h1>Environments</h1><p>Reusable setup for project worktrees</p></div></header><div className="center-state"><p>{projects.length ? "Select a project to manage its environments." : "Add a project to manage its environments."}</p>{onAddProject && <button className="primary-button" disabled={!connected} onClick={onAddProject}>Add project</button>}</div></section>;
  const config = state.config;
  const editor = state.editor;
  const editing = state.view === "edit";
  const savedItem = state.items.find(item => item.configPath === editor?.configPath);
  const summaryConfig = editor?.dirty ? savedItem?.type === "environment" ? savedItem.environment : undefined : config;

  function update(change: (current: LocalEnvironmentConfig) => LocalEnvironmentConfig) {
    if (!config) return;
    state!.edit(change(config));
  }
  function scriptValue(kind: ScriptKind) {
    const script = config?.[kind];
    const platform = scriptPlatforms[kind];
    return platform === "default" ? script?.script ?? "" : script?.[platform]?.script ?? "";
  }
  function editScript(kind: ScriptKind, value: string) {
    update(current => {
      const existing = current[kind] ?? { script: "" };
      const platform = scriptPlatforms[kind];
      if (platform === "default") return { ...current, [kind]: { ...existing, script: value } };
      return { ...current, [kind]: { ...existing, [platform]: { script: value } } };
    });
  }
  function addAction() { update(current => ({ ...current, actions: [...(current.actions ?? []), { name: "", icon: null, command: "" }] })); }
  function editAction(index: number, change: Partial<LocalEnvironmentAction>) { update(current => ({ ...current, actions: (current.actions ?? []).map((action, position) => position === index ? { ...action, ...change } : action) })); }
  function removeAction(index: number) { update(current => ({ ...current, actions: (current.actions ?? []).filter((_, position) => position !== index) })); }
  function submit(event: FormEvent) { event.preventDefault(); void state!.save(); }

  return <section ref={section} className="settings-page local-environment-settings" aria-label="Environments settings">
    {editor && <header className="local-environment-breadcrumbs"><button type="button" className="text-button" onClick={() => state.back()}>Environments</button><Icon name="chevron" />{editing ? <><button type="button" className="text-button" onClick={() => state.showSummary()}>{selected.name}</button><Icon name="chevron" /><span aria-current="page">edit</span></> : <span aria-current="page">{selected.name}</span>}</header>}
    <div className="local-environment-layout">
      <div className="local-environment-editor">
        {state.cacheWarning && <p className="inline-error" role="alert">{state.cacheWarning}</p>}
        {state.error && <p className="inline-error" role="alert">{state.error}</p>}
        {state.pending && <div className="local-environment-pending" role="status"><span>Save is awaiting confirmation from the host.</span><button type="button" className="secondary-button" disabled={!connected || state.busy} onClick={() => void state.retry()}>Retry original save</button></div>}
        {editor?.conflict !== undefined && <div className="local-environment-conflict" role="alert"><p>{editor.conflict === null ? "This environment was removed on the host. Your edits are preserved." : "This environment changed on the host. Your edits are preserved."}</p><button type="button" className="secondary-button" disabled={editor.conflict?.type !== "environment"} onClick={() => void state.acceptCurrent()}>Use host version</button><button type="button" className="secondary-button" disabled={editor.conflict !== null && !editor.conflict.revision} onClick={() => state.keepEdit()}>Keep my edits</button></div>}
        {state.notice && <p className="settings-success" role="status">{state.notice}</p>}
        {!editor && <div className="local-environment-overview">
          <header className="local-environment-overview-heading"><h1>Environments</h1><p>Local environments define setup for project worktrees.</p></header>
          <div className="local-environment-project-heading"><h2>Select a project</h2>{onAddProject && <button type="button" className="secondary-button" disabled={!connected} onClick={onAddProject}>Add project</button>}</div>
          <div className="environment-project-cards" role="list" aria-label="Project environments">{projects.map(project => <EnvironmentProjectCard key={project.id} project={project} state={projectStates.find(state => state.projectId === project.id)!} connected={connected}
            onSelect={() => { setSelectedProjectId(project.id); onSelectProject?.(project.id); }}/>)}</div>
        </div>}

        {editor && !editing && <EnvironmentSummary config={summaryConfig} dirty={editor.dirty} error={savedItem?.type === "error" ? savedItem.error : undefined} onEdit={() => void state.beginEdit()} variables={<EnvironmentVariables />} />}
        {editor && editing && (!config || rawEditor) && <div className="local-environment-form local-environment-repair"><div className="local-environment-form-heading"><div><button type="button" className="text-button" onClick={() => state.back()}>Environments</button><h2>Repair local environment</h2><p>{editor.configPath}</p></div></div>{!config && <p className="inline-error" role="alert">This configuration is invalid. Correct the TOML below before saving.</p>}<textarea aria-label="Raw environment configuration" value={editor.raw} onChange={event => state.editRaw(event.target.value)} rows={18} spellCheck={false} /><div className="local-environment-form-actions">{config && <button type="button" className="secondary-button" onClick={() => setRawEditor(false)}>Show form</button>}<button type="button" className="primary-button" disabled={!connected || state.busy || Boolean(state.pending) || editor?.conflict !== undefined} onClick={() => void state.save()}>{state.busy ? "Saving…" : "Save repaired configuration"}</button></div></div>}
        {editor && editing && config && !rawEditor && <form onSubmit={submit} className="local-environment-form">
          <div className="local-environment-form-heading"><h2>Edit local environment</h2></div>
          <label className="local-environment-field">Name<input value={config.name} onChange={event => update(current => ({ ...current, name: event.target.value }))} placeholder="Project environment" /></label>
          <ScriptEditor kind="setup" config={config} platform={scriptPlatforms.setup} script={scriptValue("setup")} onScriptChange={value => editScript("setup", value)} onPlatform={value => setScriptPlatforms(current => ({ ...current, setup: value }))} />
          <ScriptEditor kind="cleanup" config={config} platform={scriptPlatforms.cleanup} script={scriptValue("cleanup")} onScriptChange={value => editScript("cleanup", value)} onPlatform={value => setScriptPlatforms(current => ({ ...current, cleanup: value }))} />
          <section className="local-environment-actions"><div className="local-environment-section-heading"><div><h3>Actions</h3><p>Named commands saved with this environment.</p></div><button type="button" className="secondary-button" onClick={addAction}>Add action</button></div>{(config.actions ?? []).map((action, index) => <ActionEditor key={index} action={action} onChange={change => editAction(index, change)} onRemove={() => removeAction(index)} />)}{!config.actions?.length && <p className="local-environment-empty">Add a named command to this environment.</p>}</section>
          <div className="local-environment-form-actions"><button type="submit" className="primary-button" disabled={!connected || state.busy || Boolean(state.pending) || editor.conflict !== undefined}>{state.busy ? "Saving…" : "Save"}</button></div>
        </form>}
      </div>
    </div>
  </section>;
}

const normalizedFolder = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
const fileName = (path: string) => normalizedFolder(path).split("/").at(-1) ?? path;
const environmentFolder = (path: string) => normalizedFolder(path).replace(/\/(?:\.codex|\.agent-desktop)\/environments\/[^/]+$/, "");

function EnvironmentProjectCard({ project, state, connected, onSelect }: { project: Project; state: LocalEnvironmentState; connected: boolean; onSelect(): void }) {
  const [expanded, setExpanded] = useState(false), id = useId();
  const local = state.items.filter(item => environmentFolder(item.configPath) === normalizedFolder(project.path));
  const inherited = state.items.filter(item => environmentFolder(item.configPath) !== normalizedFolder(project.path));
  const defaultItem = local.find(item => item.type === "environment" && fileName(item.configPath) === "environment.toml") ?? local.find(item => item.type === "environment") ?? local[0];
  const open = (item: LocalEnvironmentCatalogItem) => { onSelect(); void state.open(item.configPath); };
  const row = (item: LocalEnvironmentCatalogItem, inherited = false) => {
    const filename = fileName(item.configPath), name = item.type === "environment" ? item.environment.name || filename : "Environment needs attention";
    const description = inherited ? `From ${fileName(environmentFolder(item.configPath))} · ${filename}` : filename !== name ? filename : undefined;
    return <button type="button" className={`environment-config-row${item.type === "error" ? " error" : ""}`} key={item.configPath} title={item.type === "error" ? item.error : item.configPath}
      disabled={!state.restored || (item.type === "error" && (!item.revision || !connected))} onClick={() => open(item)} aria-label={`View ${item.type === "error" ? filename : name}`}>
      <span className="environment-config-label"><span>{name}</span>{description && <small>{description}</small>}</span><Icon name="chevron" />
    </button>;
  };
  return <div className="environment-project-card" role="listitem" aria-label={project.name}>
    <div className="environment-project-card-heading">
      <Icon name="projectNotebook" />
      {defaultItem ? <button type="button" className="environment-project-open" onClick={() => open(defaultItem)} aria-label={`Open ${project.name}`}>{project.name}</button> : <span className="environment-project-open">{project.name}</span>}
      <button type="button" className="icon-button environment-project-add" aria-label={`Add environment to ${project.name}`} disabled={!state.restored || state.busy || !connected}
        onClick={() => { onSelect(); state.create(fileName(project.path).trim().split(/\s+/).slice(0, 3).join(" ")); }}><Icon name="plus" /></button>
    </div>
    {state.loading && !state.items.length && <p className="environment-card-status" role="status">Loading environment…</p>}
    {state.error && <div className="environment-card-status error" role="alert"><span>{state.error}</span><button type="button" className="text-button" disabled={!connected} onClick={() => void state.refresh()}>Retry</button></div>}
    {local.map(item => row(item))}
    {inherited.length > 0 && <>
      <div className="environment-inherited-heading"><span>Inherited environments ({inherited.length})</span><button type="button" className="icon-button" aria-controls={id} aria-expanded={expanded} aria-label={`${expanded ? "Hide" : "Show"} inherited environments`} onClick={() => setExpanded(!expanded)}><Icon name="chevron" /></button></div>
      <div id={id} hidden={!expanded}>{inherited.map(item => row(item, true))}</div>
    </>}
  </div>;
}

function ScriptEditor({ kind, config, platform, script, onScriptChange, onPlatform }: { kind: ScriptKind; config: LocalEnvironmentConfig; platform: typeof platforms[number]; script: string; onScriptChange(value: string): void; onPlatform(platform: typeof platforms[number]): void }) {
  return <section className="local-environment-script"><div className="local-environment-section-heading"><div><h3>{kind === "setup" ? "Setup script" : "Cleanup script"}</h3><p>{kind === "setup" ? "Setup script for new project worktrees" : "Cleanup script for project worktrees"}</p></div>{kind === "setup" && <EnvironmentVariables/>}</div><div className="local-environment-platforms" role="tablist" aria-label={`${kind} script platform`}>
    {platforms.map(value => <button type="button" role="tab" aria-selected={value === platform} className={value === platform ? "selected" : ""} key={value} onClick={() => onPlatform(value)}>{platformLabel(value)}</button>)}
  </div><textarea aria-label={`${kind} script for ${platformLabel(platform)}`} value={script} onChange={event => onScriptChange(event.target.value)} rows={6} spellCheck={false} /></section>;
}

function ActionEditor({ action, onChange, onRemove }: { action: LocalEnvironmentAction; onChange(change: Partial<LocalEnvironmentAction>): void; onRemove(): void }) {
  return <div className="local-environment-action"><div className="local-environment-action-fields"><label>Name<input value={action.name} onChange={event => onChange({ name: event.target.value })} /></label><label>Command<textarea rows={3} value={action.command} onChange={event => onChange({ command: event.target.value })} spellCheck={false} /></label><label>Icon<EnvironmentActionIconPicker value={action.icon} onChange={icon => onChange({ icon })}/></label><label>Platform<select value={action.platform ?? ""} onChange={event => onChange({ platform: (event.target.value || undefined) as LocalEnvironmentPlatform | undefined })}><option value="">All platforms</option>{platforms.slice(1).map(value => <option key={value} value={value}>{platformLabel(value)}</option>)}</select></label></div><button type="button" className="icon-button small" aria-label={`Remove ${action.name || "action"}`} onClick={onRemove}><Icon name="close" /></button></div>;
}

const actionIcons: Array<{ value: LocalEnvironmentIcon; label: string }> = [
  { value: "tool", label: "Tool" }, { value: "run", label: "Run" },
  { value: "debug", label: "Debug" }, { value: "test", label: "Test" },
];

function EnvironmentActionIconPicker({ value, onChange }: { value: LocalEnvironmentIcon | null; onChange(value: LocalEnvironmentIcon): void }) {
  const selected = actionIcons.find(option => option.value === (value ?? "tool")) ?? actionIcons[0]!;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !menu.current || !position) return;
    const bounds = menu.current.getBoundingClientRect(), anchor = trigger.current?.getBoundingClientRect();
    const left = Math.max(8, Math.min(position.left, innerWidth - bounds.width - 8));
    const preferredTop = anchor?.bottom === undefined ? position.top : anchor.bottom + 4;
    const flippedTop = anchor?.top === undefined ? preferredTop : anchor.top - bounds.height - 4;
    const top = Math.max(8, Math.min(preferredTop + bounds.height <= innerHeight - 8 || flippedTop < 8 ? preferredTop : flippedTop, innerHeight - bounds.height - 8));
    if (left !== position.left || top !== position.top) setPosition({ left, top });
  }, [open, position]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>(`[data-icon="${selected.value}"]`)?.focus();
    const dismiss = () => close(false);
    window.addEventListener("resize", dismiss);
    return () => window.removeEventListener("resize", dismiss);
  }, [open, selected.value]);

  function close(restoreFocus = true) {
    setOpen(false); setPosition(undefined);
    if (restoreFocus) queueMicrotask(() => trigger.current?.focus());
  }
  function show() {
    if (open) { close(); return; }
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds) return;
    setPosition({ left: bounds.left, top: bounds.bottom + 4 }); setOpen(true);
  }
  function move(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key === "Tab") {
      event.preventDefault();
      const candidates = [...document.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
        .filter(element => element.offsetParent !== null && !menu.current?.contains(element) && !element.classList.contains("environment-action-icon-dismiss"));
      const index = trigger.current ? candidates.indexOf(trigger.current) : -1;
      const target = index < 0 ? trigger.current : candidates[index + (event.shiftKey ? -1 : 1)];
      close(false); queueMicrotask(() => target?.focus());
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") items[0]!.focus();
    else if (event.key === "End") items.at(-1)!.focus();
    else items[(current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]!.focus();
  }

  return <>
    <button ref={trigger} type="button" className={`environment-action-icon-trigger${open ? " active" : ""}`} aria-label={selected.label}
      aria-haspopup="menu" aria-expanded={open} onClick={show} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); if (!open) show(); }
      }}><ActionIcon icon={selected.value}/></button>
    {open && position && createPortal(<>
      <button type="button" className="environment-action-icon-dismiss" aria-label="Close icon menu" tabIndex={-1}
        onPointerDown={event => event.preventDefault()} onClick={() => close(false)}/>
      <div ref={menu} className="environment-action-icon-menu" role="menu" aria-label="Action icon" style={position} onKeyDown={move}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close(false); }}>
        {actionIcons.map(option => <button key={option.value} type="button" role="menuitem" data-icon={option.value}
          onClick={() => { onChange(option.value); close(); }}><ActionIcon icon={option.value}/><span>{option.label}</span></button>)}
      </div>
    </>, document.body)}
  </>;
}

function EnvironmentVariables() {
  const id = useId();
  return <><button type="button" className="secondary-button environment-variables-trigger" popoverTarget={id}>Variables</button>
    <div id={id} popover="auto" className="environment-variables-popover" aria-label="Setup script environment variables">
      <h4>Setup script environment variables</h4>
      <p>Source workspace path</p><code>CODEX_SOURCE_TREE_PATH</code>
      <p>New worktree path</p><code>CODEX_WORKTREE_PATH</code>
    </div></>;
}
