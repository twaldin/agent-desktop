import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, Fragment, type ReactElement, type ReactNode } from "react";
import { filterModelOptions, nextModelOption } from "./model-picker";

type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...nodes(element.props.children)];
}

/** Controlled hooks call the actual popup callbacks; browser focus and pixels are Electron coverage. */
function popupFixture(options: { disabled?: boolean; models?: { value: string; label: string; provider?: string; disabled?: boolean }[] } = {}) {
  const source = readFileSync(new URL("./ComposerSelectionPopup.tsx", import.meta.url), "utf8");
  const compiled = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "createElement", jsxFragmentFactory: "Fragment" } } })
    .transformSync(source.replace(/^import .*;\n/gm, "").replace(/export /g, ""));
  const state: unknown[] = [], refs: { current: any }[] = [], frames = new Map<number, FrameRequestCallback>(); const focused: string[] = [], scrolled: string[] = []; let cursor = 0, refCursor = 0, effectCursor = 0, frameId = 0; const effects: { deps?: readonly unknown[]; cleanup?: () => void }[] = [];
  const menuNode = { querySelector(selector: string) { if (selector.includes("aria-checked")) return { scrollIntoView() { scrolled.push(selector); } }; return { focus() { focused.push(selector); } }; } };
  const useState = (initial: any) => { const slot = cursor++; if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial; return [state[slot], (next: any) => { state[slot] = typeof next === "function" ? next(state[slot]) : next; }]; };
  const useRef = (initial: unknown) => {
    const slot = refCursor++;
    if (!refs[slot]) refs[slot] = { current: slot === 1 ? { getBoundingClientRect: () => ({ right: 160, top: 20, bottom: 50 }), focus() {} } : slot === 2 ? menuNode : initial };
    return refs[slot]!;
  };
  const useEffect = (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const slot = effectCursor++, previous = effects[slot];
    if (previous && deps && previous.deps && deps.length === previous.deps.length && deps.every((value, index) => Object.is(value, previous.deps![index]))) return;
    previous?.cleanup?.();
    const cleanup = effect();
    effects[slot] = { deps: deps?.slice(), cleanup: typeof cleanup === "function" ? cleanup : undefined };
  };
  const original = { document: globalThis.document, window: globalThis.window, innerWidth: globalThis.innerWidth, innerHeight: globalThis.innerHeight, requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, ResizeObserver: globalThis.ResizeObserver, addEventListener: globalThis.addEventListener, removeEventListener: globalThis.removeEventListener };
  Object.assign(globalThis, { document: { body: {} }, window: { addEventListener() {}, removeEventListener() {} }, innerWidth: 1024, innerHeight: 768, requestAnimationFrame: (callback: FrameRequestCallback) => { const id = ++frameId; frames.set(id, callback); return id; }, cancelAnimationFrame: (id: number) => { frames.delete(id); }, addEventListener() {}, removeEventListener() {}, ResizeObserver: class { observe() {} disconnect() {} } });
  const Popup = new Function("createElement", "Fragment", "useState", "useRef", "useEffect", "useLayoutEffect", "createPortal", "Icon", "filterModelOptions", "nextModelOption", `${compiled}; return ComposerSelectionPopup;`)
    (createElement, Fragment, useState, useRef, useEffect, useEffect, (node: ReactNode) => node, () => null, filterModelOptions, nextModelOption);
  const chosen: string[] = [], efforts: (string | undefined)[] = []; let resets = 0;
  const props = { modelValue: "native\0model-0", modelLabel: "Model 0", modelTitle: "Native", models: options.models ?? Array.from({ length: 137 }, (_, index) => ({ value: `native\0model-${index}`, label: `Model ${index}`, provider: "native", disabled: index === 135 })), levels: ["low", "high", "xhigh"], effort: "xhigh", effectiveEffort: "xhigh", defaultEffortLabel: "Native default: high", disabled: options.disabled ?? false, onModel: (value: string) => chosen.push(value), onEffort: (value?: string) => efforts.push(value), onReset: () => { resets++; } };
  const render = () => { cursor = refCursor = effectCursor = 0; return nodes(Popup(props)); };
  const byLabel = (name: string) => render().find(element => element.type === "button" && element.props["aria-label"] === name)!;
  const unmount = () => { refs.forEach(ref => { ref.current = null; }); effects.forEach(effect => effect.cleanup?.()); };
  const restore = () => { unmount(); Object.assign(globalThis, original); };
  return { render, byLabel, props, chosen, efforts, focused, scrolled, runFrames: () => { for (const callback of [...frames.values()]) callback(0); frames.clear(); }, get pendingFrames() { return frames.size; }, unmount, get resets() { return resets; }, restore };
}

