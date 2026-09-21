import type { BranchReview, BranchReviewRequest } from "../../../../packages/shared/src/branch-review";
import type { DesktopEvent } from "../../../../packages/shared/src/protocol";
import type { TurnReview, TurnReviewOpenRequest } from "../../../../packages/shared/src/turn-review";
import type { WorkspaceQuery, WorkspaceQueryResult } from "../../../../packages/shared/src/workspace-protocol";

export type ReviewSource = "staged" | "unstaged" | "branch" | "commit" | "last-turn";
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

export interface TurnReviewOwner { hostId: string; conversationId: string }
export interface TurnReviewOptions {
  /** Review panel mounted. */
  active: boolean;
  /** The shared source owner currently shows Last turn. */
  sourceActive: boolean;
  connected: boolean;
  /** The conversation this workspace currently belongs to; absent when no conversation owns it. */
  current: TurnReviewOwner | undefined;
}
export interface TurnReviewView {
  /** Conversation the shown review was read for. */
  owner?: TurnReviewOwner;
  /** Opened from a historical Transcript row; the current conversation no longer steers the read. */
  override: boolean;
  /** Requested path as given; matched against recorded paths once the recorded cwd is known. */
  path?: string;
  loading: boolean;
  review?: TurnReview;
  error?: string;
}
const sameOwner = (a: TurnReviewOwner | undefined, b: TurnReviewOwner | undefined) => a === b || Boolean(a && b && a.hostId === b.hostId && a.conversationId === b.conversationId);
/** Session-owned Last-turn read. The owning host selects the turn; this state only names the
 * conversation. Conversation, host, source and connection changes retire in-flight reads. */
export class TurnReviewState {
  private view: TurnReviewView = { override: false, loading: false };
  private options: TurnReviewOptions = { active: false, sourceActive: false, connected: false, current: undefined };
  private epoch = 0;
  private reading = false;
  private again = false;
  private listeners = new Set<() => void>();
  constructor(private read: (sessionId: string, hostId: string) => Promise<TurnReview>) {}
  readonly getSnapshot = () => this.view;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<TurnReviewView>) { this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener(); }
  private wanted() { return this.options.active && this.options.sourceActive; }
  private target(): TurnReviewOwner | undefined { return this.view.override ? this.view.owner : this.options.current; }
  configure(options: TurnReviewOptions) {
    const old = this.options; this.options = options;
    const wantedChanged = (old.active && old.sourceActive) !== (options.active && options.sourceActive);
    const ownerChanged = !this.view.override && !sameOwner(old.current, options.current);
    if (wantedChanged || ownerChanged || old.connected !== options.connected) this.refresh();
  }
  /** The owning host publishes `turn_review_changed` only after the capture is persisted; only that owner's event re-reads. */
  observe(event: DesktopEvent, localHostId?: string) {
    const owner = this.target();
    if (!owner || !this.wanted() || (event.hostId ?? localHostId) !== owner.hostId || event.type !== "runtime" || event.sessionId !== owner.conversationId) return;
    const native = event.event;
    if (native && typeof native === "object" && "type" in native && native.type === "turn_review_changed") this.refresh();
  }
  /** Historical Transcript request: conversation identity and an optional path, never a turn. */
  open(request: TurnReviewOpenRequest, hostId: string) {
    this.publish({ override: true, owner: { hostId, conversationId: request.conversationId }, path: request.path, review: undefined, error: undefined });
    // Before the shared source shows Last turn, activation via configure() performs the read.
    if (this.wanted()) this.refresh();
  }
  /** Menu selection: drop any historical override and follow the current conversation. */
  useCurrent() {
    this.publish({ override: false, owner: undefined, path: undefined, review: undefined, error: undefined });
    this.refresh();
  }
  selectPath(path?: string) { if (path !== this.view.path) this.publish({ path }); }
  refresh() {
    this.epoch++; this.again = false;
    if (!this.wanted()) { if (this.view.loading || this.view.review || this.view.error || this.view.override || this.view.owner || this.view.path !== undefined) this.publish({ loading: false, review: undefined, error: undefined, override: false, owner: undefined, path: undefined }); return; }
    const owner = this.target();
    if (!owner) { this.publish({ loading: false, owner: undefined, review: undefined, error: undefined }); return; }
    if (!this.options.connected) { this.publish({ loading: false, owner, review: undefined, error: "Reconnect to read the recorded turn." }); return; }
    this.publish({ loading: true, ...(!sameOwner(this.view.owner, owner) ? { review: undefined, path: undefined } : {}), owner, error: undefined });
    if (this.reading) this.again = true;
    else void this.readTurn();
  }
  private async readTurn() {
    const epoch = this.epoch, owner = this.target();
    const current = () => this.wanted() && this.options.connected && epoch === this.epoch && sameOwner(this.target(), owner);
    if (!owner || !current()) return;
    this.reading = true;
    try {
      const review = await this.read(owner.conversationId, owner.hostId);
      if (!current()) return;
      if (review.sessionId !== owner.conversationId) throw new Error("The host returned another conversation's turn.");
      this.publish({ loading: false, owner, review: this.view.review?.revision === review.revision && this.view.review.sessionId === review.sessionId ? this.view.review : review, error: undefined });
    } catch (cause) {
      if (current()) this.publish({ loading: false, owner, review: undefined, error: cause instanceof Error ? cause.message : "Unable to read the recorded turn." });
    } finally {
      this.reading = false;
      if (this.again) { this.again = false; void this.readTurn(); }
    }
  }
}
