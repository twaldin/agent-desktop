import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { File } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";
import { REVIEW_SHADOW_CSS, REVIEW_THEMES } from "./review-theme";
import { fileLocation } from "./transcript-links";
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
  const container = useRef<HTMLDivElement>(null), current = useRef(props);
  current.current = props;
  const instance = useRef<{ file: File; editor: Editor<undefined>; sync(): void; label(): void; reveal(): void } | null>(null);
  const themeType = usePierreTheme();
  useLayoutEffect(() => {
    const element = container.current!;
    let alive = true, synchronizing = false, attached = false, readVersion = 0;
    let appliedReveal: string | undefined;
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
      onPostRender: () => queueMicrotask(() => { label(); reveal(); }),
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
    instance.current = { file, editor, sync, label, reveal };
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
  return <div ref={container} className="pierre-source-editor" hidden={props.active === false} data-read-only={Boolean(props.readOnly)} data-app-shortcuts="off"/>;
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
