import { GitFileHistoryState } from "./git-file-history-state";
import { WorkspaceGitFilePanel } from "./WorkspaceGitFilePanel";
import { workspaceSymbolNavigation } from "./symbol-navigation";
import type { FileTextSelection } from "@agent-desktop/shared";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { defaultFileTreeView, type FileTreeView, type WorkspaceTab } from "../window-state";
import { WorkspaceState } from "./workspace-state";
import { Icon } from "./Icons";
import { type WorkspaceFileRequest, type WorkspaceFileLink } from "./transcript-links";
import { ReviewPanel } from "./ReviewPanel";
import { retainWorkspace } from "./workspace-lease";
import { markdownImagePath } from "./markdown-images";
import { resolveMarkdownLink } from "./markdown-links";
import { MarkdownCopyButton } from "./MarkdownCopyButton";
import { RichMarkdownEditor } from "./RichMarkdownEditor";
import { PierreSourceEditor } from "./PierreSourceEditor";
import { WorkspaceFileBreadcrumbs } from "./WorkspaceFileBreadcrumbs";
import { WorkspaceFileTreePane } from "./WorkspaceFileTreePane";
import { WorkspaceFileOpen } from "./WorkspaceFileOpen";

export function WorkspacePanel({ data, connected, name, path, fileRequest, filePath, fileMode, onFileModeChange, onOpenFile, onFileEdit, onAddToChat, onAddFile, openExternal, fileTree, onFileTreeChange, embedded = false, active = true, commitRequest, onCommit, tab: selectedTab, onTabChange, onClose, onOpenProject }: { data: WorkspaceState; connected: boolean; name: string; path: string; fileRequest?: WorkspaceFileRequest; filePath?: string; fileMode?: "markdown" | "source"; onFileModeChange?(mode: "markdown" | "source"): void; onOpenFile?(path: string, location?: Omit<WorkspaceFileLink, "path">, options?: {preview?:boolean}): void; onFileEdit?(path:string):void; onAddToChat?(path: string, selection: FileTextSelection): void; onAddFile?(path:string):void; openExternal?(url: string): Promise<void>; fileTree?: FileTreeView; onFileTreeChange?(view: FileTreeView): void; embedded?: boolean; active?: boolean; commitRequest?: string; onCommit?(): void; tab?: WorkspaceTab; onTabChange?(tab: WorkspaceTab): void; onClose(): void; onOpenProject(path: string): Promise<void> }) {
  const [, redraw] = useReducer(value => value + 1, 0);
  const [localTab, setLocalTab] = useState<WorkspaceTab>("files");
  const tab = selectedTab ?? localTab;
  const [filesVisited, setFilesVisited] = useState(tab === "files");
  useEffect(() => { if (tab === "files") setFilesVisited(true); }, [tab]);
  const setTab = (value: WorkspaceTab) => { setLocalTab(value); onTabChange?.(value); };
  useEffect(() => { const off = data.subscribe(redraw); const release = retainWorkspace(data); void data.restore().then(() => { if (data.connected) void data.refresh(); }); return () => { off(); release(); }; }, [data]);
  useEffect(() => { data.setConnected(connected); if (connected) void data.refresh(); }, [data, connected]);
  useEffect(() => {
    if (!fileRequest) return;
    if (!filePath) setTab("files"); let cancelled = false;
    void data.restore().then(() => { if (!cancelled && data.restored) void (filePath ? data.read(filePath) : data.open(fileRequest.path)); });
    return () => { cancelled = true; };
  }, [data, fileRequest, filePath, data.restored]);
  useEffect(() => { if (filePath && active && data.restored && connected) void data.read(filePath); }, [data, filePath, active, connected, data.restored]);
  useEffect(() => {
    if (!connected || !active) return;
    if (tab === "worktrees") void data.loadWorktrees();
    const interval = setInterval(() => { if (tab === "worktrees") void data.loadWorktrees(); else if (tab === "changes") void data.loadGit(); else { if(!data.standalonePath)void data.list(data.directory); if (filePath ?? data.opened) void data.read((filePath ?? data.opened)!); } }, 5_000);
    return () => clearInterval(interval);
  }, [data, connected, active, tab, filePath]);
  const disabled = !connected || data.busy || Boolean(data.pending) || !data.restored;
  return <aside className={`workspace-panel ${embedded ? "workspace-embedded" : ""}`} aria-label={data.standalonePath ? "File" : "Workspace files and Git"} aria-busy={data.loading.size > 0 || !data.restored}>
    {!embedded && <><header className="workspace-header"><div className="truncate"><strong>{name}</strong><span title={path}>{path}</span></div><button className="icon-button" aria-label="Refresh workspace" disabled={!connected || data.loading.size > 0} onClick={() => { void data.refresh(); if (tab === "worktrees") void data.loadWorktrees(); if (tab === "changes" && data.diff) void data.showDiff(data.diffSelection.path, data.diffSelection.staged); }}><Icon name="refresh"/></button><button className="icon-button" aria-label="Close workspace panel" onClick={onClose}><Icon name="close"/></button></header>
    <div className="workspace-tabs" role="tablist" aria-label="Workspace view">{(["files", "changes", "worktrees"] as const).map(value => <button key={value} id={`workspace-tab-${value}`} role="tab" aria-selected={tab === value} aria-controls="workspace-view" onClick={() => setTab(value)}>{value === "files" ? "Files" : value === "changes" ? "Changes" : "Worktrees"}</button>)}</div></>}
    {!connected && <p className="workspace-notice">Offline · displaying cached files and status. Editor changes stay on this device.</p>}
    {!data.restored && <p className="workspace-notice">{data.cacheWarning ?? "Restoring editor buffers…"}{data.cacheWarning && <button onClick={() => void data.restore()}>Retry recovery</button>}</p>}
    {data.cacheWarning && data.restored && <p className="workspace-notice" role="alert">{data.cacheWarning}</p>}
    {data.errors.action && <div className="inline-error" role="alert">{data.errors.action}</div>}
    {data.notice && !(filePath && data.mutationReceipt?.value.type === "file.write") && <p className="workspace-notice" role="status">{data.notice}</p>}
    {data.pending?.uncertain && <div className="workspace-pending"><strong>Check the pending change</strong><p>A new command is paused until this outcome is resolved.</p><code>{data.pending.envelope.command.action.type} · {data.pending.envelope.id}</code><div><button className="primary-button" disabled={!connected || data.busy} onClick={() => void data.retry()}>Check original command</button><details><summary>After inspecting the outcome</summary><p>Use the file or Git state to establish whether the change completed before starting a new change.</p><button className="secondary-button" disabled={data.busy} onClick={() => void data.acknowledgeUnknown()}>I checked the outcome</button></details></div></div>}
    <div id={embedded ? undefined : "workspace-view"} className="workspace-view" role={embedded ? undefined : "tabpanel"} aria-labelledby={embedded ? undefined : `workspace-tab-${tab}`}>
      {(filesVisited || tab === "files") && <Files key={data.cacheKey} data={data} disabled={disabled} fileRequest={fileRequest} filePath={filePath} fileMode={fileMode} onFileModeChange={onFileModeChange} onOpenFile={onOpenFile} onFileEdit={onFileEdit} onAddToChat={onAddToChat} onAddFile={onAddFile} openExternal={openExternal} workspacePath={path} fileTree={fileTree} onFileTreeChange={onFileTreeChange} workspaceName={path.split("/").filter(Boolean).at(-1) ?? name} active={active && tab === "files"}/>}
      {tab === "changes" ? <ReviewPanel onCommit={onCommit} commitRequest={commitRequest} data={data} disabled={disabled} onEdit={path => { if (onOpenFile) onOpenFile(path); else { setTab("files"); void data.open(path); } }}/> : tab === "worktrees" ? <Worktrees data={data} disabled={disabled} onOpenProject={onOpenProject}/> : null}
    </div>
  </aside>;
}

