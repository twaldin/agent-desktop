import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { WorkspaceEntry } from "@agent-desktop/shared";
import { Icon } from "./Icons";
import { isWorkspaceFilePath } from "./dock-state";
import type { WorkspaceState } from "./workspace-state";
import "./workspace-file-tree.css";

interface TreeRow {
  entry: WorkspaceEntry;
  level: number;
  parent?: string;
  expanded: boolean;
  loading: boolean;
  error?: string;
}

type ScanState =
  | { kind: "idle" }
  | { kind: "scanning"; directories: number }
  | { kind: "complete" }
  | { kind: "incomplete"; errors: string[]; offline: boolean };

const parentPath = (path: string) => {
  const at = path.lastIndexOf("/");
  return at < 0 ? "." : path.slice(0, at);
};

const directoryAncestors = (path: string, includeSelf: boolean) => {
  if (path === ".") return [];
  const parts = path.split("/"), result: string[] = [];
  const limit = includeSelf ? parts.length : parts.length - 1;
  for (let index = 1; index <= limit; index++) result.push(parts.slice(0, index).join("/"));
  return result;
};

const supportedFile = (entry: WorkspaceEntry) =>
  entry.kind === "file" || entry.kind === "symlink" && entry.linkState === "inside";

/** Owner-bound workspace navigation. It reads directories through WorkspaceState so
 * cached/offline behavior and host ownership remain identical to the editor. */
