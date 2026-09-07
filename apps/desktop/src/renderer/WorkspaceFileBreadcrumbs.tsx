import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons";
import type { WorkspaceState } from "./workspace-state";
import "./workspace-file-breadcrumbs.css";

/** Every picker read and file selection stays on this tab's owning workspace. */
export function WorkspaceFileBreadcrumbs({ data, filePath, workspaceName, active, onOpenFile }: {
  data: WorkspaceState; filePath: string; workspaceName: string; active: boolean; onOpenFile(path: string): void;
}) {
  const [directory, setDirectory] = useState<string>();
  const [anchorIndex, setAnchorIndex] = useState<number>();
  const [position, setPosition] = useState<CSSProperties>();
  const trigger = useRef<HTMLButtonElement | null>(null), menu = useRef<HTMLDivElement>(null);
  const close = (restore = true) => { setDirectory(undefined); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (!active) close(false); }, [active]);
  useEffect(() => { setDirectory(undefined); }, [data, filePath]);
  useLayoutEffect(() => {
    if (directory === undefined || !trigger.current) return;
    const anchor = trigger.current;
    const measure = () => {
      const rect = anchor.getBoundingClientRect(), width = Math.min(384, innerWidth - 16);
      setPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - width - 8)), top: rect.bottom + 1, width, height: Math.max(40, Math.min(320, innerHeight - rect.bottom - 9)) });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(anchor);
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) close(false); };
    const dismiss = () => close(false);
    addEventListener("pointerdown", outside); addEventListener("resize", dismiss);
    return () => { observer.disconnect(); removeEventListener("pointerdown", outside); removeEventListener("resize", dismiss); };
  }, [directory, anchorIndex]);
  useEffect(() => {
    if (directory === undefined || !position) return;
    menu.current?.focus({ preventScroll: true });
  }, [directory, anchorIndex, Boolean(position)]);
  const parts = filePath.split("/"), segments = [
    { label: workspaceName, directory: "." },
    ...parts.map((label, index) => ({ label, directory: parts.slice(0, index === parts.length - 1 ? index : index + 1).join("/") || "." })),
  ];
  const entries = directory === undefined ? undefined : data.directories.get(directory);
  return <nav className="workspace-file-breadcrumbs" aria-label="File path">
    {segments.map((segment, index) => <span key={index}>
      {index > 0 && <Icon name="chevron"/>}
      <button type="button" aria-haspopup="menu" aria-expanded={directory !== undefined && anchorIndex === index} data-breadcrumb-index={index}
        title={index === 0 ? workspaceName : parts.slice(0, index).join("/")}
        onClick={event => {
          if (trigger.current === event.currentTarget && directory !== undefined) { close(); return; }
          trigger.current = event.currentTarget; setAnchorIndex(index); setDirectory(segment.directory); void data.readDirectory(segment.directory);
        }}>{segment.label}</button>
    </span>)}
    {directory !== undefined && position && active && createPortal(<div ref={menu} style={position} className="workspace-file-picker" role="menu" aria-label="Files in folder" tabIndex={-1}
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key === "Tab") { close(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
        if (!items.length) return;
        event.preventDefault(); const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : at < 0 ? event.key === "ArrowUp" ? items.length - 1 : 0 : (at + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      {data.errors[`files:${directory}`] && <p role="alert">{data.errors[`files:${directory}`]}{data.connected && <button role="menuitem" onClick={() => void data.readDirectory(directory)}>Retry</button>}</p>}
      {!entries ? !data.errors[`files:${directory}`] && <p>{data.loading.has(`files:${directory}`) ? "Loading folder…" : "This folder is not cached."}</p> : !entries.length ? <p>This folder is empty.</p> : entries.map(entry =>
        <button key={entry.path} type="button" role="menuitem" disabled={entry.kind === "other" || entry.kind === "symlink" && entry.linkState !== "inside"}
          onClick={() => { if (entry.kind === "directory") { setDirectory(entry.path); void data.readDirectory(entry.path); } else { close(); onOpenFile(entry.path); } }}>
          <Icon name={entry.kind === "directory" ? "folder" : "compose"}/><span>{entry.name}</span>{entry.path === filePath && <Icon name="check"/>}
        </button>)}
    </div>, document.body)}
  </nav>;
}
