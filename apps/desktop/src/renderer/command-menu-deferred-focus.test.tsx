import React from "react";
import { expect, test } from "bun:test";
import { CommandMenu, type CommandMenuAction } from "./CommandMenu";

/** Real component closures in returned JSX; no mounted Radix/ReactDOM, focus
 * trap or browser. The modal's close-autofocus notification is supplied below. */
function menu(action: CommandMenuAction) {
  class FocusOwner { isConnected = true; calls = 0; focus() { this.calls++; } }
  const opener = new FocusOwner();
  const originals = ["document", "HTMLElement"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const oldDispatcher = internals.H;
  const refs: unknown[] = [];
  let closes = 0;
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: opener } });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FocusOwner });
    internals.H = {
      useRef(value: unknown) { const ref = { current: value }; refs.push(ref); return ref; },
      useState(value: unknown) { return [typeof value === "function" ? (value as () => unknown)() : value, () => {}]; },
      useMemo(callback: () => unknown) { return callback(); },
      useEffect() {},
    };
    const tree = CommandMenu({ actions: [action], hosts: [], bridge: {}, mode: "commands", onModeChange() {}, onSelectSession() {}, onClose() { closes++; } });
    let select: (() => void) | undefined, closed: ((event: { preventDefault(): void }) => void) | undefined;
    function walk(value: unknown) {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!React.isValidElement(value)) return;
      const props = value.props as { children?: unknown; action?: CommandMenuAction; onSelect?: () => void; onCloseAutoFocus?: typeof closed };
      if (props.action?.id === action.id) select = props.onSelect;
      if (props.onCloseAutoFocus) closed = props.onCloseAutoFocus;
      walk(props.children);
    }
    walk(tree);
    if (!select || !closed) throw new Error("Actual command selection/close notification not found");
    return { select, closed, opener, get closes() { return closes; } };
  } finally {
    internals.H = oldDispatcher;
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
}

test("a deferred address action runs once after modal close, not while the command still owns focus", () => {
  for (const id of ["focusBrowserAddressBar", "newTask"]) {
    let calls = 0, prevented = 0;
    const m = menu({ id, title: id, group: "navigation", deferUntilClose: true, onSelect: () => calls++ });
    m.select(); expect(m.closes).toBe(1); expect(calls).toBe(0);
    m.select(); expect(m.closes).toBe(1); expect(calls).toBe(0);
    m.closed({ preventDefault: () => prevented++ }); expect(calls).toBe(1); expect(prevented).toBe(1); expect(m.opener.calls).toBe(0);
    m.closed({ preventDefault() {} }); expect(calls).toBe(1);
  }
});

test("ordinary action ordering and cancellation focus remain unchanged", () => {
  let calls = 0;
  const ordinary = menu({ id: "openFolder", title: "Folder", group: "workspace", onSelect: () => calls++ });
  ordinary.select(); expect(calls).toBe(1); expect(ordinary.closes).toBe(1);
  ordinary.closed({ preventDefault() {} }); expect(calls).toBe(1); expect(ordinary.opener.calls).toBe(0);
  const cancelled = menu({ id: "focusBrowserAddressBar", title: "Address", group: "navigation", deferUntilClose: true, onSelect: () => calls++ });
  cancelled.closed({ preventDefault() {} }); expect(calls).toBe(1); expect(cancelled.opener.calls).toBe(1);
});
