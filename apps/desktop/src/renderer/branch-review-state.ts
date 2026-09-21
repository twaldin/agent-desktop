import type { BranchReview, BranchReviewRequest } from "../../../../packages/shared/src/branch-review";
import type { WorkspaceQuery, WorkspaceQueryResult } from "../../../../packages/shared/src/workspace-protocol";

export type ReviewSource = "staged" | "unstaged" | "branch" | "commit";
interface Workspace {
  connected: boolean;
  repositoryInvalidation: number;
  diffSelection: { staged: boolean };
  query(query: WorkspaceQuery): Promise<WorkspaceQueryResult>;
  subscribe(listener: () => void): () => void;
}
export interface BranchReviewView {
  source: ReviewSource;
  baseBranch?: string;
  path?: string;
  loading: boolean;
  result?: BranchReview;
  error?: string;
}
/** One window's workspace selection. Owner/connection/source changes retire reads;
 * reopening the dock keeps intent but obtains a fresh owning-host observation. */
export class BranchReviewState {
  private view: BranchReviewView;
  private active = false;
  private connected = false;
  private invalidation = 0;
  private epoch = 0;
  private reading = false;
  private again = false;
  private unsubscribe?: () => void;
  private listeners = new Set<() => void>();
  constructor(private workspace: Workspace) {
    this.view = { source: workspace.diffSelection.staged ? "staged" : "unstaged", loading: false };
  }
  readonly getSnapshot = () => this.view;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(view: BranchReviewView) { this.view = view; for (const listener of this.listeners) listener(); }
  configure(active: boolean) {
    if (this.active === active && this.connected === this.workspace.connected && this.invalidation === this.workspace.repositoryInvalidation) return;
    this.active = active; this.connected = this.workspace.connected; this.invalidation = this.workspace.repositoryInvalidation;
    if (active) this.unsubscribe ??= this.workspace.subscribe(() => this.configure(this.active));
    else { this.unsubscribe?.(); this.unsubscribe = undefined; }
    this.refresh();
  }
  selectSource(source: ReviewSource) {
    if (source === this.view.source) return;
    this.publish({ ...this.view, source, path: undefined, result: undefined, error: undefined }); this.refresh();
  }
  selectBase(baseBranch?: string) {
    this.publish({ ...this.view, baseBranch, path: undefined, result: undefined, error: undefined }); this.refresh();
  }
  selectPath(path?: string) {
    this.publish({ ...this.view, path, result: undefined, error: undefined }); this.refresh();
  }
  refresh() {
    this.epoch++; this.again = false;
    if (!this.active || this.view.source !== "branch") { this.publish({ ...this.view, loading: false, result: undefined, error: undefined }); return; }
    if (!this.connected) { this.publish({ ...this.view, loading: false, result: undefined, error: "Reconnect to refresh branch changes." }); return; }
    this.publish({ ...this.view, loading: true, result: undefined, error: undefined });
    if (this.reading) this.again = true;
    else void this.read();
  }
  private async read() {
    const epoch = this.epoch;
    const request: BranchReviewRequest = { ...(this.view.baseBranch === undefined ? {} : { baseBranch: this.view.baseBranch }), ...(this.view.path === undefined ? {} : { path: this.view.path }) };
    const current = () => this.active && this.connected && this.workspace.connected && this.view.source === "branch" && epoch === this.epoch;
    if (!current()) return;
    this.reading = true;
    try {
      const response = await this.workspace.query({ type: "git.branch-review", ...request });
      if (!current()) return;
      if (response.type !== "git.branch-review" || !response.review || response.review.requestedBase !== (request.baseBranch ?? null)
        || !["available", "unavailable"].includes(response.review.state)
        || response.review.state === "available" && response.review.path !== request.path) throw new Error("The host returned a different branch comparison.");
      this.publish({ ...this.view, loading: false, result: response.review, error: undefined });
    } catch (cause) {
      if (current()) this.publish({ ...this.view, loading: false, result: undefined, error: cause instanceof Error ? cause.message : "Unable to load branch changes." });
    } finally {
      this.reading = false;
      if (this.again) { this.again = false; void this.read(); }
    }
  }
}
const views = new WeakMap<Workspace, BranchReviewState>();
export function branchReviewState(workspace: Workspace): BranchReviewState {
  let view = views.get(workspace); if (!view) { view = new BranchReviewState(workspace); views.set(workspace, view); } return view;
}
