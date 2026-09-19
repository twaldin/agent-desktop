import { useEffect, useReducer, useRef, useState, type RefObject } from "react";
import type { DesktopMenuItem } from "../../../../packages/shared/src/context-menu";
import type { SymbolPosition } from "../../../../packages/shared/src/symbol-navigation";
import type { SymbolEditorNavigation, SymbolEditorSnapshot, SymbolNavigation, SymbolSourcePresentation } from "./symbol-navigation";
import "./symbol-navigation.css";

export type FileEditorShortcut = "file-go-to-definition" | "file-navigate-back" | "file-navigate-forward";
export type FileEditorCommandActions = Partial<Record<FileEditorShortcut, () => void>>;
export interface CapturedFileEditorCommands { actions: FileEditorCommandActions; restoreFocus(): Promise<boolean> }
export interface FileEditorCapture { editor: object; input: HTMLElement; snapshot: SymbolEditorSnapshot }
interface Props {
  documentKey: string; binding: SymbolEditorNavigation; frame: RefObject<HTMLDivElement | null>; active: boolean;
  revealId?: string;
  capture(): FileEditorCapture | undefined;
  focus(editor: object): Promise<boolean>;
}
interface Owner { frame: HTMLElement; current(): Props; report(message: string): void }
interface Origin { owner: Owner; root: HTMLElement; key: string; binding: SymbolEditorNavigation; capture: FileEditorCapture; revision: string | undefined; selections: string }
const owners = new WeakMap<Element, Owner>();
const requests = new WeakMap<SymbolNavigation, Origin>();
const shortcuts: readonly FileEditorShortcut[] = ["file-go-to-definition", "file-navigate-back", "file-navigate-forward"];