test("the popup keeps every native result reachable and keyboard skips unavailable entries", () => {
  const models = Array.from({ length: 137 }, (_, index) => ({ value: `native\0model-${index}`, label: `Model ${index}`, provider: "native", disabled: index === 135 }));
  const all = filterModelOptions(models, "");
  expect(all).toHaveLength(137); expect(all.at(-1)?.label).toBe("Model 136");
  const filtered = filterModelOptions(models, "model-13");
  expect(filtered.map(item => item.label)).toContain("Model 136");
  expect(nextModelOption(all, 134, 1)).toBe(136);
});

test("the controlled trigger displays the pinned Extra High native label", () => {
  const fixture = popupFixture();
  try { expect(fixture.byLabel("Model and reasoning effort").props.children[0].props.children).toBe("Model 0 Extra High"); }
  finally { fixture.restore(); }
});

test("the controlled popup reaches the final native model through search keys without committing IME input", () => {
  const fixture = popupFixture();
  try {
    fixture.byLabel("Model and reasoning effort").props.onClick();
    fixture.render();
    fixture.byLabel("Select model").props.onClick();
    fixture.render();
    expect(fixture.render().filter(element => element.props["data-model-index"] !== undefined)).toHaveLength(137);
    fixture.runFrames();
    expect(fixture.scrolled).toContain('button[aria-checked="true"]');
    const input = fixture.render().find(element => element.props["aria-label"] === "Search models")!;
    input.props.onChange({ target: { value: "model-136" } });
    let search = fixture.render().find(element => element.props["aria-label"] === "Search models")!;
    let prevented = 0;
    search.props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: true }, preventDefault() { prevented++; } });
    expect(fixture.chosen).toEqual([]); expect(prevented).toBe(0);
    search.props.onKeyDown({ key: "ArrowDown", nativeEvent: { isComposing: false }, preventDefault() { prevented++; } });
    search = fixture.render().find(element => element.props["aria-label"] === "Search models")!;
    search.props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() { prevented++; } });
    expect(prevented).toBe(2); expect(fixture.chosen).toEqual(["native\0model-136"]);
    expect(fixture.render().find(element => element.props["aria-expanded"] === false)).toBeTruthy();
  } finally { fixture.restore(); }
});

test("search starts at its first result and close clears a stale model index before catalog replacement", () => {
  const fixture = popupFixture();
  try {
    fixture.byLabel("Model and reasoning effort").props.onClick(); fixture.render(); fixture.byLabel("Select model").props.onClick(); fixture.render();
    let input = fixture.render().find(element => element.props["aria-label"] === "Search models")!;
    input.props.onChange({ target: { value: "model-13" } });
    input = fixture.render().find(element => element.props["aria-label"] === "Search models")!;
    input.props.onKeyDown({ key: "ArrowDown", nativeEvent: { isComposing: false }, preventDefault() {} });
    input = fixture.render().find(element => element.props["aria-label"] === "Search models")!;
    input.props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() {} });
    expect(fixture.chosen).toEqual(["native\0model-13"]);
    fixture.props.models = [{ value: "native\0replacement", label: "Replacement", provider: "native" }];
    fixture.byLabel("Model and reasoning effort").props.onClick(); fixture.render(); fixture.byLabel("Select model").props.onClick(); fixture.render();
    input = fixture.render().find(element => element.props["aria-label"] === "Search models")!;
    input.props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() {} });
    expect(fixture.chosen).toEqual(["native\0model-13", "native\0replacement"]);
  } finally { fixture.restore(); }
});

