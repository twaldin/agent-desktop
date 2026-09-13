import { expect, test } from "bun:test";
import React from "react";
import type { DesktopBridge, OmpSessionControls } from "@agent-desktop/shared";
import { AdvancedStreamControls, type AdvancedStreamControlsProps } from "./AdvancedStreamControls";
import { AdvancedStreamState } from "./advanced-stream-state";

type Slot = { deps: readonly unknown[]; value?: unknown; cleanup?: () => void };
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/** Existing controlled React-dispatcher convention, with dependency cleanup and
 * commit effects. Exercises the real component/state, not ReactDOM or native UI. */
function driver() {
  const slots: Slot[] = [];
  let cursor = 0, pending: Array<{ index: number; deps: readonly unknown[]; effect: () => void | (() => void) }> = [];
  // React 19's private dispatcher is an in-process test seam, absent from its public types.
  if (!("__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE" in React)) throw new Error("React dispatcher unavailable");
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  if (!internals || typeof internals !== "object" || !("H" in internals)) throw new Error("React dispatcher unavailable");
  const dispatcher = {
    useMemo<T>(factory: () => T, deps: readonly unknown[]) {
      const index = cursor++, previous = slots[index];
      if (!previous || !same(previous.deps, deps)) slots[index] = { deps, value: factory() };
      return slots[index]!.value as T;
    },
    useReducer(_reducer: unknown, initial: unknown) { cursor++; return [initial, () => {}]; },
    useId() { return `stream-control-${cursor++}`; },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = cursor++, previous = slots[index];
      if (!previous || !same(previous.deps, deps)) pending.push({ index, deps, effect });
    },
  };
  return {
    render(props: AdvancedStreamControlsProps) {
      cursor = 0; pending = [];
      const previous = internals.H;
      let tree: React.ReactElement;
      internals.H = dispatcher;
      try { tree = AdvancedStreamControls(props); } finally { internals.H = previous; }
      for (const item of pending) slots[item.index]?.cleanup?.();
      for (const item of pending) {
        const cleanup = item.effect();
        slots[item.index] = { deps: item.deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
      }
      return tree;
    },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

type ControlProps = { children?: unknown; "aria-label"?: string; value?: string | number; max?: number; className?: string; disabled?: boolean; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void };
function elements(value: unknown): React.ReactElement<ControlProps>[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (!React.isValidElement<ControlProps>(value)) return [];
  return [value, ...elements(value.props.children)];
}
function input(tree: React.ReactElement) {
  const found = elements(tree).find(item => item.type === "input" && item.props["aria-label"] === "Temperature value");
  if (!found?.props.onChange) throw new Error("Temperature input is unavailable");
  return { value: found.props.value, onChange: found.props.onChange };
}
function button(tree: React.ReactElement, label: string) {
  const found = elements(tree).find(item => item.type === "button" && item.props.children === label);
  if (!found?.props.onClick) throw new Error(`${label} action is unavailable`);
  return { disabled: found.props.disabled, onClick: found.props.onClick };
}
const settle = () => { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, 0); return promise; };
const controls = (revision: string, temperature: number): OmpSessionControls => ({
  revision, sessionId: "session", model: { provider: "google", id: "gemini-2.5-flash" },
  serviceTiers: {}, capabilities: null, settings: [], overrides: [], runtimeMutablePaths: [],
  persistence: "native-session-model-thinking-tiers; runtime-settings-until-dispose",
  advancedStream: {
    supported: true, reason: "Controlled owning-host snapshot", model: { provider: "google", id: "gemini-2.5-flash", api: "google-generative-ai" },
    selection: { temperature }, native: { temperature: 0.35, topP: 0.8, maxTokens: 65536 }, persistence: "owning-session-branch-model-api",
  },
});

test("online Reload and Save remain usable when only the local host identity resolves", async () => {
  let native = controls("initial", 0.6);
  const bridge: Pick<DesktopBridge, "getSessionControls" | "setSessionControl" | "subscribe"> = {
    getSessionControls: async () => native,
    setSessionControl: async (sessionId, mutation, hostId) => {
      if (sessionId !== "session" || hostId !== "owner" || mutation.expectedRevision !== native.revision)
        throw new Error("Wrong owner or stale native revision");
      if (mutation.operation !== "advanced-stream" || mutation.field !== "temperature" || mutation.action !== "set" || mutation.value === undefined)
        throw new Error("Unsupported controlled mutation");
      native = controls("saved", mutation.value);
      return native;
    },
    subscribe: () => () => {},
  };
  // The real component uses only these three controlled DesktopBridge operations.
  const desktopBridge = bridge as DesktopBridge;
  const hooks = driver();
  let props: AdvancedStreamControlsProps = { bridge: desktopBridge, hostId: "owner", sessionId: "session", connected: true, disabled: false };
  try {
    hooks.render(props); await settle();
    let tree = hooks.render(props);
    expect(input(tree).value).toBe("0.6");

    props = { ...props, localHostId: "local" };
    hooks.render(props); await settle();
    native = controls("external-change", 0.8);
    tree = hooks.render(props);
    button(tree, "Reload").onClick(); await settle();
    tree = hooks.render(props);
    expect(input(tree).value).toBe("0.8");

    input(tree).onChange({ target: { value: "0" } });
    tree = hooks.render(props);
    expect(button(tree, "Save").disabled).toBe(false);
    button(tree, "Save").onClick(); await settle();
    tree = hooks.render(props);
    expect(elements(tree).some(item => item.type === "button" && item.props.children === "Save")).toBe(false);
    button(tree, "Reload").onClick(); await settle();
    expect(input(hooks.render(props)).value).toBe("0");
  } finally { hooks.dispose(); }
});

function outputOnlyControls(): OmpSessionControls {
  const value = controls("output-only", 0.6);
  value.model = { provider: "anthropic", id: "claude-opus-4-8" };
  value.advancedStream = {
    ...value.advancedStream!, supported: false, model: { ...value.model, api: "anthropic-messages" },
    reason: "Update your desktop to edit this model’s output budget.",
    selection: { temperature: 0.6, maxTokens: 2048 },
    native: { temperature: null, topP: null, maxTokens: 128000 },
    fields: {
      temperature: { supported: false, reason: "Sampling is not available for this model.", minimum: 0, maximum: 1 },
      topP: { supported: false, reason: "Sampling is not available for this model.", minimum: 0, maximum: 1 },
      maxTokens: { supported: true, reason: "Choose a requested budget.", minimum: 1, maximum: 128000 },
    },
    outputBudgetNote: "Native thinking may increase the request budget. OAuth can cap it at 64000.",
  };
  return value;
}

test("output budget remains editable while unavailable sampling is retained and can be cleared", async () => {
  let native = outputOnlyControls();
  const writes: Array<unknown> = [];
  const bridge: Pick<DesktopBridge, "getSessionControls" | "setSessionControl" | "subscribe"> = {
    getSessionControls: async () => structuredClone(native), subscribe: () => () => {},
    setSessionControl: async (sessionId, mutation, hostId) => {
      expect(sessionId).toBe("session"); expect(hostId).toBe("owner");
      expect(mutation.expectedRevision).toBe(native.revision);
      if (mutation.operation !== "advanced-stream") throw new Error("Unexpected operation");
      writes.push(mutation);
      if (mutation.action === "inherit") delete native.advancedStream!.selection[mutation.field];
      else if (mutation.field === "maxTokens" && mutation.action === "set") native.advancedStream!.selection.maxTokens = mutation.value;
      else throw new Error("Unavailable sampling must not be sent");
      native = { ...native, revision: `saved-${writes.length}` };
      return structuredClone(native);
    },
  };
  const hooks = driver();
  const props: AdvancedStreamControlsProps = { bridge: bridge as DesktopBridge, hostId: "owner", sessionId: "session", connected: true, disabled: false };
  const row = (tree: React.ReactElement, label: string) => {
    const found = elements(tree).find(item => item.props.className === "advanced-stream-row" && elements(item).some(child => child.type === "label" && child.props.children === label));
    if (!found) throw new Error(`Missing row ${label}`);
    return found;
  };
  try {
    hooks.render(props); await settle();
    let tree = hooks.render(props);
    const temperature = row(tree, "Temperature");
    expect(elements(tree).some(item => item.type === "p" && item.props.children === native.advancedStream!.reason)).toBe(false);
    expect(elements(temperature).find(item => item.type === "input")!.props.disabled).toBe(true);
    expect(elements(temperature).find(item => item.type === "option" && item.props.value === "set")!.props.disabled).toBe(true);
    const output = row(tree, "Requested output budget");
    const outputInput = elements(output).find(item => item.type === "input")!;
    expect(outputInput.props.disabled).toBe(false); expect(outputInput.props.max).toBe(128000);
    expect(elements(output).some(item => item.type === "small" && JSON.stringify(item.props.children).includes("OAuth can cap it at 64000"))).toBe(true);
    outputInput.props.onChange!({ target: { value: "4096" } });
    tree = hooks.render(props);
    button(row(tree, "Requested output budget"), "Save").onClick(); await settle();
    expect(native.advancedStream!.selection.maxTokens).toBe(4096);
    tree = hooks.render(props);
    elements(row(tree, "Temperature")).find(item => item.type === "select")!.props.onChange!({ target: { value: "inherit" } });
    tree = hooks.render(props);
    expect(button(row(tree, "Temperature"), "Save").disabled).toBe(false);
    button(row(tree, "Temperature"), "Save").onClick(); await settle();
    expect(native.advancedStream!.selection.temperature).toBeUndefined();
    expect(native.advancedStream!.selection.maxTokens).toBe(4096); expect(writes).toHaveLength(2);
  } finally { hooks.dispose(); }
});

test("state refuses unavailable sampling even when a caller bypasses disabled controls", async () => {
  let writes = 0;
  const native = outputOnlyControls();
  const state = new AdvancedStreamState({ getSessionControls: async () => native,
    setSessionControl: async () => { writes++; return native; }, subscribe: () => () => {} }, "owner", "session");
  state.start(); state.setConnected(true); await settle();
  state.edit("temperature", "set", "0.4"); await state.save("temperature");
  expect(writes).toBe(0); expect(state.edits.get("temperature")?.text).toBe("0.4");
  expect(state.edits.get("temperature")?.error).toBe(native.advancedStream!.fields!.temperature.reason);
  state.edit("maxTokens", "set", "4096"); state.setConnected(false); await state.save("maxTokens");
  expect(writes).toBe(0); expect(state.edits.get("maxTokens")?.text).toBe("4096"); state.stop();
});

function samplingControls(revision = "sampling-off"): OmpSessionControls {
  const value = outputOnlyControls();
  value.revision = revision;
  value.model = { provider: "anthropic", id: "claude-sonnet-4-5" };
  value.advancedStream = { ...value.advancedStream!, model: { ...value.model, api: "anthropic-messages" },
    selection: { temperature: 0.2, topP: null },
    fields: {
      temperature: { supported: true, reason: "Native request accepts sampling.", minimum: 0, maximum: 1 },
      topP: { supported: true, reason: "Native request accepts sampling.", minimum: 0, maximum: 1 },
      maxTokens: { supported: true, reason: "Native output budget.", minimum: 1, maximum: 64000 },
    },
    samplingConstraint: "Choose one sampling parameter; omit the other explicitly.",
  };
  return value;
}

test("Anthropic uses per-field support despite legacy false and exposes native conflict recovery", async () => {
  let native = samplingControls();
  native.advancedStream!.samplingConflict = "Inherited Top P conflicts with saved Temperature.";
  delete native.advancedStream!.selection.topP;
  native.advancedStream!.native.topP = 0.8;
  let saved = false;
  const bridge: Pick<DesktopBridge, "getSessionControls" | "setSessionControl" | "subscribe"> = {
    getSessionControls: async () => structuredClone(native), subscribe: () => () => {},
    setSessionControl: async (_id, mutation) => {
      if (mutation.operation !== "advanced-stream" || mutation.field !== "temperature" || mutation.action !== "set")
        throw new Error("Unexpected sampling operation");
      saved = true;
      native = samplingControls("saved"); native.advancedStream!.selection.temperature = mutation.value;
      return structuredClone(native);
    },
  };
  const hooks = driver();
  const props = { bridge: bridge as DesktopBridge, hostId: "owner", sessionId: "session", connected: true, disabled: false };
  try {
    hooks.render(props); await settle();
    let tree = hooks.render(props);
    const temperature = elements(tree).find(item => item.type === "input" && item.props["aria-label"] === "Temperature value")!;
    expect(temperature.props.disabled).toBe(false); expect(temperature.props.max).toBe(1);
    expect(elements(tree).some(item => item.type === "p" && item.props.children === native.advancedStream!.samplingConflict)).toBe(true);
    native = samplingControls("explicit-omission-saved-elsewhere");
    button(tree, "Reload").onClick(); await settle();
    tree = hooks.render(props);
    input(tree).onChange({ target: { value: "0" } });
    tree = hooks.render(props); button(tree, "Save").onClick(); await settle();
    expect(saved).toBe(true); expect(input(hooks.render(props)).value).toBe("0");
  } finally { hooks.dispose(); }
});

test("thinking snapshot changes preserve a pending draft and require explicit review before applying", async () => {
  let native = samplingControls(), writes = 0;
  const state = new AdvancedStreamState({
    getSessionControls: async () => structuredClone(native),
    setSessionControl: async () => { writes++; return structuredClone(native); }, subscribe: () => () => {},
  }, "owner", "session");
  state.start(); state.setConnected(true); await settle();
  state.edit("temperature", "set", "0.4");
  native = samplingControls("thinking-high");
  native.advancedStream!.fields!.temperature.supported = false;
  native.advancedStream!.fields!.topP.supported = false;
  await state.refresh(); await state.save("temperature");
  expect(writes).toBe(0); expect(state.edits.get("temperature")?.text).toBe("0.4");
  state.rebase("temperature"); await state.save("temperature");
  expect(writes).toBe(0);
  native = samplingControls("thinking-off-again");
  await state.refresh(); await state.save("temperature");
  expect(writes).toBe(0);
  state.rebase("temperature"); await state.save("temperature");
  expect(writes).toBe(1); expect(state.edits.has("temperature")).toBe(false);
  state.stop();
});

test("saving one sampling field never silently rebases another field's pending edit", async () => {
  let native = samplingControls(), writes = 0;
  const state = new AdvancedStreamState({
    getSessionControls: async () => structuredClone(native), subscribe: () => () => {},
    setSessionControl: async () => { writes++; native = samplingControls(`saved-${writes}`); return structuredClone(native); },
  }, "owner", "session");
  state.start(); state.setConnected(true); await settle();
  state.edit("temperature", "provider-default", "");
  state.edit("topP", "set", "0.7");
  await state.save("temperature");
  await state.save("topP");
  expect(writes).toBe(1); expect(state.edits.get("topP")?.text).toBe("0.7");
  state.rebase("topP"); await state.save("topP");
  expect(writes).toBe(2);
  state.stop();
});

test("late save acknowledgement cannot replace a newer thinking snapshot or replay on reconnect", async () => {
  let native = samplingControls(), writes = 0;
  const pending = Promise.withResolvers<OmpSessionControls>();
  const state = new AdvancedStreamState({
    getSessionControls: async () => structuredClone(native), subscribe: () => () => {},
    setSessionControl: async () => { writes++; return pending.promise; },
  }, "owner", "session");
  state.start(); state.setConnected(true); await settle();
  state.edit("temperature", "set", "0.4");
  state.edit("topP", "set", "0.7");
  const save = state.save("temperature");
  state.setConnected(false);
  native = samplingControls("changed-while-pending");
  native.advancedStream!.fields!.temperature.supported = false;
  native.advancedStream!.fields!.topP.supported = false;
  state.setConnected(true);
  pending.resolve(samplingControls("old-save-receipt"));
  await save; await settle();
  expect(state.controls?.revision).toBe("changed-while-pending");
  expect(state.edits.has("temperature")).toBe(false); // Acknowledged, not an uncertain write.
  expect(state.edits.get("topP")?.text).toBe("0.7");
  expect(writes).toBe(1);
  await state.refresh(); expect(writes).toBe(1);
  state.stop();
});

test("endpoint-unavailable selections remain visible and clearable when no field supports custom values", async () => {
  const native = samplingControls();
  for (const field of Object.values(native.advancedStream!.fields!)) field.supported = false;
  const writes: string[] = [];
  const state = new AdvancedStreamState({
    getSessionControls: async () => structuredClone(native), subscribe: () => () => {},
    setSessionControl: async (_id, mutation) => {
      if (mutation.operation !== "advanced-stream" || mutation.action !== "inherit") throw new Error("Only explicit recovery is supported");
      writes.push(mutation.field); delete native.advancedStream!.selection[mutation.field];
      return structuredClone(native);
    },
  }, "owner", "session");
  state.start(); state.setConnected(true); await settle();
  state.edit("temperature", "set", "0.4"); await state.save("temperature");
  expect(writes).toEqual([]);
  state.edit("temperature", "inherit", ""); await state.save("temperature");
  expect(writes).toEqual(["temperature"]); expect(state.controls?.advancedStream?.selection).toEqual({ topP: null });
  state.stop();
});

test("a model switch keeps the old model's draft until switchback and explicit rebase", async () => {
  let native = samplingControls(), writes = 0;
  const state = new AdvancedStreamState({
    getSessionControls: async () => structuredClone(native), subscribe: () => () => {},
    setSessionControl: async () => { writes++; return structuredClone(native); },
  }, "owner", "session");
  state.start(); state.setConnected(true); await settle();
  state.edit("temperature", "set", "0.4");
  native = outputOnlyControls();
  await state.refresh(); state.rebase("temperature"); await state.save("temperature");
  expect(writes).toBe(0); expect(state.edits.get("temperature")?.model.id).toBe("claude-sonnet-4-5");
  native = samplingControls("switchback");
  await state.refresh(); await state.save("temperature"); expect(writes).toBe(0);
  state.rebase("temperature"); await state.save("temperature"); expect(writes).toBe(1);
  state.stop();
});
