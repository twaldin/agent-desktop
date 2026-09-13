import { expect, test } from "bun:test";
import React from "react";
import type { DesktopBridge, OmpSessionControls } from "@agent-desktop/shared";
import { AdvancedStreamControls, type AdvancedStreamControlsProps } from "./AdvancedStreamControls";

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

type ControlProps = { children?: unknown; "aria-label"?: string; value?: string | number; disabled?: boolean; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void };
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
  const bridge = {
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
  } satisfies Pick<DesktopBridge, "getSessionControls" | "setSessionControl" | "subscribe">;
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