function Files({ data, disabled, fileRequest, filePath, fileMode, onFileModeChange, onOpenFile, onFileEdit, onAddToChat, onAddFile, openExternal, fileTree, onFileTreeChange, workspaceName, workspacePath, active }: { data: WorkspaceState; disabled: boolean; fileRequest?: WorkspaceFileRequest; filePath?: string; fileMode?: "markdown" | "source"; onFileModeChange?(mode: "markdown" | "source"): void; onOpenFile?(path: string, location?: Omit<WorkspaceFileLink, "path">, options?: {preview?:boolean}): void; onFileEdit?(path:string):void; onAddToChat?(path: string, selection: FileTextSelection): void; onAddFile?(path:string):void; openExternal?(url: string): Promise<void>; fileTree?: FileTreeView; onFileTreeChange?(view: FileTreeView): void; workspaceName: string; workspacePath: string; active: boolean }) {
  const markdownPath = data.standalonePath?.slice(1) ?? filePath!;
  const navigation = workspaceSymbolNavigation(data);
  const [, redrawSymbols] = useReducer(value => value + 1, 0);
  useEffect(() => navigation.subscribe(redrawSymbols), [navigation]);
  const markdownRoot = data.standalonePath ? "/" : workspacePath;
  const edit = (path:string,text:string,autosave?:boolean) => { onFileEdit?.(path); data.edit(path,text,autosave); };
  useEffect(() => {
    const protect = () => { if (filePath) { const document = data.documents.get(filePath); if(document?.dirty || document?.conflict !== undefined || document?.recoveredText !== undefined) onFileEdit?.(filePath); } };
    protect(); return data.subscribe(protect);
  }, [data,filePath,onFileEdit]);
  const [localTree, setLocalTree] = useState(defaultFileTreeView);
  const tree = fileTree ?? localTree, changeTree = onFileTreeChange ?? setLocalTree;
  const opened = filePath ?? data.opened;
  const gitFile = useMemo(() => opened && !data.standalonePath ? new GitFileHistoryState(data, opened) : undefined, [data, opened]);
  const [, redrawGitFile] = useReducer(value => value + 1, 0);
  useEffect(() => {
    if (!gitFile) return;
    const off = gitFile.subscribe(redrawGitFile);
    return () => { off(); gitFile.dispose(); };
  }, [gitFile]);
  useEffect(() => {
    if (!gitFile?.enabled || !active) return;
    return data.retainRepositoryWatch();
  }, [data, gitFile, gitFile?.enabled, active]);
  const [localMode, setLocalMode] = useState<"markdown" | "source">("markdown");
  const markdownFile = Boolean(filePath && /\.(?:md|markdown|mdx)$/i.test(filePath));
  const mode = markdownFile ? fileMode ?? localMode : "source";
  const modeOwner = useRef({ data, filePath, mode, active }); modeOwner.current = { data, filePath, mode, active };
  const [switchingMode, setSwitchingMode] = useState(false), [modeError, setModeError] = useState<string>();
  const modeGeneration = useRef(0);
  useEffect(() => { modeGeneration.current++; setSwitchingMode(false); setModeError(undefined); setLocalMode("markdown"); return () => { modeGeneration.current++; }; }, [data, filePath]);
  const switchMode = async () => {
    if (!filePath || switchingMode) return;
    const generation = ++modeGeneration.current, owner = modeOwner.current;
    setSwitchingMode(true); setModeError(undefined);
    try {
      const saved = await data.saveUntilClean(filePath);
      if (modeGeneration.current !== generation || modeOwner.current.data !== owner.data || modeOwner.current.filePath !== owner.filePath || modeOwner.current.mode !== owner.mode) return;
      if (!saved) { setModeError("Save or resolve this file before switching views. Your edits are retained."); return; }
      const next = mode === "markdown" ? "source" : "markdown";
      setLocalMode(next); onFileModeChange?.(next);
    } catch (error) { if (modeGeneration.current === generation) setModeError(error instanceof Error ? error.message : "Could not save this file."); }
    finally { if (modeGeneration.current === generation) setSwitchingMode(false); }
  };

  const open = (path: string, options?: {preview?:boolean}) => { if (onOpenFile) onOpenFile(path,undefined,options); else void data.open(path); };
  const [folder, setFolder] = useState(data.directory);
  const [newPath, setNewPath] = useState("");
  const [adding, setAdding] = useState(false);
  const [locationNotice, setLocationNotice] = useState<{ id: string; path: string; message: string }>();
  const document = opened ? data.documents.get(opened) : undefined;
  const entries = data.directories.get(data.directory);
  const editable = document && (!document.content || document.content.kind === "text");
  useEffect(() => { setFolder(data.directory); }, [data.directory]);
  const fileError = opened && data.errors[`file:${opened}`];
  const readingLinkedFile = Boolean(opened && data.loading.has(`file:${opened}`));
  const symbolReveal = navigation.pending?.request;
  const suppressedFileReveal = useRef<string | undefined>(undefined);
  const revealRequest = active && data.restored && !readingLinkedFile && (!fileError || !data.connected && editable)
    ? symbolReveal?.path === opened ? symbolReveal : opened === fileRequest?.path && fileRequest?.id !== suppressedFileReveal.current ? fileRequest : undefined : undefined;
  return <div className="files-view" hidden={!active}>
    {!filePath && <section className="file-browser" aria-label="Workspace directory">
      <form className="workspace-path-form" onSubmit={event => { event.preventDefault(); void data.list(folder || "."); }}><label className="sr-only" htmlFor="workspace-directory">Directory relative to workspace</label><input id="workspace-directory" value={folder} onChange={event => setFolder(event.target.value)} autoComplete="off"/><button disabled={!data.connected}>Go</button><button type="button" title="New file" aria-label="New file" className="icon-button small" disabled={!data.restored} onClick={() => setAdding(value => !value)}><Icon name="plus"/></button></form>
      {adding && <form className="workspace-path-form" onSubmit={event => { event.preventDefault(); data.newFile(newPath); if (data.opened === newPath) { onOpenFile?.(newPath,undefined,{preview:false}); setAdding(false); setNewPath(""); } }}><input aria-label="New file relative path" placeholder="folder/file.txt" value={newPath} onChange={event => setNewPath(event.target.value)} autoFocus/><button disabled={!newPath.trim()}>Create buffer</button></form>}
      {data.errors[`files:${data.directory}`] && <p className="workspace-notice" role="alert">{data.errors[`files:${data.directory}`]}</p>}
      <div className="file-entries">{data.directory !== "." && <button className="file-entry" onClick={() => void data.list(data.directory.split("/").slice(0, -1).join("/") || ".")}><Icon name="folder"/><span>..</span></button>}{entries?.map(entry => <div className={`file-entry-row ${entry.path === opened ? "selected" : ""}`} key={entry.path}><button className="file-entry" title={entry.linkTarget ? `${entry.linkTarget} (${entry.linkState})` : entry.path} disabled={entry.kind === "other" || entry.kind === "symlink" && entry.linkState !== "inside"} onClick={() => entry.kind === "directory" ? void data.list(entry.path) : open(entry.path)}><Icon name={entry.kind === "directory" ? "folder" : "compose"}/><span className="truncate">{entry.name}</span>{data.documents.get(entry.path)?.dirty && <span aria-label="Unsaved edits">•</span>}<small>{entry.kind === "symlink" ? `Link · ${entry.linkState}` : entry.kind === "file" ? size(entry.size) : ""}</small></button>{entry.kind === "symlink" && entry.linkState === "inside" && <button title="Browse this link as a directory" onClick={() => void data.list(entry.path)}>Browse</button>}</div>)}{entries?.length === 0 && <p className="workspace-notice">This directory is empty.</p>}{!entries && <p className="workspace-notice">{data.loading.has(`files:${data.directory}`) ? "Loading directory…" : "No directory listing is cached."}</p>}</div>
    </section>}
    <section className="file-editor" aria-label="File editor">
      {!filePath && data.documents.size > 0 && <div className="editor-tabs">{[...data.documents].map(([path, item]) => <button className={path === opened ? "selected" : ""} key={path} title={path} onClick={() => open(path)}>{path.split("/").at(-1)}{item.dirty ? " •" : ""}</button>)}</div>}
      {!opened ? <div className="workspace-empty"><Icon name="compose"/><p>Select a file to read or edit.</p></div> : <>
        <div className={`editor-toolbar ${filePath ? "workspace-file-toolbar" : ""}`}>{filePath && !data.standalonePath ? <WorkspaceFileBreadcrumbs data={data} filePath={filePath} workspaceName={workspaceName} active={active} onOpenFile={open}/> : <span className="truncate" title={data.standalonePath??opened}>{opened}</span>}{markdownFile && <button type="button" className="workspace-markdown-mode" disabled={switchingMode || !document || !editable} onClick={() => void switchMode()}>{mode === "markdown" ? "View source" : "View preview"}</button>}{filePath && !data.standalonePath && <button type="button" className="icon-button file-tree-toggle" aria-label="Toggle file tree" title="Toggle file tree" aria-pressed={tree.open} onClick={() => changeTree({ ...tree, open: !tree.open })}><Icon name="fileTree"/></button>}{filePath && <WorkspaceFileOpen key={`${data.cacheKey}:${filePath}`} data={data} path={filePath} active={active} disabled={disabled}/>}{!filePath && <button className="secondary-button" disabled={disabled || !document?.dirty || document.conflict !== undefined || !editable} onClick={() => void data.saveFile(opened!)}>Save <kbd>⌘S</kbd></button>}</div>
      </>}
      <div className="workspace-file-body" hidden={!opened}><div className={`workspace-file-main ${markdownFile ? "workspace-markdown-main" : ""}`}>
      {gitFile && <WorkspaceGitFilePanel key={`${data.cacheKey}:${opened}`} state={gitFile} active={active}/>}
      {opened && <>
        {fileError && <p className="workspace-notice" role="alert">{fileError}</p>}{modeError && <p className="workspace-notice" role="alert">{modeError}</p>}
        {locationNotice?.path === opened && locationNotice?.id === fileRequest?.id && <p className="workspace-notice" role="status">{locationNotice.message}</p>}
        {document?.conflict !== undefined && <div className="file-conflict"><strong>The host file changed.</strong><details><summary>View host version</summary><pre>{document.conflict?.kind === "text" ? document.conflict.text : document.conflict ? `File is ${document.conflict.kind}` : "The file no longer exists."}</pre></details><div><button className="secondary-button" onClick={() => data.resolve(opened!, "remote")}>Use host version</button><button className="primary-button" onClick={() => data.resolve(opened!, "local")}>Keep my edits for next save</button></div></div>}
        {document?.recoveredText !== undefined && <details className="editor-recovery"><summary>Previous local buffer retained</summary><pre>{document.recoveredText}</pre><button onClick={() => edit(opened!, document.recoveredText!, true)}>Restore this text into editor</button></details>}
        {!document ? <p className="workspace-notice">{data.loading.has(`file:${opened}`) ? "Loading file…" : "No file content is cached."}</p> : editable ? null : <div className="workspace-empty"><p>{document.content?.kind === "binary" ? "This is a binary file. Text editing is unavailable." : document.content?.kind === "too-large" ? `This file is ${size(document.content.size)}; the host text editor limit is ${size(document.content.maximumBytes)}.` : document.content?.kind === "unsupported-encoding" ? `${document.content.encoding} editing is not supported. The original file is unchanged.` : "No text to display."}</p></div>}
      </>}
      {markdownFile && document && editable && <div className="workspace-markdown-actions"><MarkdownCopyButton key={`${data.cacheKey}:${filePath}`} text={document.text}/></div>}
      {/* Keep each open file's native history and selection while another tab is visible. */}
      {markdownFile && document && editable && <RichMarkdownEditor documentKey={`${data.cacheKey}:${filePath}:markdown`} value={document.text} label={`Edit Markdown ${filePath}`} active={active && mode === "markdown" && !gitFile?.selected} revealRequest={revealRequest} onReveal={(id, error) => setLocationNotice(error ? { id, path: filePath!, message: error } : undefined)}
        onAddToChat={onAddToChat ? selection => onAddToChat(filePath!, selection) : undefined} imageGeneration={data.imageGeneration}
        resolveImage={href => { const path = markdownImagePath(href, markdownPath, markdownRoot); return path === null ? null : { key: `${data.cacheKey}:${data.imageGeneration}:${path}`, load: () => data.acquireImage(data.standalonePath ? `/${path}` : path) }; }}
        openLink={async href => {
          const link = resolveMarkdownLink(href, markdownPath, markdownRoot);
          if (link.kind === "unavailable") throw new Error(link.reason);
          if (link.kind === "external") { if (!openExternal) throw new Error("The browser opener is unavailable."); await openExternal(link.url); return; }
          if (link.kind === "fragment") throw new Error("This document anchor is unavailable.");
          if (!onOpenFile) throw new Error("The owning workspace file opener is unavailable.");
          const { path, ...location } = link.file; onOpenFile(data.standalonePath ? `/${path}` : path, location);
        }} onChange={text => edit(filePath!, text, true)} onSave={() => { if (!disabled) void data.saveFile(filePath!); }}/>}
      <div className="workspace-source-editors" hidden={!editable || mode === "markdown"}>
        {[...data.documents].filter(([path, item]) => (!filePath || path === filePath) && (!item.content || item.content.kind === "text")).map(([path, item]) =>
          <PierreSourceEditor key={path} documentKey={`${data.cacheKey}:${path}`} name={path} value={item.text}
            gitBlame={opened === path ? gitFile?.blame : undefined}
            onAddToChat={onAddToChat ? selection => onAddToChat(path, selection) : undefined} label={`Edit ${path}`} active={active && opened === path && mode === "source" && !gitFile?.selected}
            symbolNavigation={{ navigation, path, open: location => {
              if (onOpenFile) onOpenFile(location.path, undefined, { preview: false });
              else void data.open(location.path);
            } }}
            onChange={text => edit(path, text, true)} onSave={() => { if (!disabled) void data.saveFile(path); }}
            revealRequest={opened === path ? revealRequest : undefined}
            onReveal={(id, error) => {
              if (navigation.pending?.request.id === id) { suppressedFileReveal.current = fileRequest?.id; navigation.revealed(id, error); return; }
              if (opened !== path || fileRequest?.id !== id) return;
              const message = error ?? (item.dirty && fileRequest.line !== undefined ? `File link opened at line ${fileRequest.line} in your unsaved buffer.` : undefined);
              setLocationNotice(message ? { id, path, message } : undefined);
            }}/>
        )}
      </div>
      {document && !filePath && <footer className="editor-status">{document.dirty ? "Unsaved edits" : "Host version"}{document.content?.kind === "text" ? ` · UTF-8${document.content.bom ? " with BOM" : ""}` : ""}{!data.connected ? " · Offline cache" : ""}</footer>}
      {filePath && document && <div className="workspace-file-save-status" role="status">
        {data.busy && data.pending?.envelope.command.action.type === "file.write" && data.pending.envelope.command.action.path === filePath
          ? <span><Icon name="refresh"/>Saving…</span> : document.saveError ? <button title={document.saveError} disabled={disabled || document.conflict !== undefined} onClick={() => void data.saveFile(filePath)}>Save failed</button> : null}
      </div>}
      </div>{filePath && !data.standalonePath && <WorkspaceFileTreePane cwd={workspacePath} onAddFile={onAddFile} data={data} filePath={filePath} active={active} view={tree} onChange={changeTree} onOpenFile={open}/>}</div>
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
