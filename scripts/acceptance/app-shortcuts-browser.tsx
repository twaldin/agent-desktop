import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { installAppShortcuts, type AppShortcut } from "../../apps/desktop/src/renderer/app-shortcuts";
import { wireNativeXtermInput } from "../../apps/desktop/src/renderer/native-xterm-input";
import { ModelPicker } from "../../apps/desktop/src/renderer/ModelPicker";
import "@xterm/xterm/css/xterm.css";

const calls: AppShortcut[] = [], checks: string[] = [];
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function press(target: EventTarget, key = "n", options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true, composed: true, ...options });
  target.dispatchEvent(event); return event;
}
function mark(name: string) { checks.push(name); }
function noCommand(target: EventTarget, name: string, key?: string, options?: KeyboardEventInit) {
  const count = calls.length, event = press(target, key, options);
  assert(calls.length === count, `${name} issued an app command`); return event;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement = document.body) {
  const value = document.createElement(tag); parent.append(value); return value;
}

let nativeOff: (() => void) | undefined, nativePrompt: HTMLTextAreaElement;
const trusted: { key: string; trusted: boolean; prevented: boolean; target: string | null }[] = [];
const actions = Object.fromEntries(["new-chat", "search", "sidebar", "settings"].map(command => [command, () => calls.push(command as AppShortcut)])) as Record<AppShortcut, () => void>;

async function runAppShortcutAcceptance() {
  const prompt = node("textarea"); prompt.id = "fixture-composer"; prompt.value = "Keep this unsent prompt";
  const button = node("button"); button.textContent = "App surface";
  let blocked = false;
  let dispose = installAppShortcuts(window, { platform: "mac", actions, composer: () => prompt, blocked: () => blocked });
  try {
    prompt.focus();
    for (const [key, command] of [["n", "new-chat"], ["k", "search"], ["\\", "sidebar"], [",", "settings"]]) {
      const event = press(prompt, key);
      assert(event.defaultPrevented && calls.at(-1) === command, `composer ${key} did not invoke exactly its app command`);
    }
    assert(calls.length === 4 && prompt.value === "Keep this unsent prompt", "commands changed the controlled draft");
    button.focus(); assert(press(button).defaultPrevented && calls.at(-1) === "new-chat", "plain app surface should permit command");
    mark("composer opt-in and ordinary app focus dispatch the four existing commands once");

    const claim = (event: KeyboardEvent) => event.preventDefault();
    button.addEventListener("keydown", claim);
    noCommand(button, "earlier preventDefault"); button.removeEventListener("keydown", claim);
    const stop = (event: KeyboardEvent) => event.stopPropagation();
    button.addEventListener("keydown", stop); noCommand(button, "earlier stopPropagation"); button.removeEventListener("keydown", stop);
    blocked = true; assert(!noCommand(button, "explicit menu state").defaultPrevented, "blocked state consumed input"); blocked = false;
    mark("local handlers and explicit transient state retain ownership before the window listener");

    prompt.focus();
    assert(!noCommand(prompt, "macOS Control+N", "n", { metaKey: false, ctrlKey: true }).defaultPrevented, "Control+N consumed");
    assert(!noCommand(prompt, "macOS Control+K", "k", { metaKey: false, ctrlKey: true }).defaultPrevented, "Control+K consumed");
    noCommand(prompt, "IME event", "n", { isComposing: true });
    noCommand(prompt, "IME keyCode 229", "n", { keyCode: 229 });
    prompt.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    noCommand(prompt, "IME lifecycle with unmarked key");
    prompt.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    assert(press(prompt).defaultPrevented, "composition end did not restore app input");
    prompt.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    window.dispatchEvent(new FocusEvent("blur"));
    assert(press(prompt).defaultPrevented, "window blur left stale composition lock");
    mark("macOS text controls, both IME markers and composition lifecycle are preserved");

    for (const tag of ["input", "textarea", "select"] as const) {
      const input = node(tag); input.focus();
      assert(!noCommand(input, tag).defaultPrevented, `${tag} app command consumed`); input.remove();
    }
    const editable = node("div"); editable.contentEditable = "true"; editable.textContent = "Editor contents"; editable.focus();
    assert(!noCommand(editable, "contenteditable").defaultPrevented, "rich editor command consumed"); editable.remove();
    const shadowHost = node("div"), shadow = shadowHost.attachShadow({ mode: "open" }), shadowInput = document.createElement("textarea"); shadow.append(shadowInput); shadowInput.focus();
    assert(!noCommand(shadowInput, "shadow textarea").defaultPrevented, "shadow editor consumed"); shadowHost.remove();
    for (const className of ["editor-content", "interaction-card"]) {
      const owner = node("div"); owner.className = className; const control = node("button", owner); control.focus();
      assert(!noCommand(control, className).defaultPrevented, `${className} control consumed`); owner.remove();
    }
    const scope = node("div"); scope.dataset.appShortcuts = "off"; const custom = node("button", scope); custom.focus();
    assert(!noCommand(custom, "explicit local scope").defaultPrevented, "custom scope consumed"); scope.remove();
    mark("plain, rich and shadow editors plus request controls preserve focused ownership");

    const menu = node("div"); menu.className = "action-menu"; menu.textContent = "An open menu";
    prompt.focus(); assert(!noCommand(prompt, "rendered menu").defaultPrevented, "open menu lost ownership");
    menu.hidden = true; assert(press(prompt).defaultPrevented, "hidden menu blocked app command"); menu.remove();
    const modal = node("dialog"); const modalButton = node("button", modal); modalButton.textContent = "Modal control"; modal.showModal(); modalButton.focus();
    assert(!noCommand(modalButton, "native modal").defaultPrevented, "modal lost ownership");
    modal.close(); modal.remove(); prompt.focus(); assert(press(prompt).defaultPrevented, "closed modal still blocked");
    mark("open menus and native dialogs own commands; hidden or closed popups do not block");

    const mount = node("div"), root = createRoot(mount); let selected = "one";
    flushSync(() => root.render(<ModelPicker label="Model" value={selected} options={[{ value: "one", label: "One" }, { value: "two", label: "Two" }]} onChange={value => { selected = value; }}/>));
    mount.querySelector<HTMLButtonElement>("button")!.click(); await tick();
    const search = mount.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    assert(search === document.activeElement && mount.querySelector<HTMLDialogElement>("dialog")!.open, "production model picker did not own focus");
    noCommand(search, "production model picker command");
    const active = search.getAttribute("aria-activedescendant"); press(search, "ArrowDown", { metaKey: false }); await tick();
    assert(search.getAttribute("aria-activedescendant") !== active, "model picker arrow navigation was intercepted");
    press(search, "Enter", { metaKey: false }); await tick();
    assert(selected === "two" && !mount.querySelector("dialog"), "model picker Enter selection failed");
    assert(document.activeElement === mount.querySelector("button"), "model picker did not restore trigger focus");
    mount.querySelector<HTMLButtonElement>("button")!.click(); await tick();
    const open = mount.querySelector<HTMLDialogElement>("dialog")!;
    assert(!noCommand(open, "model picker Escape", "Escape", { metaKey: false }).defaultPrevented, "app claimed Escape");
    // Synthetic key events do not run the browser default action. Invoke the native cancel event separately.
    open.dispatchEvent(new Event("cancel", { cancelable: true })); await tick();
    assert(!mount.querySelector("dialog") && document.activeElement === mount.querySelector("button"), "picker cancel handler did not restore focus");
    flushSync(() => root.unmount()); mount.remove();
    mark("production ModelPicker keeps command, arrow, Enter and cancel/focus behavior");

    const terminalMount = node("div"); terminalMount.style.cssText = "width:600px;height:160px";
    const terminal = new Terminal({ cols: 60, rows: 5 }); terminal.open(terminalMount);
    const inputs: unknown[] = [];
    const input = wireNativeXtermInput(terminal, value => inputs.push(value), () => true, { copy: () => {}, selectAll: () => terminal.selectAll() });
    try {
      terminal.focus();
      for (const key of ["n", "k", "\\", ","]) noCommand(terminal.textarea!, `terminal Command+${key}`, key);
      for (const key of ["n", "k"]) noCommand(terminal.textarea!, `terminal Control+${key}`, key, { metaKey: false, ctrlKey: true });
      assert(JSON.stringify(inputs) === JSON.stringify([{ kind: "key", key: "C-n" }, { kind: "key", key: "C-k" }]), `native terminal mapping changed: ${JSON.stringify(inputs)}`);
      // Verify a Linux/Windows app binding also defers to the same terminal's handler.
      dispose(); dispose = installAppShortcuts(window, { platform: "other", actions, composer: () => prompt });
      noCommand(terminal.textarea!, "non-Mac terminal Control+N", "n", { metaKey: false, ctrlKey: true });
      assert(inputs.length === 3, "non-Mac native terminal key did not reach native adapter");
      prompt.focus(); assert(press(prompt, "n", { metaKey: false, ctrlKey: true }).defaultPrevented, "non-Mac composer app binding failed");
    } finally { input.dispose(); terminal.dispose(); terminalMount.remove(); }
    mark("real xterm and production native input adapter receive Control keys with no app action");

    dispose(); prompt.focus(); assert(!noCommand(prompt, "disposed listener", "n", { metaKey: false, ctrlKey: true }).defaultPrevented, "disposed listener still consumed");
    dispose = installAppShortcuts(window, { platform: "mac", actions, composer: () => prompt });
    const before = calls.length; press(prompt); assert(calls.length === before + 1, "remount duplicated listener");
    mark("cleanup and remount leave exactly one live listener");
    return { passed: true, checks, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, platform: navigator.platform, documentFocused: document.hasFocus(), scope: "Controlled DOM KeyboardEvents through the production window listener, ModelPicker and native xterm input adapter; no installed app, host or shell." };
  } finally { dispose(); document.body.replaceChildren(); }
}

