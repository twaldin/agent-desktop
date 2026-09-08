import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceQueryResult } from "@agent-desktop/shared";
import "./workspace-file-open.css";
type FileOpenOptions = Extract<WorkspaceQueryResult, {type:"file.open-options"}>;
import { Icon } from "./Icons";
import { TranscriptMarkdownContext } from "./MarkdownText";
import type { WorkspaceFileLink } from "./transcript-links";
import "./transcript-file-reference.css";

export interface TranscriptFileReferenceProps {
  /** Literal native file path. It is never parsed as a URL or line location. */
  path: string;
  /** Native display label, when the record supplied one. */
  label?: string;
}

type Resolution = { file: WorkspaceFileLink } | { error: string };

function absolutePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/**
 * Native file references are paths, not Markdown hrefs. In particular `%`,
 * `#`, `?`, `:` and spaces remain literal filename characters.
 */
export function resolveTranscriptFileReference(path: string, cwd?: string): Resolution {
  if (typeof path !== "string" || !path || path.length > 32_768 || /[\x00-\x1f\x7f\\]/.test(path)) return { error: "This native file reference has an invalid path." };
  if (path.startsWith("//")) return { error: "This native file reference names another host." };
  if (!cwd?.startsWith("/")) return { error: "This file reference has no owning workspace." };
  const root = absolutePath(cwd), resolved = absolutePath(path.startsWith("/") ? path : `${root}/${path}`);
  if (resolved === root || root !== "/" && !resolved.startsWith(`${root}/`)) return { error: "This file reference is outside the owning workspace." };
  return { file: { path: resolved.slice(root === "/" ? 1 : root.length + 1) } };
}

export function TranscriptFileReference({ path, label }: TranscriptFileReferenceProps) {
  const { actions } = useContext(TranscriptMarkdownContext);
  const target = resolveTranscriptFileReference(path, actions?.cwd), text = label?.trim() || path;
  if ("error" in target) return <span className="transcript-file-reference unavailable" title={target.error}>{text}<span className="sr-only"> ({target.error})</span></span>;
  return <FileReferenceControl key={`${actions?.ownerKey ?? actions?.cwd}:${path}`} file={target.file} title={path}>{text}</FileReferenceControl>;
}

