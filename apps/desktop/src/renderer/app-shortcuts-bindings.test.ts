import { expect, test } from "bun:test";
import { installAppShortcuts, type AppShortcutOptions } from "./app-shortcuts";
import { readAppCommandBindings } from "./app-command-bindings";
import { sidebarChatActions, type SidebarChatTarget } from "./sidebar-layout";
import { numberedMainTaskActions, type MainTaskTarget } from "./main-task-targets";

/** Listener adapter only: no Electron, browser, native keyboard or DOM layout proof. */
function inputOwner() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const document = { activeElement: null, querySelectorAll: () => [] };
  const owner = { document, navigator: { platform: "MacIntel" },
    addEventListener: (type: string, callback: (event: any) => void) => { const set = listeners.get(type) ?? new Set(); set.add(callback); listeners.set(type, set); },
    removeEventListener: (type: string, callback: (event: any) => void) => { listeners.get(type)?.delete(callback); },
  };
  const fire = (type: string, event: any = {}) => { for (const callback of listeners.get(type) ?? []) callback(event); };
  return { window: owner as unknown as Window, listeners, fire,
    key(value: string, fields: Record<string, unknown> = {}) {
      const event = { key: value, code: `Key${value.toUpperCase()}`, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 0, defaultPrevented: false,
        getModifierState: () => false, composedPath: () => [], preventDefault() { this.defaultPrevented = true; }, ...fields };
      fire("keydown", event); return event.defaultPrevented;
    },
  };
}

test("numeric task keys use saved bindings and live targets without consuming missing slots or composition", () => {
  const input = inputOwner(), selected: MainTaskTarget[] = [];
  let targets: MainTaskTarget[] = [{ kind: "chat", hostId: "home", sessionId: "s" }, { kind: "content", hostId: "work", tabId: "file", target: "session:s" }];
  const bindings = readAppCommandBindings(undefined, true).bindings;
  expect(bindings["task-tab-1"]).toEqual(["Command+1"]);
  const dispose = installAppShortcuts(input.window, () => ({ bindings, actions: numberedMainTaskActions(targets, "ltr", t => selected.push(t)) }));
  try {
    expect(input.key("2", { code: "Digit2" })).toBe(true); expect(selected).toEqual([targets[1]!]);
    expect(input.key("3", { code: "Digit3" })).toBe(false);
    input.fire("compositionstart"); targets = [targets[0]!];
    expect(input.key("1", { code: "Digit1" })).toBe(false);
    input.fire("compositionend");
    expect(input.key("1", { code: "Digit1" })).toBe(true); expect(selected[1]).toEqual(targets[0]);
    expect(input.key("2", { code: "Digit2" })).toBe(false);
    expect(input.listeners.get("keydown")?.size).toBe(1);
  } finally { dispose(); }
});

test("next/previous tab bindings repeat only while eligible and keep IME, popup and input ownership", () => {
  const input = inputOwner(); let next = 0, previous = 0, blocked = false;
  const bindings = readAppCommandBindings(undefined,true).bindings;
  expect(bindings["next-task-tab"]).toEqual(["Ctrl+Tab","Command+Shift+]","Command+Alt+Right"]);
  expect(bindings["previous-task-tab"]).toEqual(["Ctrl+Shift+Tab","Command+Shift+[","Command+Alt+Left"]);
  let actions: AppShortcutOptions["actions"] = {"next-task-tab":() => next++,"previous-task-tab":() => previous++};
  const dispose = installAppShortcuts(input.window,() => ({bindings,actions,blocked:() => blocked}));
  const tab = (fields:Record<string,unknown> = {}) => input.key("Tab",{code:"Tab",metaKey:false,ctrlKey:true,...fields});
  try {
    expect(tab()).toBe(true); expect(tab({repeat:true})).toBe(true); expect(next).toBe(2);
    expect(tab({shiftKey:true})).toBe(true); expect(previous).toBe(1);
    input.fire("compositionstart"); actions = {...actions};
    expect(tab({repeat:true})).toBe(false); input.fire("compositionend");
    blocked = true; expect(tab()).toBe(false); blocked = false;
    const editor = {nodeType:1,isContentEditable:true,closest:() => null} as unknown as HTMLElement;
    expect(tab({composedPath:() => [editor]})).toBe(false);
    actions = {}; expect(tab()).toBe(false); expect(tab({repeat:true})).toBe(false);
    expect(next).toBe(2); expect(previous).toBe(1); expect(input.listeners.get("keydown")?.size).toBe(1);
  } finally {dispose();}
});

