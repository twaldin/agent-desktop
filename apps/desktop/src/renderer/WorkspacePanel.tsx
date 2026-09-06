import { useEffect, useReducer, useRef, useState } from "react";
import type { WorkspaceTab } from "../window-state";
import { WorkspaceState } from "./workspace-state";
import { Icon } from "./Icons";
import { fileLocation, type WorkspaceFileRequest } from "./transcript-links";
import { ReviewPanel } from "./ReviewPanel";
import { retainWorkspace } from "./workspace-lease";

export function WorkspacePanel({ data, connected, name, path, fileRequest, embedded = false, commitRequest, tab: selectedTab, onTabChange, onClose, onOpenProject }: { data: WorkspaceState; connected: boolean; name: string; path: string; fileRequest?: WorkspaceFileRequest; embedded?: boolean; commitRequest?: string; tab?: WorkspaceTab; onTabChange?(tab: WorkspaceTab): void; onClose(): void; onOpenProject(path: string): Promise<void> }) {
  const [, redraw] = useReducer(value => value + 1, 0);
  const [localTab, setLocalTab] = useState<WorkspaceTab>("files");
  const tab = selectedTab ?? localTab;
  const setTab = (value: WorkspaceTab) => { setLocalTab(value); onTabChange?.(value); };
  useEffect(() => { const off = data.subscribe(redraw); const release = retainWorkspace(data); void data.restore().then(() => { if (data.connected) void data.refresh(); }); return () => { off(); release(); }; }, [data]);
  useEffect(() => { data.setConnected(connected); if (connected) void data.refresh(); }, [data, connected]);
  useEffect(() => {
    if (!fileRequest) return;
    setTab("files"); let cancelled = false;
    void data.restore().then(() => { if (!cancelled && data.restored) void data.open(fileRequest.path); });
    return () => { cancelled = true; };
  }, [data, fileRequest, data.restored]);
  useEffect(() => {
    if (!connected) return;
    if (tab === "worktrees") void data.loadWorktrees();
    const interval = setInterval(() => { if (tab === "worktrees") void data.loadWorktrees(); else if (tab === "changes") void data.loadGit(); else { void data.list(data.directory); if (data.opened) void data.read(data.opened); } }, 5_000);
    return () => clearInterval(interval);
  }, [data, connected, tab]);
  const disabled = !connected || data.busy || Boolean(data.pending) || !data.restored;
  return <aside className={`workspace-panel ${embedded ? "workspace-embedded" : ""}`} aria-label="Workspace files and Git" aria-busy={data.loading.size > 0 || !data.restored}>
    {!embedded && <><header className="workspace-header"><div className="truncate"><strong>{name}</strong><span title={path}>{path}</span></div><button className="icon-button" aria-label="Refresh workspace" disabled={!connected || data.loading.size > 0} onClick={() => { void data.refresh(); if (tab === "worktrees") void data.loadWorktrees(); if (tab === "changes" && data.diff) void data.showDiff(data.diffSelection.path, data.diffSelection.staged); }}><Icon name="refresh"/></button><button className="icon-button" aria-label="Close workspace panel" onClick={onClose}><Icon name="close"/></button></header>
    <div className="workspace-tabs" role="tablist" aria-label="Workspace view">{(["files", "changes", "worktrees"] as const).map(value => <button key={value} id={`workspace-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls="workspace-view" onClick={() => setTab(value)}>{value === "files" ? "Files" : value === "changes" ? "Changes" : "Worktrees"}</button>)}</div></>}
    {!connected && <p className="workspace-notice">Offline · displaying cached files and status. Editor changes stay on this device.</p>}
    {!data.restored && <p className="workspace-notice">{data.cacheWarning ?? "Restoring editor buffers…"}{data.cacheWarning && <button onClick={() => void data.restore()}>Retry recovery</button>}</p>}
    {data.cacheWarning && data.restored && <p className="workspace-notice" role="alert">{data.cacheWarning}</p>}
    {data.errors.action && <div className="inline-error" role="alert">{data.errors.action}</div>}
    {data.notice && <p className="workspace-notice" role="status">{data.notice}</p>}
    {data.pending?.uncertain && <div className="workspace-pending"><strong>Check the pending change</strong><p>A new command is paused until this outcome is resolved.</p><code>{data.pending.envelope.command.action.type} · {data.pending.envelope.id}</code><div><button className="primary-button" disabled={!connected || data.busy} onClick={() => void data.retry()}>Check original command</button><details><summary>After inspecting the outcome</summary><p>Use the file or Git state to establish whether the change completed before starting a new change.</p><button className="secondary-button" disabled={data.busy} onClick={() => void data.acknowledgeUnknown()}>I checked the outcome</button></details></div></div>}
    <div id={embedded ? undefined : "workspace-view"} className="workspace-view" role={embedded ? undefined : "tabpanel"} aria-labelledby={embedded ? undefined : `workspace-tab-${tab}`}>
      {tab === "files" ? <Files data={data} disabled={disabled} fileRequest={fileRequest}/> : tab === "changes" ? <ReviewPanel commitRequest={commitRequest} data={data} disabled={disabled} onEdit={path => { setTab("files"); void data.open(path); }}/> : <Worktrees data={data} disabled={disabled} onOpenProject={onOpenProject}/>}
    </div>
  </aside>;
}

function Files({ data, disabled, fileRequest }: { data: WorkspaceState; disabled: boolean; fileRequest?: WorkspaceFileRequest }) {
  const [folder, setFolder] = useState(data.directory);
  const [newPath, setNewPath] = useState("");
  const [adding, setAdding] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const appliedFileRequest = useRef<string>(undefined);
  const [locationNotice, setLocationNotice] = useState<string>();
  const document = data.opened ? data.documents.get(data.opened) : undefined;
  const entries = data.directories.get(data.directory);
  const editable = document && (!document.content || document.content.kind === "text");
  useEffect(() => { setFolder(data.directory); }, [data.directory]);
  const fileError = data.opened && data.errors[`file:${data.opened}`];
  const readingLinkedFile = Boolean(data.opened && data.loading.has(`file:${data.opened}`));
  useEffect(() => {
    if (data.opened !== fileRequest?.path) { setLocationNotice(undefined); return; }
    if (!fileRequest || appliedFileRequest.current === fileRequest.id || !data.restored || readingLinkedFile || fileError || !document || !editable || !editor.current) return;
    appliedFileRequest.current = fileRequest.id; setLocationNotice(undefined);
    editor.current.focus({ preventScroll: true });
    if (fileRequest.line === undefined) return;
    const location = fileLocation(editor.current.value, fileRequest.line, fileRequest.column);
    if ("error" in location) { setLocationNotice(location.error); return; }
    editor.current.setSelectionRange(location.start, location.end);
    const lineHeight = Number.parseFloat(getComputedStyle(editor.current).lineHeight);
    if (Number.isFinite(lineHeight)) editor.current.scrollTop = Math.max(0, (fileRequest.line - 1) * lineHeight - editor.current.clientHeight / 2);
    if (gutter.current) gutter.current.scrollTop = editor.current.scrollTop;
    if (document.dirty) setLocationNotice(`File link opened at line ${fileRequest.line} in your unsaved buffer.`);
  }, [fileRequest, data.opened, data.restored, document, editable, readingLinkedFile, fileError]);
  return <div className="files-view">
    <section className="file-browser" aria-label="Workspace directory">
      <form className="workspace-path-form" onSubmit={event => { event.preventDefault(); void data.list(folder || "."); }}><label className="sr-only" htmlFor="workspace-directory">Directory relative to workspace</label><input id="workspace-directory" value={folder} onChange={event => setFolder(event.target.value)} autoComplete="off"/><button disabled={!data.connected}>Go</button><button type="button" title="New file" aria-label="New file" className="icon-button small" disabled={!data.restored} onClick={() => setAdding(value => !value)}><Icon name="plus"/></button></form>
      {adding && <form className="workspace-path-form" onSubmit={event => { event.preventDefault(); data.newFile(newPath); if (data.opened === newPath) { setAdding(false); setNewPath(""); } }}><input aria-label="New file relative path" placeholder="folder/file.txt" value={newPath} onChange={event => setNewPath(event.target.value)} autoFocus/><button disabled={!newPath.trim()}>Create buffer</button></form>}
      {data.errors[`files:${data.directory}`] && <p className="workspace-notice" role="alert">{data.errors[`files:${data.directory}`]}</p>}
      <div className="file-entries">{data.directory !== "." && <button className="file-entry" onClick={() => void data.list(data.directory.split("/").slice(0, -1).join("/") || ".")}><Icon name="folder"/><span>..</span></button>}{entries?.map(entry => <div className={`file-entry-row ${entry.path === data.opened ? "selected" : ""}`} key={entry.path}><button className="file-entry" title={entry.linkTarget ? `${entry.linkTarget} (${entry.linkState})` : entry.path} disabled={entry.kind === "other" || entry.kind === "symlink" && entry.linkState !== "inside"} onClick={() => entry.kind === "directory" ? void data.list(entry.path) : void data.open(entry.path)}><Icon name={entry.kind === "directory" ? "folder" : "compose"}/><span className="truncate">{entry.name}</span>{data.documents.get(entry.path)?.dirty && <span aria-label="Unsaved edits">•</span>}<small>{entry.kind === "symlink" ? `Link · ${entry.linkState}` : entry.kind === "file" ? size(entry.size) : ""}</small></button>{entry.kind === "symlink" && entry.linkState === "inside" && <button title="Browse this link as a directory" onClick={() => void data.list(entry.path)}>Browse</button>}</div>)}{entries?.length === 0 && <p className="workspace-notice">This directory is empty.</p>}{!entries && <p className="workspace-notice">{data.loading.has(`files:${data.directory}`) ? "Loading directory…" : "No directory listing is cached."}</p>}</div>
    </section>
    <section className="file-editor" aria-label="File editor">
      {data.documents.size > 0 && <div className="editor-tabs">{[...data.documents].map(([path, item]) => <button className={path === data.opened ? "selected" : ""} key={path} title={path} onClick={() => void data.open(path)}>{path.split("/").at(-1)}{item.dirty ? " •" : ""}</button>)}</div>}
      {!data.opened ? <div className="workspace-empty"><Icon name="compose"/><p>Select a file to read or edit.</p></div> : <>
        <div className="editor-toolbar"><span className="truncate" title={data.opened}>{data.opened}</span><button className="secondary-button" disabled={disabled || !document?.dirty || document.conflict !== undefined || !editable} onClick={() => void data.saveFile(data.opened!)}>Save <kbd>⌘S</kbd></button></div>
        {fileError && <p className="workspace-notice" role="alert">{fileError}</p>}
        {locationNotice && <p className="workspace-notice" role="status">{locationNotice}</p>}
        {document?.conflict !== undefined && <div className="file-conflict"><strong>The host file changed.</strong><details><summary>View host version</summary><pre>{document.conflict?.kind === "text" ? document.conflict.text : document.conflict ? `File is ${document.conflict.kind}` : "The file no longer exists."}</pre></details><div><button className="secondary-button" onClick={() => data.resolve(data.opened!, "remote")}>Use host version</button><button className="primary-button" onClick={() => data.resolve(data.opened!, "local")}>Keep my edits for next save</button></div></div>}
        {document?.recoveredText !== undefined && <details className="editor-recovery"><summary>Previous local buffer retained</summary><pre>{document.recoveredText}</pre><button onClick={() => data.edit(data.opened!, document.recoveredText!)}>Restore this text into editor</button></details>}
        {!document ? <p className="workspace-notice">{data.loading.has(`file:${data.opened}`) ? "Loading file…" : "No file content is cached."}</p> : editable ? <div className="editor-content"><pre ref={gutter} className="editor-gutter" aria-hidden="true">{Array.from({ length: document.text.split("\n").length }, (_, index) => index + 1).join("\n")}</pre><textarea ref={editor} aria-label={`Edit ${data.opened}`} value={document.text} wrap="off" spellCheck={false} autoComplete="off" onChange={event => data.edit(data.opened!, event.target.value)} onScroll={event => { if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop; }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!disabled) void data.saveFile(data.opened!); } }}/></div> : <div className="workspace-empty"><p>{document.content?.kind === "binary" ? "This is a binary file. Text editing is unavailable." : document.content?.kind === "too-large" ? `This file is ${size(document.content.size)}; the host text editor limit is ${size(document.content.maximumBytes)}.` : document.content?.kind === "unsupported-encoding" ? `${document.content.encoding} editing is not supported. The original file is unchanged.` : "No text to display."}</p></div>}
        {document && <footer className="editor-status">{document.dirty ? "Unsaved edits" : "Host version"}{document.content?.kind === "text" ? ` · UTF-8${document.content.bom ? " with BOM" : ""}` : ""}{!data.connected ? " · Offline cache" : ""}</footer>}
      </>}
    </section>
  </div>;
}

function Worktrees({ data, disabled, onOpenProject }: { data: WorkspaceState; disabled: boolean; onOpenProject(path: string): Promise<void> }) {
  const [destination, setDestination] = useState(""); const [mode, setMode] = useState<"new" | "existing" | "detached">("new");
  const [branch, setBranch] = useState(""); const [start, setStart] = useState("");
  const [opening, setOpening] = useState<string>(); const [error, setError] = useState<string>();
  return <div className="worktrees-view">{data.errors.worktrees && <p className="workspace-notice" role="alert">{data.errors.worktrees}</p>}{error && <p className="workspace-notice" role="alert">{error}</p>}
    <form className="worktree-create" onSubmit={event => { event.preventDefault(); void data.mutate({ type: "worktree.create", options: { path: destination, ...(mode === "existing" ? { branch } : { ...(mode === "new" ? { newBranch: branch } : {}), ...(start.trim() ? { startPoint: start.trim() } : {}) }) } }); }}><h3>Create worktree</h3><p>The directory is created inside this host’s managed worktree folder.</p><label>Directory name<input className="text-field" required value={destination} onChange={event => setDestination(event.target.value)} placeholder="feature-work"/></label><label>Starting state<select className="text-field" value={mode} onChange={event => { setMode(event.target.value as typeof mode); setBranch(""); }}><option value="new">Create a new branch</option><option value="existing">Use an existing local branch</option><option value="detached">Detached commit</option></select></label>{mode === "existing" ? <label>Branch<select className="text-field" value={branch} onChange={event => setBranch(event.target.value)} required><option value="">Choose a local branch</option>{data.branches.filter(branch => !branch.remote).map(branch => <option key={branch.ref} value={branch.name}>{branch.name}{branch.current ? " (current)" : ""}</option>)}</select></label> : <>{mode === "new" && <label>New branch name<input className="text-field" required value={branch} onChange={event => setBranch(event.target.value)}/></label>}<label>Start point<input className="text-field" placeholder="HEAD" value={start} onChange={event => setStart(event.target.value)} list="worktree-start-points"/><datalist id="worktree-start-points">{data.branches.map(branch => <option key={branch.ref} value={branch.ref}/>)}</datalist></label></>}<button className="primary-button" disabled={disabled || !destination.trim() || mode !== "detached" && !branch.trim()}>Create worktree</button></form>
    <h3>Registered worktrees</h3>{!data.worktrees.length && <p className="workspace-notice">{data.loading.has("worktrees") ? "Loading worktrees…" : "No worktree listing is available."}</p>}{data.worktrees.map(tree => <article className="worktree-card" key={tree.path}><strong>{tree.branch ?? (tree.detached ? "Detached HEAD" : "Bare repository")}</strong><code>{tree.path}</code><p>{tree.managed ? "Managed by this host" : "Existing repository worktree"}{tree.locked ? ` · Locked${tree.lockReason ? `: ${tree.lockReason}` : ""}` : ""}{tree.prunable ? ` · ${tree.prunable}` : ""}</p><div><button className="secondary-button" disabled={!data.connected || Boolean(opening) || tree.bare} onClick={() => { setOpening(tree.path); setError(undefined); void onOpenProject(tree.path).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setOpening(undefined)); }}>{opening === tree.path ? "Opening…" : "Open as project"}</button>{tree.managed && <button className="secondary-button" disabled={disabled || tree.locked || !tree.managedRelativePath} title={!tree.managedRelativePath ? "Update this host to expose its managed removal path" : undefined} onClick={() => { void data.mutate({ type: "worktree.remove", path: tree.managedRelativePath! }); }}>Delete</button>}</div></article>)}
  </div>;
}
function size(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`; }
