import { useEffect, useReducer, useRef, type RefObject } from "react";
import type { SymbolEditorNavigation, SymbolEditorSnapshot } from "./symbol-navigation";
import "./symbol-navigation.css";

export type SymbolCommand = "file.goToDefinition" | "file.navigateBack" | "file.navigateForward";
/** Keyboard integration dispatches this cancelable event on the focused Pierre frame.
 * No global shortcut registration: General/Keyboard remains the binding owner. */
export function dispatchSymbolCommand(frame: HTMLElement, command: SymbolCommand): boolean {
  return !frame.dispatchEvent(new CustomEvent("workspace-symbol-command", { detail: command, cancelable: true }));
}
export function SymbolNavigationControls({ binding, frame, active, capture }: {
  binding: SymbolEditorNavigation; frame: RefObject<HTMLDivElement | null>; active: boolean;
  capture(): SymbolEditorSnapshot | undefined;
}) {
  const [, redraw] = useReducer(value => value + 1, 0), current = useRef({ binding, active, capture });
  current.current = { binding, active, capture };
  const { navigation, path } = binding;
  useEffect(() => navigation.subscribe(redraw), [navigation]);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const command = (event: Event) => {
      const value = current.current;
      if (!value.active || value.binding.navigation.busy || !(event instanceof CustomEvent)) return;
      const { navigation, path } = value.binding;
      if (event.detail === "file.goToDefinition" && !navigation.unavailable(path)) { event.preventDefault(); void navigation.define(path, value.capture(), value.binding); }
      else if (event.detail === "file.navigateBack" && navigation.canBack && navigation.data.connected) { event.preventDefault(); void navigation.travel(-1, path, value.capture(), value.binding); }
      else if (event.detail === "file.navigateForward" && navigation.canForward && navigation.data.connected) { event.preventDefault(); void navigation.travel(1, path, value.capture(), value.binding); }
    };
    element.addEventListener("workspace-symbol-command", command);
    return () => element.removeEventListener("workspace-symbol-command", command);
  }, [frame]);
  if (!active) return null;
  const unavailable = navigation.unavailable(path);
  return <div className="symbol-navigation" data-symbol-navigation>
    <div className="symbol-navigation-actions" role="group" aria-label="Symbol navigation">
      <button type="button" data-symbol-command="file.goToDefinition" disabled={navigation.busy || Boolean(unavailable)} title={unavailable ?? "Resolve the identifier at the editor cursor with TypeScript 7.0.2"}
        onClick={() => void navigation.define(path, capture(), binding)}>Go to definition</button>
      <button type="button" data-symbol-command="file.navigateBack" disabled={!navigation.canBack || !navigation.data.connected} onClick={() => void navigation.travel(-1, path, capture(), binding)}>Back to symbol</button>
      <button type="button" data-symbol-command="file.navigateForward" disabled={!navigation.canForward || !navigation.data.connected} onClick={() => void navigation.travel(1, path, capture(), binding)}>Forward to symbol</button>
      {(navigation.busy || navigation.choice) && <button type="button" onClick={() => navigation.cancel()}>Cancel navigation</button>}
    </div>
    {(unavailable || navigation.message) && <p role="status">{navigation.message || unavailable}</p>}
    <details><summary>Definition support</summary><p>TypeScript 7.0.2 resolves JavaScript, JSX, TypeScript and TSX symbols in this workspace, including saved-base unsaved buffers. Files, dependencies and configuration outside the owning workspace, historical Git content, language plugins and external standard libraries are unavailable. Source syntax errors must be corrected before lookup.</p></details>
    {navigation.choice && navigation.choice.definitions.length > 1 && <div className="symbol-definition-choices" role="group" aria-label="Choose a symbol definition" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); navigation.cancel(); } }}>
      {navigation.choice.definitions.map((definition, index) => <button type="button" key={`${definition.path}:${definition.selection.start.line}:${definition.selection.start.column}:${index}`} disabled={navigation.busy}
        onClick={() => void navigation.choose(index)} aria-label={`Open ${definition.path}, line ${definition.selection.start.line}, column ${definition.selection.start.column}`}>
        <span>{definition.name} · {definition.path}</span><span>{definition.selection.start.line}:{definition.selection.start.column}</span>
      </button>)}
      <button type="button" onClick={() => navigation.cancel()}>Dismiss definitions</button>
    </div>}
  </div>;
}
