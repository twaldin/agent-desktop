import type { WorkspaceQueryResult } from "@agent-desktop/shared";

export type FileTreeSearchResult = Extract<WorkspaceQueryResult, { type: "files.search" }>;
export interface FileTreeSnapshot {
  query: string;
  expandedPaths: ReadonlySet<string>;
  selectedPath: string;
  scrollTop: number;
  searchScrollTop: number;
  collapsedSearchPaths: ReadonlySet<string>;
  search?: { query: string; value: FileTreeSearchResult };
  searchError?: { query: string; message: string };
}

export function directoryAncestors(path: string, includeSelf = false): string[] {
  if (!path || path === ".") return [];
  const parts = path.split("/"), result: string[] = [];
  for (let index = 1; index <= parts.length - (includeSelf ? 0 : 1); index++) result.push(parts.slice(0, index).join("/"));
  return result;
}

/** UI memory follows App's window-local WorkspaceState map, not a panel lease.
 * Weak ownership lets a discarded window/bridge release all its roots. A cwd
 * change under the same target is a new root, never an inherited file view. */
const owners = new WeakMap<object, Map<string, WorkspaceFileTreeState>>();
export function getWorkspaceFileTreeState(owner: object, root: string): WorkspaceFileTreeState {
  let roots = owners.get(owner);
  if (!roots) { roots = new Map(); owners.set(owner, roots); }
  let state = roots.get(root);
  if (!state) { state = new WorkspaceFileTreeState(); roots.set(root, state); }
  return state;
}

export class WorkspaceFileTreeState {
  private snapshot: FileTreeSnapshot = { query: "", expandedPaths: new Set(), selectedPath: "", scrollTop: 0, searchScrollTop: 0, collapsedSearchPaths: new Set() };
  private listeners = new Set<() => void>();
  private activeViews = new Set<object>();
  private requests = new Map<object, number>();
  private requestSequence = 0;
  private completedRequest = 0;
  getSnapshot = (): FileTreeSnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<FileTreeSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  activate(view: object): () => void {
    this.activeViews.add(view);
    return () => { this.activeViews.delete(view); this.requests.delete(view); };
  }
  isActive(view: object): boolean { return this.activeViews.has(view); }
  setQuery(view: object, query: string) {
    if (!this.isActive(view) || this.snapshot.query === query) return;
    this.requests.clear();
    this.update({ query, searchScrollTop: 0, collapsedSearchPaths: new Set(), searchError: undefined });
  }
  /** iVi: reveal is additive, and neither filters nor scroll are reset. */
  reveal(view: object, path: string, initialDirectory = ".") {
    if (!this.isActive(view)) return;
    let expandedPaths = this.snapshot.expandedPaths;
    for (const ancestor of [...directoryAncestors(path), ...directoryAncestors(initialDirectory, true)]) {
      if (expandedPaths.has(ancestor)) continue;
      if (expandedPaths === this.snapshot.expandedPaths) expandedPaths = new Set(expandedPaths);
      (expandedPaths as Set<string>).add(ancestor);
    }
    const selectedPath = path || this.snapshot.selectedPath;
    if (expandedPaths !== this.snapshot.expandedPaths || selectedPath !== this.snapshot.selectedPath) this.update({ expandedPaths, selectedPath });
  }
  select(view: object, selectedPath: string) {
    if (this.isActive(view) && selectedPath !== this.snapshot.selectedPath) this.update({ selectedPath });
  }
  setScrollTop(view: object, value: number, search: boolean) {
    if (!this.isActive(view)) return;
    const key = search ? "searchScrollTop" : "scrollTop";
    if (value !== this.snapshot[key]) this.update({ [key]: value });
  }
  toggleDirectory(view: object, path: string, force?: boolean, search = false) {
    if (!this.isActive(view)) return;
    const previous = search ? this.snapshot.collapsedSearchPaths : this.snapshot.expandedPaths;
    const next = new Set(previous), open = force ?? (search ? next.has(path) : !next.has(path));
    if (search ? !open : open) next.add(path); else next.delete(path);
    this.update(search ? { collapsedSearchPaths: next } : { expandedPaths: next });
  }
  searchResult(query: string): FileTreeSearchResult | undefined {
    return this.snapshot.search?.query === query ? this.snapshot.search.value : undefined;
  }
  /** Like WorkspaceFileSearch's effect cleanup, replies are owner/query fenced.
   * The identity also rejects A → B → A and a prior view's late completion. */
  beginSearch(view: object, query: string) {
    const request = ++this.requestSequence;
    if (this.isActive(view) && this.snapshot.query === query) { this.requests.set(view, request); this.update({ searchError: undefined }); }
    const current = () => this.isActive(view) && this.requests.get(view) === request && this.snapshot.query === query && request >= this.completedRequest;
    return {
      resolve: (value: FileTreeSearchResult) => { if (current()) { this.completedRequest = request; this.update({ search: { query, value }, searchError: undefined }); } },
      reject: (cause: unknown) => { if (current()) { this.completedRequest = request; this.update({ searchError: { query, message: cause instanceof Error ? cause.message : "File search failed." } }); } },
      cancel: () => { if (this.requests.get(view) === request) this.requests.delete(view); },
    };
  }
}
