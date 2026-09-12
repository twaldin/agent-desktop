import type { GitReviewSummary, GitStatus, WorkspaceQuery, WorkspaceQueryResult } from "@agent-desktop/shared";

interface ReviewWorkspace {
  connected: boolean;
  status?: GitStatus;
  query(query: WorkspaceQuery): Promise<WorkspaceQueryResult>;
  subscribe(listener: () => void): () => void;
}
export interface BranchReviewValue {
  files: GitReviewSummary["files"];
  additions: number;
  deletions: number;
  fileCount: number;
}
export interface BranchReviewSnapshot { value?: BranchReviewValue; loading: boolean; error?: string }
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function readSummary(response: WorkspaceQueryResult, source: GitReviewSummary["source"]): GitReviewSummary {
  const invalid = () => new Error("The host returned invalid review statistics.");
  if (response.type !== "git.review-summary") throw invalid();
  const summary = response.summary;
  if (!summary || summary.source !== source || typeof summary.revision !== "string" || !/^[a-f0-9]{64}$/.test(summary.revision)
    || ![summary.stagedCount, summary.unstagedCount, summary.untrackedCount].every(count) || !Array.isArray(summary.files)) throw invalid();
  const files = summary.files.map(file => {
    if (!file || typeof file.path !== "string" || !file.path || file.path.includes("\0")
      || file.previousPath !== null && (typeof file.previousPath !== "string" || !file.previousPath || file.previousPath.includes("\0"))
      || file.additions !== null && !count(file.additions) || file.deletions !== null && !count(file.deletions)
      || (file.additions === null) !== (file.deletions === null)) throw invalid();
    return { path: file.path, previousPath: file.previousPath, additions: file.additions, deletions: file.deletions };
  });
  return { ...summary, files };
}

/** Pinned In/Ln semantics: sum the two review sources, including cancellation,
 * and match a refusal's display path against either side of a rename. */
export function combineBranchReview(staged: GitReviewSummary, unstaged: GitReviewSummary): BranchReviewValue {
  if (staged.revision !== unstaged.revision || staged.stagedCount !== unstaged.stagedCount
    || staged.unstagedCount !== unstaged.unstagedCount || staged.untrackedCount !== unstaged.untrackedCount)
    throw new Error("Git changed while reading review statistics. Refresh the changes.");
  const files = [...staged.files, ...unstaged.files];
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0), deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  const fileCount = Math.max(staged.stagedCount, staged.unstagedCount) + staged.untrackedCount;
  if (![additions, deletions, fileCount].every(count)) throw new Error("Review totals exceed the supported range.");
  return { files, additions, deletions, fileCount };
}
function normalizedPath(path: string) {
  const trimmed = path.trim();
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"') || trimmed.startsWith("'") && trimmed.endsWith("'") ? trimmed.slice(1, -1) : trimmed;
  const relative = unquoted.startsWith("./") ? unquoted.slice(2) : unquoted;
  return relative.startsWith("a/") || relative.startsWith("b/") ? relative.slice(2) : relative;
}
export function branchReviewPath(value: BranchReviewValue | undefined, path: string) {
  const normalized = normalizedPath(path), files = value?.files.filter(file => [file.path, file.previousPath].some(path => path !== null && normalizedPath(path) === normalized));
  return files?.length ? { additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0), deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) } : undefined;
}

/** One dialog's read lifetime. Sent queries cannot be cancelled, so replacements
 * queue behind the old pair; generation invalidation prevents stale publication. */
export class BranchReview {
  private active = false;
  private connected = false;
  private status?: GitStatus;
  private generation = 0;
  private reading = false;
  private queued?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private listeners = new Set<() => void>();
  private snapshot: BranchReviewSnapshot = { loading: false };
  constructor(private workspace: ReviewWorkspace) {}
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(value: BranchReviewSnapshot) { this.snapshot = value; for (const listener of this.listeners) listener(); }
  private current(version: number) { return this.active && this.connected && this.workspace.connected && this.generation === version && this.status === this.workspace.status; }
  configure(active: boolean) {
    const connected = this.workspace.connected, status = this.workspace.status;
    if (active === this.active && connected === this.connected && status === this.status) return;
    this.active = active; this.connected = connected; this.status = status;
    if (active) this.unsubscribe ??= this.workspace.subscribe(() => this.configure(this.active));
    else { this.unsubscribe?.(); this.unsubscribe = undefined; }
    this.refresh(true);
  }
  readonly retry = () => { if (this.active && this.connected) this.refresh(false); };
  private refresh(clear: boolean) {
    clearTimeout(this.timer); this.timer = undefined;
    const version = ++this.generation; this.queued = undefined;
    if (!this.active) { this.publish({ loading: false }); return; }
    if (!this.connected) { this.publish({ loading: false, error: "Reconnect to load change statistics." }); return; }
    this.publish({ ...(clear ? {} : this.snapshot), loading: true, error: undefined });
    void this.read(version);
  }
  private async read(version: number) {
    if (!this.current(version)) return;
    if (this.reading) { this.queued = version; return; }
    this.reading = true;
    try {
      // allSettled also drains the sibling after an early failure: retry cannot
      // start an overlapping pair while uncancellable IPC is still in flight.
      const query = (source: GitReviewSummary["source"]) => Promise.resolve().then(() => {
        if (!this.current(version)) throw new Error("The change statistics read is no longer current.");
        return this.workspace.query({ type: "git.review-summary", source });
      });
      const results = await Promise.allSettled([query("staged"), query("unstaged")]);
      if (!this.current(version)) return;
      const [staged, unstaged] = results;
      if (staged.status === "rejected") throw staged.reason;
      if (unstaged.status === "rejected") throw unstaged.reason;
      const first = readSummary(staged.value, "staged"), second = readSummary(unstaged.value, "unstaged");
      if (this.status && first.revision !== this.status.revision) throw new Error("Git changed while reading review statistics. Refresh the changes.");
      this.publish({ loading: false, value: combineBranchReview(first, second) });
    } catch (cause) {
      if (this.current(version)) this.publish({ loading: false, error: cause instanceof Error ? cause.message : "Unable to load change statistics." });
    } finally {
      this.reading = false;
      const queued = this.queued; this.queued = undefined;
      if (queued !== undefined) void this.read(queued);
      else if (this.current(version)) this.timer = setTimeout(this.retry, 2000);
    }
  }
}
