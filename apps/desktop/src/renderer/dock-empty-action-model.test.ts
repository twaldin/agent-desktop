import { expect, test } from "bun:test";
import { createElement } from "react";
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

// Exercise the actual hook-owning component through React while keeping callback
// assertions on the semantic actions returned by the catalogue.
function renderActions(actions: readonly DockAddAction[], destination: "right" | "bottom") {
  const markup = renderToStaticMarkup(createElement(DockEmptyActions, { actions, destination }));
  return { markup, activate: () => actions.forEach(action => action.onSelect(destination)) };
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
  const rendered = renderActions(actions, "right");
  const { markup } = rendered;
  expect(markup).toContain("⌥⇧F");
  expect(markup).not.toContain(">Review<");
  rendered.activate();
  expect(selected).toEqual(["right"]);
});

test("repository ordering is independent of Review membership and retains contributed action dispatch", () => {
  const calls: string[] = [];
  const ids = ["files", "side-chat", "browser", "review", "mcp:second", "mcp:first", "terminal"];
  const declarations: DockAddAction[] = ids.map(id => ({
    id, label: id, icon: "compose", singletonTabId: id === "review" ? review.id : undefined,
    onSelect: destination => calls.push(`${id}:${destination}`),
  }));
  const state = createDockState();
  const normal = dockEmptyActionCatalogue(declarations, state, false);
  const rendered = renderActions(normal, "right");
  expect(ids.every(id => rendered.markup.includes(`>${id}<`))).toBe(true);
  expect(ids.every((id, index) => index === 0 || rendered.markup.indexOf(`>${ids[index - 1]}<`) < rendered.markup.indexOf(`>${id}<`))).toBe(true);
  rendered.activate();
  expect(calls).toEqual(ids.map(id => `${id}:right`));
  expect(dockEmptyActionCatalogue(declarations, state, true).map(action => action.id))
    .toEqual(["review", "terminal", "browser", "files", "side-chat", "mcp:second", "mcp:first"]);
  const hiddenReview = hideDock(insertDockTab(state, review, "bottom"), "bottom");
  expect(dockEmptyActionCatalogue(declarations, hiddenReview, true).map(action => action.id))
    .toEqual(["terminal", "browser", "files", "side-chat", "mcp:second", "mcp:first"]);
  expect(dockEmptyActionCatalogue(declarations, hiddenReview, false).map(action => action.id))
    .toEqual(["files", "side-chat", "browser", "mcp:second", "mcp:first", "terminal"]);
  expect(declarations.map(action => action.id)).toEqual(ids);
});
