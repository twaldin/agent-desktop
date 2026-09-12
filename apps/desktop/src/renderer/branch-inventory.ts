import { parseWorktreeStartingState, parseGitRevisionExpression, type LiveBranchQuery, type LiveBranchResult, type BranchQueryObserverView } from "@agent-desktop/shared";
import type { BranchQueryObserver } from "./branch-query-observer";

type Observer = Pick<BranchQueryObserver, "start" | "dispose" | "recover" | "getSnapshot">;
interface BranchInventoryWorkspace {
  connected: boolean;
  createBranchQueryObserver(query: LiveBranchQuery, listener: (view: BranchQueryObserverView) => void): Observer;
  subscribe(listener: () => void): () => void;
}
export interface BranchInventorySnapshot {
  recent: readonly string[];
  defaultBranch?: string;
  loading: boolean;
  loaded: boolean;
  error?: string;
  defaultError?: string;
  warning?: string;
  defaultWarning?: string;
  baseBranch?: { local: string; remote: string } | null;
}
export function orderBranchNames(recent: readonly string[], current?: string | null, defaultBranch?: string): string[] {
  return [...new Set([defaultBranch, current, ...recent].filter((name): name is string => Boolean(name)))];
}

type InventoryRead = "recent" | "default";
interface ReadSlot { generation: number; owner?: Observer; drain: Promise<void> }
/** Committed inventory owns two independent live subscriptions. The host owns
 * invalidation and query scheduling; renderer release failures fence replacement. */
export class BranchInventory {
  private active = false;
  private connected = false;
  private reads: Record<InventoryRead, ReadSlot> = {
    recent: { generation: 0, drain: Promise.resolve() }, default: { generation: 0, drain: Promise.resolve() },
  };
  private unsubscribe?: () => void;
  private listeners = new Set<() => void>();
  private snapshot: BranchInventorySnapshot = { recent: [], loading: false, loaded: false };
  constructor(private workspace: BranchInventoryWorkspace, private mode: "checkout" | "starting-state" = "checkout") {}
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private current(kind: InventoryRead, version: number) { return version === this.reads[kind].generation && this.active && this.connected && this.workspace.connected; }
  private publish(snapshot: BranchInventorySnapshot) { this.snapshot = snapshot; for (const listener of this.listeners) listener(); }
  private retire(kind: InventoryRead): number {
    const slot = this.reads[kind], version = ++slot.generation, owner = slot.owner;
    slot.owner = undefined;
    if (owner) {
      slot.drain = Promise.resolve().then(() => owner.dispose());
      // Keep the rejected drain for subsequent admission, while observing it now.
      void slot.drain.catch(() => {});
    }
    return version;
  }
  configure(active: boolean) {
    const connected = this.workspace.connected;
    if (this.active === active && this.connected === connected) return;
    this.active = active; this.connected = connected;
    if (active) this.unsubscribe ??= this.workspace.subscribe(() => this.configure(this.active));
    else { this.unsubscribe?.(); this.unsubscribe = undefined; }
    const versions = { recent: this.retire("recent"), default: this.retire("default") };
    this.publish({ recent: [], loading: active && connected, loaded: false,
      ...(active && !connected ? { error: "Reconnect to load branches." } : {}) });
    for (const kind of ["recent", "default"] as const) void this.start(kind, versions[kind]);
  }
  retry() {
    if (!this.active || !this.connected || !this.workspace.connected) return;
    const versions = { recent: this.reads.recent.generation, default: this.reads.default.generation };
    for (const kind of ["recent", "default"] as const) {
      if (!this.current(kind, versions[kind])) continue;
      const slot = this.reads[kind], view = slot.owner?.getSnapshot();
      // Host recover only admits subscriptions whose watch coverage is degraded.
      // Other explicit retries replace the lifetime after its release is acknowledged.
      if (view?.phase === "ready" && (view.error || view.update?.requiresRecovery)) void slot.owner!.recover();
      else {
        const version = this.retire(kind);
        this.publish(kind === "recent" ? { ...this.snapshot, loading: true, error: undefined } : { ...this.snapshot, defaultError: undefined });
        void this.start(kind, version);
      }
    }
  }
  private error(kind: InventoryRead, cause: unknown, warning?: string) {
    const message = cause instanceof Error ? cause.message : String(cause);
    this.publish(kind === "recent" ? { ...this.snapshot, loading: false, error: message, warning }
      : { ...this.snapshot, defaultBranch: undefined, ...(this.mode === "starting-state" ? { baseBranch: null } : {}), defaultError: message, defaultWarning: warning });
  }
  private async start(kind: InventoryRead, version: number) {
    const slot = this.reads[kind];
    try {
      await slot.drain;
      if (!this.current(kind, version)) return;
      const query: LiveBranchQuery = kind === "recent" ? { type: "git.recent-branches", limit: 100 }
        : { type: this.mode === "starting-state" ? "git.base-branch" : "git.default-branch" };
      const owner = this.workspace.createBranchQueryObserver(query, view => {
        if (this.current(kind, version) && slot.owner === owner) this.observe(kind, view);
      });
      slot.owner = owner;
      await owner.start();
    } catch (cause) { if (this.current(kind, version)) this.error(kind, cause); }
  }
  private observe(kind: InventoryRead, view: BranchQueryObserverView) {
    if (view.phase === "connecting" || view.phase === "pending") {
      this.publish(kind === "recent" ? { ...this.snapshot, loading: true, error: undefined } : { ...this.snapshot, defaultError: undefined });
      return;
    }
    if (view.phase !== "ready") {
      this.error(kind, "error" in view && view.error || "Live branch queries are unavailable. Reconnect or retry."); return;
    }
    const warning = view.error ? `Live updates may be incomplete. ${view.error}`
      : view.update?.requiresRecovery ? "Live updates may be incomplete. Retry to restore watching." : undefined;
    if (!view.update) { this.publish(kind === "recent" ? { ...this.snapshot, warning } : { ...this.snapshot, defaultWarning: warning }); return; }
    if (view.update.phase === "failed") { this.error(kind, view.update.error, warning); return; }
    try {
      const next = this.result(kind, view.update.result);
      this.publish(kind === "recent" ? { ...next, warning } : { ...next, defaultWarning: warning });
    } catch (cause) { this.error(kind, cause, warning); }
  }
  private result(kind: InventoryRead, response: LiveBranchResult): BranchInventorySnapshot {
    if (kind === "recent") {
      if (response.type !== "git.recent-branches" || !Array.isArray(response.branches) || response.branches.length > 100)
        throw new Error("The host returned an invalid recent branch response.");
      const recent = response.branches.map(parseGitRevisionExpression);
      return { ...this.snapshot, recent, loading: false, loaded: true, error: undefined };
    } else if (this.mode === "starting-state") {
      if (response.type !== "git.base-branch") throw new Error("The host returned the wrong base branch response.");
      const base = response.base;
      if (base !== null) {
        if (!base || typeof base.remote !== "string") throw new Error("The host returned an invalid base branch.");
        parseWorktreeStartingState({ type: "branch", branchName: parseGitRevisionExpression(base.local), remoteRef: `refs/remotes/${base.remote}/${base.local}` });
      }
      return { ...this.snapshot, baseBranch: base, defaultBranch: base?.local, defaultError: undefined };
    } else {
      if (response.type !== "git.default-branch") throw new Error("The host returned the wrong default branch response.");
      const defaultBranch = response.branch === null ? undefined : parseGitRevisionExpression(response.branch);
      return { ...this.snapshot, defaultBranch, defaultError: undefined };
    }
  }
}
