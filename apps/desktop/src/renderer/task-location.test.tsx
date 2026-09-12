import { expect, test } from "bun:test";
import { createElement, Fragment, type ReactElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { sameTaskLocationOwner, type TaskLocationSnapshot } from "./task-location";

type Element = ReactElement<Record<string, any>>;
function nodes(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as Element;
  return [element, ...(typeof element.type === "function" ? nodes((element.type as (props: Record<string, any>) => ReactNode)(element.props)) : nodes(element.props.children))];
}
function text(node: ReactNode): string { return Array.isArray(node) ? node.map(text).join("") : typeof node === "string" ? node : node && typeof node === "object" && "props" in node ? text((node as Element).props.children) : ""; }

// Exercise the maintained callbacks with controlled hook storage. Radix is a
// thin structural stand-in here; keyboard/focus timing belongs to Electron.
function fixture() {
  const source = readFileSync(new URL("./TaskLocationControl.tsx", import.meta.url), "utf8");
  const compiled = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "createElement", jsxFragmentFactory: "Fragment" } } })
    .transformSync(source.replace(/^import .*;\n/gm, "").replace("export function TaskLocationControl", "function TaskLocationControl"));
  const state: unknown[] = [], refs: { current: unknown }[] = []; let cursor = 0, refCursor = 0;
  const useState = (initial: any) => { const slot = cursor++; if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial; return [state[slot], (next: any) => { state[slot] = typeof next === "function" ? next(state[slot]) : next; }]; };
  const useRef = (initial: unknown) => refs[refCursor++] ??= { current: initial };
  const passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>;
  const DropdownMenu = { Root: passthrough, Trigger: passthrough, Portal: passthrough, Content: passthrough, Label: passthrough, Item: passthrough };
  const Dialog = { Root: passthrough, Portal: passthrough, Overlay: passthrough, Content: passthrough, Title: passthrough, Description: passthrough };
  const Component = new Function("createElement", "Fragment", "useEffect", "useRef", "useState", "Dialog", "DropdownMenu", "Icon", "sameTaskLocationOwner", `${compiled}; return TaskLocationControl;`)
    (createElement, Fragment, () => {}, useRef, useState, Dialog, DropdownMenu, () => null, sameTaskLocationOwner) as (props: any) => ReactNode;
  const calls: unknown[] = [];
  const snapshot: TaskLocationSnapshot = {
    version: 1, revision: "revision-1", hostId: "home", sessionId: "chat", current: { kind: "local", cwd: "/repo", gitRoot: "/repo", branch: "main", managed: false },
    local: { available: true, destination: { kind: "local", cwd: "/repo", gitRoot: "/repo", branch: "main", managed: false } },
    localCheckoutBranches: ["feature/local"], worktree: { available: true, destination: { kind: "worktree", cwd: "/worktrees/topic", gitRoot: "/repo", branch: "topic", managed: false } },
  };
  const props = { snapshot, connected: true, actions: { move: async (...args: unknown[]) => { calls.push(args); return { type: "session.location.move" as const, operation: { id: args[2] ?? "move-1" } as any, session: {} as any }; }, resume: async (...args: unknown[]) => { calls.push(["resume", ...args]); return { type: "session.location.move" as const, operation: { id: args[2] ?? "move-1" } as any, session: {} as any }; } } };
  const render = () => { cursor = refCursor = 0; return nodes(Component(props)); };
  const button = (name: string) => render().find(node => node.type === "button" && (node.props["aria-label"] ?? text(node.props.children)) === name)!;
  const item = (name: string) => render().find(node => node.props.className === "task-location-menu-item" && text(node.props.children).includes(name))!;
  return { render, button, item, calls, props };
}

test("same task ownership tracks the host and session across revision and cwd progress", () => {
  const owner = fixture().props.snapshot;
  expect(sameTaskLocationOwner(owner, { ...owner })).toBe(true);
  expect(sameTaskLocationOwner(owner, { ...owner, current: { ...owner.current, cwd: "/other" } })).toBe(true);
  expect(sameTaskLocationOwner(owner, { ...owner, revision: "revision-2" })).toBe(true);
  expect(sameTaskLocationOwner(owner, { ...owner, hostId: "work" })).toBe(false);
});

test("task location menu captures the original task and starts its host-proven worktree destination", async () => {
  const f = fixture();
  expect(f.button("Change task location").props.disabled).toBeUndefined();
  f.item("New local worktree").props.onSelect({ preventDefault() {} });
  expect(f.render().some(node => node.type === "button" && text(node.props.children) === "Hand off")).toBe(true);
  const branch = f.render().find(node => node.type === "select" && node.props["aria-label"] === "Local checkout branch")!; branch.props.onChange({ target: { value: "feature/local" } });
  await f.button("Hand off").props.onClick();
  expect(f.calls).toMatchObject([[expect.objectContaining({ hostId: "home", sessionId: "chat", revision: "revision-1" }), { kind: "worktree", branch: "topic", localCheckoutBranch: "feature/local" }, expect.any(String)]]);
});

