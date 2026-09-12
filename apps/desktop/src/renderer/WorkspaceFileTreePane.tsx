import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileTreeView } from "../window-state";
import type { WorkspaceState } from "./workspace-state";
import { WorkspaceFileTree } from "./WorkspaceFileTree";
import "./workspace-file-tree-pane.css";

import { fileTreeWidth, fileTreeResize } from "./file-tree-layout";

/** Presentation belongs to this window; entries remain owned by the workspace host. */
export function WorkspaceFileTreePane({ data, filePath, active, view, onChange, onOpenFile, cwd, onAddFile, autoFocusSearch }: {
  cwd?:string;onAddFile?(path:string):void;
  data: WorkspaceState; filePath?: string; active: boolean; view: FileTreeView;
  autoFocusSearch?: boolean;
  onChange(view: FileTreeView): void; onOpenFile(path: string, options?: {preview?:boolean}): void;
}) {
  const pane = useRef<HTMLElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const latest = useRef({ view, onChange }); latest.current = { view, onChange };
  const drag = useRef<{ pointer: number; start: FileTreeView } | undefined>(undefined);
  useLayoutEffect(() => {
    const container = pane.current?.parentElement; if (!container) return;
    const measure = () => setContainerWidth(container.getBoundingClientRect().width);
    const observer = new ResizeObserver(measure); observer.observe(container); measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (drag.current?.pointer !== event.pointerId) return;
      const bounds = pane.current?.parentElement?.getBoundingClientRect(); if (!bounds) return;
      latest.current.onChange(fileTreeResize(latest.current.view, bounds.right - event.clientX, bounds.width));
    };
    const finish = (event: PointerEvent) => { if (drag.current?.pointer === event.pointerId) drag.current = undefined; };
    const cancel = (event: PointerEvent) => {
      if (drag.current?.pointer !== event.pointerId) return;
      latest.current.onChange(drag.current.start); drag.current = undefined;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drag.current) return;
      event.preventDefault(); latest.current.onChange(drag.current.start); drag.current = undefined;
    };
    addEventListener("pointermove", move); addEventListener("pointerup", finish); addEventListener("pointercancel", cancel); addEventListener("keydown", escape);
    return () => { removeEventListener("pointermove", move); removeEventListener("pointerup", finish); removeEventListener("pointercancel", cancel); removeEventListener("keydown", escape); };
  }, []);
  useEffect(() => { if (!active) drag.current = undefined; }, [active]);
  const width = fileTreeWidth(view.width, containerWidth);
  return <aside data-tab-preview-pin-exempt ref={pane} className="workspace-file-tree-pane" aria-label="Workspace file tree" hidden={!view.open} style={{ width }}>
    <div className="workspace-file-tree-resize" role="separator" aria-label="Resize file tree" aria-orientation="vertical" tabIndex={0}
      aria-valuemin={Math.min(200, containerWidth * .6)} aria-valuemax={containerWidth * .6} aria-valuenow={Math.min(width, containerWidth * .6)}
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); drag.current = { pointer: event.pointerId, start: view }; }}
      onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 200 : event.key === "End" ? containerWidth * .6 : width + (event.key === "ArrowLeft" ? 16 : -16);
        onChange({ open: true, width: fileTreeWidth(next, containerWidth) });
      }}/>
    <WorkspaceFileTree cwd={cwd} onAddFile={onAddFile} data={data} filePath={filePath} active={active && view.open} autoFocusSearch={autoFocusSearch} onOpenFile={onOpenFile}/>
  </aside>;
}
