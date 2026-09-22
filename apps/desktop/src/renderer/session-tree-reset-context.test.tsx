import { expect, test } from "bun:test";
import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionTreeHistory, SessionTreeResetContext } from "./SessionTree";
import { SessionTreeState, type SessionTreePorts, type SessionTreeView } from "./use-session-tree";
import type { SessionTree } from "../../../../packages/shared/src/session-tree";

interface ButtonProps { children?: ReactNode; onClick?(): void; disabled?: boolean; "aria-label"?: string }
interface Probed { label: string; disabled: boolean; click(): void }

const owner = { hostId: "host", sessionId: "session" };
const tree: SessionTree = { ticket: { nativeSessionId: "session", epoch: "epoch", revision: "current" },
  entries: [{ id: "entry", parentId: null, timestamp: "today", kind: "user", text: "hello", active: true, editable: true, imageCount: 0 }],
  leafId: "entry", summariesEnabled: false, nativeCommandAvailable: true, reconciliationRequired: false };
const view = (patch: Partial<SessionTreeView>): SessionTreeView =>
  ({ owner, value: tree, fresh: true, loading: false, pending: false, uncertain: false, resetSupported: false, ...patch });

function text(node: ReactNode): string {
  let out = "";
  for (const child of Children.toArray(node)) {
    if (typeof child === "string" || typeof child === "number") out += String(child);
    else if (isValidElement<ButtonProps>(child)) out += text(child.props.children);
  }
  return out;
}

/** Render through React and retain only the semantic button gating. Native modal
 * behavior stays Electron coverage; these assertions are the callback contract. */
function probe(render: () => ReactNode) {
  const buttons: Probed[] = [];
  const collect = (node: ReactNode): void => {
    for (const child of Children.toArray(node)) {
      if (!isValidElement<ButtonProps>(child)) continue;
      if (child.type === "button") buttons.push({ label: child.props["aria-label"] ?? text(child.props.children), disabled: !!child.props.disabled, click: () => child.props.onClick?.() });
      collect(child.props.children);
    }
  };
  const Probe = () => { const tree = render(); collect(tree); return tree; };
  return { markup: renderToStaticMarkup(createElement(Probe)), buttons };
}

function history(patch: Partial<SessionTreeView>, onResetContext?: () => void, connected = true) {
  let commands = 0;
  const state = new SessionTreeState(owner);
  const ports: SessionTreePorts = { bridge: { subscribe: () => () => {},
    command: async () => { commands++; throw Error("the dialog must not dispatch"); },
    getSessionTree: async () => ({ ...owner, tree }) } };
  state.configure(ports, true, undefined, !!patch.resetSupported);
  const rendered = probe(() => SessionTreeHistory({ state, view: view(patch), connected,
    onClose: () => {}, onRestore: () => {}, onNavigate: () => {}, ...(onResetContext ? { onResetContext } : {}) }));
  return { ...rendered, dispatched: () => commands, clear: rendered.buttons.find(button => button.label === "Clear context") };
}

test("the history clear-context button appears only with an owner callback and is disabled without host support", () => {
  expect(history({ resetSupported: true }).clear).toBeUndefined();
  const unsupported = history({ resetSupported: false }, () => {});
  expect(unsupported.clear?.disabled).toBe(true);
});

test("a supported clear-context button delegates to the owner instead of mutating the tree", () => {
  let invoked = 0;
  const ready = history({ resetSupported: true }, () => { invoked++; });
  expect(ready.clear?.disabled).toBe(false);
  ready.clear!.click();
  expect(invoked).toBe(1);
  expect(ready.dispatched()).toBe(0);
  // A reset needs no target, so it is available while the navigation action still waits for one.
  expect(ready.buttons.find(button => button.label === "Continue from here")?.disabled).toBe(true);
});

test("the existing history guards keep clearing blocked while the tree is unsettled", () => {
  for (const patch of [{ pending: true }, { uncertain: true }, { fresh: false }, { value: { ...tree, busyReason: "The session is streaming." } },
    { value: null }, { value: { ...tree, reconciliationRequired: true } }]) {
    expect(history({ resetSupported: true, ...patch }, () => {}).clear?.disabled).toBe(true);
  }
  expect(history({ resetSupported: true }, () => {}, false).clear?.disabled).toBe(true);
});

test("the reset dialog refuses to close while the owner's command is in flight but closes once it is merely refused", () => {
  let confirmed = 0, closed = 0;
  const busy = probe(() => SessionTreeResetContext({ busy: true, disabled: false, onClose: () => { closed++; }, onConfirm: () => { confirmed++; } }));
  expect(busy.buttons.map(button => button.disabled)).toEqual([true, true, true]);
  for (const button of busy.buttons.slice(0, -1)) button.click();
  expect(closed).toBe(0);
  expect(confirmed).toBe(0);
  const refused = probe(() => SessionTreeResetContext({ busy: false, disabled: true, error: "The owning host refused the reset.", onClose: () => { closed++; }, onConfirm: () => { confirmed++; } }));
  expect(refused.markup).toContain("The owning host refused the reset.");
  expect(refused.buttons.at(-1)!.disabled).toBe(true);
  for (const button of refused.buttons.slice(0, -1)) button.click();
  expect(closed).toBe(2);
});