export function WorkspaceFileTree({ data, filePath, active, initialDirectory = ".", showFilter = true, onOpenFile }: {
  data: WorkspaceState;
  filePath: string;
  active: boolean;
  initialDirectory?: string;
  showFilter?: boolean;
  onOpenFile(path: string): void;
}) {
  const safeInitialDirectory = initialDirectory === "." || isWorkspaceFilePath(initialDirectory) ? initialDirectory : ".";
  const [revision, changed] = useReducer((value: number) => value + 1, 0);
  const [filter, setFilter] = useState("");
  const [scanRetry, setScanRetry] = useState(0);
  const [scan, setScan] = useState<ScanState>({ kind: "idle" });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([
    ...directoryAncestors(filePath, false),
    ...directoryAncestors(safeInitialDirectory, true),
  ]));
  const [focusedPath, setFocusedPath] = useState(filePath);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const activeRef = useRef(active), mounted = useRef(false), focusFrame = useRef<number | undefined>(undefined);
  activeRef.current = active;

  useEffect(() => data.subscribe(changed), [data]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
    };
  }, []);
  useEffect(() => {
    setExpanded(previous => new Set([
      ...previous,
      ...directoryAncestors(filePath, false),
      ...directoryAncestors(safeInitialDirectory, true),
    ]));
  }, [filePath, safeInitialDirectory]);

  useEffect(() => {
    if (!active || !data.connected) return;
    for (const directory of [".", ...expanded]) {
      if ((!data.directories.has(directory) || data.errors[`files:${directory}`]) && !data.loading.has(`files:${directory}`))
        void data.readDirectory(directory);
    }
  }, [active, data, data.connected, expanded]);

  const query = showFilter ? filter.trim().toLocaleLowerCase() : "";
  useEffect(() => {
    if (!active || !query) { setScan({ kind: "idle" }); return; }
    let cancelled = false;
    void (async () => {
      const queue = ["."], visited = new Set<string>(), errors: string[] = [];
      const offline = !data.connected;
      setScan({ kind: "scanning", directories: 0 });
      while (queue.length && !cancelled) {
        const directory = queue.shift()!;
        if (visited.has(directory)) continue;
        visited.add(directory);
        if (data.connected) {
          await data.readDirectory(directory);
          if (cancelled) return;
        }
        const entries = data.directories.get(directory);
        const error = data.errors[`files:${directory}`];
        if (error) errors.push(`${directory}: ${error}`);
        if (!entries) {
          if (!error && !offline) errors.push(`${directory}: Folder contents are unavailable.`);
          continue;
        }
        for (const entry of entries) if (entry.kind === "directory" && !visited.has(entry.path)) queue.push(entry.path);
        setScan({ kind: "scanning", directories: visited.size });
        if (visited.size % 32 === 0) {
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          if (cancelled) return;
        }
      }
      if (cancelled) return;
      setScan(errors.length || offline ? { kind: "incomplete", errors, offline } : { kind: "complete" });
    })();
    return () => { cancelled = true; };
  }, [active, data, data.connected, query, scanRetry]);

  const included = useMemo(() => {
    if (!query) return undefined;
    const paths = new Set<string>();
    for (const entries of data.directories.values()) for (const entry of entries) {
      if (!entry.name.toLocaleLowerCase().includes(query) && !entry.path.toLocaleLowerCase().includes(query)) continue;
      paths.add(entry.path);
      for (const ancestor of directoryAncestors(entry.path, false)) paths.add(ancestor);
    }
    return paths;
  }, [data, query, revision, scan]);

  const rows = useMemo(() => {
    const result: TreeRow[] = [];
    const visit = (directory: string, level: number) => {
      for (const entry of data.directories.get(directory) ?? []) {
        if (included && !included.has(entry.path)) continue;
        const isDirectory = entry.kind === "directory";
        const isExpanded = isDirectory && (Boolean(included) || expanded.has(entry.path));
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
  }, [data, expanded, included, revision, scan]);

  useEffect(() => {
    if (!rows.some(row => row.entry.path === focusedPath)) setFocusedPath(rows.find(row => row.entry.path === filePath)?.entry.path ?? rows[0]?.entry.path ?? "");
  }, [rows, filePath, focusedPath]);

  const toggle = (row: TreeRow, force?: boolean) => {
    if (row.entry.kind !== "directory") { if (supportedFile(row.entry)) onOpenFile(row.entry.path); return; }
    setExpanded(previous => {
      const next = new Set(previous), open = force ?? !next.has(row.entry.path);
      if (open) next.add(row.entry.path); else next.delete(row.entry.path);
      return next;
    });
  };
  const focusRow = (path: string) => {
    setFocusedPath(path);
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = undefined;
      if (!mounted.current || !activeRef.current) return;
      const element = rowElements.current.get(path);
      if (!element?.isConnected) return;
      element.scrollIntoView({ block: "nearest" });
      if (mounted.current && activeRef.current && element.isConnected) element.focus({ preventScroll: true });
    });
  };
  const onRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: TreeRow, index: number) => {
    let destination: TreeRow | undefined;
    if (event.key === "ArrowDown") destination = rows[index + 1];
    else if (event.key === "ArrowUp") destination = rows[index - 1];
    else if (event.key === "Home") destination = rows[0];
    else if (event.key === "End") destination = rows.at(-1);
    else if (event.key === "ArrowRight" && row.entry.kind === "directory") {
      if (!row.expanded) toggle(row, true);
      else destination = rows[index + 1]?.parent === row.entry.path ? rows[index + 1] : undefined;
    } else if (event.key === "ArrowLeft") {
      if (row.entry.kind === "directory" && row.expanded && !included) toggle(row, false);
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
  return <section className="workspace-file-tree-shell" aria-label="Workspace files">
    {showFilter && <label className="workspace-file-tree-filter">
      <span className="sr-only">Filter files</span><Icon name="search"/>
      <input value={filter} disabled={!active} placeholder="Filter files…" onChange={event => setFilter(event.target.value)} />
      {filter && <button type="button" aria-label="Clear file filter" disabled={!active} onClick={() => setFilter("")}><Icon name="close"/></button>}
    </label>}
    <div className="workspace-file-tree" role="tree" aria-label="Files" aria-busy={scan.kind === "scanning" || data.loading.has("files:.")} tabIndex={active ? 0 : -1}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || !rows.length) return;
        const destination = event.key === "ArrowUp" || event.key === "End" ? rows.at(-1) : event.key === "ArrowDown" || event.key === "Home" || event.key === "ArrowRight" ? rows[0] : undefined;
        if (!destination) return;
        event.preventDefault();
        event.stopPropagation();
        focusRow(destination.entry.path);
      }}>
      {rows.map((row, index) => {
        const disabled = row.entry.kind === "other" || row.entry.kind === "symlink" && row.entry.linkState !== "inside";
        return <div key={row.entry.path} ref={element => { if (element) rowElements.current.set(row.entry.path, element); else rowElements.current.delete(row.entry.path); }}
          role="treeitem" aria-level={row.level} aria-selected={row.entry.path === filePath} aria-expanded={row.entry.kind === "directory" ? row.expanded : undefined}
          aria-disabled={disabled || undefined} tabIndex={-1}
          className={`workspace-file-tree-row${row.entry.path === filePath ? " selected" : ""}${disabled ? " disabled" : ""}`}
          style={{ "--tree-level": row.level } as CSSProperties} title={row.entry.path}
          onFocus={() => setFocusedPath(row.entry.path)} onKeyDown={event => onRowKeyDown(event, row, index)} onClick={() => { if (!disabled) toggle(row); }}>
          <span className={`workspace-file-tree-chevron${row.expanded ? " expanded" : ""}`}>{row.entry.kind === "directory" && <Icon name="chevron"/>}</span>
          <Icon name={row.entry.kind === "directory" ? "folder" : "compose"}/><span className="workspace-file-tree-name">{row.entry.name}</span>
          {row.loading && <span className="workspace-file-tree-progress" aria-label="Loading"/>}
        </div>;
      })}
      {!rows.length && !rootError && !data.loading.has("files:.") && <p className="workspace-file-tree-empty">{query ? scan.kind === "scanning" ? "Scanning workspace…" : "No matching files." : data.directories.has(".") ? "This workspace is empty." : data.connected ? "Workspace files are not loaded." : "Workspace files are unavailable offline. This tree is incomplete."}</p>}
    </div>
    {scan.kind === "scanning" && <p className="workspace-file-tree-status" role="status">Scanning workspace… {scan.directories} {scan.directories === 1 ? "folder" : "folders"}</p>}
    {scan.kind === "incomplete" && <div className="workspace-file-tree-status error" role="alert">
      <span>{scan.offline ? "Search is incomplete while this host is offline." : "Search is incomplete because some folders could not be read."}</span>
      {scan.errors[0] && <span>{scan.errors[0]}</span>}
      {active && data.connected && <button type="button" onClick={() => setScanRetry(value => value + 1)}>Retry scan</button>}
    </div>}
    {!query && uncachedExpanded && <p className="workspace-file-tree-status" role="status">Folder contents for {uncachedExpanded.entry.path} are unavailable offline. This tree is incomplete.</p>}
    {!query && (rootError || expandedError) && <div className="workspace-file-tree-status error" role="alert"><span>{rootError ?? expandedError}</span>{active && data.connected && <button type="button" onClick={() => {
      if (rootError) void data.readDirectory(".");
      else { const failed = rows.find(row => row.error); if (failed) void data.readDirectory(failed.entry.path); }
    }}>Retry</button>}</div>}
  </section>;
}
