import { expect, test } from "bun:test";
import { acceleratorStroke, KeyboardAcceleratorMatcher, type AcceleratorKeyEvent } from "./keyboard-accelerators";

function key(value: string, changes: Partial<AcceleratorKeyEvent> = {}): AcceleratorKeyEvent {
  return { key: value, code: /^[a-z]$/i.test(value) ? `Key${value.toUpperCase()}` : "", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 0, defaultPrevented: false, getModifierState: () => false, ...changes };
}

test("held single-stroke tab keys repeat without advancing or resetting sequences or repeating other owners", () => {
  const matcher = new KeyboardAcceleratorMatcher("mac");
  const bindings = [{command:"cycle",keys:["Ctrl+Tab","Command+K Command+R"],allowsKeyRepeat:true}, {command:"send",keys:["Command+Enter"]}];
  const repeatTab = key("Tab",{code:"Tab",metaKey:false,ctrlKey:true,repeat:true});
  expect(matcher.match(repeatTab,bindings,0)).toEqual({type:"command",command:"cycle"});
  expect(matcher.match(key("Enter",{repeat:true}),bindings,1)).toBeUndefined();
  expect(matcher.match(key("k",{repeat:true}),bindings,2)).toBeUndefined();
  expect(matcher.match(key("k"),bindings,3)).toEqual({type:"prefix"});
  expect(matcher.match(key("r",{repeat:true}),bindings,4)).toBeUndefined();
  expect(matcher.match(repeatTab,bindings,5)).toEqual({type:"command",command:"cycle"});
  expect(matcher.match(key("Dead",{repeat:true}),bindings,6)).toBeUndefined();
  expect(matcher.match(key("r"),bindings,7)).toEqual({type:"command",command:"cycle"});
  expect(matcher.match(repeatTab,[],8)).toBeUndefined();
  expect(matcher.match({...repeatTab,isComposing:true},bindings,9)).toBeUndefined();
  expect(matcher.match(key("x",{metaKey:false,repeat:true}),[{command:"cycle",keys:["X"],allowsKeyRepeat:true}],10,true)).toBeUndefined();
});

test("alternative and cleared keys come from current bindings, with exact modifiers and actual keyboard layout", () => {
  const matcher = new KeyboardAcceleratorMatcher("mac");
  expect(matcher.match(key("j"), [{ command: "search", keys: ["Command+J", "Ctrl+K"] }], 0)).toEqual({ type: "command", command: "search" });
  expect(matcher.match(key("k"), [{ command: "search", keys: ["Command+J", "Ctrl+K"] }], 1)).toBeUndefined();
  expect(matcher.match(key("j"), [{ command: "search", keys: [] }], 2)).toBeUndefined();
  expect(matcher.match(key("q", { code: "KeyA" }), [{ command: "select", keys: ["Command+Q"] }], 3)).toMatchObject({ command: "select" });
  expect(matcher.match(key("q", { shiftKey: true }), [{ command: "select", keys: ["Command+Q"] }], 4)).toBeUndefined();
  expect(acceleratorStroke(key("ß", { altKey: true, code: "KeyS" }))).toBe("Command+Alt+S");
  expect(acceleratorStroke(key("+", { metaKey: false }))).toBe("Plus");
});

test("sequences expire after one second and mismatch restarts from the current stroke", () => {
  const matcher = new KeyboardAcceleratorMatcher("mac");
  const bindings = [{ command: "review", keys: ["Command+K Command+R"] }, { command: "search", keys: ["Command+J"] }];
  expect(matcher.match(key("k"), bindings, 0)).toEqual({ type: "prefix" });
  expect(matcher.match(key("r"), bindings, 999)).toEqual({ type: "command", command: "review" });
  expect(matcher.match(key("r"), bindings, 1000)).toBeUndefined();
  expect(matcher.match(key("k"), bindings, 2000)).toEqual({ type: "prefix" });
  expect(matcher.match(key("r"), bindings, 3000)).toBeUndefined();
  expect(matcher.match(key("k"), bindings, 4000)).toEqual({ type: "prefix" });
  expect(matcher.match(key("j"), bindings, 4001)).toEqual({ type: "command", command: "search" });
});

test("a prefix cannot retain an unavailable owner or stale binding across an ordinary update", () => {
  const matcher = new KeyboardAcceleratorMatcher("mac");
  const old = [{ command: "review", keys: ["Command+K Command+R"] }];
  expect(matcher.match(key("k"), old, 0)).toMatchObject({ type: "prefix" });
  expect(matcher.match(key("r"), [], 1)).toBeUndefined();
  expect(matcher.match(key("k"), old, 2)).toMatchObject({ type: "prefix" });
  expect(matcher.match(key("r"), [{ command: "review", keys: ["Command+J Command+R"] }], 3)).toBeUndefined();
});

test("IME, external prevention and reset cancel a prefix; repeat does not duplicate or cancel it", () => {
  const matcher = new KeyboardAcceleratorMatcher("mac");
  const bindings = [{ command: "review", keys: ["Command+K Command+R"] }];
  for (const change of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { getModifierState: () => true }]) {
    matcher.match(key("k"), bindings, 0);
    expect(matcher.match(key("r", change), bindings, 1)).toBeUndefined();
    expect(matcher.match(key("r"), bindings, 2)).toBeUndefined();
  }
  matcher.match(key("k"), bindings, 0);
  expect(matcher.match(key("k", { repeat: true }), bindings, 1)).toBeUndefined();
  expect(matcher.match(key("r"), bindings, 2)).toMatchObject({ type: "command" });
  matcher.match(key("k"), bindings, 3); matcher.reset();
  expect(matcher.match(key("r"), bindings, 4)).toBeUndefined();
});

test("editable controls keep text, shift-only bindings and sequences but admit modified single strokes", () => {
  const matcher = new KeyboardAcceleratorMatcher("mac");
  const bindings = [{ command: "text", keys: ["R", "Shift+R"] }, { command: "sequence", keys: ["Command+K Command+R"] }, { command: "save", keys: ["Command+S"] }];
  expect(matcher.match(key("r", { metaKey: false }), bindings, 0, true)).toBeUndefined();
  expect(matcher.match(key("R", { metaKey: false, shiftKey: true }), bindings, 1, true)).toBeUndefined();
  expect(matcher.match(key("k"), bindings, 2, true)).toBeUndefined();
  expect(matcher.match(key("s"), bindings, 3, true)).toMatchObject({ command: "save" });
});


test("modifier-only events retain sequence progress while a dead-key composition cancels it", () => {
  const matcher = new KeyboardAcceleratorMatcher("mac");
  const bindings = [{ command: "review", keys: ["Command+K Command+R"] }];
  matcher.match(key("k"), bindings, 0);
  expect(matcher.match(key("Meta"), bindings, 1)).toBeUndefined();
  expect(matcher.match(key("r"), bindings, 2)).toMatchObject({ command: "review" });
  matcher.match(key("k"), bindings, 3);
  expect(matcher.match(key("Dead"), bindings, 4)).toBeUndefined();
  expect(matcher.match(key("r"), bindings, 5)).toBeUndefined();
});