function parent(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}
function within(root: Element, value: Element | null): boolean {
  for (let element = value; element; element = parent(element)) if (element === root) return true;
  return false;
}
function focused(document: Document): Element | null {
  let value = document.activeElement;
  while (value?.shadowRoot?.activeElement) value = value.shadowRoot.activeElement;
  return value;
}
function visible(owner: Owner): boolean {
  if (owners.get(owner.frame) !== owner || !owner.frame.isConnected || !owner.current().active || owner.frame.closest("[hidden], [inert]")) return false;
  const bounds = owner.frame.getBoundingClientRect(), visibility = owner.frame.ownerDocument.defaultView?.getComputedStyle(owner.frame).visibility;
  return bounds.width > 0 && bounds.height > 0 && visibility !== "hidden" && visibility !== "collapse";
}
function focusedOwner(root: HTMLElement, origin: Element | null): Owner | undefined {
  for (let element = origin; element && within(root, element); element = parent(element)) {
    const owner = owners.get(element);
    if (!owner || !visible(owner)) continue;
    const input = owner.frame.querySelector("diffs-container")?.shadowRoot?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (input && within(input, focused(root.ownerDocument))) return owner;
  }
}
function unavailable(owner: Owner, command: FileEditorShortcut): string | undefined {
  const { binding, active } = owner.current(), { navigation, path } = binding;
  if (!active || !visible(owner) || !binding.isCurrentSource()) return "The original source editor is no longer active. Focus the working source and retry.";
  if (navigation.busy) return "Wait for the current symbol navigation or cancel it.";
  if (command === "file-go-to-definition") return navigation.unavailable(path);
  if (!navigation.data.connected) return "Reconnect to the owning host to revisit symbol locations.";
  const document = navigation.data.documents.get(path);
  if (!navigation.data.restored || document?.content?.kind !== "text") return "Load or save this source file before revisiting symbols.";
  if (document.conflict !== undefined || navigation.data.busy || navigation.data.pending) return "Resolve the source conflict or pending workspace change before revisiting symbols.";
  if (command === "file-navigate-back" ? !navigation.canBack : !navigation.canForward) return command === "file-navigate-back" ? "There is no earlier symbol location." : "There is no later symbol location.";
}
function captureOrigin(owner: Owner, root: HTMLElement): Origin | undefined {
  const value = owner.current(), capture = value.capture();
  if (!visible(owner) || !within(root, owner.frame) || !value.binding.isCurrentSource() || !capture || !capture.input.isConnected || !within(owner.frame, capture.input)) return;
  const content = value.binding.navigation.data.documents.get(value.binding.path)?.content;
  return { owner, root, key: value.documentKey, binding: value.binding, capture, revision: content?.kind === "text" ? content.revision : undefined, selections: JSON.stringify(capture.snapshot.selections) };
}
function current(origin: Origin): boolean {
  const { owner, binding, capture } = origin, value = owner.current();
  if (!visible(owner) || !within(origin.root, owner.frame) || value.documentKey !== origin.key || value.binding.navigation !== binding.navigation || value.binding.path !== binding.path || !binding.isCurrentSource() || !value.binding.isCurrentSource()) return false;
  const fresh = value.capture(), document = binding.navigation.data.documents.get(binding.path);
  return fresh?.editor === capture.editor && fresh.input === capture.input && capture.input.isConnected && fresh.snapshot.text === capture.snapshot.text && JSON.stringify(fresh.snapshot.selections) === origin.selections && document?.content?.kind === "text" && document.content.revision === origin.revision && document.text === capture.snapshot.text;
}
async function restore(origin: Origin): Promise<boolean> {
  return current(origin) && await origin.owner.current().focus(origin.capture.editor) && current(origin);
}
function execute(origin: Origin, command: FileEditorShortcut, position?: SymbolPosition) {
  if (!current(origin)) throw new Error("The original file editor, source or selection changed. Return to that source and retry; navigation was not dispatched.");
  const reason = unavailable(origin.owner, command);
  if (reason) throw new Error(reason);
  // Return menu/palette input to the original native editor before any asynchronous query.
  // This neither rewrites its selection nor queues/replays early keyboard input.
  void restore(origin).then(ready => {
    if (!ready) throw new Error("The original editor could not receive input or its captured source changed. Focus it and retry.");
    const reason = unavailable(origin.owner, command);
    if (reason) throw new Error(reason);
    const { binding } = origin, navigation = binding.navigation;
    origin.owner.report(""); requests.set(navigation, origin);
    const presentation: SymbolSourcePresentation = { isCurrentSource: () => current(origin), open: location => binding.open(location) };
    const snapshot = position ? { ...origin.capture.snapshot, position } : origin.capture.snapshot;
    if (command === "file-go-to-definition") void navigation.define(binding.path, snapshot, presentation);
    else void navigation.travel(command === "file-navigate-back" ? -1 : 1, binding.path, snapshot, presentation);
  }).catch(cause => origin.owner.report(cause instanceof Error ? cause.message : String(cause)));
}
function actions(owner: Owner, root: HTMLElement, retained?: Origin): FileEditorCommandActions {
  const result: FileEditorCommandActions = {};
  for (const command of shortcuts) if (!unavailable(owner, command)) result[command] = () => {
    const origin = retained ?? captureOrigin(owner, root);
    if (!origin) throw new Error("Focus the original working source editor and select a symbol first.");
    execute(origin, command);
  };
  return result;
}
/** Central keyboard eligibility is cheap; the original Pierre snapshot is read only when a command executes. */
export function focusedFileEditorCommands(root: HTMLElement, origin: Element | null): FileEditorCommandActions | undefined {
  const owner = focusedOwner(root, origin);
  return owner ? actions(owner, root) : undefined;
}
/** Capture before palette focus transfer; invocation never resolves a replacement editor. */
export function captureFileEditorCommands(root: HTMLElement, origin: Element | null): CapturedFileEditorCommands | undefined {
  const owner = focusedOwner(root, origin), captured = owner && captureOrigin(owner, root);
  return owner && captured ? { actions: actions(owner, root, captured), restoreFocus: () => restore(captured) } : undefined;
}
/** Incoming focus belongs to the dispatched operation, not a newly focused control. */
export function symbolRevealOriginInput(navigation: SymbolNavigation | undefined, requestId: string): HTMLElement | undefined {
  if (!navigation || navigation.pending?.request.id !== requestId) return;
  return requests.get(navigation)?.capture.input;
}
/** Pointer definition uses the actual clicked token without changing the original editor selection. */
export function fileDefinitionCommand(frame: HTMLElement, position: SymbolPosition): (() => void) | undefined {
  const owner = owners.get(frame), origin = owner && captureOrigin(owner, frame);
  if (!owner || !origin || unavailable(owner, "file-go-to-definition")) return;
  return () => { try { execute(origin, "file-go-to-definition", position); } catch (cause) { owner.report(cause instanceof Error ? cause.message : String(cause)); } };
}

