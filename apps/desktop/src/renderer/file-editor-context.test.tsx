import React from "react";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import type { SymbolLocation } from "../../../../packages/shared/src/symbol-navigation";
import { WorkspaceService } from "../../../host/src/workspace/service";
import { WorkspaceState } from "./workspace-state";
import { SymbolNavigation, type SymbolEditorSnapshot } from "./symbol-navigation";
import { captureFileEditorCommands, SymbolNavigationControls, type CapturedFileEditorCommands } from "./SymbolNavigationControls";
import { CommandMenuSearchButton } from "./CommandMenuSearchButton";

// Actual component effects and captured command, with a real compiler/service.
// DOM/default-action ordering and native-menu replies are controlled boundaries;
// this is not browser-default-action, physical-pointer or native-menu acceptance.
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "file-context-regression-"));
  const source = 'import { first, second } from "./target.js";\nfirst();\nsecond();\n';
  const targetText = 'export function first() { return 1; }\nexport function second() { return 2; }\n';
  await writeFile(join(cwd, "source.ts"), source); await writeFile(join(cwd, "target.ts"), targetText);
  await writeFile(join(cwd, "tsconfig.json"), '{"compilerOptions":{"noLib":true,"module":"nodenext","moduleResolution":"nodenext"}}');
  const service = new WorkspaceService(cwd), target = { projectId: "context-project" }, requests: unknown[] = [];
  const bridge: Pick<DesktopBridge, "workspaceQuery" | "subscribe" | "command"> = {
    subscribe: () => () => {}, command: async () => { throw new Error("Context navigation cannot write files"); },
    workspaceQuery: async (_owner, query) => {
      if (query.type === "file.read") return { type: query.type, content: await service.readText(query.path) };
      if (query.type === "file.symbol-context") return { type: query.type, workspaceIdentity: await service.symbolContext() };
      if (query.type === "file.definitions") { requests.push(query.request); return { type: query.type, workspaceIdentity: await service.symbolContext(), result: await service.symbolDefinitions(query.request) }; }
      throw new Error("Unexpected query");
    },
  };
  const data = new WorkspaceState(bridge, "context-host", target, { read: async () => null, write: async () => {} });
  data.restored = true; data.setConnected(true); await data.read("source.ts"); await data.read("target.ts");
  const navigation = new SymbolNavigation(data), opened: SymbolLocation[] = [];
  let point = { line: 3, column: 3 }, editor: object = {}, hidden = false;
  type Listener = (event: MouseEvent) => void;
  class DocumentFixture {
    activeElement: ElementFixture | null = null;
    listeners = new Map<string, Array<(event: Event) => void>>();
    defaultView = { getComputedStyle: () => ({ visibility: "visible" }),
      addEventListener: (type: string, listener: (event: Event) => void) => this.addEventListener(type, listener),
      removeEventListener: (type: string, listener: (event: Event) => void) => this.removeEventListener(type, listener) };
    addEventListener(type: string, listener: (event: Event) => void) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
    removeEventListener(type: string, listener: (event: Event) => void) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener)); }
    dispatch(type: string, fields: Record<string, unknown>) { for (const listener of this.listeners.get(type) ?? []) listener({ type, ...fields } as unknown as Event); }
  }
  const documentFixture = new DocumentFixture();
  class ElementFixture {
    isConnected = true;
    parentElement: ElementFixture | null = null;
    dataset: Record<string, string> = {};
    listeners = new Map<string, Listener[]>();
    ownerDocument: DocumentFixture = documentFixture;
    editorInput?: ElementFixture;
    closest() { return hidden && this === frame ? frame : null; }
    querySelector() { return this.editorInput ? { shadowRoot: { querySelector: () => this.editorInput } } : null; }
    contains(candidate: ElementFixture | null) { for (let node = candidate; node; node = node.parentElement) if (node === this) return true; return false; }
    focus() { const previous = documentFixture.activeElement; documentFixture.activeElement = this; documentFixture.dispatch("focusin", { target: this, relatedTarget: previous }); }
    getBoundingClientRect() { return { x: 0, y: 0, width: 640, height: 300 }; }
    getRootNode() { return this.ownerDocument; }
    addEventListener(type: string, listener: Listener) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
    removeEventListener(type: string, listener: Listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(value => value !== listener)); }
  }
  const workbench = new ElementFixture(), frame = new ElementFixture(), line = new ElementFixture(), token = new ElementFixture();
  const otherFrame = new ElementFixture(), otherInput = new ElementFixture(), search = new ElementFixture(), intermediate = new ElementFixture();
  frame.parentElement = workbench; otherFrame.parentElement = workbench; otherInput.parentElement = otherFrame; otherFrame.editorInput = otherInput;
  let input = new ElementFixture(); input.parentElement = frame; frame.editorInput = input; line.parentElement = input; token.parentElement = line;
  line.dataset.line = "2"; token.dataset.char = "0";
  const globals = ["window", "HTMLElement", "ShadowRoot"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  let menuReply: ((id: string | null) => void) | undefined;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { agentDesktop: { showContextMenu: () => new Promise<string | null>(resolve => { menuReply = resolve; }) } } });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: ElementFixture });
  Object.defineProperty(globalThis, "ShadowRoot", { configurable: true, value: class {} });
  // Same pinned React-19 controlled-dispatcher seam as existing renderer tests.
  const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const previous = internals.H, effects: Array<() => void | (() => void)> = [], cleanups: Array<() => void> = [];
  let searchCapture: CapturedFileEditorCommands | null = null;
  let searchProps!: React.ComponentProps<"button">;
  internals.H = {
    useRef: (value: unknown) => ({ current: value }),
    useState: (value: unknown) => [value, () => {}],
    useReducer: (_reducer: unknown, value: unknown) => [value, () => {}],
    useEffect: (effect: () => void | (() => void)) => effects.push(effect),
    useLayoutEffect: (effect: () => void | (() => void)) => effects.push(effect),
  };
  try {
    // Controlled DOM object exposes precisely the methods this public component uses.
    SymbolNavigationControls({ documentKey: "source-owner", frame: { current: frame as unknown as HTMLDivElement }, active: true,
      binding: { navigation, path: "source.ts", isCurrentSource: () => true, open: location => { opened.push(location); } },
      capture: () => ({ editor, input: input as unknown as HTMLElement, snapshot: { text: data.documents.get("source.ts")!.text,
        selections: [{ start: { ...point }, end: { ...point }, direction: "forward" }] } satisfies SymbolEditorSnapshot }),
      focus: async candidate => { if (candidate !== editor || !input.isConnected) return false; input.focus(); return true; },
    });
    SymbolNavigationControls({ documentKey: "other-owner", frame: { current: otherFrame as unknown as HTMLDivElement }, active: true,
      binding: { navigation, path: "target.ts", isCurrentSource: () => true, open: location => { opened.push(location); } },
      capture: () => ({ editor: otherFrame, input: otherInput as unknown as HTMLElement, snapshot: { text: data.documents.get("target.ts")!.text,
        selections: [{ start: { line: 1, column: 20 }, end: { line: 1, column: 20 }, direction: "forward" }] } satisfies SymbolEditorSnapshot }),
      focus: async candidate => { if (candidate !== otherFrame) return false; otherInput.focus(); return true; },
    });
    searchProps = (CommandMenuSearchButton({ title: "Search", expanded: false, children: "Search",
      captureFileEditor: () => captureFileEditorCommands(workbench as unknown as HTMLElement, documentFixture.activeElement as unknown as Element | null),
      onOpen: capture => { searchCapture = capture; },
    }) as React.ReactElement<React.ComponentProps<"button">>).props;
    if (searchProps.ref && typeof searchProps.ref === "object") searchProps.ref.current = search as unknown as HTMLButtonElement;
    for (const effect of effects) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }
  } finally { internals.H = previous; }
  const event = (button: number) => {
    let prevented = false;
    return { button, get defaultPrevented() { return prevented; }, preventDefault() { prevented = true; }, stopPropagation() {},
      composedPath: () => [token, line, input, frame] };
  };
  const dispatch = (type: string, value: ReturnType<typeof event>) => {
    // Explicit event fixture at the controlled DOM boundary, not a real MouseEvent.
    for (const listener of frame.listeners.get(type) ?? []) listener(value as unknown as MouseEvent);
  };
  const key = (value: string, altKey = false) => documentFixture.dispatch("keydown", { key: value, target: documentFixture.activeElement,
    ctrlKey: false, metaKey: false, altKey, shiftKey: value === "Tab" });
  const settle = async () => {
    await Bun.sleep(0);
    const deadline = Date.now() + 10_000;
    while (navigation.busy && opened.length === 0) { if (Date.now() > deadline) throw new Error("Compiler did not settle"); await Bun.sleep(1); }
  };
  return { data, navigation, opened, requests, source,
    context() {
      const down = event(2); dispatch("mousedown", down); dispatch("contextmenu", event(2));
      // Browser gesture observed in red021/diagnostic023: context capture occurs
      // before the gesture's queued selectionchange commits the clicked caret.
      if (!down.defaultPrevented) point = { line: 2, column: 4 };
    },
    primaryPointer() {
      const down = event(0); dispatch("mousedown", down);
      if (!down.defaultPrevented) point = { line: 2, column: 4 };
    },
    async choose() {
      if (!menuReply) throw new Error("The actual component did not request its native menu");
      menuReply("definition");
      await settle();
    },
    searchKeyboard(interveningInteraction = false) {
      input.focus(); key("Alt", true); key("Tab", true); intermediate.focus();
      if (interveningInteraction) key("x");
      key("Alt", true); key("Tab", true); search.focus(); key("Enter");
      searchProps.onClick?.({ detail: 0 } as React.MouseEvent<HTMLButtonElement>);
    },
    searchPointer() {
      input.focus(); documentFixture.dispatch("pointerdown", { target: search });
      searchProps.onPointerDown?.({ button: 0 } as React.PointerEvent<HTMLButtonElement>);
      search.focus(); searchProps.onClick?.({ detail: 1 } as React.MouseEvent<HTMLButtonElement>);
    },
    async chooseSearch() { searchCapture?.actions["file-go-to-definition"]?.(); await settle(); },
    restoreSearch() { return searchCapture?.restoreFocus() ?? false; },
    focusedSource: () => documentFixture.activeElement === input,
    focusedOther: () => documentFixture.activeElement === otherInput,
    changeSelection() { point = { line: 3, column: 4 }; },
    edit() { data.edit("source.ts", source + "// later edit\n"); },
    replaceEditor() { editor = {}; },
    replaceInput() { input.isConnected = false; input = new ElementFixture(); input.parentElement = frame; frame.editorInput = input; },
    hide() { hidden = true; },
    selection: () => ({ ...point }),
    async close() {
      for (const cleanup of cleanups.reverse()) cleanup(); navigation.cancel(); data.stop();
      for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test("context Definition resolves the clicked first token without invalidating its own captured caret", async () => {
  const f = await fixture();
  try {
    f.context(); await f.choose();
    expect(f.opened.map(location => ({ path: location.path, start: location.selection.start, end: location.selection.end }))).toEqual([
      { path: "target.ts", start: { line: 1, column: 17 }, end: { line: 1, column: 22 } },
    ]);
    expect(f.selection()).toEqual({ line: 3, column: 3 });
    expect(f.data.documents.get("source.ts")?.text).toBe(f.source);
  } finally { await f.close(); }
}, 60_000);

for (const change of ["changeSelection", "edit", "replaceEditor", "replaceInput", "hide"] as const) {
  test(`a captured context Definition refuses a later ${change}`, async () => {
    const f = await fixture();
    try {
      f.context(); f[change](); await f.choose();
      expect(f.requests).toEqual([]);
      expect(f.opened).toEqual([]);
      expect(f.data.documents.get("source.ts")?.text).toBe(change === "edit" ? f.source + "// later edit\n" : f.source);
    } finally { await f.close(); }
  }, 60_000);
}

test("ordinary primary-pointer caret placement remains available", async () => {
  const f = await fixture();
  try {
    f.primaryPointer();
    expect(f.selection()).toEqual({ line: 2, column: 4 });
    expect(f.data.documents.get("source.ts")?.text).toBe(f.source);
  } finally { await f.close(); }
}, 60_000);

test("keyboard Search keeps the original source through Tab focus transfer and cancellation", async () => {
  const f = await fixture();
  try {
    f.searchKeyboard();
    expect(await f.restoreSearch()).toBe(true);
    expect(f.focusedSource()).toBe(true);
    expect(f.selection()).toEqual({ line: 3, column: 3 });
    await f.chooseSearch();
    expect(f.opened.map(location => ({ path: location.path, start: location.selection.start, end: location.selection.end }))).toEqual([
      { path: "target.ts", start: { line: 2, column: 17 }, end: { line: 2, column: 23 } },
    ]);
    expect(f.data.documents.get("source.ts")?.text).toBe(f.source);
  } finally { await f.close(); }
}, 60_000);

test("Search discards the original source after an intervening control interaction", async () => {
  const f = await fixture();
  try {
    f.searchKeyboard(true); await f.chooseSearch();
    expect(await f.restoreSearch()).toBe(false);
    expect(f.requests).toEqual([]);
    expect(f.opened).toEqual([]);
    expect(f.focusedOther()).toBe(false);
  } finally { await f.close(); }
}, 60_000);

test("Search never substitutes a visible editor after its original selection changes", async () => {
  const f = await fixture();
  try {
    f.searchKeyboard(); f.changeSelection(); await expect(f.chooseSearch()).rejects.toBeInstanceOf(Error);
    expect(await f.restoreSearch()).toBe(false);
    expect(f.requests).toEqual([]);
    expect(f.opened).toEqual([]);
    expect(f.focusedOther()).toBe(false);
  } finally { await f.close(); }
}, 60_000);

test("pointer Search retains its original source before the button takes focus", async () => {
  const f = await fixture();
  try {
    f.searchPointer(); await f.chooseSearch();
    expect(f.opened.map(location => ({ path: location.path, start: location.selection.start, end: location.selection.end }))).toEqual([
      { path: "target.ts", start: { line: 2, column: 17 }, end: { line: 2, column: 23 } },
    ]);
    expect(f.data.documents.get("source.ts")?.text).toBe(f.source);
  } finally { await f.close(); }
}, 60_000);