test("numbered chat keys resolve live logical slots and preserve IME and unavailable-event ownership", () => {
  const input = inputOwner(), calls: string[] = [];
  let slots: SidebarChatTarget[] = [{ hostId: "home", sessionId: "same" }, { hostId: "work", sessionId: "same" }];
  const bindings = readAppCommandBindings(undefined, true).bindings;
  expect(bindings["thread-1"]).toEqual(["Ctrl+1"]);
  expect(bindings["thread-9"]).toEqual(["Ctrl+9"]);
  const dispose = installAppShortcuts(input.window, () => ({ bindings, actions: sidebarChatActions(slots, (session, host) => calls.push(`${host}:${session}`)) }));
  const key = (number: string) => input.key(number, { code: `Digit${number}`, metaKey: false, ctrlKey: true });
  try {
    expect(key("2")).toBe(true); expect(calls).toEqual(["work:same"]);
    expect(key("3")).toBe(false);
    input.fire("compositionstart");
    slots = [{ hostId: "other", sessionId: "new-order" }];
    expect(key("1")).toBe(false); expect(calls).toHaveLength(1);
    input.fire("compositionend");
    expect(key("1")).toBe(true); expect(calls).toEqual(["work:same", "other:new-order"]);
    expect(key("2")).toBe(false);
    slots = []; expect(key("1")).toBe(false);
    expect(input.listeners.get("keydown")?.size).toBe(1);
  } finally { dispose(); }
});

test("the installed listener reads current bindings and eligible callbacks without reinstalling through IME", () => {
  const input = inputOwner(); let calls = 0;
  let options: AppShortcutOptions = { platform: "mac", bindings: { review: ["Command+J"] }, actions: { review: () => calls++ } };
  const dispose = installAppShortcuts(input.window, () => options);
  expect(input.key("j")).toBe(true); expect(calls).toBe(1);
  input.fire("compositionstart");
  options = { ...options, bindings: { review: ["Command+R"] }, actions: { review: () => calls++ } };
  expect(input.key("r")).toBe(false); expect(calls).toBe(1);
  input.fire("compositionend");
  expect(input.key("j")).toBe(false); expect(input.key("r")).toBe(true); expect(calls).toBe(2);
  options = { ...options, actions: {} };
  expect(input.key("r")).toBe(false); expect(calls).toBe(2);
  expect(input.listeners.get("keydown")?.size).toBe(1);
  dispose(); expect(input.listeners.get("keydown")?.size).toBe(0);
});

test("prefix capture and completion execute once, while blocked popups and window blur reset progress", () => {
  const input = inputOwner(); let calls = 0, blocked = false;
  const dispose = installAppShortcuts(input.window, { platform: "mac", bindings: { review: ["Command+K Command+R"] }, actions: { review: () => calls++ }, blocked: () => blocked });
  expect(input.key("k")).toBe(true); expect(calls).toBe(0);
  expect(input.key("r")).toBe(true); expect(calls).toBe(1);
  expect(input.key("r")).toBe(false); expect(calls).toBe(1);
  input.key("k"); blocked = true; expect(input.key("r")).toBe(false);
  blocked = false; expect(input.key("r")).toBe(false);
  input.key("k"); input.fire("blur", { target: input.window }); expect(input.key("r")).toBe(false);
  expect(calls).toBe(1); dispose();
});

test("an explicit empty keymap suppresses legacy shortcuts and external prevention stays owned", () => {
  const input = inputOwner(); let calls = 0;
  let options: AppShortcutOptions = { actions: { "new-chat": () => calls++ }, bindings: {} };
  const dispose = installAppShortcuts(input.window, () => options);
  expect(input.key("n")).toBe(false); expect(calls).toBe(0);
  options = { ...options, bindings: { "new-chat": ["Command+N"] } };
  input.key("n", { defaultPrevented: true }); expect(calls).toBe(0);
  expect(input.key("n")).toBe(true); expect(calls).toBe(1); dispose();
});

test("focused and shadow editors keep input; composer allows modified singles but not application text sequences", () => {
  const input = inputOwner(); let calls = 0;
  const composer = { nodeType: 1, isContentEditable: true, contains: () => false, closest: () => null } as unknown as HTMLElement;
  const shadowEditor = { nodeType: 1, isContentEditable: true, closest: () => null } as unknown as HTMLElement;
  let captured = false;
  const captureComposer = { nodeType: 1, isContentEditable: true, contains: () => false,
    closest: (selector: string) => selector === '[data-codex-shortcut-capture]' && captured ? composer : null } as unknown as HTMLElement;
  const dispose = installAppShortcuts(input.window, { composer: () => captureComposer, platform: "mac", bindings: { review: ["Command+J", "Command+K Command+R", "R"] }, actions: { review: () => calls++ } });
  expect(input.key("j", { composedPath: () => [shadowEditor] })).toBe(false);
  expect(input.key("j", { composedPath: () => [captureComposer] })).toBe(true);
  expect(input.key("r", { metaKey: false, composedPath: () => [captureComposer] })).toBe(false);
  expect(input.key("k", { composedPath: () => [captureComposer] })).toBe(false);
  captured = true;
  expect(input.key("j", { composedPath: () => [captureComposer] })).toBe(false);
  expect(calls).toBe(1); dispose();
});