test("the worktree dialog submits the edited local branch to the host-proven checkout", async () => {
  const f = fixture();
  const worktree = f.props.snapshot.worktree.destination!;
  f.props.snapshot = {
    ...f.props.snapshot,
    current: worktree,
    local: { available: true, destination: { kind: "local", cwd: "/repo", gitRoot: "/repo", branch: "main", managed: false, label: "Desktop" } },
    worktree: { available: false, reason: "The task is already in this worktree.", destination: worktree },
  };
  f.item("Local").props.onSelect({ preventDefault() {} });
  const input = f.render().find(node => node.type === "input" && node.props["aria-label"] === "Local branch name")!;
  expect(input.props.value).toBe("main");
  input.props.onChange({ target: { value: "land/topic" } });
  expect(f.button("Local workspace: Desktop, /repo").props.disabled).toBe(true);
  await f.button("Bring changes back").props.onClick();
  expect(f.calls).toMatchObject([[expect.objectContaining({ hostId: "home", sessionId: "chat" }), { kind: "local", branch: "land/topic" }, expect.any(String)]]);
});

test("host-unavailable destinations open the faithful explanation but cannot dispatch", () => {
  const f = fixture(), destination=f.props.snapshot.worktree.destination; f.props.snapshot = { ...f.props.snapshot, localCheckoutBranches: ["feature/local"], worktree: { available: false, reason: "The selected branch has conflicts.", destination } };
  f.item("New local worktree").props.onSelect({ preventDefault() {} });
  expect(f.render().some(node => text(node.props.children) === "The selected branch has conflicts.")).toBe(true);
  expect(f.button("Hand off").props.disabled).toBe(true);
});

test("an observed running move reopens its progress instead of disabling the location trigger", () => {
  const f = fixture(); f.props.snapshot = { ...f.props.snapshot, operation: {
    id: "move-1", revision: 1, sessionId: "chat", hostId: "home", direction: "to-worktree", status: "running", step: "prepare-destination",
    source: f.props.snapshot.current, destination: f.props.snapshot.worktree.destination!, warnings: [], message: "Preparing destination…",
  } };
  expect(f.button("Change task location").props.disabled).toBeUndefined();
  f.item("New local worktree").props.onSelect({ preventDefault() {} });
  expect(f.render().some(node => text(node.props.children).includes("Preparing destination…"))).toBe(true);
  expect(f.render().some(node => node.type === "button" && text(node.props.children) === "Hand off")).toBe(false);
});

test("an unknown move retains its captured destination and resumes only the original operation", async () => {
  const f = fixture(); f.props.snapshot = { ...f.props.snapshot, localCheckoutBranches: ["feature/local"], worktree: { available: false, reason: "Reconnect to inspect the destination." }, operation: {
    id: "move-unknown", revision: 1, sessionId: "chat", hostId: "home", direction: "to-worktree", status: "unknown", step: "move-session",
    source: f.props.snapshot.current, destination: f.props.snapshot.worktree.destination!, warnings: [], message: "The host stopped before it confirmed the move.",
  } };
  f.item("New local worktree").props.onSelect({ preventDefault() {} });
  await f.button("Check original operation").props.onClick();
  expect(f.calls).toEqual([["resume", expect.objectContaining({ revision: "revision-1", sessionId: "chat" }), "move-unknown"]]);
});


test("the captured operation follows revision updates and may be closed while running", async () => {
  const f = fixture(); f.item("New local worktree").props.onSelect({ preventDefault() {} });
  f.render().find(node => node.type === "select")!.props.onChange({ target: { value: "feature/local" } });
  await f.button("Hand off").props.onClick();
  f.props.snapshot = { ...f.props.snapshot, revision: "revision-2", operation: { id: (f.calls[0] as unknown[])[2] as string, revision: 2, sessionId: "chat", hostId: "home", direction: "to-worktree", status: "running", step: "prepare-destination", source: f.props.snapshot.current, destination: f.props.snapshot.worktree.destination!, warnings: [] } };
  expect(f.render().some(node => text(node.props.children).includes("Preparing destination"))).toBe(true);
  expect(f.button("Close dialog").props.disabled).toBeUndefined();
});

test("a held move owns its preallocated operation ID, may close, and cannot replace a newer dialog", async () => {
  const f = fixture(); const held = Promise.withResolvers<any>();
  f.props.actions.move = async (...args: unknown[]) => { f.calls.push(args); return held.promise; };
  f.item("New local worktree").props.onSelect({ preventDefault() {} });
  f.render().find(node => node.type === "select")!.props.onChange({ target: { value: "feature/local" } });
  const first = f.button("Hand off").props.onClick();
  expect(f.render().some(node => text(node.props.children).includes("Starting location move"))).toBe(true);
  expect(f.button("Close dialog").props.disabled).toBeUndefined(); f.button("Close dialog").props.onClick();
  f.item("New local worktree").props.onSelect({ preventDefault() {} });
  f.render().find(node => node.type === "select")!.props.onChange({ target: { value: "feature/local" } });
  held.resolve({ type: "session.location.move", operation: { id: (f.calls[0] as unknown[])[2] }, session: {} }); await first;
  expect(f.render().some(node => text(node.props.children) === "Hand off")).toBe(true);
});

test("a late failure from a closed move cannot appear in a newer dialog", async () => {
  const f = fixture(); const held = Promise.withResolvers<any>();
  f.props.actions.move = async (...args: unknown[]) => { f.calls.push(args); return held.promise; };
  f.item("New local worktree").props.onSelect({ preventDefault() {} });
  f.render().find(node => node.type === "select")!.props.onChange({ target: { value: "feature/local" } });
  const first = f.button("Hand off").props.onClick(); f.button("Close dialog").props.onClick();
  f.item("New local worktree").props.onSelect({ preventDefault() {} });
  held.reject(new Error("old request failed")); await first;
  expect(f.render().some(node => text(node.props.children).includes("old request failed"))).toBe(false);
});