/** Shared by native references and parsed Markdown links; never reparses a literal native path. */
export function FileReferenceControl({ file, title, children }: { file: WorkspaceFileLink; title: string; children: ReactNode }) {
  const { actions } = useContext(TranscriptMarkdownContext);
  const [discoveryError, setDiscoveryError] = useState<string>();
  const [submenu, setSubmenu] = useState(false);
  const [error, setError] = useState<string>(), [options, setOptions] = useState<FileOpenOptions>();
  const [position, setPosition] = useState<{left:number;top:number}>();
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const alive = useRef(true), pending = useRef(false), read = useRef<Promise<FileOpenOptions | undefined> | undefined>(undefined);
  const cached = useRef<{at:number;value:FileOpenOptions} | undefined>(undefined);
  const currentActions = useRef(actions); currentActions.current = actions;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const close = (restore = true) => { setSubmenu(false); setPosition(undefined); if (restore) trigger.current?.focus({preventScroll:true}); };
  const discover = (force = false): Promise<FileOpenOptions | undefined> => {
    if (!currentActions.current?.fileOpenOptions) return Promise.resolve(undefined);
    if (read.current) return read.current;
    if (!force && cached.current && Date.now() - cached.current.at < 5000) return Promise.resolve(cached.current.value);
    setLoading(true);
    const task = currentActions.current.fileOpenOptions(file).then(value => {
      if (!alive.current) return undefined;
      if (value.path !== file.path) throw new Error("The host returned Open options for a different file.");
      cached.current = {at:Date.now(),value}; setOptions(value); setDiscoveryError(undefined); return value;
    }).catch(cause => { if (alive.current) { cached.current = undefined; setOptions(undefined); setDiscoveryError(String(cause instanceof Error ? cause.message : cause)); } return undefined; })
      .finally(() => { read.current = undefined; if (alive.current) setLoading(false); });
    read.current = task; return task;
  };
  const activate = async (external = false, targetId?: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined); close();
    try {
      const action = external ? currentActions.current?.openFileOnHost : currentActions.current?.openFile;
      if (!action) throw new Error(external ? "Opening in an application on the owning host is unavailable." : "The owning workspace is unavailable.");
      await action(file, targetId);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const showMenu = (x?: number, y?: number) => {
    const box = trigger.current!.getBoundingClientRect();
    setPosition({left: Math.max(8, Math.min(x ?? box.left, innerWidth - 248)), top: Math.max(8, y ?? box.bottom + 4)});
    void discover(true);
  };
  useLayoutEffect(() => {
    if (!position || !menu.current) return;
    const box = menu.current.getBoundingClientRect();
    if (box.bottom > innerHeight - 8) setPosition(p => p ? {...p, top:Math.max(8,innerHeight - box.height - 8)} : p);
    if (!menu.current.contains(document.activeElement)) menu.current.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({preventScroll:true});
  }, [position, options, error, loading]);
  useEffect(() => {
    if (!position) return;
    const outside = (event: Event) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close(false); };
    const dismiss = () => close(false);
    addEventListener("pointerdown",outside); addEventListener("focusin",outside); addEventListener("resize",dismiss);
    return () => { removeEventListener("pointerdown",outside); removeEventListener("focusin",outside); removeEventListener("resize",dismiss); };
  }, [Boolean(position)]);
  const fileManager = options?.targets.find(target => target.id === "fileManager");
  const preferred = options?.targets.find(target => target.id === options.preferredTargetId);
  const copyOrSave = async (save: boolean) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined); close();
    try {
      if (save) { if (!currentActions.current?.saveFileCopy) throw new Error("Save as is unavailable."); await currentActions.current.saveFileCopy(file); }
      else { if (!currentActions.current?.cwd) throw new Error("This file reference has no owning workspace."); await navigator.clipboard.writeText(absolutePath(`${currentActions.current.cwd}/${file.path}`)); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  };
  const hasLocation = file.line !== undefined || file.column !== undefined || file.endLine !== undefined;
  return <><button ref={trigger} type="button" className="transcript-file-reference" title={title} data-file-reference aria-busy={busy || undefined}
    onFocus={() => void discover()} onPointerEnter={() => void discover()}
    onClick={event => void activate((/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? event.metaKey : event.ctrlKey))}
    onAuxClick={event => { if (event.button === 1) { event.preventDefault(); void activate(true); } }}
    onContextMenu={event => { event.preventDefault(); showMenu(event.clientX,event.clientY); }}
    onKeyDown={event => { if (event.key === "ContextMenu" || event.key === "F10" && event.shiftKey) { event.preventDefault(); showMenu(); } }}>{children}</button>
    {error && !position && <span className="transcript-file-reference-error" role="alert">{error}</span>}
    {position && createPortal(<div ref={menu} className="workspace-file-open-menu transcript-file-reference-menu" style={position} role="menu" aria-label="File actions"
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key === "Tab") { close(false); return; }
        if (!["ArrowDown","ArrowUp","Home","End"].includes(event.key)) return;
        event.preventDefault(); const items = [...menu.current!.querySelectorAll<HTMLButtonElement>(':scope > [role="menuitem"]:not(:disabled), :scope > .transcript-file-open-with > [role="menuitem"]:not(:disabled)')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }}>
      <button type="button" role="menuitem" disabled={busy} onClick={() => void activate()}>Open file</button>
      {loading && !options && <p role="status">Loading available apps…</p>}
      {discoveryError && <><p role="alert">{discoveryError}</p><button type="button" role="menuitem" onClick={() => void discover(true)}>Try again</button></>}
      {preferred && preferred.kind !== "file-manager" && <button type="button" role="menuitem" disabled={busy || hasLocation} onClick={() => void activate(true,preferred.id)}>Open in {preferred.label}</button>}
      {options && options.targets.some(target => target.kind !== "file-manager") && <div className="transcript-file-open-with" onPointerEnter={() => setSubmenu(true)} onPointerLeave={() => setSubmenu(false)}>
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={submenu} disabled={busy || hasLocation}
          onClick={() => setSubmenu(true)} onKeyDown={event => { if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); setSubmenu(true); } }}>Open with <Icon name="chevron"/></button>
        {submenu && <FileTargetSubmenu targets={options.targets.filter(target => target.kind !== "file-manager")} disabled={busy || hasLocation} onOpen={id => void activate(true,id)} onClose={() => { setSubmenu(false); menu.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus(); }}/>}
      </div>}
      {options && !options.targets.length && <p role="status">{options.availabilityReason ?? "No supported applications are available on this host."}</p>}
      <div role="separator"/>
      {actions?.saveFileCopy && <button type="button" role="menuitem" disabled={busy} onClick={() => void copyOrSave(true)}>Save as…</button>}
      <button type="button" role="menuitem" disabled={busy} onClick={() => void copyOrSave(false)}>Copy path</button>
      {fileManager && <button type="button" role="menuitem" disabled={busy} onClick={() => void activate(true,"fileManager")}>{fileManager.label === "Finder" ? "Reveal in Finder" : "Open in File Manager"}</button>}
    </div>,document.body)}</>;
}

function FileTargetSubmenu({targets,disabled,onOpen,onClose}:{targets:FileOpenOptions["targets"];disabled:boolean;onOpen:(id:string)=>void;onClose:()=>void}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style,setStyle] = useState<{left:number;top:number}>();
  useLayoutEffect(() => {
    const node = ref.current!; const anchor = node.parentElement!.getBoundingClientRect();
    const width = Math.min(220,innerWidth-16), height = node.getBoundingClientRect().height;
    setStyle({left:anchor.right+width < innerWidth ? anchor.right : Math.max(8,anchor.left-width),top:Math.max(8,Math.min(anchor.top,innerHeight-height-8))});
    // Keyboard and pointer entry both leave a usable first target.
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});
  }, []);
  return <div ref={ref} style={style} className="workspace-file-open-menu transcript-file-targets" role="menu" aria-label="Open with" onKeyDown={event => {
    if(event.key === "Escape" || event.key === "ArrowLeft") { event.preventDefault();event.stopPropagation();onClose();return; }
    if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;
    event.preventDefault();event.stopPropagation(); const items=[...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const i=items.indexOf(document.activeElement as HTMLButtonElement);
    items[event.key==="Home"?0:event.key==="End"?items.length-1:(i+(event.key==="ArrowDown"?1:items.length-1))%items.length]?.focus();
  }}>{targets.map(target=><button key={target.id} type="button" role="menuitem" disabled={disabled} onClick={()=>onOpen(target.id)}>{target.label}</button>)}</div>;
}