function prepareTrustedAppShortcutAcceptance() {
  calls.length = 0; trusted.length = 0;
  nativePrompt = node("textarea"); nativePrompt.id = "trusted-composer"; nativePrompt.value = "Native event check"; nativePrompt.focus();
  nativeOff = installAppShortcuts(window, { actions, composer: () => nativePrompt });
  window.addEventListener("keydown", recordTrusted);
  return { focused: document.hasFocus(), active: document.activeElement?.id };
}
function recordTrusted(event: KeyboardEvent) { trusted.push({ key: event.key, trusted: event.isTrusted, prevented: event.defaultPrevented, target: (event.target as HTMLElement)?.id ?? null }); }
function finishTrustedAppShortcutAcceptance() {
  nativeOff?.(); window.removeEventListener("keydown", recordTrusted);
  const result = { events: trusted, calls: [...calls], focused: document.hasFocus(), draft: nativePrompt.value };
  if (!trusted.length && !document.hasFocus()) return { ...result, status: "deferred-unfocused-hidden-window" };
  assert(trusted.length === 1 && trusted[0]!.trusted && trusted[0]!.prevented && trusted[0]!.target === "trusted-composer" && calls.join() === "new-chat", `Electron input dispatch failed: ${JSON.stringify(result)}`);
  return { ...result, status: "passed" };
}
Object.assign(window, { runAppShortcutAcceptance, prepareTrustedAppShortcutAcceptance, finishTrustedAppShortcutAcceptance });