test("disabled, reset, and effort controls preserve native choices without unsupported modes", () => {
  const fixture = popupFixture();
  try {
    fixture.byLabel("Model and reasoning effort").props.onClick();
    fixture.render();
    fixture.byLabel("Reset composer selections").props.onClick();
    expect(fixture.resets).toBe(1);
    fixture.byLabel("Model and reasoning effort").props.onClick();
    fixture.render();
    fixture.byLabel("Select effort").props.onClick();
    fixture.render();
    const defaultChoice = fixture.render().find(element => element.type === "button" && element.props.role === "menuitemradio" && element.props["aria-checked"] === false)!;
    defaultChoice.props.onClick();
    expect(fixture.efforts).toEqual([undefined]);
  } finally { fixture.restore(); }
  const disabled = popupFixture({ disabled: true });
  try {
    const trigger = disabled.byLabel("Model and reasoning effort");
    expect(trigger.props.disabled).toBe(true); trigger.props.onClick();
    expect(disabled.render().some(element => element.props.role === "menu")).toBe(false);
  } finally { disabled.restore(); }
});

test("a listed native provider-disabled model remains visible but cannot replace the draft choice", () => {
  const fixture = popupFixture({ models: [{ value: "", label: "Default" }, { value: "native\\0offline", label: "Offline model", provider: "native", disabled: true }] });
  try {
    fixture.byLabel("Model and reasoning effort").props.onClick(); fixture.render();
    fixture.byLabel("Select model").props.onClick(); fixture.render();
    const offline = fixture.render().find(element => element.type === "button" && element.props["data-model-index"] === 1)!;
    expect(offline.props.disabled).toBe(true); expect(offline.props["aria-disabled"]).toBe(true);
    offline.props.onClick(); expect(fixture.chosen).toEqual([]);
  } finally { fixture.restore(); }
});



test("search arrows focus the first and last enabled actual rendered options", () => {
  const fixture = popupFixture({ models: [{ value: "first", label: "First" }, { value: "last", label: "Last" }, { value: "disabled", label: "Disabled", disabled: true }] });
  try {
    fixture.byLabel("Model and reasoning effort").props.onClick(); fixture.render();
    fixture.byLabel("Select model").props.onClick(); fixture.render(); fixture.runFrames();
    const input = fixture.render().find(element => element.props["aria-label"] === "Search models")!;
    input.props.onKeyDown({ key: "ArrowDown", nativeEvent: { isComposing: false }, preventDefault() {} });
    expect(fixture.focused.at(-1)).toBe('button[data-model-index="0"]');
    input.props.onKeyDown({ key: "ArrowUp", nativeEvent: { isComposing: false }, preventDefault() {} });
    expect(fixture.focused.at(-1)).toBe('button[data-model-index="1"]');
  } finally { fixture.restore(); }
});

test("unchanged renders do not duplicate focus work and unmount cancels pending frames", () => {
  const fixture = popupFixture();
  try {
    fixture.byLabel("Model and reasoning effort").props.onClick(); fixture.render();
    fixture.byLabel("Select model").props.onClick(); fixture.render();
    const pending = fixture.pendingFrames;
    expect(pending).toBeGreaterThan(0);
    fixture.render(); fixture.render();
    expect(fixture.pendingFrames).toBe(pending);
    fixture.unmount(); fixture.runFrames();
    expect(fixture.focused).toEqual([]);
    expect(fixture.scrolled).toEqual([]);
  } finally { fixture.restore(); }
});
