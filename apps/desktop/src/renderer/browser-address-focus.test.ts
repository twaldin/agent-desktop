import { expect, test } from "bun:test";
import { browserAddressFocusOwner, browserAddressTarget, withBrowserAddressShortcut } from "./browser-address-focus";
import { installAppShortcuts, type AppShortcutOptions } from "./app-shortcuts";
import { APP_COMMAND_BINDING_OWNERS, readAppCommandBindings } from "./app-command-bindings";

// Controlled document/listener model only. No browser layout, React commit, OS
// focus, native page input or provider is executed by these tests.
class Node {
  nodeType = 1;
  parent: Node | null = null;
  children: Node[] = [];
  attributes: Record<string, string> = {};
  dataset: Record<string, string> = {};
  disabled = false;
  isConnected = true;
  isContentEditable = false;
  shadowRoot: { activeElement: Node } | null = null;
  painted = true;
  scrollLeft = 10;
  focused = 0;
  selected = 0;
  selection = [2, 4];
  constructor(readonly tag: string, readonly ownerDocument: ModelDocument, attrs: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(attrs)) this.attributes[key] = value;
  }
  add(tag: string, attrs: Record<string, string> = {}) { const child = new Node(tag, this.ownerDocument, attrs); child.parent = this; this.children.push(child); return child; }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  matches(selectors: string): boolean {
    return selectors.split(",").some(raw => {
      const selector = raw.trim();
      const tag = /^[a-z]+/.exec(selector)?.[0];
      if (tag && tag !== this.tag) return false;
      const cls = /\.([\w-]+)/.exec(selector)?.[1];
      if (cls && !this.attributes.class?.split(" ").includes(cls)) return false;
      return [...selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].every(([, key, value]) => Object.hasOwn(this.attributes, key!) && (value === undefined || this.attributes[key!] === value));
    });
  }
  closest(selector: string): Node | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  querySelectorAll(selector: string): Node[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  getClientRects() { return this.painted ? [{}] : []; }
  focus() { this.focused++; this.ownerDocument.activeElement = this; }
  select() { this.selected++; this.selection = [0, 40]; }
}
class ModelDocument {
  activeElement: Node | null = null;
  body = new Node("body", this);
  defaultView = { getComputedStyle: () => ({ visibility: "visible" }) };
  querySelectorAll(selector: string) { return this.body.querySelectorAll(selector); }
}
const owner = JSON.stringify(["home", "session"]);
function scene(focusOwner = owner) {
  const owner = focusOwner;
  const document = new ModelDocument(), root = document.body.add("div", { "data-browser-current-owner": owner }), main = root.add("main", { "data-main-task-chat": "" });
  const composer = main.add("div", { contenteditable: "true", "data-codex-composer": "" }); composer.isContentEditable = true;
  const panel = (destination: string) => {
    const dock = root.add("section", { "data-dock-destination": destination, "data-open": "true" });
    const content = dock.add("div");
    const browser = content.add("section", { class: "browser-panel" });
    const input = browser.add("input", { "data-browser-address-owner": owner, role: "combobox" }); input.dataset.browserAddressOwner = owner;
    const page = browser.add("textarea");
    return { dock, content, browser, input, page };
  };
  const bottom = panel("bottom"), side = panel("right"); // Deliberately reverse DOM order.
  document.activeElement = document.body;
  return { document, root, main, composer, bottom, side, rootElement: root as unknown as HTMLElement };
}
function keyboard(document: ModelDocument) {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const window = { document, navigator: { platform: "MacIntel" },
    addEventListener(type: string, listener: (event: any) => void) { const set = listeners.get(type) ?? new Set(); set.add(listener); listeners.set(type, set); },
    removeEventListener(type: string, listener: (event: any) => void) { listeners.get(type)?.delete(listener); },
  };
  const fire = (type: string, event: any = {}) => { for (const listener of listeners.get(type) ?? []) listener(event); };
  const event = (fields: Record<string, unknown> = {}) => ({ key: "l", code: "KeyL", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 0, defaultPrevented: false,
    getModifierState: () => false, composedPath: () => document.activeElement ? [document.activeElement] : [], preventDefault() { this.defaultPrevented = true; }, ...fields });
  return { window: window as unknown as Window, fire, event, listeners, key(fields: Record<string, unknown> = {}) { const value = event(fields); fire("keydown", value); return value.defaultPrevented; } };
}

