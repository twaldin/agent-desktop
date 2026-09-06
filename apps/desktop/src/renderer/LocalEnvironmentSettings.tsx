import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from "react";
import type { DesktopBridge, LocalEnvironmentAction, LocalEnvironmentConfig, LocalEnvironmentPlatform, Project } from "@agent-desktop/shared";
import { LocalEnvironmentState } from "./local-environment-state";
import { offlineCache } from "./offline-cache";
import { Icon } from "./Icons";
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
  const state = useMemo(() => {
    if (!selected) return undefined;
    const key = `${hostId}:${selected.id}`;
    let value = states.current.get(key);
    if (!value) { value = new LocalEnvironmentState(bridge, hostId, selected.id, offlineCache, localHostId); states.current.set(key, value); }
    return value;
  }, [bridge, hostId, localHostId, selected]);
  useEffect(() => { if (!state) return; const off = state.subscribe(redraw); state.start(); void state.restore(); return () => { off(); state.stop(); }; }, [state]);
  useEffect(() => { state?.setConnected(connected); }, [state, connected]);
  const [scriptPlatforms, setScriptPlatforms] = useState<Record<ScriptKind, typeof platforms[number]>>({ setup: "default", cleanup: "default" });
  const [variablesOpen, setVariablesOpen] = useState(false);
  useEffect(() => { setRawEditor(Boolean(state?.editor && !state.config)); }, [state, state?.selected]);
  useEffect(() => {
    if (!state?.restored) return;
    const frame = requestAnimationFrame(() => {
      const selector = state.editor ? state.config ? ".local-environment-field input" : ".local-environment-repair textarea" : ".local-environment-editor-title .primary-button";
      section.current?.querySelector<HTMLElement>(selector)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [state, state?.selected, state?.restored]);
  if (!state || !selected) return <section ref={section} className="settings-page local-environment-settings" aria-label="Environments settings"><header className="settings-header local-environment-header"><button className="icon-button" type="button" onClick={onClose} aria-label="Back to settings"><Icon name="browserBack" /></button><div><h1>Environments</h1><p>Reusable setup for project worktrees</p></div></header><div className="center-state"><p>{projects.length ? "Select a project to manage its environments." : "Add a project to manage its environments."}</p>{onAddProject && <button className="primary-button" disabled={!connected} onClick={onAddProject}>Add project</button>}</div></section>;
  const config = state.config;
  const editor = state.editor;

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
    <header className="local-environment-breadcrumbs"><button type="button" className="text-button" onClick={() => state.back()}>Environments</button><Icon name="chevron" /><span>{selected.name}</span>{editor && <><Icon name="chevron" /><span aria-current="page">edit</span></>}</header>
    <div className="local-environment-layout">
      {!editor && <aside className="local-environment-projects" aria-label="Available projects">
        <div className="local-environment-project-heading"><h2>Projects</h2>{onAddProject && <button type="button" className="secondary-button" disabled={!connected} onClick={onAddProject}>Add project</button>}</div>
        <div className="local-environment-project-list">{projects.map(project => <div className={`local-environment-project ${project.id === selectedProjectId ? "selected" : ""}`} key={project.id}><button type="button" onClick={() => { setSelectedProjectId(project.id); onSelectProject?.(project.id); }} aria-current={project.id === selectedProjectId ? "page" : undefined} title={project.path}><Icon name="folder" /><span>{project.name}</span></button><button type="button" className="icon-button small" aria-label={`Select ${project.name}`} onClick={() => { setSelectedProjectId(project.id); onSelectProject?.(project.id); }}><Icon name="plus" /></button></div>)}</div>
      </aside>}
      <div className="local-environment-editor">
        {state.cacheWarning && <p className="inline-error" role="alert">{state.cacheWarning}</p>}
        {state.error && <p className="inline-error" role="alert">{state.error}</p>}
        {state.pending && <div className="local-environment-pending" role="status"><span>Save is awaiting confirmation from the host.</span><button type="button" className="secondary-button" disabled={!connected || state.busy} onClick={() => void state.retry()}>Retry original save</button></div>}
        {editor?.conflict !== undefined && <div className="local-environment-conflict" role="alert"><p>{editor.conflict === null ? "This environment was removed on the host. Your edits are preserved." : "This environment changed on the host. Your edits are preserved."}</p><button type="button" className="secondary-button" disabled={editor.conflict?.type !== "environment"} onClick={() => void state.acceptCurrent()}>Use host version</button><button type="button" className="secondary-button" disabled={editor.conflict !== null && !editor.conflict.revision} onClick={() => state.keepEdit()}>Keep my edits</button></div>}
        {state.notice && <p className="settings-success" role="status">{state.notice}</p>}
        {!editor && <><div className="local-environment-editor-title"><div><h2>{selected.name}</h2><p>{selected.path} · {hostName}</p></div><button type="button" className="primary-button" onClick={() => state.create()} disabled={!state.restored || state.busy || !connected}>Add environment</button></div><div className="local-environment-list">{state.loading && <p role="status">Loading environments…</p>}{state.items.map(item => item.type === "error" ? <div className="local-environment-row error" key={item.configPath}><div><strong>Unreadable environment</strong><small>{item.configPath}</small><p>{item.error}</p></div><button type="button" className="secondary-button" disabled={!connected || !item.revision} title={!item.revision ? "The host cannot safely edit this file." : !connected ? "Reconnect to read this configuration." : undefined} onClick={() => void state.open(item.configPath)}>Repair</button></div> : <button type="button" className="local-environment-row" key={item.configPath} onClick={() => void state.open(item.configPath)}><Icon name="folder" /><span><strong>{item.environment.name}</strong><small>{item.configPath}</small></span><Icon name="chevron" /></button>)}</div></>}
        {editor && (!config || rawEditor) && <div className="local-environment-form local-environment-repair"><div className="local-environment-form-heading"><div><button type="button" className="text-button" onClick={() => state.back()}>Environments</button><h2>Repair local environment</h2><p>{editor.configPath}</p></div></div>{!config && <p className="inline-error" role="alert">This configuration is invalid. Correct the TOML below before saving.</p>}<textarea aria-label="Raw environment configuration" value={editor.raw} onChange={event => state.editRaw(event.target.value)} rows={18} spellCheck={false} /><div className="local-environment-form-actions">{config && <button type="button" className="secondary-button" onClick={() => setRawEditor(false)}>Show form</button>}<button type="button" className="primary-button" disabled={!connected || state.busy || Boolean(state.pending) || editor?.conflict !== undefined} onClick={() => void state.save()}>{state.busy ? "Saving…" : "Save repaired configuration"}</button></div></div>}
        {editor && config && !rawEditor && <form onSubmit={submit} className="local-environment-form">
          <div className="local-environment-form-heading"><h2>Edit local environment</h2></div>
          <label className="local-environment-field">Name<input value={config.name} onChange={event => update(current => ({ ...current, name: event.target.value }))} placeholder="Project environment" /></label>
          <ScriptEditor kind="setup" config={config} platform={scriptPlatforms.setup} script={scriptValue("setup")} onScriptChange={value => editScript("setup", value)} onPlatform={value => setScriptPlatforms(current => ({ ...current, setup: value }))} variablesOpen={variablesOpen} onVariables={() => setVariablesOpen(value => !value)} />
          {variablesOpen && <div className="local-environment-variables" role="note"><strong>Available variables</strong><code>CODEX_SOURCE_TREE_PATH</code><code>CODEX_WORKTREE_PATH</code><p>These variables identify the source repository and managed worktree.</p></div>}
          <ScriptEditor kind="cleanup" config={config} platform={scriptPlatforms.cleanup} script={scriptValue("cleanup")} onScriptChange={value => editScript("cleanup", value)} onPlatform={value => setScriptPlatforms(current => ({ ...current, cleanup: value }))} />
          <section className="local-environment-actions"><div className="local-environment-section-heading"><div><h3>Actions</h3><p>Named commands saved with this environment.</p></div><button type="button" className="secondary-button" onClick={addAction}>Add action</button></div>{(config.actions ?? []).map((action, index) => <ActionEditor key={index} action={action} onChange={change => editAction(index, change)} onRemove={() => removeAction(index)} />)}{!config.actions?.length && <p className="local-environment-empty">Add a named command to this environment.</p>}</section>
          <div className="local-environment-form-actions"><button type="submit" className="primary-button" disabled={!connected || state.busy || Boolean(state.pending) || editor.conflict !== undefined}>{state.busy ? "Saving…" : "Save"}</button></div>
        </form>}
      </div>
    </div>
  </section>;
}

function ScriptEditor({ kind, config, platform, script, onScriptChange, onPlatform, variablesOpen, onVariables }: { kind: ScriptKind; config: LocalEnvironmentConfig; platform: typeof platforms[number]; script: string; onScriptChange(value: string): void; onPlatform(platform: typeof platforms[number]): void; variablesOpen?: boolean; onVariables?: () => void }) {
  return <section className="local-environment-script"><div className="local-environment-section-heading"><div><h3>{kind === "setup" ? "Setup script" : "Cleanup script"}</h3><p>{kind === "setup" ? "Setup script for new project worktrees" : "Cleanup script for project worktrees"}</p></div>{kind === "setup" && <button type="button" className="secondary-button" onClick={onVariables}>{variablesOpen ? "Hide variables" : "Variables"}</button>}</div><div className="local-environment-platforms" role="tablist" aria-label={`${kind} script platform`}>
    {platforms.map(value => <button type="button" role="tab" aria-selected={value === platform} className={value === platform ? "selected" : ""} key={value} onClick={() => onPlatform(value)}>{platformLabel(value)}</button>)}
  </div><textarea aria-label={`${kind} script for ${platformLabel(platform)}`} value={script} onChange={event => onScriptChange(event.target.value)} rows={6} spellCheck={false} /></section>;
}

function ActionEditor({ action, onChange, onRemove }: { action: LocalEnvironmentAction; onChange(change: Partial<LocalEnvironmentAction>): void; onRemove(): void }) {
  return <div className="local-environment-action"><div className="local-environment-action-fields"><label>Name<input value={action.name} onChange={event => onChange({ name: event.target.value })} /></label><label>Command<textarea rows={3} value={action.command} onChange={event => onChange({ command: event.target.value })} spellCheck={false} /></label><label>Icon<select value={action.icon ?? ""} onChange={event => onChange({ icon: (event.target.value || null) as LocalEnvironmentAction["icon"] })}><option value="">No icon</option><option value="tool">Tool</option><option value="run">Run</option><option value="debug">Debug</option><option value="test">Test</option></select></label><label>Platform<select value={action.platform ?? ""} onChange={event => onChange({ platform: (event.target.value || undefined) as LocalEnvironmentPlatform | undefined })}><option value="">All platforms</option>{platforms.slice(1).map(value => <option key={value} value={value}>{platformLabel(value)}</option>)}</select></label></div><button type="button" className="icon-button small" aria-label={`Remove ${action.name || "action"}`} onClick={onRemove}><Icon name="close" /></button></div>;
}
