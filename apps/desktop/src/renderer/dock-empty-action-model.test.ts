import { expect, test } from "bun:test";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DockEmptyActions } from "./DockEmptyActions";
import type { DockAddAction } from "./DockPanel";
import { dockEmptyActionCatalogue } from "./dock-empty-action-model";
import { closeDockTab, createDockState, dockTabId, hideDock, insertDockTab, type DockTab } from "./dock-state";

function panel(kind: "review" | "files", hostId = "owner", target: DockTab["target"] = "session:chat"): DockTab {
  const descriptor = { kind, hostId, target, title: kind };
  return { ...descriptor, id: dockTabId(descriptor) };
}
const review = panel("review");
const reviewAction: DockAddAction = { id: "review", label: "Review", icon: "compose", singletonTabId: review.id, onSelect() {} };
const terminalAction: DockAddAction = { id: "terminal", label: "Terminal", icon: "terminal", onSelect() {} };

// The launcher is pure; walk its semantic children rather than pinning its markup nesting.
function clickButtons(node: ReactNode): void {
  if (Array.isArray(node)) { node.forEach(clickButtons); return; }
  if (!isValidElement<{ children?: ReactNode; onClick?(): void }>(node)) return;
  if (node.type === "button") node.props.onClick!();
  else clickButtons(node.props.children);
}

test("Review is absent while its owner has a tab in either region, including a hidden region, and returns after close", () => {
  for (const destination of ["right", "bottom"] as const) {
    const opened = insertDockTab(createDockState(), review, destination);
    const ids = (state: typeof opened) => dockEmptyActionCatalogue([reviewAction, undefined, terminalAction], state).map(action => action.id);
    expect(ids(opened)).toEqual(["terminal"]);
    expect(ids(hideDock(opened, destination))).toEqual(["terminal"]);
    expect(ids(closeDockTab(opened, destination, review.id))).toEqual(["review", "terminal"]);
  }
});

test("another host or workspace Review does not suppress the current owner's Review", () => {
  let state = insertDockTab(createDockState(), panel("review", "other-host"), "right");
  state = insertDockTab(state, panel("review", "owner", "session:other-chat"), "bottom");
  expect(dockEmptyActionCatalogue([reviewAction, terminalAction], state).map(action => action.id)).toEqual(["review", "terminal"]);
});

test("an existing Files tab stays launchable with its configured shortcut and destination callback", () => {
  const files = panel("files"), selected: string[] = [];
  const filesAction: DockAddAction = { id: "files", label: "Files", icon: "folder", singletonTabId: files.id,
    shortcut: "⌥⇧F", onSelect: destination => selected.push(destination) };
  let state = insertDockTab(createDockState(), review, "bottom");
  state = insertDockTab(state, files, "bottom");
  const actions = dockEmptyActionCatalogue([reviewAction, filesAction], state);
  const markup = renderToStaticMarkup(createElement(DockEmptyActions, { actions, destination: "right" }));
  expect(markup).toContain("⌥⇧F");
  expect(markup).not.toContain(">Review<");
  clickButtons(DockEmptyActions({ actions, destination: "right" }));
  expect(selected).toEqual(["right"]);
});