test("visible browser ownership prefers the side fallback, exact focused browser and main composer", () => {
  const s = scene(), target = (origin?: Node | null) => browserAddressTarget(s.rootElement, owner, origin as unknown as Element) as unknown as Node | undefined;
  expect(target()).toBe(s.side.input);
  s.root.attributes["aria-hidden"] = "true"; // Modal AX hiding must not erase palette targets.
  expect(target()).toBe(s.side.input);
  delete s.root.attributes["aria-hidden"];
  expect(target(s.composer)).toBe(s.side.input);
  expect(target(s.bottom.page)).toBe(s.bottom.input);
  expect(target(s.bottom.input)).toBe(s.bottom.input);
  expect(target(s.side.dock.add("button"))).toBe(s.side.input);
  expect(target(s.main.add("button"))).toBe(s.side.input);
  expect(target(s.root.add("input"))).toBeUndefined();
  expect(target(s.bottom.dock.add("div", { class: "editor-content" }).add("textarea"))).toBeUndefined();
  expect(target(s.root.add("button"))).toBeUndefined();
  const shadow = s.root.add("div"); shadow.shadowRoot = { activeElement: s.bottom.page };
  expect(target(shadow)).toBe(s.bottom.input);
});

test("closed, inactive, absent, foreign and disconnected targets cannot receive focus or open a fallback from another browser", () => {
  const s = scene();
  const target = () => browserAddressTarget(s.rootElement, owner) as unknown as Node | undefined;
  s.side.dock.attributes["data-open"] = "false"; expect(target()).toBe(s.bottom.input);
  s.bottom.content.attributes.hidden = ""; expect(target()).toBeUndefined();
  delete s.bottom.content.attributes.hidden;
  s.bottom.content.attributes.inert = ""; expect(target()).toBeUndefined();
  delete s.bottom.content.attributes.inert;
  s.bottom.input.disabled = true; expect(target()).toBeUndefined(); s.bottom.input.disabled = false;
  s.bottom.input.dataset.browserAddressOwner = JSON.stringify(["work", "session"]); expect(target()).toBeUndefined();
  s.bottom.input.dataset.browserAddressOwner = owner;
  s.bottom.input.painted = false; expect(target()).toBeUndefined(); s.bottom.input.painted = true;
  s.bottom.input.isConnected = false; expect(target()).toBeUndefined(); s.bottom.input.isConnected = true;
  expect(browserAddressTarget(s.rootElement, undefined)).toBeUndefined();
  s.document.activeElement = s.side.page; expect(target()).toBeUndefined();
});

test("focus preserves a dirty address range, selects a clean address, and revalidates a saved palette action", () => {
  const s = scene(); s.document.activeElement = s.bottom.page;
  const action = withBrowserAddressShortcut({ actions: {} }, s.rootElement, owner).actions["browser-address"]!;
  s.bottom.input.dataset.browserAddressDraft = "true";
  action(); expect(s.document.activeElement).toBe(s.bottom.input); expect(s.bottom.input.selection).toEqual([2, 4]); expect(s.bottom.input.selected).toBe(0);
  delete s.bottom.input.dataset.browserAddressDraft;
  action(); expect(s.bottom.input.selected).toBe(1); expect(s.bottom.input.scrollLeft).toBe(0);
  s.bottom.content.attributes.hidden = "";
  action(); expect(s.bottom.input.focused).toBe(2); expect(s.side.input.focused).toBe(0);
});

test("deferred address action rejects a changed live App owner without selecting a replacement", () => {
  for (const nextOwner of [JSON.stringify(["work", "session"]), JSON.stringify(["home", "other-session"]), undefined]) {
    const s = scene(); s.document.activeElement = s.bottom.page;
    const action = withBrowserAddressShortcut({ actions: {} }, s.rootElement, owner).actions["browser-address"]!;
    // The original remains connected, visible, enabled and marked with its old
    // native owner. Only the App route/suppression boundary changes on commit.
    if (nextOwner === undefined) delete s.root.attributes["data-browser-current-owner"];
    else s.root.attributes["data-browser-current-owner"] = nextOwner;
    s.side.input.dataset.browserAddressOwner = nextOwner ?? owner;
    action();
    expect(s.bottom.input.focused).toBe(0); expect(s.bottom.input.selected).toBe(0);
    expect(s.side.input.focused).toBe(0); expect(s.document.activeElement).toBe(s.bottom.page);
  }
});

