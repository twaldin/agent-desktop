import { repositoryChangeAffects, type GitRepositoryChange, type WorkspaceQuery, type WorkspaceQueryResult } from "@agent-desktop/shared";

export type BranchLiveQuery = Extract<WorkspaceQuery, { type: "git.recent-branches" | "git.default-branch" | "git.base-branch" }>;
export type BranchLiveResult = Extract<WorkspaceQueryResult, { type: BranchLiveQuery["type"] }>;
export interface BranchQueryLocation { hostId: string; root: string; commonDir: string; local: boolean }
export type BranchQueryUpdate = {
  subscriptionId: string; generation: number; requiresRecovery: boolean;
} & ({ phase: "complete"; result: BranchLiveResult } | { phase: "failed"; error: string });
interface Subscription {
  id: string; location: BranchQueryLocation; query: BranchLiveQuery; current(): boolean;
  emit(update: BranchQueryUpdate): void; generation: number; recovery: boolean; dirty: boolean;
  timer?: ReturnType<typeof setTimeout>; running?: Promise<void>; abort?: AbortController;
  waiters: (() => void)[];
}
interface SharedRun { abort: AbortController; consumers: Set<Subscription>; result: Promise<BranchLiveResult> }
const stopped = () => new DOMException("Branch query subscription ended.", "AbortError");

/** Host-private query execution owner. Its caller must first resolve the
 * catalog owner and retain its repository watch, and release that watch only
 * after unregistering here. This is not an admission or transport API. */
export class BranchLiveQueries {
  private subscriptions = new Map<string, Subscription>();
  private shared = new Map<string, SharedRun>();
  private repositories = new Map<string, Promise<void>>();
  private generation = 0;
  private disposed = false;
  constructor(private dependencies: {
    run(query: BranchLiveQuery, location: BranchQueryLocation, signal: AbortSignal): Promise<BranchLiveResult>;
    prepareRecovery(location: BranchQueryLocation): void;
  }) {}