export function SymbolNavigationControls(props: Props) {
  const [, redraw] = useReducer(value => value + 1, 0), latest = useRef(props); latest.current = props;
  const [notice, setNotice] = useState("");
  const [received, setReceived] = useState<Origin>();
  const registration = useRef<Owner | undefined>(undefined);
  const { navigation } = props.binding;
  useEffect(() => navigation.subscribe(() => {
    if (!navigation.busy && !navigation.choice && !navigation.message) requests.delete(navigation);
    redraw();
  }), [navigation]);
  useEffect(() => {
    const frame = props.frame.current;
    if (!frame) return;
    let alive = true, menuGeneration = 0;
    const owner: Owner = { frame, current: () => latest.current, report: message => { if (alive) setNotice(message); } };
    owners.set(frame, owner); registration.current = owner;
    const contextPosition = (event: MouseEvent): SymbolPosition | undefined => {
      const path = event.composedPath(), token = path.find(value => value instanceof HTMLElement && value.dataset.char !== undefined) as HTMLElement | undefined;
      const line = path.find(value => value instanceof HTMLElement && value.dataset.line !== undefined) as HTMLElement | undefined;
      if (!token || !line || !within(frame, token) || !visible(owner)) return;
      const character = Number(token.dataset.char), row = Number(line.dataset.line);
      if (!Number.isInteger(character) || character < 0 || !Number.isInteger(row) || row < 1) return;
      return { line: row, column: character + 1 };
    };
    const preserveContextSelection = (event: MouseEvent) => {
      // A secondary mousedown otherwise queues a caret change after contextmenu
      // captures the source. Prevent that gesture default, not later guard checks.
      if (event.button === 2 && contextPosition(event) && captureOrigin(owner, frame)) event.preventDefault();
    };
    const contextMenu = (event: MouseEvent) => {
      const position = contextPosition(event);
      if (!position) return;
      const origin = captureOrigin(owner, frame);
      if (!origin) return;
      event.preventDefault(); event.stopPropagation();
      const reason = unavailable(owner, "file-go-to-definition");
      const run = reason ? undefined : () => { try { execute(origin, "file-go-to-definition", position); } catch (cause) { owner.report(cause instanceof Error ? cause.message : String(cause)); } };
      if (reason) owner.report(reason);
      const native = window.agentDesktop?.showContextMenu, generation = ++menuGeneration;
      if (!native) { owner.report("The native file editor menu is unavailable. Use the command menu or a keyboard shortcut."); return; }
      const items: DesktopMenuItem[] = [{ id: "definition", label: "Go to Definition", enabled: Boolean(run) }];
      void native(items).then(id => { if (!alive || generation !== menuGeneration) return; if (id === "definition") run?.(); else if (id === null) restore(origin); }).catch(cause => { if (alive && generation === menuGeneration) owner.report(cause instanceof Error ? cause.message : String(cause)); });
    };
    frame.addEventListener("mousedown", preserveContextSelection, true);
    frame.addEventListener("contextmenu", contextMenu);
    return () => { alive = false; menuGeneration++; frame.removeEventListener("mousedown", preserveContextSelection, true); frame.removeEventListener("contextmenu", contextMenu); if (owners.get(frame) === owner) owners.delete(frame); if (!navigation.pending && requests.get(navigation)?.owner === owner) requests.delete(navigation); registration.current = undefined; };
  }, [props.frame, props.documentKey]);
  const origin = requests.get(navigation);
  const receiving = origin !== undefined && props.revealId !== undefined && props.revealId === navigation.pending?.request.id;
  useEffect(() => { if (receiving || !origin) setReceived(origin); }, [receiving, origin]);
  const own = origin !== undefined && (origin.owner === registration.current || receiving || received === origin);
  const message = notice || (own ? navigation.message : "");
  const choices = origin?.owner === registration.current ? navigation.choice : undefined;
  const cancel = () => {
    const frame = props.frame.current, owner = registration.current;
    const target = own && owner && frame ? captureOrigin(owner, frame) : undefined;
    setNotice(""); navigation.cancel(); if (target) restore(target);
  };
  const choose = async (index: number) => {
    if (!origin || !await restore(origin)) { setNotice("The original source or selection changed. Dismiss these definitions and retry."); return; }
    void navigation.choose(index);
  };
  if (!props.active) return null;
  return <>
    {(message || own && (navigation.busy || choices)) && <div className="symbol-navigation" data-symbol-navigation>
      {message && <p role="status">{message}</p>}
      {own && navigation.busy && <button type="button" onClick={cancel}>Cancel navigation</button>}
      {choices && choices.definitions.length > 1 && <div className="symbol-definition-choices" role="group" aria-label="Choose a symbol definition" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); cancel(); } }}>
        {choices.definitions.map((definition, index) => <button type="button" key={`${definition.path}:${definition.selection.start.line}:${definition.selection.start.column}:${index}`} disabled={navigation.busy}
          onClick={() => choose(index)} aria-label={`Open ${definition.path}, line ${definition.selection.start.line}, column ${definition.selection.start.column}`}>
          <span>{definition.name} · {definition.path}</span><span>{definition.selection.start.line}:{definition.selection.start.column}</span>
        </button>)}
      </div>}
      {!navigation.busy && <button type="button" onClick={cancel}>Dismiss navigation</button>}
    </div>}
  </>;
}
