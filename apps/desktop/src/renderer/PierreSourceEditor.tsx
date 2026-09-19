import { PierreGitBlame } from "./PierreGitBlame";
import type { PierreGitBlame as PierreGitBlameData } from "./git-file-history-state";
import { fileDefinitionCommand, SymbolNavigationControls, symbolRevealOriginInput } from "./SymbolNavigationControls";
import type { SymbolEditorNavigation, SymbolEditorSnapshot } from "./symbol-navigation";
import { symbolOffset, type SymbolSelection } from "../../../../packages/shared/src/symbol-navigation";
import { useEditorScroll } from "./use-editor-scroll";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { File } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";
import { REVIEW_SHADOW_CSS } from "./review-theme";
import { useCodeTheme } from "./use-code-theme";
import { fileLocation } from "./transcript-links";
import { GoToLine } from "./GoToLine";
import "./pierre-source-editor.css";
import { EditorSelectionToolbar } from "./EditorSelectionToolbar";
import { rawOffsetAt } from "./editor-selection";
import { fileTextSelection, type FileTextSelection } from "@agent-desktop/shared";

const SOURCE_SHADOW_CSS = `${REVIEW_SHADOW_CSS}
:host { --diffs-line-height:calc(var(--code-font-size,12px) * var(--code-line-height,1.8)); }
pre { --diffs-bg:var(--editor-surface,var(--app-surface)); --diffs-bg-buffer:var(--editor-surface,var(--app-surface)); font-weight:var(--code-font-weight,400); }
`;

export interface PierreSourceEditorProps {
  documentKey: string; name: string; value: string; onChange(text: string): void;
  onSave(): void; label: string; readOnly?: boolean; active?: boolean;
  initialScrollTop?: number; onScrollChange?(top: number): void;
  revealRequest?: { id: string; line?: number; column?: number; endLine?: number; selections?: SymbolSelection[]; text?: string };
  onReveal?(id: string, error?: string): void;
  onAddToChat?(selection: FileTextSelection): void;
  gitBlame?: PierreGitBlameData;
  symbolNavigation?: SymbolEditorNavigation;
}

