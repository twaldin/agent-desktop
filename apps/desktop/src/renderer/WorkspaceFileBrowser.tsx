import { useEffect, useLayoutEffect, useReducer, useRef } from "react";
import type { FileTreeView } from "../window-state";
import type { WorkspaceState } from "./workspace-state";
import { retainWorkspace } from "./workspace-lease";
import { WorkspaceFileTreePane } from "./WorkspaceFileTreePane";
import { Icon } from "./Icons";
import "./workspace-file-browser.css";

/** The pointer Files action is an empty file tab with a workspace tree.
 * Command-P's search overlay is a separate entry point. */
export function WorkspaceFileBrowser({ data, connected, active, cwd, view, onChange, onOpenFile, onAddFile }: {
  data: WorkspaceState; connected: boolean; active: boolean; cwd: string;
  view: FileTreeView; onChange(view: FileTreeView): void;
  onOpenFile(path: string): void; onAddFile?(path: string): void;
}) {
  const [, redraw] = useReducer(value => value + 1, 0);
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (!active || opened.current) return;
    opened.current = true;
    if (!view.open) onChange({ ...view, open: true });
  }, [active, view, onChange]);
  useEffect(() => {
    const off = data.subscribe(redraw), release = retainWorkspace(data);
    void data.restore();
    return () => { off(); release(); };
  }, [data]);
  useEffect(() => { data.setConnected(connected); }, [data, connected]);
  return <section className="workspace-file-browser" aria-label="Open file">
    <div className="editor-toolbar workspace-file-toolbar workspace-file-browser-toolbar">
      <button type="button" className="icon-button file-tree-toggle" aria-label="Toggle file tree" title="Toggle file tree" aria-pressed={view.open}
        onClick={() => onChange({ ...view, open: !view.open })}><Icon name="fileTree"/></button>
    </div>
    {data.cacheWarning && <p className="workspace-notice" role="alert">{data.cacheWarning}</p>}
    {!connected && <p className="workspace-notice">Offline · displaying cached workspace files.</p>}
    <div className="workspace-file-body">
      <div className="workspace-file-browser-empty"><div>
        <Icon name="fileTree"/><div><h2>Open file</h2><p>Select a file from the workspace tree</p></div>
      </div></div>
      <WorkspaceFileTreePane data={data} active={active && data.restored} autoFocusSearch cwd={cwd} view={view} onChange={onChange} onOpenFile={onOpenFile} onAddFile={onAddFile}/>
    </div>
  </section>;
}
