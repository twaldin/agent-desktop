import { reconcileCommitReviewSelection, type GitCommitReviewFile, type GitCommitReviewList, type GitCommitReviewSelection, type GitCommitReviewSnapshot, type GitReviewCommit } from "../../../../packages/shared/src/git-commit-review";
import type { WorkspaceQuery, WorkspaceQueryResult } from "../../../../packages/shared/src/workspace-protocol";

interface Workspace {
  connected: boolean;
  repositoryInvalidation: number;
  query(query: WorkspaceQuery): Promise<WorkspaceQueryResult>;
  subscribe(listener: () => void): () => void;
}
export interface CommitReviewOptions {
  /** Review panel mounted. */
  active: boolean;
  /** The shared source owner currently shows Commit. */
  sourceActive: boolean;
  /** The Commits submenu is open; the picker list is loaded for it even while another source is shown. */
  pickerOpen: boolean;
  /** Shared Branch base; changes picker membership only, never a selected commit's parent. */
  baseBranch?: string;
}
export interface CommitReviewFileView { loading: boolean; patch?: string; error?: string }
export interface CommitReviewView {
  /** Present only after the last authoritative read for the current base and owner; empty commits differ from an error. */
  list?: GitCommitReviewList;
  listLoading: boolean;
  listError?: string;
  /** Retained across source switches and pending/error lists; cleared only by an authoritative list. */
  selection: GitCommitReviewSelection | null;
  review?: GitCommitReviewSnapshot;
  loading: boolean;
  error?: string;
  path?: string;
  /** Lazily read per-file patches keyed by the destination path of a snapshot-issued file. */
  diffs: ReadonlyMap<string, CommitReviewFileView>;
}
const FILE_READ_LIMIT = 4;
const NO_DIFFS: ReadonlyMap<string, CommitReviewFileView> = new Map();
const message = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

/** One window's immutable commit selection. The picker list follows base/owner/connection
 * changes; the selected snapshot and its file patches follow only source/selection/connection.
 * Each read family keeps its own epoch so a late reply can never outrun a newer intent. */