test("owned editors admit only their explicit scoped commands and capture revokes admission", () => {
  const input = inputOwner(); let local = 0, unrelated = 0, captured = false;
  const editor = { nodeType: 1, isContentEditable: true,
    closest: (selector: string) => selector.includes(".editor-content") || (captured && selector.includes("[data-codex-shortcut-capture]")) ? editor : null } as unknown as HTMLElement;
  let options: AppShortcutOptions = {
    bindings: { review: ["Command+R"], settings: ["Command+,"] },
    actions: { review: () => local++, settings: () => unrelated++ },
    ownedSurfaceActions: ["review"],
  };
  const dispose = installAppShortcuts(input.window, () => options);
  const press = (value: string) => input.key(value, { composedPath: () => [editor] });
  try {
    expect(press("r")).toBe(true);
    expect(local).toBe(1);
    expect(press(",")).toBe(false);
    expect(unrelated).toBe(0);
    options = { ...options, ownedSurfaceActions: [] };
    expect(press("r")).toBe(false);
    options = { ...options, ownedSurfaceActions: ["review"] };
    captured = true;
    expect(press("r")).toBe(false);
    expect(local).toBe(1);
  } finally { dispose(); }
});

test("resolved file Forward owns the native shifted-Minus event", () => {
  const input = inputOwner(), calls: string[] = [];
  const editor = { nodeType: 1, isContentEditable: true,
    closest: (selector: string) => selector.includes(".editor-content") ? editor : null } as unknown as HTMLElement;
  const dispose = installAppShortcuts(input.window, {
    bindings: readAppCommandBindings(undefined, true).bindings,
    actions: { "file-navigate-back": () => calls.push("back"), "file-navigate-forward": () => calls.push("forward") },
    inputActions: ["file-navigate-back", "file-navigate-forward"],
    ownedSurfaceActions: ["file-navigate-back", "file-navigate-forward"],
  });
  try {
    const consumed = input.key("_", { code: "Minus", metaKey: false, ctrlKey: true, shiftKey: true, composedPath: () => [editor] });
    expect(calls).toEqual(["forward"]);
    expect(consumed).toBe(true);
  } finally { dispose(); }
});

test("file Forward physical spelling preserves saved logical underscore and live remaps", () => {
  const input = inputOwner(), calls: string[] = [];
  const editor = { nodeType: 1, isContentEditable: true,
    closest: (selector: string) => selector.includes(".editor-content") ? editor : null } as unknown as HTMLElement;
  const resolve = (overrides: { command: string; keys: string[] }[]) => readAppCommandBindings({
    key: "general.commandKeymap", deleted: false, value: { version: 1, platform: "mac", overrides },
    revision: { counter: 1, actor: "00000000-0000-4000-8000-000000000001", opId: "00000000-0000-4000-8000-000000000002" },
  }, true).bindings;
  let bindings = resolve([{ command: "file.navigateBack", keys: ["Ctrl+Shift+_"] }]);
  const dispose = installAppShortcuts(input.window, () => ({
    bindings,
    actions: { "file-navigate-back": () => calls.push("back"), "file-navigate-forward": () => calls.push("forward") },
    inputActions: ["file-navigate-back", "file-navigate-forward"],
    ownedSurfaceActions: ["file-navigate-back", "file-navigate-forward"],
  }));
  const shiftedMinus = () => input.key("_", { code: "Minus", metaKey: false, ctrlKey: true, shiftKey: true, composedPath: () => [editor] });
  try {
    expect(shiftedMinus()).toBe(true);
    expect(calls).toEqual(["back"]);
    bindings = resolve([{ command: "file.navigateForward", keys: ["Command+J"] }]);
    expect(shiftedMinus()).toBe(false);
    expect(input.key("j", { composedPath: () => [editor] })).toBe(true);
    expect(calls).toEqual(["back", "forward"]);
    bindings = resolve([{ command: "file.navigateForward", keys: [] }]);
    expect(shiftedMinus()).toBe(false);
    expect(input.key("_", { code: "Minus", metaKey: false, shiftKey: true, composedPath: () => [editor] })).toBe(false);
    expect(calls).toEqual(["back", "forward"]);
  } finally { dispose(); }
});
