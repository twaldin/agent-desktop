import { useEffect, useId, useRef, useState } from "react";
import type { ComposerAction } from "@agent-desktop/shared";
import { Icon } from "./Icons";
import { NativeSwitch } from "./NativeSwitch";
import { MarkdownText, TranscriptMarkdownContext } from "./MarkdownText";
import "./native-skill-dialog.css";

/** Frontmatter is metadata, not part of the rendered skill document. Keep the
 * original bytes for Copy Markdown; incomplete headers stay text. */
export function skillDocument(content: string): string {
  const text = content.replace(/^\uFEFF/, "");
  return text.replace(/^---\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/, "");
}

export function NativeSkillDialog({ action, content, loading, error, notice: settingNotice, enablement, onClose, openExternal, onTry, tryDisabled = false, onDisposed, fileActions }: {
  action: ComposerAction; content?: string; loading: boolean; error?: string;
  notice?: string; tryDisabled?: boolean;
  fileActions?: {disabled:boolean;onOpen():void;revealLabel:string;revealDisabled:boolean;revealReason?:string;onReveal():Promise<void>};
  enablement?: { checked: boolean; disabled: boolean; title: string; onChange(checked: boolean): void };
  onClose(): void; onDisposed?(): void; onTry?(): void; openExternal?(url: string): Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null), more = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const menuKeyboard = useRef(false);
  const titleId = useId(), descriptionId = useId();
  const [menuOpen, setMenuOpen] = useState(false), [revealing,setRevealing] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string }>();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const element = dialog.current!; element.showModal();
    element.querySelector<HTMLButtonElement>('[aria-label="Close skill dialog"]')?.focus();
    return () => { active.current = false; if (element.open) element.close(); onDisposed?.(); };
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    if (menuKeyboard.current) menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    else menu.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !more.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menuOpen]);
  const closeMenu = () => { setMenuOpen(false); requestAnimationFrame(() => more.current?.focus()); };
  async function copy(value: string, label: string) {
    closeMenu();
    try {
      await navigator.clipboard.writeText(value);
      if (active.current) setNotice({ error: false, text: label === "Markdown" ? "Copied SKILL.md" : `${label} copied.` });
    } catch { if (active.current) setNotice({ error: true, text: `${label} could not be copied.` }); }
  }
  return <dialog ref={dialog} className="native-skill-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); if (menuOpen) closeMenu(); else onClose(); }}
    onClick={event => { if (event.target !== event.currentTarget) return; const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose(); }}>
    <header className="skill-dialog-header">
      <span className="skill-dialog-icon" aria-hidden="true"><Icon name="skill"/></span>
      <div className="skill-dialog-actions">
        {enablement && <NativeSwitch className="skill-dialog-enabled-switch" label={`Enable ${action.name}`} {...enablement}/>}
        <span className="skill-dialog-menu-anchor">
        <button ref={more} className="icon-button" aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen} onPointerDown={event => {
          if (event.button !== 0 || event.ctrlKey) return;
          menuKeyboard.current = false; setMenuOpen(value => !value); event.preventDefault();
        }} onKeyDown={event => {
          if (!["Enter", " ", "ArrowDown"].includes(event.key)) return;
          event.preventDefault(); menuKeyboard.current = true;
          setMenuOpen(value => event.key === "ArrowDown" ? true : !value);
        }} onClick={event => { if (event.detail === 0) { menuKeyboard.current = true; setMenuOpen(value => !value); } }}><Icon name="more"/></button>
        {menuOpen && <div ref={menu} role="menu" tabIndex={-1} aria-label="More actions" className="skill-dialog-menu" onPointerMove={event => {
          const item = (event.target as HTMLElement).closest<HTMLButtonElement>('button[role="menuitem"]');
          if (item && !item.disabled) item.focus({preventScroll:true});
        }} onPointerLeave={() => menu.current?.focus({preventScroll:true})} onKeyDown={event => {
          if (event.key === "Tab") { event.preventDefault(); const backwards=event.shiftKey; setMenuOpen(false); requestAnimationFrame(()=>{if(backwards) more.current?.focus(); else dialog.current?.querySelector<HTMLButtonElement>('[aria-label="Close skill dialog"]')?.focus();}); return; }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : current < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }}>
          <button role="menuitem" disabled={loading || revealing || !fileActions || fileActions.disabled} onClick={() => { closeMenu(); fileActions?.onOpen(); }}>Open</button>
          <button role="menuitem" disabled={revealing || !fileActions || fileActions.revealDisabled} title={fileActions?.revealReason} onClick={() => {
            closeMenu(); setRevealing(true); setNotice(undefined);
            void fileActions!.onReveal().then(()=>{if(active.current)setNotice({error:false,text:"Revealed on the owning host."});},cause=>{if(active.current)setNotice({error:true,text:cause instanceof Error ? cause.message : "Reveal was not confirmed. Inspect the owning host before trying again."});}).finally(()=>{if(active.current)setRevealing(false);});
          }}>{fileActions?.revealLabel ?? "Reveal in file manager"}</button>
          <button role="menuitem" disabled={content === undefined || loading} onClick={() => void copy(content!, "Markdown")}>Copy Markdown</button>
        </div>}
        </span>
        <button className="icon-button" aria-label="Close skill dialog" onClick={onClose}><Icon name="close"/></button>
      </div>
      <h2 id={titleId}>{action.name} <span>Skill</span>{action.availability==="disabled"&&<em className="skill-disabled-badge">Disabled</em>}</h2>
      <p id={descriptionId}>{action.description}</p>
    </header>
    {notice && <p role={notice.error ? "alert" : "status"} className={notice.error ? "inline-error" : "skill-dialog-notice"}>{notice.text}</p>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    {settingNotice && <p role="status" className="skill-dialog-notice">{settingNotice}</p>}
    <section className="skill-dialog-document" aria-label={`${action.name} skill contents`} aria-busy={loading} tabIndex={0}>
      {loading ? <p role="status">Loading skill…</p> : content !== undefined ?
        <TranscriptMarkdownContext value={{ actions: { openExternal } }}><MarkdownText text={skillDocument(content)} blockKey={`skill:${action.id}`}/></TranscriptMarkdownContext> : null}
    </section>
    <footer className="skill-dialog-footer"><span title={action.source.path}>{action.source.label}</span>{action.availability !== "executable" && <span>{action.reason ?? "Native skill invocation is unavailable."}</span>}{onTry && <button className="primary-button" disabled={tryDisabled || loading || action.availability !== "executable"} title="Prepare a new chat with this skill" onClick={onTry}>Try now</button>}</footer>
  </dialog>;
}
