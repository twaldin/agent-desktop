import { afterEach, expect, test } from "bun:test";
import * as React from "react";
import { BranchSwitchContent } from "./BranchSwitchContent";
import { observeDialogHeight } from "./dialog-height";

const originals = new Map<string, PropertyDescriptor | undefined>();
const cleanups: Array<() => void> = [];
function replace(name: string, value: unknown) { if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { configurable: true, writable: true, value }); }
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const [name, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
  originals.clear();
});
function fixture() {
  const frames = new Map<number, FrameRequestCallback>(), cancelled: number[] = [], observers: Array<{ callback: ResizeObserverCallback; observed?: Element; disconnected: boolean }> = [];
  let id = 0;
  replace("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  replace("cancelAnimationFrame", (key: number) => { cancelled.push(key); frames.delete(key); });
  replace("ResizeObserver", class {
    private state: typeof observers[number];
    constructor(callback: ResizeObserverCallback) { this.state = { callback, disconnected: false }; observers.push(this.state); }
    observe(element: Element) { this.state.observed = element; }
    disconnect() { this.state.disconnected = true; }
  });
  const properties = new Map<string, string>(), writes: Array<[string, string]> = [];
  const content = { style: { height: "", setProperty(name: string, value: string) { properties.set(name, value); writes.push([name, value]); }, removeProperty(name: string) { properties.delete(name); } }, dataset: {} as DOMStringMap } as unknown as HTMLElement;
  const body = { offsetHeight: 220, scrollHeight: 220 } as HTMLElement;
  const resize = () => { for (const observer of observers) observer.callback([], {} as ResizeObserver); };
  const frame = () => { const pending = [...frames]; frames.clear(); for (const [, callback] of pending) callback(0); };
  return { frames, cancelled, observers, properties, writes, content, body, resize, frame };
}

test("initial natural height is scheduled once; ready marker waits for the following frame", () => {
  const f = fixture(); cleanups.push(observeDialogHeight(f.content, f.body));
  expect(f.observers[0]!.observed).toBe(f.body); expect(f.frames.size).toBe(1); expect(f.properties.size).toBe(0);
  f.resize(); f.resize(); expect(f.frames.size).toBe(1);
  f.frame(); expect(f.properties.get("--dialog-content-height")).toBe("220px");
  expect(f.content.style.height).toBe("var(--dialog-content-height)"); expect(f.content.dataset.dialogHeightReady).toBeUndefined();
  f.frame(); expect(f.content.dataset.dialogHeightReady).toBe("true"); expect(f.frames.size).toBe(0);
});

test("body growth and shrink update height; sub-half-pixel jitter and nonfinite values do not", () => {
  const f = fixture(); cleanups.push(observeDialogHeight(f.content, f.body)); f.frame(); f.frame();
  const size = (value: number) => { Object.defineProperty(f.body, "offsetHeight", { value, configurable: true }); Object.defineProperty(f.body, "scrollHeight", { value, configurable: true }); f.resize(); f.frame(); };
  size(300); expect(f.properties.get("--dialog-content-height")).toBe("300px");
  size(150); expect(f.properties.get("--dialog-content-height")).toBe("150px");
  const before = f.writes.length; size(150.25); size(NaN); size(Infinity); expect(f.writes).toHaveLength(before);
  size(150.5); expect(f.properties.get("--dialog-content-height")).toBe("150.5px");
});

test("zero offset uses natural scroll height", () => {
  const f = fixture(); Object.defineProperty(f.body, "offsetHeight", { value: 0 }); Object.defineProperty(f.body, "scrollHeight", { value: 340 });
  cleanups.push(observeDialogHeight(f.content, f.body)); f.frame(); expect(f.properties.get("--dialog-content-height")).toBe("340px");
});

for (const stage of ["before-measure", "before-ready", "after-ready"] as const) test(`cleanup at ${stage} cancels both frames and rejects late callbacks`, () => {
  const f = fixture(), cleanup = observeDialogHeight(f.content, f.body);
  if (stage !== "before-measure") f.frame(); if (stage === "after-ready") f.frame();
  const late = [...f.frames.values()]; cleanup();
  expect(f.observers[0]!.disconnected).toBe(true); expect(f.frames.size).toBe(0); expect(f.properties.size).toBe(0);
  expect(f.content.style.height).toBe(""); expect(f.content.dataset.dialogHeightReady).toBeUndefined();
  for (const callback of late) callback(0); f.resize(); expect(f.frames.size).toBe(0); expect(f.properties.size).toBe(0); expect(f.content.dataset.dialogHeightReady).toBeUndefined();
});

test("strict-effect cleanup and replacement restart measurement without old callback writes", () => {
  const f = fixture(), first = observeDialogHeight(f.content, f.body); f.frame(); const old = [...f.frames.values()]; first();
  const second = observeDialogHeight(f.content, f.body); cleanups.push(second);
  for (const callback of old) callback(0); expect(f.content.dataset.dialogHeightReady).toBeUndefined();
  f.frame(); f.frame(); expect(f.content.dataset.dialogHeightReady).toBe("true"); expect(f.observers).toHaveLength(2);
});

test("missing ResizeObserver retains automatic sizing", () => {
  const f = fixture(); replace("ResizeObserver", undefined); observeDialogHeight(f.content, f.body)();
  expect(f.frames.size).toBe(0); expect(f.properties.size).toBe(0); expect(f.content.style.height).toBe("");
});

test("actual portal child binds surface/body refs in layout phase and preserves dialog props/children", () => {
  const f = fixture(), slots: Array<{ current: unknown }> = [], effects: Array<() => unknown> = [];
  const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, previous = internals.H;
  const focus = () => {}, child = React.createElement("form", { id: "body" }, "Body");
  internals.H = { useRef(value: unknown) { const ref = { current: value }; slots.push(ref); return ref; }, useLayoutEffect(run: () => unknown) { effects.push(run); } };
  let tree: React.ReactElement<any>;
  try { tree = BranchSwitchContent({ className: "branch-switch-dialog", onOpenAutoFocus: focus, children: child }); }
  finally { internals.H = previous; }
  expect(tree.props.onOpenAutoFocus).toBe(focus); expect(tree.props.className).toBe("branch-switch-dialog");
  const inner = tree.props.children as React.ReactElement<any>;
  expect(inner.props.children).toBe(child); expect(tree.props.ref).toBe(slots[0]); expect(inner.props.ref).toBe(slots[1]);
  slots[0]!.current = f.content; slots[1]!.current = f.body;
  for (const run of effects) { const cleanup = run(); if (typeof cleanup === "function") cleanups.push(cleanup as () => void); }
  f.frame(); expect(f.properties.get("--dialog-content-height")).toBe("220px");
});