/** Pierre owns its document and history. Parent echoes must never reinitialize it. */
export function PierreSourceEditor(props: PierreSourceEditorProps) {
  const frame = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null), current = useRef(props);
  current.current = props;
  const instance = useRef<{ file: File; editor: Editor<undefined>; sync(): void; label(): void; reveal(): void; captureSymbol(): SymbolEditorSnapshot | undefined;
    setTheme(themes: { light: string; dark: string }, type: "light" | "dark"): void;
    focus(): Promise<boolean>; cancelFocus(): void;
    openLine(): boolean; goToLine(line: number, focus: boolean): void; closeLine(cancel: boolean, focus: boolean): void } | null>(null);
  const { themeType, themes } = useCodeTheme();
  const [selectionAction, setSelectionAction] = useState<{ owner: string; document: string; start: unknown; end: unknown; rect: DOMRect; selection: FileTextSelection }>();
  const blameSelection = useCallback(() => {
    const editor = instance.current?.editor, picked = editor?.getState().selections?.[0];
    return editor && picked ? { text: editor.getText(), line: (picked.direction < 0 ? picked.start.line : picked.end.line) + 1 } : undefined;
  }, []);
  useLayoutEffect(() => {
    const element = container.current!;
    let alive = true, synchronizing = false, attached = false, readVersion = 0;
    let appliedReveal: string | undefined;
    let lineBaseline: { text: string; state: ReturnType<Editor<undefined>["getState"]> } | undefined;
    let pendingLine: { line: number; focus: boolean } | undefined;
    let pendingSymbolReveal: { id: string; text: string; selections: string; focusOrigin: HTMLElement | undefined; acknowledge(error?: string): void } | undefined;
    const focusWaiters = new Set<(ready: boolean) => void>();
    const finishFocus = (ready: boolean) => { for (const resolve of focusWaiters) resolve(ready); focusWaiters.clear(); };
    const focusSymbolReveal = () => {
      const pending = pendingSymbolReveal;
      if (!pending) return false;
      const host = element.querySelector("diffs-container"), input = host?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]');
      let active = element.ownerDocument.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      if (active && active !== element.ownerDocument.body && active !== pending.focusOrigin && active !== input && active !== host) {
        pendingSymbolReveal = undefined; pendingLine = undefined;
        editor.blur();
        pending.acknowledge("Focus left the navigation target before it was ready. Input was not replayed; history has not moved.");
        return false;
      }
      void focus();
      return true;
    };
    const settleSymbolReveal = () => {
      const pending = pendingSymbolReveal;
      if (!pending || !alive || !attached || current.current.active === false) return;
      const snapshot = captureSymbol();
      if (current.current.revealRequest?.id !== pending.id || !snapshot || snapshot.text !== pending.text || JSON.stringify(snapshot.selections) !== pending.selections) {
        pendingSymbolReveal = undefined; pendingLine = undefined;
        pending.acknowledge("The target changed before its native editor accepted the symbol location. Input was retained; history has not moved.");
        return;
      }
      if (pendingLine) return;
      const shadow = element.querySelector("diffs-container")?.shadowRoot, input = shadow?.querySelector<HTMLElement>('[contenteditable="true"]');
      if (!input?.isConnected) return;
      if (shadow?.activeElement !== input && !focusSymbolReveal()) return;
      if (shadow?.activeElement === input) { pendingSymbolReveal = undefined; pending.acknowledge(); }
    };
    const positionLine = () => {
      settleSymbolReveal();
      if (!pendingLine || !alive || !attached || current.current.active === false) return;
      const row = element.querySelector("diffs-container")?.shadowRoot?.querySelector<HTMLElement>(`[data-line="${pendingLine.line}"]`);
      if (!row?.getClientRects().length) return;
      const shouldFocus = pendingLine.focus; pendingLine = undefined;
      const bounds = row.getBoundingClientRect(), viewport = element.getBoundingClientRect();
      element.scrollTop += bounds.top + bounds.height / 2 - viewport.top - element.clientHeight / 2;
      if (shouldFocus) {
        if (pendingSymbolReveal) { if (!focusSymbolReveal()) return; }
        else editor.focus({ preventScroll: true });
      }
      settleSymbolReveal();
    };
    const goToLine = (line: number, focus: boolean) => {
      if (!attached) return;
      if (focus) lineBaseline = undefined;
      const point = { line: line - 1, character: 0 };
      // Unlike setSelections, setState with a view does not focus the editable.
      editor.setState({ selections: [{ start: point, end: point, direction: 0 }], view: editor.getState().view });
      pendingLine = { line, focus }; positionLine();
    };
    const openLine = () => {
      if (!alive || !attached || current.current.active === false) return false;
      element.querySelector("diffs-container")?.shadowRoot?.querySelector<HTMLButtonElement>('[data-search-close]')?.click();
      lineBaseline = { text: editor.getText(), state: structuredClone(editor.getState()) };
      pendingLine = undefined;
      return true;
    };
    const closeLine = (cancel: boolean, focus: boolean) => {
      pendingLine = undefined;
      if (cancel && lineBaseline && attached && lineBaseline.text === editor.getText()) editor.setState(lineBaseline.state);
      lineBaseline = undefined;
      if (focus && alive && attached) editor.focus({ preventScroll: true });
    };
    const reveal = () => {
      const request = current.current.revealRequest;
      if (alive && current.current.readOnly && current.current.active !== false && request && request.id !== appliedReveal) {
        if (request.selections) { appliedReveal = request.id; current.current.onReveal?.(request.id, "The target is no longer an editable native source. History has not moved."); return; }
        if (request.line !== undefined) {
          const location = fileLocation(current.current.value, request.line, request.column, request.endLine);
          if ("error" in location) { appliedReveal = request.id; current.current.onReveal?.(request.id, location.error); return; }
          const row = element.querySelector("diffs-container")?.shadowRoot?.querySelector<HTMLElement>(`[data-line="${request.line}"]`);
          if (!row?.getClientRects().length) return;
          const bounds = row.getBoundingClientRect(), viewport = element.getBoundingClientRect();
          element.scrollTop += bounds.top - viewport.top - element.clientHeight / 2;
          row.tabIndex = -1; row.focus({ preventScroll: true });
        }
        appliedReveal = request.id; current.current.onReveal?.(request.id);
        return;
      }
      if (!alive || !attached || current.current.active === false || !request || request.id === appliedReveal) return;
      if (request.selections && !element.querySelector("diffs-container")?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]')?.isConnected) return;
      appliedReveal = request.id;
      if (request.selections) {
        try {
          const text = editor.getText();
          if (request.text !== text) throw new Error("This symbol location belongs to a changed document. Run Go to definition again.");
          for (const selection of request.selections) { symbolOffset(text, selection.start); symbolOffset(text, selection.end); }
          const onReveal = current.current.onReveal;
          pendingSymbolReveal = { id: request.id, text, selections: JSON.stringify(request.selections),
            focusOrigin: symbolRevealOriginInput(current.current.symbolNavigation?.navigation, request.id), acknowledge: error => onReveal?.(request.id, error) };
          editor.setSelections(request.selections.map(selection => ({
            start: { line: selection.start.line - 1, character: selection.start.column - 1 },
            end: { line: selection.end.line - 1, character: selection.end.column - 1 },
            direction: selection.direction,
          })));
          pendingLine = { line: request.selections[0]!.start.line, focus: true }; positionLine();
          settleSymbolReveal();
        } catch (error) { pendingSymbolReveal = undefined; current.current.onReveal?.(request.id, error instanceof Error ? error.message : String(error)); }
        return;
      }
      editor.focus({ preventScroll: true });
      if (request.line !== undefined) {
        const location = fileLocation(editor.getText(), request.line, request.column, request.endLine);
        if ("error" in location) { current.current.onReveal?.(request.id, location.error); return; }
        const lastLine = request.endLine ?? request.line;
        const row = editor.getText().split(/\r\n|\r|\n/)[lastLine - 1]!;
        const start = { line: request.line - 1, character: request.column === undefined ? 0 : request.column - 1 };
        editor.setSelections([{ start, end: request.column === undefined || request.endLine !== undefined ? { line: lastLine - 1, character: row.length } : start, direction: "forward" }]);
      }
      current.current.onReveal?.(request.id);
    };
    const label = () => {
      if (!alive) return;
      const input = element.querySelector("diffs-container")?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]');
      if (input) {
        if (input.getAttribute("aria-label") !== current.current.label) input.setAttribute("aria-label", current.current.label);
        if (input.getAttribute("aria-readonly") !== "false") input.setAttribute("aria-readonly", "false");
      }
    };
    const captureSymbol = (): SymbolEditorSnapshot | undefined => {
      if (!alive || !attached || current.current.readOnly) return;
      const selections = editor.getState().selections;
      if (!selections?.length) return;
      return { text: editor.getText(), selections: selections.map(selection => ({
        start: { line: selection.start.line + 1, column: selection.start.character + 1 },
        end: { line: selection.end.line + 1, column: selection.end.character + 1 },
        direction: selection.direction === -1 ? "backward" : "forward",
      })) };
    };
    const fileOptions = { theme: themes, themeType, overflow: "scroll", disableFileHeader: true, unsafeCSS: SOURCE_SHADOW_CSS,
      onPostRender: () => queueMicrotask(() => { label(); reveal(); positionLine(); settleSymbolReveal(); }),
      onTokenClick: props.symbolNavigation ? (token: { lineNumber: number; lineCharStart: number }, event: MouseEvent) => {
        if (current.current.active === false || event.altKey || !(event.metaKey || event.ctrlKey) || !frame.current) return;
        const command = fileDefinitionCommand(frame.current, { line: token.lineNumber, column: token.lineCharStart + 1 });
        if (!command) return;
        event.preventDefault(); event.stopPropagation(); command();
      } : undefined,
    } as const;
    const file = new File(fileOptions);
    const sync = () => {
      if (!alive) return;
      if (current.current.readOnly) {
        file.render({ file: { name: current.current.name, contents: current.current.value, cacheKey: `${current.current.documentKey}:readonly:${++readVersion}` } });
        return;
      }
      if (!attached || editor.getText() === current.current.value) return;
      const text = editor.getText(), lines = text.split(/\r\n|\r|\n/);
      synchronizing = true;
      try {
        // The public editor API puts external changes on its undo timeline too.
        // Suppress its callback: host/rich-mode updates are not new source writes.
        editor.applyEdits([{ range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: lines.at(-1)!.length } }, newText: current.current.value }]);
      } finally { synchronizing = false; }
      label();
    };
    const focus = (): Promise<boolean> => {
      const shadow = element.querySelector("diffs-container")?.shadowRoot, input = shadow?.querySelector<HTMLElement>('[contenteditable="true"]');
      if (!alive || !attached || !input?.isConnected || current.current.active === false || current.current.readOnly) return Promise.resolve(false);
      if (shadow?.activeElement === input) return Promise.resolve(true);
      return new Promise(resolve => {
        const requested = focusWaiters.size > 0; focusWaiters.add(resolve);
        if (!requested) {
          // Let the original Editor prepare its managed selection/focus state,
          // then make that same native editable the synchronous input owner.
          // Waiting for Pierre's queued focus leaves a real inter-event BODY gap.
          editor.focus({ preventScroll: true });
          label();
          if (alive && current.current.active !== false && input.isConnected && shadow?.activeElement !== input) input.focus({ preventScroll: true });
        }
        if (shadow?.activeElement === input) finishFocus(true);
      });
    };
    const editor = new Editor<undefined>({ onAttach: () => { attached = true; sync(); label(); reveal(); },
      onChange: changed => { if (!synchronizing && changed.contents !== current.current.value) current.current.onChange(changed.contents); },
      onFocus: () => { finishFocus(alive && current.current.active !== false); queueMicrotask(settleSymbolReveal); },
      onBlur: () => finishFocus(false),
    });
    file.render({ file: { name: props.name, contents: props.value, cacheKey: props.documentKey }, containerWrapper: element });
    // Pierre refreshes its accessible label after some asynchronous tokenization
    // passes. Retain the app label on that same native editable element.
    const observer = new MutationObserver(label), shadow = element.querySelector("diffs-container")?.shadowRoot;
    if (shadow) observer.observe(shadow, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label", "contenteditable"] });
    const detach = props.readOnly ? undefined : editor.edit(file);
    instance.current = { file, editor, sync, label, reveal, openLine, goToLine, closeLine, captureSymbol, focus, cancelFocus: () => { finishFocus(false); editor.blur(); },
      setTheme: (theme, type) => { file.setOptions({ ...fileOptions, theme, themeType: type }); file.onThemeChange(); label(); } };
    const save = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault(); event.stopPropagation(); if (!current.current.readOnly) current.current.onSave();
      }
    };
    element.addEventListener("keydown", save, true);
    return () => {
      alive = false;
      finishFocus(false);
      const pending = pendingSymbolReveal; pendingSymbolReveal = undefined;
      pending?.acknowledge("The target editor closed before accepting the symbol location. History has not moved.");
      observer.disconnect(); instance.current = null; element.removeEventListener("keydown", save, true); detach?.(); editor.cleanUp(); file.cleanUp(); element.replaceChildren();
    };
  }, [props.documentKey, props.name, props.readOnly]);
  useLayoutEffect(() => { instance.current?.sync(); }, [props.value]);
  // Hiding/removing an editable need not emit DOM blur. Cancel the original
  // Editor's pending focus intent at the owner transition, before another event.
  useLayoutEffect(() => { if (props.active === false) instance.current?.cancelFocus(); }, [props.active]);
  useEffect(() => {
    const value = instance.current;
    if (!value) return;
    value.setTheme(themes, themeType);
  }, [themes, themeType]);
  useEffect(() => { if (props.active !== false) { instance.current?.file.rerender(); instance.current?.label(); instance.current?.reveal(); } }, [props.active, props.revealRequest]);
  useEditorScroll(container, props);
  useEffect(() => {
    if (!props.onAddToChat || props.readOnly) return;
    let frameId = 0;
    const update = () => {
      const input = container.current?.querySelector("diffs-container")?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]');
      const shadow = container.current?.querySelector("diffs-container")?.shadowRoot;
      const native = (shadow as (ShadowRoot & { getSelection?: () => Selection }) | null)?.getSelection?.() ?? window.getSelection();
      const state = instance.current?.editor.getState(), picked = state?.selections?.[0];
      if (!input || !native || native.rangeCount === 0 || native.isCollapsed || !input.contains(native.anchorNode) || !input.contains(native.focusNode) || !picked || picked.start.line !== picked.end.line && picked.start.line > picked.end.line) { setSelectionAction(undefined); return; }
      const range = native.getRangeAt(0), raw = instance.current?.editor.getText() ?? props.value;
      const selection = fileTextSelection(raw, rawOffsetAt(raw, picked.start), rawOffsetAt(raw, picked.end)), rect = range.getBoundingClientRect();
      setSelectionAction(selection && (rect.width || rect.height) ? { owner: props.documentKey, document: raw, start: picked.start, end: picked.end, rect, selection } : undefined);
    };
    const onSelection = () => { cancelAnimationFrame(frameId); frameId = requestAnimationFrame(update); };
    const onScroll = () => setSelectionAction(undefined);
    const onPointerDown = (event: PointerEvent) => { const target = event.target as Node; if (!container.current?.contains(target) && !(target instanceof Element && target.closest("[data-editor-selection-toolbar]"))) setSelectionAction(undefined); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectionAction(undefined); };
    document.addEventListener("selectionchange", onSelection);
    document.addEventListener("pointerdown", onPointerDown, true); document.addEventListener("keydown", onKeyDown, true);
    container.current?.addEventListener("scroll", onScroll, { passive: true });
    return () => { cancelAnimationFrame(frameId); document.removeEventListener("selectionchange", onSelection); document.removeEventListener("pointerdown", onPointerDown, true); document.removeEventListener("keydown", onKeyDown, true); container.current?.removeEventListener("scroll", onScroll); };
  }, [props.documentKey, props.onAddToChat, props.readOnly]);
  return <div ref={frame} className="pierre-source-editor-frame" hidden={props.active === false} data-app-shortcuts="off" data-symbol-owner={props.symbolNavigation ? props.documentKey : undefined}>
    {props.symbolNavigation && <SymbolNavigationControls documentKey={props.documentKey} binding={props.symbolNavigation} frame={frame} active={props.active !== false && !props.readOnly} revealId={props.revealRequest?.id}
      capture={() => {
        const owner = instance.current, input = container.current?.querySelector("diffs-container")?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]');
        const snapshot = owner?.captureSymbol();
        return owner && input && snapshot ? { editor: owner.editor, input, snapshot } : undefined;
      }}
      focus={editor => {
        const owner = instance.current;
        if (!owner || owner.editor !== editor) return Promise.resolve(false);
        return owner.focus();
      }}/>}
    <div ref={container} className="pierre-source-editor" hidden={props.active === false} data-read-only={Boolean(props.readOnly)}/>
    <GoToLine frame={frame} active={props.active !== false && !props.readOnly} value={props.value}
      onOpen={() => instance.current?.openLine() ?? false} onPreview={line => instance.current?.goToLine(line, false)}
      onCommit={line => instance.current?.goToLine(line, true)} onClose={(cancel, focus) => instance.current?.closeLine(cancel, focus)}/>
    {props.gitBlame && !props.readOnly && <PierreGitBlame blame={props.gitBlame} container={container} active={props.active !== false} value={props.value} selection={blameSelection}/>}
    {selectionAction && props.onAddToChat && <EditorSelectionToolbar anchor={selectionAction.rect} selection={selectionAction.selection} onAddToChat={selection => { const current = instance.current?.editor.getText(), state = instance.current?.editor.getState(), picked = state?.selections?.[0]; if (props.active === false || selectionAction.owner !== props.documentKey || selectionAction.document !== current || !current || !picked || JSON.stringify(picked.start) !== JSON.stringify(selectionAction.start) || JSON.stringify(picked.end) !== JSON.stringify(selectionAction.end)) return; const fresh = fileTextSelection(current, rawOffsetAt(current, picked.start), rawOffsetAt(current, picked.end)); if (!fresh || fresh.text !== selection.text || JSON.stringify(fresh.range) !== JSON.stringify(selection.range)) return; props.onAddToChat?.(selection); setSelectionAction(undefined); }}/>}
  </div>;
}
