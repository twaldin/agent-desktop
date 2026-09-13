import type { ComposerInput } from "./ComposerEditor";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { ChangeEvent, KeyboardEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import type { ComposerActionsCatalog } from "../../../../packages/shared/src/composer-actions";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace-protocol";
import { assertComposerOwner, catalogSuggestions, composerToken, fileSuggestions, nextSuggestion, replaceComposerToken, targetIdentity } from "./composer-autocomplete";
import type { ComposerAppAction, ComposerSuggestion } from "./composer-autocomplete";
import { errorMessage } from "./desktop-state";
import { Icon } from "./Icons";
import { SessionForkIcon, forkSlashQueryRemoval, sessionForkDestinations } from "./SessionFork";
import type { ForkExecution, SessionForkState } from "./session-fork-state";
import "./composer-autocomplete.css";

interface Props {
  bridge: Pick<DesktopBridge, "getComposerActions" | "getComposerCompletions">; hostId: string; target?: WorkspaceTarget; draftId: string; text: string; connected: boolean; disabled: boolean;
  input: RefObject<ComposerInput | null>; readText(): string; updateText(text: string): void; insertFile?(source:{hostId:string;path:string},range:{start:number;end:number}):void; actions: ComposerAppAction[];
  fork?: { data: SessionForkState; emptyComposer: boolean; run(execution: ForkExecution): Promise<void> };
}
export function useComposerAutocomplete(props: Props) {
  const { bridge, hostId, target, draftId, text, input, connected, disabled } = props;
  const scope = `${hostId}:${targetIdentity(target)}:${draftId}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const [focused, setFocused] = useState(false), [composition, setComposition] = useState(false);
  const composing = useRef(false);
  const [caret, setCaret] = useState({ scope, start: 0, end: 0 });
  const [dismissed, setDismissed] = useState<string>();
  const [catalogState, setCatalogState] = useState<{ scope: string; catalog?: ComposerActionsCatalog; error?: string; loading: boolean }>();
  const [forkSubmenu, setForkSubmenu] = useState<{ scope: string; prefix: string; queryStart: number; input: ComposerInput | null }>();
  const forkQuery = forkSubmenu?.scope === scope && props.fork?.emptyComposer && text.startsWith(forkSubmenu.prefix)
    && caret.scope === scope && caret.start === text.length && caret.end === text.length ? text.slice(forkSubmenu.prefix.length).trim() : undefined;
  const catalog = catalogState?.scope === scope ? catalogState.catalog : undefined;
  const token = focused && !composition && !disabled && caret.scope === scope ? forkQuery !== undefined
    ? { kind: "command" as const, start: 0, end: text.length, caret: caret.start, query: forkQuery }
    : composerToken(text, caret.start, caret.end, catalog) : undefined;
  const key = token ? `${scope}:${text}:${token.caret}` : undefined;
  const open = Boolean(token && key !== dismissed);
  const [fileState, setFileState] = useState<{ key: string; items: ComposerSuggestion[]; error?: string; loading: boolean; notice?: string }>();
  const [revision, refresh] = useState(0);
  const [highlight, setHighlight] = useState<string>();
  const [actionState, setActionState] = useState<{ scope: string; pending?: boolean; error?: string }>();
  const pendingAction = useRef(false);
  const menuId = useId();
  // Load while the composer is focused, so native URI schemes and argument
  // callbacks are discoverable even before a slash menu is opened. Responses
  // are scoped before
  // publication, and effect cleanup rejects late replies after navigation.
  useEffect(() => {
    if (!focused || !connected) return;
    let active = true;
    setCatalogState(previous => ({ scope, catalog: previous?.scope === scope ? previous.catalog : undefined, loading: true }));
    if (!bridge.getComposerActions) { setCatalogState({ scope, loading: false, error: "Update the owning host to load native commands and skills." }); return; }
    void bridge.getComposerActions(target, revision > 0, hostId).then(value => {
      assertComposerOwner(value, hostId, target);
      if (active) setCatalogState({ scope, catalog: value, loading: false });
    }).catch(cause => { if (active) setCatalogState({ scope, loading: false, error: errorMessage(cause) }); });
    return () => { active = false; };
  }, [bridge, hostId, scope, focused, connected, revision]);
  const remoteCompletion = token?.kind === "file" || token?.kind === "reference" || token?.kind === "command-argument";
  const fileKey = open && remoteCompletion ? `${scope}:${token.kind}:${token.commandName ?? ""}:${token.query}:${catalog?.revision ?? ""}` : undefined;
  useEffect(() => {
    if (!fileKey || !token || !connected) return;
    let active = true;
    setFileState({ key: fileKey, items: [], loading: true });
    const timer = setTimeout(() => {
      if (!bridge.getComposerCompletions) { setFileState({ key: fileKey, items: [], loading: false, error: "Update the owning host to search files and references." }); return; }
      void bridge.getComposerCompletions({ kind: token.kind === "command-argument" ? "command-argument" : token.kind === "reference" ? "reference" : "file", commandName: token.commandName, query: token.query, target, catalogRevision: catalog?.revision, limit: 80 }, hostId).then(value => {
        assertComposerOwner(value, hostId, target);
        if (catalog && value.cwd !== catalog.cwd) throw new Error("The workspace changed while searching files. Refresh this menu.");
        if (active) setFileState({ key: fileKey, items: fileSuggestions(value), loading: false, notice: [value.truncated ? "More matches exist. Type to narrow the search." : "", ...value.diagnostics].filter(Boolean).join(" ") });
      }).catch(cause => { if (active) setFileState({ key: fileKey, items: [], loading: false, error: errorMessage(cause) }); });
    }, 100);
    return () => { active = false; clearTimeout(timer); };
  }, [bridge, fileKey, connected, revision]);
  let items = token ? remoteCompletion ? fileState && fileState.key === fileKey ? fileState.items : [] : catalogSuggestions(catalog, token, text, props.actions) : [];
  if (props.fork && token?.kind === "command") {
    const fork = props.fork, snapshot = fork.data.value;
    if (forkQuery !== undefined && snapshot) {
      items = sessionForkDestinations(snapshot).filter(item => `${item.title} ${item.id}`.toLocaleLowerCase().includes(forkQuery.toLocaleLowerCase())).map(item => ({
        id: `host:fork:${item.id}`, label: item.title, description: item.description, origin: "", insertText: text, icon: "command",
        disabled: !fork.data.canStart || !item.available ? item.reason ?? fork.data.error ?? "Resolve the previous fork before starting another." : undefined,
      }));
    } else items = items.flatMap(item => {
      if (item.native?.name !== "fork" || item.native.source.kind !== "builtin" || item.native.availability === "shadowed") return [item];
      if (!fork.emptyComposer || text.slice(token.end).trim()) return [];
      return [{ ...item, id: "host:fork", label: "Fork chat", origin: "", insertText: "/fork",
        description: !snapshot?.worktree.available ? "Fork this chat" : snapshot.local.isWorktree ? "Fork this chat in the same worktree or a new worktree" : "Fork this chat in the current workspace or a new worktree",
        disabled: !fork.data.canStart ? fork.data.error ?? "Loading fork destinations…" : undefined }];
    });
  }
  // Cached native items are informative while disconnected; selecting one
  // cannot pretend that its owner still supports the command/path.
  if (!connected) items = items.map(item => item.action ? item : { ...item, disabled: "Reconnect to this workspace before selecting a native completion." });
  const selected = items.find(item => item.id === highlight && !item.disabled) ?? items.find(item => !item.disabled);
  const selectedIndex = selected ? items.indexOf(selected) : -1;
  const activeId = selectedIndex < 0 ? undefined : `${menuId}-${selectedIndex}`;
  const pending = actionState?.scope === scope && actionState.pending;
  const error = actionState?.scope === scope && actionState.error || (!connected ? "The owning host is offline. Native completions are unavailable." : remoteCompletion ? fileState && fileState.key === fileKey ? fileState.error : undefined : catalogState?.scope === scope ? catalogState.error : undefined);
  const loading = connected && (remoteCompletion ? !fileState || fileState.key !== fileKey || fileState.loading : catalogState?.scope !== scope || catalogState.loading);
  const notice = remoteCompletion ? fileState && fileState.key === fileKey ? fileState.notice : undefined : catalog?.diagnostics.join(" ");
  const observeCaret = () => { const element = input.current; if (element) setCaret({ scope, start: element.selectionStart, end: element.selectionEnd }); };
  const apply = async (item: ComposerSuggestion, tab = false) => {
    if (!token || item.disabled || pendingAction.current) return;
    const captured = text, capturedScope = scope, capturedKey = key;
    // A stale event cannot replace input edited since this render.
    if (currentScope.current !== capturedScope || props.readText() !== captured) return;
    if (item.id === "host:fork" && !tab) {
      setForkSubmenu({ scope, prefix: captured, queryStart: captured.indexOf("/", token.start), input: input.current }); setHighlight("host:fork:local"); return;
    }
    if (item.id.startsWith("host:fork:") && props.fork?.data.value) {
      if (tab) return;
      const destination = sessionForkDestinations(props.fork.data.value).find(value => item.id === `host:fork:${value.id}`);
      if (!destination?.available) return;
      pendingAction.current = true; setDismissed(capturedKey); setForkSubmenu(undefined);
      try { await props.fork.run(destination.execution); }
      finally { pendingAction.current = false; }
      return;
    }
    if (item.action && !tab) {
      pendingAction.current = true; setActionState({ scope, pending: true });
      try {
        await item.action.run();
        if (currentScope.current === capturedScope && props.readText() === captured) props.updateText(replaceComposerToken(captured, token, "").text);
        if (currentScope.current === capturedScope) { setDismissed(capturedKey); setActionState({ scope }); }
      } catch (cause) { if (currentScope.current === capturedScope) setActionState({ scope, error: errorMessage(cause) }); }
      finally { pendingAction.current = false; }
      return;
    }
    if (item.source && props.insertFile) {
      try {
        props.insertFile(item.source,{start:token.start,end:token.end});
        setDismissed(`${scope}:${props.readText()}:${token.start}`);setHighlight(undefined);setActionState(undefined);
        input.current?.focus();observeCaret();
      } catch(cause) { setActionState({scope,error:errorMessage(cause)}); }
      return;
    }
    const replacement = replaceComposerToken(captured, token, item.insertText);
    props.updateText(replacement.text); setHighlight(item.id); setActionState(undefined);
    // Tab completes an app action's query; only explicit Enter/click runs it.
    setDismissed(item.action ? undefined : `${scope}:${replacement.text}:${replacement.caret}`);
    requestAnimationFrame(() => {
      if (currentScope.current !== capturedScope || props.readText() !== replacement.text) return;
      input.current?.focus(); input.current?.setSelectionRange(replacement.caret, replacement.caret);
      setCaret({ scope, start: replacement.caret, end: replacement.caret });
    });
  };
  const dismissForkSubmenu = (restore: boolean) => {
    const editor = forkSubmenu?.input;
    if (forkQuery === undefined || !forkSubmenu || !token || !editor || currentScope.current !== scope || input.current !== editor) return;
    const removal = forkSlashQueryRemoval({ text, start: forkSubmenu.queryStart, end: token.end }, props.readText(), { start: editor.selectionStart, end: editor.selectionEnd });
    if (!removal) return;
    props.updateText(removal.text);
    if (restore) { editor.focus(); editor.setSelectionRange(removal.selection.start, removal.selection.end); }
    setCaret({ scope, ...removal.selection });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): boolean => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return false;
    const macMove = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform) && event.ctrlKey && (event.key === "n" || event.key === "p");
    if (!open || event.metaKey || event.altKey || (event.ctrlKey && !macMove)) return false;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismissForkSubmenu(true); setDismissed(key); setForkSubmenu(undefined); return true; }
    if (event.key === "Tab" && forkQuery !== undefined) { dismissForkSubmenu(false); setDismissed(key); setForkSubmenu(undefined); return false; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || macMove) {
      event.preventDefault(); event.stopPropagation(); setHighlight(nextSuggestion(items, selected?.id, event.key === "ArrowDown" || macMove && event.key === "n" ? 1 : -1)); return true;
    }
    if (token?.kind === "command-argument" && !loading && !selected && !error) return false;
    if ((event.key === "Enter" && !event.shiftKey) || (event.key === "Tab" && !event.shiftKey)) {
      // Even an empty/loading menu owns Enter: it must never send an unfinished
      // slash/skill/file query to the agent while results are changing.
      event.preventDefault(); event.stopPropagation(); if (selected && !event.repeat) void apply(selected, event.key === "Tab"); return true;
    }
    return false;
  };
  return {
    open, composing, observeCaret,
    inputProps: {
      "aria-autocomplete": "list" as const, "aria-controls": open ? menuId : undefined, "aria-expanded": open, "aria-activedescendant": open ? activeId : undefined,
      onFocus: () => { setFocused(true); observeCaret(); }, onBlur: () => { dismissForkSubmenu(false); setForkSubmenu(undefined); setFocused(false); }, onSelect: observeCaret,
      onCompositionStart: () => { composing.current = true; setComposition(true); },
      onCompositionEnd: () => { composing.current = false; setComposition(false); observeCaret(); },
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { props.updateText(event.target.value); setCaret({ scope, start: event.target.selectionStart, end: event.target.selectionEnd }); setActionState(undefined); },
    }, onKeyDown,
    popup: open ? <ComposerAutocompletePopup input={input} anchor={token!.start} id={menuId} items={items} selectedId={selected?.id} onHighlight={setHighlight} onSelect={item => void apply(item)} pending={Boolean(pending)} loading={Boolean(loading)} error={error || undefined} notice={notice} onRefresh={() => refresh(value => value + 1)} connected={connected} kind={token!.kind} forkMenu={forkQuery !== undefined} forkLocalWorktree={props.fork?.data.value?.local.isWorktree}/> : null,
  };
}

function CompletionIcon({ item, forkLocalWorktree }: { item: ComposerSuggestion; forkLocalWorktree?: boolean }) {
  if (item.id.startsWith("host:fork")) return <SessionForkIcon worktree={item.id !== "host:fork:local" || forkLocalWorktree}/>;
  if (["archive", "folder", "terminal", "compose", "refresh", "more", "sideChat"].includes(item.icon)) return <Icon name={item.icon as ComposerAppAction["icon"]}/>;
  // Semantic fallback glyphs are deliberately separate from the fifteen
  // source-matched app icons. Their exact reference variants remain unverified.
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{item.icon === "skill" ? <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></> : item.icon === "file" ? <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z"/><path d="M14 3v5h5"/></> : <><path d="m8 5-4 7 4 7m8-14 4 7-4 7M13.5 4l-3 16"/></>}</svg>;
}
function ComposerAutocompletePopup({ input, anchor, id, items, selectedId, onHighlight, onSelect, pending, loading, error, notice, onRefresh, connected, kind, forkMenu, forkLocalWorktree }: {
  input: RefObject<ComposerInput | null>; anchor: number; id: string; items: ComposerSuggestion[]; selectedId?: string;
  onHighlight(id: string): void; onSelect(item: ComposerSuggestion): void; pending: boolean; loading: boolean; error?: string; notice?: string; onRefresh(): void; connected: boolean; kind: string;
  forkMenu?: boolean; forkLocalWorktree?: boolean;
}) {
  const [position, setPosition] = useState<{ container: Element; style: CSSProperties }>();
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const editor = input.current?.closest(".composer-rich-input"), form = input.current?.closest("form");
    if (!editor || !form || !input.current?.getCaretRect) return;
    const measure = () => {
      const container = editor.closest(".app-dialog") ?? document.body;
      const box = container === document.body ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : container.getBoundingClientRect();
      const caret = input.current!.getCaretRect!(anchor);
      const above = getComputedStyle(editor).getPropertyValue("--composer-overlay-placement").trim() !== "bottom";
      const width = Math.min(360, Math.max(box.width - 24, 0));
      const left = Math.max(12, Math.min(caret.left - box.left, box.width - width - 12));
      const top = (above ? caret.top : caret.bottom) - box.top + (above ? -8 : 8);
      const next: { container: Element; style: CSSProperties } = { container, style: { position: container === document.body ? "fixed" : "absolute", left, top, width,
        transform: above ? "translateY(-100%)" : undefined,
        maxHeight: Math.max(0, Math.min(320, (above ? top : box.height - top) - 12)) } };
      setPosition(previous => previous?.container === container && JSON.stringify(previous.style) === JSON.stringify(next.style) ? previous : next);
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(form);
    window.addEventListener("resize", measure); window.addEventListener("scroll", measure, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  });
  useLayoutEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [selectedId]);
  if (!position) return null;
  return createPortal(<div className={`composer-autocomplete${forkMenu ? " session-fork-menu" : ""}`} style={position.style} data-composer-overlay-floating-ui data-kind={kind} onMouseDown={event => event.preventDefault()}>
    <div className="composer-autocomplete-list" ref={list} id={id} role="listbox" aria-label={kind === "skill" ? "Skills" : kind === "file" || kind === "reference" ? "Files and references" : "Commands and app actions"} aria-busy={loading || pending}>
      {items.map((item, index) => <button type="button" role="option" id={`${id}-${index}`} key={item.id} className="composer-autocomplete-row" aria-selected={item.id === selectedId} aria-disabled={Boolean(item.disabled || pending)} title={item.disabled ?? `${item.description}${item.native?.source.path ? `\n${item.native.source.path}` : ""}`} onMouseMove={() => { if (!item.disabled) onHighlight(item.id); }} onClick={() => { if (!item.disabled && !pending) onSelect(item); }} tabIndex={-1}>
        <CompletionIcon item={item} forkLocalWorktree={forkLocalWorktree}/>{item.id.startsWith("host:fork") ? <span className="session-fork-row-content"><span className="completion-label">{item.label}</span><span className="completion-description">{item.disabled ?? item.description}</span></span> : <><span className="completion-label">{item.label}</span><span className="completion-description">{item.disabled ?? item.description}</span><span className="completion-origin">{item.origin}</span></>}
      </button>)}
    </div>
    {(pending || loading || error || !items.length || notice) && <div className="composer-autocomplete-status" role={error ? "alert" : "status"}>{pending ? "Running app action…" : error || (loading ? "Loading from this workspace…" : notice || (!items.length ? "No results" : undefined))}{error && connected && <button type="button" onClick={onRefresh}>Retry</button>}</div>}
  </div>, position.container);
}