test("deferred address action with the same live App owner still uses only its original node", () => {
  const s = scene(); s.document.activeElement = s.bottom.page;
  const action = withBrowserAddressShortcut({ actions: {} }, s.rootElement, owner).actions["browser-address"]!;
  s.bottom.input.dataset.browserAddressDraft = "true";
  action(); expect(s.bottom.input.focused).toBe(1); expect(s.bottom.input.selection).toEqual([2, 4]);
  s.bottom.input.isConnected = false;
  action(); expect(s.bottom.input.focused).toBe(1); expect(s.side.input.focused).toBe(0);
});

test("installed address command uses resolved keys and clears the legacy binding without forwarding to another app action", () => {
  const s = scene(), k = keyboard(s.document); s.document.activeElement = s.composer;
  const defaults = readAppCommandBindings(undefined, true).bindings;
  expect(APP_COMMAND_BINDING_OWNERS.focusBrowserAddressBar).toBe("browser-address");
  expect(defaults["browser-address"]).toEqual(["CmdOrCtrl+L"]);
  let options: AppShortcutOptions = { platform: "mac", composer: () => s.composer as unknown as HTMLElement, bindings: defaults, actions: {} };
  const dispose = installAppShortcuts(k.window, () => withBrowserAddressShortcut(options, s.rootElement, owner));
  try {
    expect(k.key()).toBe(true); expect(s.side.input.focused).toBe(1);
    options = { ...options, bindings: { "browser-address": ["Command+J"] } };
    expect(k.key()).toBe(false); expect(k.key({ key: "j", code: "KeyJ" })).toBe(true);
    options = { ...options, bindings: { "browser-address": [] } };
    expect(k.key()).toBe(false); expect(k.key({ key: "j", code: "KeyJ" })).toBe(false);
    expect(s.side.input.focused).toBe(2);
  } finally { dispose(); }
});

test("page input arbitration runs before forwarding, once per event, and never hijacks text, IME, popups or capture editors", () => {
  const s = scene(), k = keyboard(s.document); s.document.activeElement = s.bottom.page;
  let blocked = false, other = 0;
  let bindings: AppShortcutOptions["bindings"] = { "browser-address": ["Command+Enter"], "new-chat": ["Command+N"] };
  const dispose = installAppShortcuts(k.window, () => withBrowserAddressShortcut({ platform: "mac", bindings, blocked: () => blocked, actions: { "new-chat": () => other++ } }, s.rootElement, owner));
  let forwards = 0;
  try {
    const value = k.event({ key: "Enter", code: "Enter" });
    dispose.handleKey(value as unknown as KeyboardEvent);
    if (!value.defaultPrevented) forwards++;
    k.fire("keydown", value);
    expect(value.defaultPrevented).toBe(true); expect(forwards).toBe(0); expect(s.bottom.input.focused).toBe(1);
    expect(k.key({ key: "n", code: "KeyN" })).toBe(false); expect(other).toBe(0);
    bindings = { "browser-address": ["CmdOrCtrl+L", "L", "Command+K Command+L"] };
    for (const fields of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { getModifierState: () => true }, { altKey: true }, { shiftKey: true }, { ctrlKey: true }, { metaKey: false }]) expect(k.key(fields)).toBe(false);
    const prevented = k.event({ defaultPrevented: true }); k.fire("keydown", prevented); expect(s.bottom.input.focused).toBe(1);
    expect(k.key({ key: "k", code: "KeyK" })).toBe(false); // No application sequences in editables.
    k.fire("compositionstart"); bindings = { "browser-address": ["Command+J"] };
    expect(k.key({ key: "j", code: "KeyJ" })).toBe(false); k.fire("compositionend");
    blocked = true; expect(k.key({ key: "j", code: "KeyJ" })).toBe(false); blocked = false;
    const popup = s.root.add("div", { role: "menu" }); expect(k.key({ key: "j", code: "KeyJ" })).toBe(false); popup.painted = false;
    s.bottom.input.attributes["data-codex-shortcut-capture"] = ""; expect(k.key({ key: "j", code: "KeyJ" })).toBe(false); delete s.bottom.input.attributes["data-codex-shortcut-capture"];
    expect(k.key({ key: "j", code: "KeyJ" })).toBe(true); expect(s.bottom.input.focused).toBe(2);
    expect(k.listeners.get("keydown")?.size).toBe(1);
  } finally { dispose(); }
});

