import { parseGitCheckoutTarget, parseGitRevisionExpression, type BranchQueryType, type GitCheckoutTarget, type GitBranch, type WorkspaceQuery, type WorkspaceQueryResult } from "@agent-desktop/shared";
import { parseStartingSearchRows } from "./starting-state-options";

export interface BranchSearchWorkspace {
  connected: boolean;
  repositoryInvalidation?: number;
  repositoryQueryRevision(query: BranchQueryType): number;
  query(query: WorkspaceQuery): Promise<WorkspaceQueryResult>;
  subscribe(listener: () => void): () => void;
}
export interface BranchSearchSnapshot {
  query: string;
  loading: boolean;
  branches: readonly GitBranch[];
  limitReached: boolean;
  error?: string;
}
export const BRANCH_SEARCH_DELAY_MS = 200;
export type BranchPickerMode = "checkout" | "starting-state";

/** One open picker's owning-host reads. Connection loss invalidates sent reads
 * even if reconnect happens before React renders again. It does not cancel IPC. */
export class BranchSearch {
  private active = false;
  private connected = false;
  private query = "";
  private repositoryInvalidation?: number;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private reading = false;
  private queued?: { query: string; version: number };
  private unsubscribe?: () => void;
  private listeners = new Set<() => void>();
  private snapshot: BranchSearchSnapshot = { query: "", loading: false, branches: [], limitReached: false };
  constructor(private workspace: BranchSearchWorkspace, private mode: BranchPickerMode = "checkout") {}
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = () => this.snapshot;
  get version() { return this.generation; }
  isCurrent(version: number) { return version === this.generation && this.active && this.connected && this.workspace.connected; }
  private publish(snapshot: BranchSearchSnapshot) { this.snapshot = snapshot; for (const listener of this.listeners) listener(); }
  configure(query: string, active: boolean) {
    query = query.trim();
    if (this.query === query && this.active === active && this.connected === this.workspace.connected && this.repositoryInvalidation === this.workspace.repositoryQueryRevision(this.mode === "starting-state" ? "git.search-starting-branches" : "git.search-branches")) return;
    this.query = query; this.active = active; this.connected = this.workspace.connected; this.repositoryInvalidation = this.workspace.repositoryQueryRevision(this.mode === "starting-state" ? "git.search-starting-branches" : "git.search-branches");
    if (active) this.unsubscribe ??= this.workspace.subscribe(() => {
      if (this.connected !== this.workspace.connected || this.repositoryInvalidation !== this.workspace.repositoryQueryRevision(this.mode === "starting-state" ? "git.search-starting-branches" : "git.search-branches")) this.configure(this.query, this.active);
    });
    else { this.unsubscribe?.(); this.unsubscribe = undefined; }
    this.restart();
  }
  retry() { if (this.active && this.connected && this.query) this.restart(); }
  private restart() {
    const version = ++this.generation, query = this.query;
    clearTimeout(this.timer); this.timer = undefined; this.queued = undefined;
    if (!this.active || !query) { this.publish({ query, loading: false, branches: [], limitReached: false }); return; }
    if (!this.connected) { this.publish({ query, loading: false, branches: [], limitReached: false, error: "Reconnect to search branches." }); return; }
    this.publish({ query, loading: true, branches: [], limitReached: false });
    this.timer = setTimeout(() => { this.timer = undefined; void this.read(query, version); }, this.mode === "starting-state" ? 300 : BRANCH_SEARCH_DELAY_MS);
  }
  private async read(query: string, version: number) {
    if (!this.isCurrent(version)) return;
    if (this.reading) { this.queued = { query, version }; return; }
    this.reading = true;
    try {
      const type = this.mode === "starting-state" ? "git.search-starting-branches" : "git.search-branches";
      const result = await this.workspace.query({ type, query, limit: 20 });
      if (!this.isCurrent(version)) return;
      if ((result.type !== "git.search-branches" && result.type !== "git.search-starting-branches") || result.type !== type || typeof result.limitReached !== "boolean") throw new Error("The host returned the wrong branch search response.");
      this.publish({ query, loading: false, branches: this.mode === "starting-state" ? parseStartingSearchRows(result.branches) : result.branches, limitReached: result.limitReached });
    } catch (cause) {
      if (this.isCurrent(version)) this.publish({ query, loading: false, branches: [], limitReached: false,
        error: cause instanceof Error ? cause.message : "Unable to load branches." });
    } finally {
      this.reading = false;
      const queued = this.queued; this.queued = undefined;
      if (queued) void this.read(queued.query, queued.version);
    }
  }
  async resolveCheckout(query: string): Promise<GitCheckoutTarget | undefined> {
    const version = this.generation, admission = this.workspace.repositoryInvalidation;
    if (this.mode !== "checkout" || !this.isCurrent(version)) return;
    const expression = parseGitRevisionExpression(query);
    try {
      const result = await this.workspace.query({ type: "git.resolve-checkout", expression });
      if (!this.isCurrent(version) || admission !== this.workspace.repositoryInvalidation) return;
      if (result.type !== "git.resolve-checkout") throw new Error("The host returned the wrong checkout target response.");
      if (result.target === null) throw new Error("No matching branch or locally available commit.");
      const target = parseGitCheckoutTarget(result.target);
      if (target.expression !== expression) throw new Error("The host returned a different checkout expression.");
      return target;
    } catch (cause) { if (this.isCurrent(version) && admission === this.workspace.repositoryInvalidation) throw cause; return; }
  }
}
