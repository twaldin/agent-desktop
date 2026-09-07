import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { File } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";
import { REVIEW_SHADOW_CSS, REVIEW_THEMES } from "./review-theme";
import { fileLocation } from "./transcript-links";
import { GoToLine } from "./GoToLine";
import "./pierre-source-editor.css";

const SOURCE_SHADOW_CSS = `${REVIEW_SHADOW_CSS}
:host { --diffs-line-height:calc(var(--code-font-size,12px) * var(--code-line-height,1.8)); }
pre { --diffs-bg:var(--editor-surface,var(--app-surface)); --diffs-bg-buffer:var(--editor-surface,var(--app-surface)); font-weight:var(--code-font-weight,400); }
`;

export interface PierreSourceEditorProps {
  documentKey: string; name: string; value: string; onChange(text: string): void;
  onSave(): void; label: string; readOnly?: boolean; active?: boolean;
  revealRequest?: { id: string; line?: number; column?: number };
  onReveal?(id: string, error?: string): void;
}

/** Pierre owns its document and history. Parent echoes must never reinitialize it. */
export function PierreSourceEditor(props: PierreSourceEditorProps) {
  const frame = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null), current = useRef(props);
  current.current = props;
  const instance = useRef<{ file: File; editor: Editor<undefined>; sync(): void; label(): void; reveal(): void;
    openLine(): boolean; goToLine(line: number, focus: boolean): void; closeLine(cancel: boolean, focus: boolean): void } | null>(null);
  const themeType = usePierreTheme();
  useLayoutEffect(() => {
    const element = container.current!;
    let alive = true, synchronizing = false, attached = false, readVersion = 0;
    let appliedReveal: string | undefined;
    let lineBaseline: { text: string; state: ReturnType<Editor<undefined>["getState"]> } | undefined;
    let pendingLine: { line: number; focus: boolean } | undefined;
    const positionLine = () => {
      if (!pendingLine || !alive || !attached || current.current.active === false) return;
      const row = element.querySelector("diffs-container")?.shadowRoot?.querySelector<HTMLElement>(`[data-line="${pendingLine.line}"]`);
      if (!row?.getClientRects().length) return;
      const focus = pendingLine.focus; pendingLine = undefined;
      const bounds = row.getBoundingClientRect(), viewport = element.getBoundingClientRect();
      element.scrollTop += bounds.top + bounds.height / 2 - viewport.top - element.clientHeight / 2;
      if (focus) editor.focus({ preventScroll: true });
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
      if (!alive || !attached || current.current.active === false || !request || request.id === appliedReveal) return;
      appliedReveal = request.id;
      editor.focus({ preventScroll: true });
      if (request.line !== undefined) {
        const location = fileLocation(editor.getText(), request.line, request.column);
        if ("error" in location) { current.current.onReveal?.(request.id, location.error); return; }
        const row = editor.getText().split(/\r\n|\r|\n/)[request.line - 1]!;
        const start = { line: request.line - 1, character: request.column === undefined ? 0 : request.column - 1 };
        editor.setSelections([{ start, end: request.column === undefined ? { ...start, character: row.length } : start, direction: "forward" }]);
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
    const file = new File({ theme: REVIEW_THEMES, themeType, overflow: "scroll", disableFileHeader: true, unsafeCSS: SOURCE_SHADOW_CSS,
      onPostRender: () => queueMicrotask(() => { label(); reveal(); positionLine(); }),
    });
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
    const editor = new Editor<undefined>({ onAttach: () => { attached = true; sync(); label(); reveal(); },
      onChange: changed => { if (!synchronizing && changed.contents !== current.current.value) current.current.onChange(changed.contents); },
    });
    file.render({ file: { name: props.name, contents: props.value, cacheKey: props.documentKey }, containerWrapper: element });
    // Pierre refreshes its accessible label after some asynchronous tokenization
    // passes. Retain the app label on that same native editable element.
    const observer = new MutationObserver(label), shadow = element.querySelector("diffs-container")?.shadowRoot;
    if (shadow) observer.observe(shadow, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-label", "contenteditable"] });
    const detach = props.readOnly ? undefined : editor.edit(file);
    instance.current = { file, editor, sync, label, reveal, openLine, goToLine, closeLine };
    const save = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault(); event.stopPropagation(); if (!current.current.readOnly) current.current.onSave();
      }
    };
    element.addEventListener("keydown", save, true);
    return () => { alive = false; observer.disconnect(); instance.current = null; element.removeEventListener("keydown", save, true); detach?.(); editor.cleanUp(); file.cleanUp(); element.replaceChildren(); };
  }, [props.documentKey, props.name, props.readOnly]);
  useLayoutEffect(() => { instance.current?.sync(); }, [props.value]);
  useEffect(() => {
    const value = instance.current;
    if (!value) return;
    value.file.setThemeType(themeType); value.file.rerender(); value.label();
  }, [themeType]);
  useEffect(() => { if (props.active !== false) { instance.current?.file.rerender(); instance.current?.label(); instance.current?.reveal(); } }, [props.active, props.revealRequest]);
  return <div ref={frame} className="pierre-source-editor-frame" hidden={props.active === false} data-app-shortcuts="off">
    <div ref={container} className="pierre-source-editor" hidden={props.active === false} data-read-only={Boolean(props.readOnly)}/>
    <GoToLine frame={frame} active={props.active !== false && !props.readOnly} value={props.value}
      onOpen={() => instance.current?.openLine() ?? false} onPreview={line => instance.current?.goToLine(line, false)}
      onCommit={line => instance.current?.goToLine(line, true)} onClose={(cancel, focus) => instance.current?.closeLine(cancel, focus)}/>
  </div>;
}

function usePierreTheme(): "dark" | "light" {
  const read = () => document.documentElement.dataset.theme === "light" ? "light" as const
    : document.documentElement.dataset.theme === "dark" ? "dark" as const
      : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" as const : "light" as const;
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const change = () => setTheme(read());
    const observer = new MutationObserver(change);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "style"] });
    const media = matchMedia("(prefers-color-scheme: dark)"); media.addEventListener("change", change);
    return () => { observer.disconnect(); media.removeEventListener("change", change); };
  }, []);
  return theme;
}
