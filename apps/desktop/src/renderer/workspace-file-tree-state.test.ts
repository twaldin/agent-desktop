import { expect, test } from "bun:test";
import { getWorkspaceFileTreeState, WorkspaceFileTreeState, type FileTreeSearchResult } from "./workspace-file-tree-state";

const result = (path: string): FileTreeSearchResult => ({
  type: "files.search", status: "complete", nativeTotalMatches: 1,
  entries: [{ path, name: path.split("/").at(-1)!, kind: "file", size: 1, mode: 0, modifiedAt: 0, score: 1 }],
});

test("browser replacement, preview replacement and reopen retain the owner/root view while revealing active ancestors", () => {
  const owner = {}, browser = {}, preview = {}, reopened = {};
  const state = getWorkspaceFileTreeState(owner, "/workspace");
  const releaseBrowser = state.activate(browser);
  state.toggleDirectory(browser, "docs");
  state.setScrollTop(browser, 180, false);
  state.setQuery(browser, "needle");
  state.setScrollTop(browser, 48, true);
  releaseBrowser();
  const editor = getWorkspaceFileTreeState(owner, "/workspace");
  const releasePreview = editor.activate(preview);
  editor.reveal(preview, "src/deep/needle.ts");
  editor.reveal(preview, "lib/next.ts");
  releasePreview();
  const restored = getWorkspaceFileTreeState(owner, "/workspace");
  restored.activate(reopened);
  expect(restored.getSnapshot()).toMatchObject({ query: "needle", scrollTop: 180, searchScrollTop: 48, selectedPath: "lib/next.ts" });
  expect([...restored.getSnapshot().expandedPaths]).toEqual(["docs", "src", "src/deep", "lib"]);
  expect(getWorkspaceFileTreeState({}, "/workspace").getSnapshot().query).toBe("");
  expect(getWorkspaceFileTreeState(owner, "/other-root").getSnapshot().selectedPath).toBe("");
});

test("hidden views and late cleanup cannot overwrite the active view's selection, query or scroll", () => {
  const state = new WorkspaceFileTreeState(), hidden = {}, active = {};
  const releaseHidden = state.activate(hidden);
  state.activate(active);
  state.reveal(active, "src/active.ts");
  state.setQuery(active, "active");
  state.setScrollTop(active, 240, false);
  releaseHidden();
  state.reveal(hidden, "old/hidden.ts");
  state.select(hidden, "old.ts");
  state.setQuery(hidden, "old");
  state.setScrollTop(hidden, 0, false);
  expect(state.getSnapshot()).toMatchObject({ query: "active", selectedPath: "src/active.ts", scrollTop: 240 });
  state.select(active, "src/next.ts");
  expect(state.getSnapshot().selectedPath).toBe("src/next.ts");
});

test("simultaneously visible panes remain usable and one pane closing cannot cancel the other's search", () => {
  const state = new WorkspaceFileTreeState(), right = {}, bottom = {};
  state.activate(right);
  const closeBottom = state.activate(bottom);
  state.setQuery(right, "needle");
  expect(state.getSnapshot().query).toBe("needle");
  const rightSearch = state.beginSearch(right, "needle");
  const bottomSearch = state.beginSearch(bottom, "needle");
  closeBottom();
  bottomSearch.resolve(result("closed.ts"));
  rightSearch.resolve(result("needle.ts"));
  expect(state.searchResult("needle")?.entries.map(entry => entry.path)).toEqual(["needle.ts"]);
});

test("search completion is fenced across query changes, owner changes and replacement views", () => {
  const state = new WorkspaceFileTreeState(), view = {}, replacement = {};
  const releaseView = state.activate(view); state.setQuery(view, "old");
  const old = state.beginSearch(view, "old");
  state.setQuery(view, "new");
  const current = state.beginSearch(view, "new");
  current.resolve(result("new.ts")); old.resolve(result("old.ts"));
  expect(state.searchResult("new")?.entries.map(entry => entry.path)).toEqual(["new.ts"]);
  expect(state.searchResult("old")).toBeUndefined();
  const departing = state.beginSearch(view, "new");
  releaseView();
  state.activate(replacement);
  departing.resolve(result("late.ts"));
  expect(state.searchResult("new")?.entries[0]?.path).toBe("new.ts");
  const other = new WorkspaceFileTreeState(); other.activate(view); other.setQuery(view, "new");
  expect(other.searchResult("new")).toBeUndefined();
  const cancelled = other.beginSearch(view, "new"); cancelled.cancel(); cancelled.reject(new Error("Late error"));
  expect(other.getSnapshot().searchError).toBeUndefined();
  const returning = other.beginSearch(view, "new");
  other.setQuery(view, "away"); other.setQuery(view, "new");
  returning.resolve(result("obsolete.ts"));
  expect(other.searchResult("new")).toBeUndefined();
});

test("query mode preserves tree state, resets search navigation and keeps only exact-query host results", () => {
  const state = new WorkspaceFileTreeState(), view = {};
  state.activate(view); state.toggleDirectory(view, "docs"); state.select(view, "docs"); state.setScrollTop(view, 120, false);
  state.setQuery(view, " needle ");
  const bounded = result("z/needle.ts");
  bounded.entries.push({ ...bounded.entries[0]!, path: "a/needle.ts" });
  bounded.status = "truncated"; bounded.nativeTotalMatches = 800;
  state.beginSearch(view, " needle ").resolve(bounded);
  expect(state.searchResult(" needle ")).toEqual(bounded);
  expect(state.searchResult("needle")).toBeUndefined();
  state.toggleDirectory(view, "z", undefined, true); state.setScrollTop(view, 80, true);
  state.setQuery(view, "other");
  expect(state.getSnapshot().searchScrollTop).toBe(0);
  expect(state.getSnapshot().collapsedSearchPaths.size).toBe(0);
  expect(state.searchResult("other")).toBeUndefined();
  state.setQuery(view, "");
  expect(state.getSnapshot()).toMatchObject({ selectedPath: "docs", scrollTop: 120 });
  expect([...state.getSnapshot().expandedPaths]).toEqual(["docs"]);
});
