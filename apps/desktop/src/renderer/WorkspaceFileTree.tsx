import {WorkspaceTreeMenu,type TreeMenuTarget} from "./WorkspaceTreeMenu";
import { TreeFileIcon } from "./TreeFileIcon";
import { WorkspaceFileName } from "./WorkspaceFileName";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./Icons";
import { isWorkspaceFilePath } from "./dock-state";
import type { WorkspaceState } from "./workspace-state";
import { getWorkspaceFileTreeState } from "./workspace-file-tree-state";
import { fileTreeSearchRows, type FileTreeRow as TreeRow } from "./workspace-file-tree-search";
import "./workspace-file-tree.css";


const supportedFile = (entry: TreeRow["entry"]) =>
  entry.kind === "file" || entry.kind === "symlink" && entry.linkState === "inside";

/** Owner-bound workspace navigation. It reads directories through WorkspaceState so
 * cached/offline behavior and host ownership remain identical to the editor. */
export function WorkspaceFileTree({ data, filePath = "", active, initialDirectory = ".", showFilter = true, autoFocusSearch = false, onOpenFile, cwd, onAddFile }: {
  data: WorkspaceState;
  cwd?:string;
  onAddFile?(path:string):void;
  filePath?: string;
  active: boolean;
  initialDirectory?: string;
  showFilter?: boolean;
  autoFocusSearch?: boolean;
  onOpenFile(path: string, options?: {preview?:boolean}): void;
}) {
  const [context,setContext]=useState<TreeMenuTarget>();
  const closeContext=(restore=true)=>{if(restore&&context?.anchor.isConnected)context.anchor.focus({preventScroll:true});setContext(undefined)};
  useEffect(()=>{setContext(undefined)},[active,data,cwd]);
  const showContext=(anchor:HTMLElement,path:string,kind:TreeMenuTarget["kind"],x?:number,y?:number)=>{const r=anchor.getBoundingClientRect();setContext({anchor,path,kind,x:x??r.left+16,y:y??r.bottom});};
  const safeInitialDirectory = initialDirectory === "." || isWorkspaceFilePath(initialDirectory) ? initialDirectory : ".";
  const [revision, changed] = useReducer((value: number) => value + 1, 0);
  const state = useMemo(() => getWorkspaceFileTreeState(data, cwd ?? "."), [data, cwd]);
  const view = useRef({}).current;
  const snapshot = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  const filter = snapshot.query, expanded = snapshot.expandedPaths;
  const [searchRetry, setSearchRetry] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const restoredScroll = useRef<{ element: HTMLDivElement; top: number } | undefined>(undefined);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const filterInput = useRef<HTMLInputElement>(null), autoFocusedSearch = useRef(false);
  const activeRef = useRef(active), mounted = useRef(false), focusFrame = useRef<number | undefined>(undefined);
  activeRef.current = active;

  useEffect(() => data.subscribe(changed), [data]);
  useLayoutEffect(() => {
    if (active) return state.activate(view);
  }, [active, state, view]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
    };
  }, []);
  useLayoutEffect(() => {
    if (active) state.reveal(view, filePath, safeInitialDirectory);
  }, [active, state, view, filePath, safeInitialDirectory]);
  useEffect(() => {
    if (!active || !autoFocusSearch || !showFilter || autoFocusedSearch.current) return;
    const element = filterInput.current;
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      if (!element.isConnected) return;
      autoFocusedSearch.current = true;
      element.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active, autoFocusSearch, showFilter]);

  useEffect(() => {
    if (!active || !data.connected) return;
    for (const directory of [".", ...expanded]) {
      if ((!data.directories.has(directory) || data.errors[`files:${directory}`]) && !data.loading.has(`files:${directory}`))
        void data.readDirectory(directory);
    }
  }, [active, data, data.connected, expanded]);

  const query = showFilter ? filter.trim() : "";
  useEffect(() => {
    if (!active || !query || !data.connected) return;
    let current = true;
    const request = state.beginSearch(view, filter);
    // Match WorkspaceFileSearch: bound native work and fence uncancellable replies.
    const timer = setTimeout(() => {
      void data.query({ type: "files.search", query, limit: 50 }).then(value => {
        if (value.type !== "files.search") throw new Error("The host returned the wrong file search response.");
        if (current) request.resolve(value);
      }).catch(cause => { if (current) request.reject(cause); });
    }, 150);
    return () => { current = false; clearTimeout(timer); request.cancel(); };
  }, [active, data, data.connected, state, view, filter, query, searchRetry]);
  const searchResult = query && data.connected ? state.searchResult(filter) : undefined;
  const searchError = query && data.connected && snapshot.searchError?.query === filter ? snapshot.searchError.message : undefined;
  const searching = Boolean(query && data.connected && !searchResult && !searchError);

  const rows = useMemo(() => {
    if (query) return fileTreeSearchRows(searchResult?.entries ?? [], snapshot.collapsedSearchPaths);
    const result: TreeRow[] = [];
    const visit = (directory: string, level: number) => {
      for (const entry of data.directories.get(directory) ?? []) {
        const isDirectory = entry.kind === "directory";
        const isExpanded = isDirectory && expanded.has(entry.path);
        result.push({
          entry,
          level,
          parent: directory === "." ? undefined : directory,
          expanded: isExpanded,
          loading: isDirectory && data.loading.has(`files:${entry.path}`),
          error: isDirectory ? data.errors[`files:${entry.path}`] : undefined,
        });
        if (isExpanded) visit(entry.path, level + 1);
      }
    };
    visit(".", 1);
    return result;
  }, [data, expanded, query, searchResult, snapshot.collapsedSearchPaths, revision]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!active || !element || !state.isActive(view)) return;
    const retained = state.getSnapshot();
    element.scrollTop = query ? retained.searchScrollTop : retained.scrollTop;
    // A partially loaded directory can clamp restoration. Do not save that
    // programmatic clamp; retry as rows arrive, until the user actually scrolls.
    restoredScroll.current = { element, top: element.scrollTop };
  }, [active, state, view, query, filter, rows]);

  const toggle = (row: TreeRow, force?: boolean) => {
    if (!active || !state.isActive(view)) return;
    if (force === undefined) state.select(view, row.entry.path);
    if (row.entry.kind !== "directory") { if (supportedFile(row.entry)) onOpenFile(row.entry.path,{preview:true}); return; }
    state.toggleDirectory(view, row.entry.path, force, Boolean(query));
  };
  const focusRow = (path: string) => {
    if (!active || !state.isActive(view)) return;
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = undefined;
      if (!mounted.current || !activeRef.current || !state.isActive(view)) return;
      const element = rowElements.current.get(path);
      if (!element?.isConnected) return;
      element.scrollIntoView({ block: "nearest" });
      if (mounted.current && activeRef.current && element.isConnected) element.focus({ preventScroll: true });
    });
  };
  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: TreeRow, index: number) => {
    if((event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey)&&cwd&&row.entry.kind!=="other"){event.preventDefault();event.stopPropagation();showContext(event.currentTarget,row.entry.path,row.entry.kind);return;}
    let destination: TreeRow | undefined;
    if (event.key === "ArrowDown") destination = rows[index + 1];
    else if (event.key === "ArrowUp") destination = rows[index - 1];
    else if (event.key === "Home") destination = rows[0];
    else if (event.key === "End") destination = rows.at(-1);
    else if (event.key === "ArrowRight") {
      if (row.entry.kind === "directory" && !row.expanded) toggle(row, true);
      else destination = rows[index + 1];
    } else if (event.key === "ArrowLeft") {
      if (row.entry.kind === "directory" && row.expanded) toggle(row, false);
      else destination = row.parent ? rows.find(candidate => candidate.entry.path === row.parent) : undefined;
    } else if (event.key === "Enter" || event.key === " ") toggle(row);
    else return;
    event.preventDefault();
    event.stopPropagation();
    if (destination) focusRow(destination.entry.path);
  };

  const rootError = data.errors["files:."];
  const expandedError = rows.find(row => row.error)?.error;
  const uncachedExpanded = !data.connected && data.directories.has(".")
    ? rows.find(row => row.entry.kind === "directory" && row.expanded && !data.directories.has(row.entry.path))
    : undefined;
  return <section data-tab-preview-pin-exempt className="workspace-file-tree-shell" aria-label="Workspace files">
    {showFilter && <div className="workspace-file-tree-toolbar"><label className="workspace-file-tree-filter">
      <span className="sr-only">Filter files</span><Icon name="search"/>
      <input ref={filterInput} value={filter} disabled={!active} placeholder="Filter files…" maxLength={512} onChange={event => state.setQuery(view, event.target.value)} />
      {filter && <button type="button" aria-label="Clear file filter" disabled={!active} onClick={() => state.setQuery(view, "")}><Icon name="close"/></button>}
    </label>{cwd&&<button type="button" className="workspace-file-tree-actions" aria-label="Workspace file actions" disabled={!active} onClick={event=>showContext(event.currentTarget,".","root")}><Icon name="more"/></button>}</div>}
    <div ref={scroller} className="workspace-file-tree" role="tree" aria-label="Files" aria-busy={query ? searching : data.loading.has("files:.") || !data.directories.has(".") && data.connected && !rootError} tabIndex={active ? 0 : -1}
      onScroll={event => {
        if (!active || !state.isActive(view)) return;
        const element = event.currentTarget, restored = restoredScroll.current;
        if (restored?.element === element && restored.top === element.scrollTop) return;
        restoredScroll.current = undefined;
        state.setScrollTop(view, element.scrollTop, Boolean(query));
      }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || !rows.length) return;
        const destination = event.key === "ArrowUp" || event.key === "End" ? rows.at(-1) : event.key === "ArrowDown" || event.key === "Home" || event.key === "ArrowRight" ? rows[0] : undefined;
        if (!destination) return;
        event.preventDefault();
        event.stopPropagation();
        focusRow(destination.entry.path);
      }}>
      {renderTreeBranches(rows, (row, index) => {
        const disabled = row.entry.kind === "other" || row.entry.kind === "symlink" && row.entry.linkState !== "inside";
        return <div key={row.entry.path} ref={element => { if (element) rowElements.current.set(row.entry.path, element); else rowElements.current.delete(row.entry.path); }}
          role="treeitem" aria-label={row.entry.name} aria-level={row.level} aria-selected={row.entry.path === snapshot.selectedPath} aria-expanded={row.entry.kind === "directory" ? row.expanded : undefined}
          aria-disabled={disabled || undefined} tabIndex={-1}
          className={`workspace-file-tree-row${row.entry.path === snapshot.selectedPath ? " selected" : ""}${disabled ? " disabled" : ""}`}
          style={{ "--tree-level": row.level } as CSSProperties} title={row.entry.path}
          onContextMenu={event=>{if(cwd&&row.entry.kind!=="other"){event.preventDefault();event.stopPropagation();showContext(event.currentTarget,row.entry.path,row.entry.kind,event.clientX,event.clientY)}}}
          onKeyDown={event => onRowKeyDown(event, row, index)} onClick={() => { if (!disabled) toggle(row); }} onDoubleClick={() => { if (active && state.isActive(view) && !disabled && row.entry.kind !== "directory" && supportedFile(row.entry)) onOpenFile(row.entry.path,{preview:false}); }}>
          {row.level > 1 && <span className="workspace-file-tree-spacing" aria-hidden="true">{Array.from({length:row.level-1},(_,index)=><i key={index}/>)}</span>}
          <span className="workspace-file-tree-icon"><TreeFileIcon path={row.entry.path} folder={row.entry.kind === "directory"} expanded={row.expanded}/></span><span className="workspace-file-tree-name"><WorkspaceFileName name={row.entry.name}/></span>
          {row.loading && <span className="workspace-file-tree-progress" aria-label="Loading"/>}
        </div>;
      })}
      {query ? !rows.length && !searchError && <p className="workspace-file-tree-empty" role="status">{!data.connected ? "Reconnect to search files on this host." : searching ? "Searching files…" : "No matching files."}</p>
        : !rows.length && !rootError && <p className="workspace-file-tree-empty" role="status">{data.loading.has("files:.") || !data.directories.has(".") && data.connected ? "Loading directory entries…" : data.directories.has(".") ? "This workspace is empty." : "Workspace files are unavailable offline. This tree is incomplete."}</p>}
    </div>
    {searchError && <div className="workspace-file-tree-status error" role="alert"><span>{searchError}</span>{active && <button type="button" onClick={() => setSearchRetry(value => value + 1)}>Try again</button>}</div>}
    {searchResult?.status === "truncated" && <p className="workspace-file-tree-status" role="status">More matches available. Refine your search.</p>}
    {!query && uncachedExpanded && <p className="workspace-file-tree-status" role="status">Folder contents for {uncachedExpanded.entry.path} are unavailable offline. This tree is incomplete.</p>}
    {!query && (rootError || expandedError) && <div className="workspace-file-tree-status error" role="alert"><span>{rootError ?? expandedError}</span>{active && data.connected && <button type="button" onClick={() => {
      if (rootError) void data.readDirectory(".");
      else { const failed = rows.find(row => row.error); if (failed) void data.readDirectory(failed.entry.path); }
    }}>Retry</button>}</div>}
    {context&&cwd&&active&&<WorkspaceTreeMenu key={`${data.cacheKey}:${context.path}:${context.x}:${context.y}`} data={data} cwd={cwd} target={context} onClose={closeContext} onAddFile={onAddFile} onOpenFile={onOpenFile}/>}
  </section>;
}


/** Real nested groups bound each sticky folder to its own descendants. */
function renderTreeBranches(rows: readonly TreeRow[], render: (row: TreeRow, index: number) => ReactNode): ReactNode[] {
  let cursor = 0;
  const level = (minimum: number): ReactNode[] => {
    const children: ReactNode[] = [];
    while (cursor < rows.length && rows[cursor]!.level >= minimum) {
      const index = cursor++, row = rows[index]!, node = render(row, index);
      const descendants = rows[cursor] && rows[cursor]!.level > row.level ? level(row.level + 1) : null;
      children.push(row.entry.kind === "directory"
        ? <div className="workspace-file-tree-branch" key={row.entry.path}>{node}{descendants}</div>
        : node);
    }
    return children;
  };
  return level(1);
}