test("composer-to-browser address dispatch is absent when suppressed and works through the installed listener when eligible", () => {
  const s = scene(), k = keyboard(s.document); s.document.activeElement = s.composer;
  let eligibleOwner: string | undefined;
  const bindings = readAppCommandBindings(undefined, true).bindings;
  const dispose = installAppShortcuts(k.window, () => withBrowserAddressShortcut({ bindings, composer: () => s.composer as unknown as HTMLElement, actions: {} }, s.rootElement, eligibleOwner));
  try {
    expect(k.key()).toBe(false); expect(s.side.input.focused).toBe(0);
    eligibleOwner = owner;
    expect(k.key()).toBe(true); expect(s.side.input.focused).toBe(1);
    eligibleOwner = undefined;
    expect(k.key()).toBe(false); expect(s.side.input.focused).toBe(1);
  } finally { dispose(); }
});


test("draft address command uses the installed listener and the current draft group only", () => {
  const current = browserAddressFocusOwner("home", "draft", "original");
  expect(current).toBe(JSON.stringify(["draft", "home", "original"]));
  expect(browserAddressFocusOwner("home", "session", "original")).toBe(JSON.stringify(["home", "original"]));
  const s = scene(current), k = keyboard(s.document); s.document.activeElement = s.composer;
  const options: AppShortcutOptions = { platform: "mac", bindings: readAppCommandBindings(undefined, true).bindings,
    composer: () => s.composer as unknown as HTMLElement, actions: {} };
  let liveOwner: string | undefined = current;
  const dispose = installAppShortcuts(k.window, () => withBrowserAddressShortcut(options, s.rootElement, liveOwner));
  try {
    expect(k.key()).toBe(true); expect(s.side.input.focused).toBe(1); expect(s.bottom.input.focused).toBe(0);
    s.document.activeElement = s.bottom.page; s.bottom.input.dataset.browserAddressDraft = "true";
    expect(k.key()).toBe(true); expect(s.bottom.input.selection).toEqual([2, 4]); expect(s.bottom.input.selected).toBe(0);
    const retained = withBrowserAddressShortcut(options, s.rootElement, liveOwner).actions["browser-address"]!;
    liveOwner = browserAddressFocusOwner("home", "draft", "different"); s.root.attributes["data-browser-current-owner"] = liveOwner;
    retained(); expect(s.bottom.input.focused).toBe(1); expect(k.key()).toBe(false);
    liveOwner = undefined; delete s.root.attributes["data-browser-current-owner"];
    expect(k.key()).toBe(false); expect(s.side.input.focused).toBe(1);
  } finally { dispose(); }
});

test("draft address fallback excludes foreign hosts, sessions and draft scopes without selecting replacement input", () => {
  const current = browserAddressFocusOwner("home", "draft", "original");
  for (const foreign of [browserAddressFocusOwner("work", "draft", "original"), browserAddressFocusOwner("home", "draft", "other"), browserAddressFocusOwner("home", "session", "original")]) {
    const s = scene(current); s.bottom.input.dataset.browserAddressOwner = foreign;
    s.document.activeElement = s.bottom.page; expect(browserAddressTarget(s.rootElement, current)).toBeUndefined();
    s.document.activeElement = s.composer; expect(browserAddressTarget(s.rootElement, current)).toBe(s.side.input as unknown as HTMLInputElement);
    const retained = withBrowserAddressShortcut({ actions: {} }, s.rootElement, current).actions["browser-address"]!;
    s.side.input.isConnected = false; retained(); expect(s.side.input.focused).toBe(0); expect(s.bottom.input.focused).toBe(0);
  }
});