  subscribe(input: {
    subscriptionId: string; location: BranchQueryLocation; query: BranchLiveQuery;
    requiresRecovery: boolean; isCurrent(): boolean; emit(update: BranchQueryUpdate): void;
  }): { dispose(): void } {
    if (this.disposed || !input.isCurrent()) throw stopped();
    if (this.subscriptions.has(input.subscriptionId)) throw new Error("Branch query identity is already registered.");
    // Queries arrive normalized by admitted input parsing; snapshot property
    // order explicitly so caller object mutation/order cannot change run keys.
    const query: BranchLiveQuery = input.query.type === "git.recent-branches"
      ? { type: input.query.type, ...(input.query.limit === undefined ? {} : { limit: input.query.limit }) }
      : { type: input.query.type };
    const state: Subscription = { id: input.subscriptionId, location: { ...input.location }, query,
      current: input.isCurrent, emit: input.emit, generation: ++this.generation,
      recovery: input.requiresRecovery, dirty: true, waiters: [] };
    this.subscriptions.set(state.id, state);
    this.refresh(state); // Initial query is immediate, including local repositories.
    return { dispose: () => this.remove(state) };
  }
  private active(state: Subscription): boolean {
    if (this.subscriptions.get(state.id) !== state) return false;
    if (!this.disposed && state.current()) return true;
    this.remove(state); return false;
  }
  private remove(state: Subscription) {
    if (this.subscriptions.get(state.id) !== state) return;
    this.subscriptions.delete(state.id);
    clearTimeout(state.timer); state.timer = undefined;
    state.abort?.abort(stopped());
    for (const done of state.waiters.splice(0)) done();
  }
  /** Called on catalog publication, not only when a query happens to finish. */
  reconcileOwners() { for (const state of this.subscriptions.values()) this.active(state); }
  changed(location: Pick<BranchQueryLocation, "hostId" | "commonDir" | "root">, kind: GitRepositoryChange): Promise<void> {
    return this.invalidate([...this.subscriptions.values()].filter(state =>
      state.location.hostId === location.hostId && state.location.commonDir === location.commonDir && state.location.root === location.root
      && repositoryChangeAffects(state.query.type, kind)));
  }
  setRequiresRecovery(hostId: string, root: string, required: boolean): Promise<void> {
    const states = [...this.subscriptions.values()].filter(state => state.location.hostId === hostId && state.location.root === root && state.recovery !== required);
    for (const state of states) state.recovery = required;
    return this.invalidate(states);
  }
  /** Explicit mutation/recovery refresh; reads never perform Git writes. */
  refreshRepository(hostId: string, root: string): Promise<void> {
    return this.invalidate([...this.subscriptions.values()].filter(state => state.location.hostId === hostId && state.location.root === root));
  }
  recover(hostId: string, subscriptionIds: readonly string[], root?: string): Promise<void> {
    const ids = new Set(subscriptionIds);
    const states = [...this.subscriptions.values()].filter(state => ids.has(state.id) && state.location.hostId === hostId
      && (root === undefined || state.location.root === root) && state.recovery && this.active(state));
    const roots = new Map(states.map(state => [state.location.root, state.location]));
    for (const location of roots.values()) this.dependencies.prepareRecovery({ ...location });
    return this.invalidate(states);
  }
  private invalidate(states: Subscription[]): Promise<void> {
    return Promise.all(states.filter(state => this.active(state)).map(state => {
      state.generation = ++this.generation; state.dirty = true;
      const completed = new Promise<void>(resolve => state.waiters.push(resolve));
      this.schedule(state); return completed;
    })).then(() => {});
  }
  private schedule(state: Subscription) {
    if (!this.active(state) || state.running || state.timer !== undefined) return;
    if (!state.location.local) { this.refresh(state); return; }
    state.timer = setTimeout(() => { state.timer = undefined; this.refresh(state); }, 100);
  }
  private refresh(state: Subscription) {
    if (!this.active(state) || state.running || !state.dirty) return;
    const generation = state.generation, abort = new AbortController();
    state.abort = abort; state.dirty = false;
    state.running = Promise.resolve().then(() => this.execute(state, abort.signal)).then(result => {
      if (this.active(state) && state.generation === generation)
        this.publish(state, { subscriptionId: state.id, generation, requiresRecovery: state.recovery, phase: "complete", result: structuredClone(result) });
    }).catch(error => {
      if (this.active(state) && state.generation === generation)
        this.publish(state, { subscriptionId: state.id, generation, requiresRecovery: state.recovery, phase: "failed", error: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      if (this.subscriptions.get(state.id) !== state) return;
      state.running = undefined; state.abort = undefined;
      if (state.generation === generation) for (const done of state.waiters.splice(0)) done();
      if (state.dirty) this.schedule(state);
    });
  }
  private publish(state: Subscription, update: BranchQueryUpdate) {
    try { state.emit(update); }
    catch (error) { console.error("Branch query observer failed:", error); }
  }
  private execute(state: Subscription, signal: AbortSignal): Promise<BranchLiveResult> {
    if (!this.active(state) || signal.aborted) return Promise.reject(stopped());
    const repositoryKey = JSON.stringify([state.location.hostId, state.location.commonDir]);
    const key = JSON.stringify([state.location.hostId, state.location.commonDir, state.location.root, state.query]);
    let shared = this.shared.get(key);
    if (!shared || shared.abort.signal.aborted) {
      const abort = new AbortController(), predecessor = this.repositories.get(repositoryKey) ?? Promise.resolve();
      const created: SharedRun = { abort, consumers: new Set(), result: undefined! };
      created.result = predecessor.then(() => {
        for (const consumer of [...created.consumers]) this.active(consumer);
        abort.signal.throwIfAborted();
        return this.dependencies.run({ ...state.query }, { ...state.location }, abort.signal).then(result => {
          if (result.type !== state.query.type) throw new Error("Branch query returned a different result method.");
          return result;
        });
      });
      const completion = created.result.then(() => {}, () => {}).finally(() => {
        if (this.shared.get(key) === created) this.shared.delete(key);
        if (this.repositories.get(repositoryKey) === completion) this.repositories.delete(repositoryKey);
      });
      this.repositories.set(repositoryKey, completion); this.shared.set(key, created); shared = created;
    }
    const run = shared;
    run.consumers.add(state);
    const detach = () => { run.consumers.delete(state); if (!run.consumers.size) run.abort.abort(signal.reason ?? stopped()); };
    signal.addEventListener("abort", detach, { once: true });
    if (signal.aborted) detach();
    return run.result.finally(() => { signal.removeEventListener("abort", detach); run.consumers.delete(state); });
  }
  /** Terminal owner shutdown: stop publication/admission and await sent reads.
   * Cancellation cannot promise to stop an external Git process ignoring it. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const state of [...this.subscriptions.values()]) this.remove(state);
    await Promise.all([...this.repositories.values()]);
  }
}
