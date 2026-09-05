import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import type { ComposerActionsCatalog } from "../../../../packages/shared/src/composer-actions";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace-protocol";
import { assertComposerOwner, catalogSuggestions, composerToken, fileSuggestions, nextSuggestion, replaceComposerToken, targetIdentity } from "./composer-autocomplete";
import type { ComposerAppAction, ComposerSuggestion } from "./composer-autocomplete";
import { errorMessage } from "./desktop-state";
import { Icon } from "./Icons";
import "./composer-autocomplete.css";

interface Props {
  bridge: DesktopBridge; hostId: string; target?: WorkspaceTarget; draftId: string; text: string; connected: boolean; disabled: boolean;
  input: RefObject<HTMLTextAreaElement | null>; readText(): string; updateText(text: string): void; actions: ComposerAppAction[];
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
  const catalog = catalogState?.scope === scope ? catalogState.catalog : undefined;
  const token = focused && !composition && !disabled && caret.scope === scope ? composerToken(text, caret.start, caret.end, catalog) : undefined;
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
    if (props.readText() !== captured) return;
    if (item.action && !tab) {
      pendingAction.current = true; setActionState({ scope, pending: true });
      try {
        await item.action.run();
        if (props.readText() === captured) props.updateText(replaceComposerToken(captured, token, "").text);
        if (currentScope.current === capturedScope) { setDismissed(capturedKey); setActionState({ scope }); }
      } catch (cause) { if (currentScope.current === capturedScope) setActionState({ scope, error: errorMessage(cause) }); }
      finally { pendingAction.current = false; }
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
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return false;
    if (!open || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDismissed(key); return true; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation(); setHighlight(nextSuggestion(items, selected?.id, event.key === "ArrowDown" ? 1 : -1)); return true;
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
    open, composing,
    inputProps: {
      "aria-autocomplete": "list" as const, "aria-controls": open ? menuId : undefined, "aria-expanded": open, "aria-activedescendant": open ? activeId : undefined,
      onFocus: () => { setFocused(true); observeCaret(); }, onBlur: () => setFocused(false), onSelect: observeCaret,
      onCompositionStart: () => { composing.current = true; setComposition(true); },
      onCompositionEnd: () => { composing.current = false; setComposition(false); observeCaret(); },
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => { props.updateText(event.target.value); setCaret({ scope, start: event.target.selectionStart, end: event.target.selectionEnd }); setActionState(undefined); },
    }, onKeyDown,
    popup: open ? <ComposerAutocompletePopup input={input} id={menuId} items={items} selectedId={selected?.id} onHighlight={setHighlight} onSelect={item => void apply(item)} pending={Boolean(pending)} loading={Boolean(loading)} error={error || undefined} notice={notice} onRefresh={() => refresh(value => value + 1)} connected={connected} kind={token!.kind}/> : null,
  };
}

function CompletionIcon({ item }: { item: ComposerSuggestion }) {
  if (["archive", "folder", "terminal", "compose", "refresh", "more"].includes(item.icon)) return <Icon name={item.icon as ComposerAppAction["icon"]}/>;
  // Semantic fallback glyphs are deliberately separate from the fifteen
  // source-matched app icons. Their exact reference variants remain unverified.
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{item.icon === "skill" ? <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></> : item.icon === "file" ? <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z"/><path d="M14 3v5h5"/></> : <><path d="m8 5-4 7 4 7m8-14 4 7-4 7M13.5 4l-3 16"/></>}</svg>;
}
function ComposerAutocompletePopup({ input, id, items, selectedId, onHighlight, onSelect, pending, loading, error, notice, onRefresh, connected, kind }: {
  input: RefObject<HTMLTextAreaElement | null>; id: string; items: ComposerSuggestion[]; selectedId?: string;
  onHighlight(id: string): void; onSelect(item: ComposerSuggestion): void; pending: boolean; loading: boolean; error?: string; notice?: string; onRefresh(): void; connected: boolean; kind: string;
}) {
  const [position, setPosition] = useState<{ left: number; bottom: number; width: number; maxHeight: number }>();
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const form = input.current?.closest("form"); if (!form) return;
    const measure = () => { const box = form.getBoundingClientRect(); setPosition({ left: Math.max(8, box.left), bottom: innerHeight - box.top + 8, width: Math.min(box.width, innerWidth - 16), maxHeight: Math.max(56, Math.min(320, box.top - 16)) }); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(form); window.addEventListener("resize", measure); window.addEventListener("scroll", measure, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [input]);
  useLayoutEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [selectedId]);
  if (!position) return null;
  return createPortal(<div className="composer-autocomplete" style={position} data-kind={kind} onMouseDown={event => event.preventDefault()}>
    <div className="composer-autocomplete-list" ref={list} id={id} role="listbox" aria-label={kind === "skill" ? "Skills" : kind === "file" || kind === "reference" ? "Files and references" : "Commands and app actions"} aria-busy={loading || pending}>
      {items.map((item, index) => <button type="button" role="option" id={`${id}-${index}`} key={item.id} className="composer-autocomplete-row" aria-selected={item.id === selectedId} aria-disabled={Boolean(item.disabled || pending)} title={item.disabled ?? `${item.description}${item.native?.source.path ? `\n${item.native.source.path}` : ""}`} onMouseMove={() => { if (!item.disabled) onHighlight(item.id); }} onClick={() => { if (!item.disabled && !pending) onSelect(item); }} tabIndex={-1}>
        <CompletionIcon item={item}/><span className="completion-label">{item.label}</span><span className="completion-description">{item.disabled ?? item.description}</span><span className="completion-origin">{item.origin}</span>
      </button>)}
    </div>
    {(pending || loading || error || !items.length || notice) && <div className="composer-autocomplete-status" role={error ? "alert" : "status"}>{pending ? "Running app action…" : error || (loading ? "Loading from this workspace…" : !items.length ? "No matching items." : notice)}{error && connected && <button type="button" onClick={onRefresh}>Retry</button>}</div>}
  </div>, document.body);
}
