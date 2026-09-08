import type { DesktopBridge, Draft, ModelChoice, OmpComposerCatalog, OmpComposerModel, OmpSessionControls, SessionSummary, WorkspaceTarget } from "@agent-desktop/shared";

export const composerModelKey = (model: ModelChoice | null | undefined) => model ? `${model.provider}\0${model.id}` : "";
type ComposerWorkspaceTarget = Exclude<WorkspaceTarget, { filePath: string }>;
export const composerTargetKey = (target?: WorkspaceTarget) => target ? "filePath" in target ? `file:${encodeURIComponent(target.filePath)}` : "sessionId" in target ? `session:${target.sessionId}` : `project:${target.projectId}` : "new";
type Bridge = Pick<DesktopBridge, "getComposerCatalog" | "getSessionControls" | "subscribe">;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Native model metadata could not be loaded.";

/** One owning host + catalog target. Responses can never move to another draft. */
export class ComposerCatalogState {
  catalog?: OmpComposerCatalog;
  controls?: OmpSessionControls;
  connected = false;
  loading = false;
  error?: string;
  controlsError?: string;
  #listeners = new Set<() => void>();
  #unsubscribe?: () => void;
  #pending?: Promise<void>;
  #again = false;
  #reloadNative = false;
  #epoch = 0;
  #stopped = false;
  #sessionModel?: string;
  constructor(private bridge: Bridge, readonly hostId: string, readonly target?: ComposerWorkspaceTarget) {
    if (target && "filePath" in (target as WorkspaceTarget))
      throw new Error("Standalone files cannot load composer catalogs.");
  }
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #notify() { for (const listener of this.#listeners) listener(); }
  start(localHostId?: string) {
    this.#stopped = false;
    this.#unsubscribe ??= this.bridge.subscribe(event => {
      if ((event.hostId ?? localHostId) !== this.hostId) return;
      if (event.type === "settings" || event.type === "accounts") { this.#epoch++; void this.refresh(true); }
      if (event.type === "state" && this.target && "sessionId" in this.target) {
        const id = this.target.sessionId;
        const session = event.state.sessions.find(item => item.id === id);
        if (!session) return;
        const model = composerModelKey(session.model);
        if (this.#sessionModel !== model) { this.#sessionModel = model; this.#epoch++; void this.refresh(); }
      }
    });
  }
  stop() { this.#stopped = true; this.connected = false; this.#epoch++; this.#unsubscribe?.(); this.#unsubscribe = undefined; }
  setConnected(connected: boolean) {
    if (this.connected === connected) return;
    this.connected = connected; this.#epoch++; this.#notify();
    if (connected) void this.refresh(true);
  }
  refresh(reloadNative = false): Promise<void> {
    if (!this.connected || this.#stopped) return Promise.resolve();
    this.#reloadNative ||= reloadNative;
    if (this.#pending) { this.#again = true; return this.#pending; }
    this.loading = true; this.#notify();
    this.#pending = (async () => {
      do {
        this.#again = false;
        const epoch = this.#epoch, refresh = this.#reloadNative;
        this.#reloadNative = false;
        const results = await Promise.allSettled([
          this.bridge.getComposerCatalog ? this.bridge.getComposerCatalog(this.target, refresh, this.hostId) : Promise.reject(new Error("Update this desktop to load the owning workspace’s native model defaults.")),
          this.target && "sessionId" in this.target ? this.bridge.getSessionControls(this.target.sessionId, this.hostId) : Promise.resolve(undefined),
        ]);
        if (epoch !== this.#epoch || !this.connected || this.#stopped) continue;
        const [catalog, controls] = results;
        if (catalog.status === "fulfilled") this.catalog = catalog.value;
        if (controls.status === "fulfilled") this.controls = controls.value;
        this.error = catalog.status === "rejected" ? errorMessage(catalog.reason) : undefined;
        this.controlsError = controls.status === "rejected" ? errorMessage(controls.reason) : undefined;
        this.#notify();
      } while (this.#again && this.connected && !this.#stopped);
    })().finally(() => { this.#pending = undefined; this.loading = false; this.#notify(); });
    return this.#pending;
  }
}

/** Null means follow native state; a saved non-null model is never guessed away.
 * `current` is the last reported snapshot, not proof of a connected live worker.
 * Callers must qualify cached/loading/failed control reads in visible labels. */
export function composerSelection(draft: Draft, catalog?: OmpComposerCatalog, session?: SessionSummary | null, controls?: OmpSessionControls) {
  const current = controls ? controls.model : session?.model ?? null;
  const model = draft.model ?? (session ? current : catalog?.default.model ?? null);
  const entry = catalog?.models.find(item => composerModelKey(item) === composerModelKey(model));
  const currentCapabilities = controls?.capabilities && composerModelKey(controls.model) === composerModelKey(model) ? controls.capabilities : undefined;
  // An existing worker keeps its native model definition until reopened. Its
  // actual capabilities outrank refreshed configuration for that same model.
  const reasoning = currentCapabilities?.reasoning ?? entry?.reasoning ?? false;
  const levels = currentCapabilities?.thinkingSelectors ?? entry?.thinkingLevels ?? [];
  const defaultThinking = session ? controls?.thinkingLevel : draft.model ? entry?.defaultThinkingLevel : catalog?.default.thinkingLevel;
  const effectiveDefaultThinking = session ? undefined : draft.model ? entry?.effectiveDefaultThinkingLevel : catalog?.default.effectiveThinkingLevel;
  return {
    model, entry, current, reasoning, levels, defaultThinking, effectiveDefaultThinking,
    thinking: draft.thinkingLevel ?? defaultThinking,
    differingDraftModel: Boolean(session && draft.model && current && composerModelKey(draft.model) !== composerModelKey(current)),
  };
}

export function composerModelGroups(models: OmpComposerModel[]) {
  const groups = new Map<string, OmpComposerModel[]>();
  for (const model of models) { const group = groups.get(model.provider) ?? []; group.push(model); groups.set(model.provider, group); }
  return [...groups];
}