export class CommitReviewState {
  private view: CommitReviewView = { listLoading: false, selection: null, loading: false, diffs: NO_DIFFS };
  private options: CommitReviewOptions = { active: false, sourceActive: false, pickerOpen: false };
  private connected = false;
  private invalidation = 0;
  private listEpoch = 0;
  private listReading = false;
  private listAgain = false;
  private reviewEpoch = 0;
  private reviewReading = false;
  private reviewAgain = false;
  private fileEpoch = 0;
  private fileQueue: GitCommitReviewFile[] = [];
  private filesReading = 0;
  private unsubscribe?: () => void;
  private listeners = new Set<() => void>();
  constructor(private workspace: Workspace, private onInvalidSelection: () => void) {}
  readonly getSnapshot = () => this.view;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<CommitReviewView>) { this.view = { ...this.view, ...patch }; for (const listener of this.listeners) listener(); }
  private listWanted() { return this.options.active && (this.options.pickerOpen || this.options.sourceActive); }
  private reviewWanted() { return this.options.active && this.options.sourceActive && this.view.selection !== null; }

  configure(options: CommitReviewOptions) {
    const previous = this.options, connected = this.workspace.connected, invalidation = this.workspace.repositoryInvalidation;
    const listBefore = this.listWanted(), reviewBefore = this.reviewWanted();
    const connectionChanged = connected !== this.connected;
    const baseChanged = options.baseBranch !== previous.baseBranch;
    this.options = options; this.connected = connected;
    const ownerChanged = invalidation !== this.invalidation; this.invalidation = invalidation;
    if (options.active) this.unsubscribe ??= this.workspace.subscribe(() => this.configure(this.options));
    else { this.unsubscribe?.(); this.unsubscribe = undefined; }
    const listAfter = this.listWanted(), reviewAfter = this.reviewWanted();
    if (reviewBefore !== reviewAfter || reviewAfter && connectionChanged) this.syncReview();
    if (listBefore !== listAfter || listAfter && (connectionChanged || baseChanged || ownerChanged)) this.syncList(baseChanged || ownerChanged);
  }
  /** Rows come from the visible list; the selection adopts that list's owner. */
  selectCommit(commit: GitReviewCommit) {
    const list = this.view.list;
    if (!list || !list.commits.some(row => row.commit === commit.commit)) return;
    const selection = this.view.selection;
    if (selection && selection.repositoryId === list.repositoryId && selection.commit === commit.commit) return;
    this.publish({ selection: { repositoryId: list.repositoryId, commit: commit.commit }, path: undefined, review: undefined, loading: false, error: undefined, diffs: NO_DIFFS });
    this.syncReview();
  }
  selectPath(path?: string) { if (path !== this.view.path) this.publish({ path }); }
  /** Lazy immutable patch for one snapshot-issued file. Inflight reads are shared; errors re-request. */
  requestFile(file: GitCommitReviewFile) {
    const review = this.view.review;
    if (!review || !this.reviewWanted() || !review.files.some(row => row.path === file.path && row.previousPath === file.previousPath)) return;
    const existing = this.view.diffs.get(file.path);
    if (existing && (existing.loading || existing.patch !== undefined)) return;
    this.publishFile(file.path, { loading: true });
    this.fileQueue.push(file); this.pumpFiles();
  }
  retryCommits() { if (this.listWanted()) this.syncList(false); }
  refresh() {
    if (this.reviewWanted()) this.syncReview();
    if (this.listWanted()) this.syncList(false);
  }

  private syncList(discard: boolean) {
    this.listEpoch++; this.listAgain = false;
    if (!this.listWanted()) { this.publish({ list: undefined, listLoading: false, listError: undefined }); return; }
    if (!this.connected) { this.publish({ list: undefined, listLoading: false, listError: "Reconnect to refresh commits." }); return; }
    this.publish({ ...(discard ? { list: undefined } : {}), listLoading: true, listError: undefined });
    if (this.listReading) this.listAgain = true;
    else void this.readList();
  }
  private async readList() {
    const epoch = this.listEpoch, baseBranch = this.options.baseBranch;
    const current = () => epoch === this.listEpoch && this.connected && this.workspace.connected && this.listWanted();
    if (!current()) return;
    this.listReading = true;
    try {
      const response = await this.workspace.query({ type: "git.commit-review-commits", ...(baseBranch === undefined ? {} : { baseBranch }) });
      if (!current()) return;
      if (response.type !== "git.commit-review-commits" || typeof response.list?.repositoryId !== "string" || !Array.isArray(response.list.commits)) throw new Error("The host returned a different commit list.");
      const list = response.list;
      const selection = reconcileCommitReviewSelection(this.view.selection, list.repositoryId, list.commits);
      const invalidated = this.view.selection !== null && selection === null;
      this.publish({ list, listLoading: false, listError: undefined, ...(invalidated ? { selection: null, path: undefined, review: undefined, loading: false, error: undefined, diffs: NO_DIFFS } : {}) });
      if (invalidated) { const sourceActive = this.options.sourceActive; this.syncReview(); if (sourceActive) this.onInvalidSelection(); }
    } catch (cause) {
      if (current()) this.publish({ list: undefined, listLoading: false, listError: message(cause, "Unable to load commits.") });
    } finally {
      this.listReading = false;
      if (this.listAgain) { this.listAgain = false; void this.readList(); }
    }
  }
  private syncReview() {
    this.reviewEpoch++; this.reviewAgain = false;
    this.fileEpoch++; this.fileQueue.length = 0;
    if (!this.reviewWanted()) { this.publish({ review: undefined, loading: false, error: undefined, diffs: NO_DIFFS }); return; }
    if (!this.connected) { this.publish({ review: undefined, loading: false, error: "Reconnect to refresh commit changes.", diffs: NO_DIFFS }); return; }
    this.publish({ review: undefined, loading: true, error: undefined, diffs: NO_DIFFS });
    if (this.reviewReading) this.reviewAgain = true;
    else void this.readReview();
  }
  private async readReview() {
    const epoch = this.reviewEpoch, selection = this.view.selection;
    const current = () => epoch === this.reviewEpoch && this.connected && this.workspace.connected && this.reviewWanted();
    if (!selection || !current()) return;
    this.reviewReading = true;
    try {
      const response = await this.workspace.query({ type: "git.commit-review", selection });
      if (!current()) return;
      const review = response.type === "git.commit-review" ? response.review : undefined;
      if (!review || review.selection.repositoryId !== selection.repositoryId || review.selection.commit !== selection.commit || !Array.isArray(review.files)) throw new Error("The host returned a different commit.");
      this.publish({ review, loading: false, error: undefined });
    } catch (cause) {
      if (current()) this.publish({ review: undefined, loading: false, error: message(cause, "Unable to load commit changes.") });
    } finally {
      this.reviewReading = false;
      if (this.reviewAgain) { this.reviewAgain = false; void this.readReview(); }
    }
  }
  private publishFile(path: string, file: CommitReviewFileView) {
    const diffs = new Map(this.view.diffs); diffs.set(path, file); this.publish({ diffs });
  }
  private pumpFiles() {
    while (this.filesReading < FILE_READ_LIMIT && this.fileQueue.length) { this.filesReading++; void this.readFile(this.fileQueue.shift()!); }
  }
  private async readFile(file: GitCommitReviewFile) {
    const epoch = this.fileEpoch, selection = this.view.selection!;
    const current = () => epoch === this.fileEpoch && this.connected && this.workspace.connected;
    try {
      const response = await this.workspace.query({ type: "git.commit-review-diff", selection, file: { path: file.path, ...(file.previousPath === null ? {} : { previousPath: file.previousPath }) } });
      if (!current()) return;
      const diff = response.type === "git.commit-review-diff" ? response.diff : undefined;
      if (!diff || diff.selection.repositoryId !== selection.repositoryId || diff.selection.commit !== selection.commit || diff.path !== file.path || typeof diff.patch !== "string") throw new Error("The host returned a different file diff.");
      this.publishFile(file.path, { loading: false, patch: diff.patch });
    } catch (cause) {
      if (current()) this.publishFile(file.path, { loading: false, error: message(cause, "Unable to load this file.") });
    } finally {
      this.filesReading--; this.pumpFiles();
    }
  }
}

const views = new WeakMap<Workspace, CommitReviewState>();
export function commitReviewState(workspace: Workspace, onInvalidSelection: () => void): CommitReviewState {
  let view = views.get(workspace);
  if (!view) { view = new CommitReviewState(workspace, onInvalidSelection); views.set(workspace, view); }
  return view;
}
