import type { AgentSession, CodexResetPolicyOwner, CodexResetPolicyOwnerFactory, CodexResetPolicySessionBinding, NativeResetAnswer, ResetCheckpoint, ResetObservation, ResetPermit, ResetPlanSnapshot } from "@oh-my-pi/pi-coding-agent";
import type { AuthStorage, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import type { ResetPolicySettingsWriter } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { OmpInteractionBridge } from "./interactions";

export interface NativeResetRuntimeOwner extends CodexResetPolicyOwner {
  beginSessionClose(): void;
  retireSession(): Promise<void>;
  beginClose(): void;
  finish(): Promise<void>;
}
export type CreateNativeResetRuntimeOwner = (binding: Readonly<CodexResetPolicySessionBinding>, interactions: Pick<OmpInteractionBridge, "runWithDecisionBinding" | "runWithSignal">) => NativeResetRuntimeOwner;
type Entry = {
  session: AgentSession;
  owner?: NativeResetRuntimeOwner;
  callbacks: Set<Promise<unknown>>;
  ready: Promise<void>;
  nativeDrained: Promise<void>;
  resolveDrained(): void;
  closing: boolean;
  ownerClosed: boolean;
  drained: boolean;
  registered: boolean;
  nativeCloseStarted: boolean;
  unsubscribe?: () => void;
  retirement?: Promise<void>;
};
const MAX_OWNERS = 128;

/** One pinned root plus live/retiring exact-session children; history consumes no slots. */
export class NativeResetRuntimeOwners {
  readonly factory: CodexResetPolicyOwnerFactory;
  readonly #owners = new Set<Entry>();
  readonly #seen = new WeakSet<AgentSession>();
  readonly #errors: unknown[] = [];
  #errorCount = 0;
  #root?: Entry;
  #closing = false;
  #finished?: Promise<void>;

  constructor(root: Readonly<{ settings: Settings; modelRegistry: ModelRegistry; authStorage: AuthStorage; writer: ResetPolicySettingsWriter }>, getBridge: () => OmpInteractionBridge | undefined, create: CreateNativeResetRuntimeOwner) {
    const bridge = () => {
      const current = getBridge(); if (!current) throw new Error("OMP interaction bridge is unavailable for the native reset decision");
      return current;
    };
    const interactions = Object.freeze({
      runWithDecisionBinding: <T>(bind: (interactionId: string) => Promise<void>, select: () => Promise<T>) => bridge().runWithDecisionBinding(bind, select),
      runWithSignal: <T>(signal: AbortSignal, work: () => Promise<T>) => bridge().runWithSignal(signal, work),
    });
    this.factory = binding => {
      if (this.#closing || this.#owners.size >= MAX_OWNERS) throw new Error("Native reset owner group is unavailable");
      if (this.#seen.has(binding.session)) throw new Error("Native reset session already has an original owner");
      if (binding.session.settings !== binding.settings || binding.session.modelRegistry !== binding.modelRegistry || binding.modelRegistry.authStorage !== binding.authStorage)
        throw new Error("Native reset owner is not bound to its exact SDK session objects");
      if (typeof binding.registerLifecycle !== "function") throw new Error("Native reset session has no exact lifecycle registrar");
      if (!this.#root) {
        if (binding.settings !== root.settings || binding.modelRegistry !== root.modelRegistry || binding.authStorage !== root.authStorage)
          throw new Error("Native reset root owner is not bound to the original OMP objects");
      } else if (binding.settings.getResetPolicySettingsWriter() !== root.writer)
        throw new Error("Native reset child owner did not inherit the original Settings writer");
      const ready = Promise.withResolvers<void>(), nativeDrained = Promise.withResolvers<void>();
      const entry: Entry = { session: binding.session, callbacks: new Set(), ready: ready.promise,
        nativeDrained: nativeDrained.promise, resolveDrained: nativeDrained.resolve,
        closing: false, ownerClosed: false, drained: false, registered: false, nativeCloseStarted: false };
      // Reserve identity, root position and capacity before either outward callback.
      this.#root ??= entry;
      this.#seen.add(binding.session); this.#owners.add(entry);
      try {
        entry.unsubscribe = binding.registerLifecycle({
          beginClose: () => {
            if (entry === this.#root) { try { this.beginClose(); } catch { /* Already retained by this group. */ } }
            else this.#closeEntry(entry);
          },
          drained: () => this.#drained(entry),
        });
        entry.registered = true;
        if (entry.closing || entry.drained) throw new Error("Native reset session closed before owner creation");
        const owner = create(binding, interactions); entry.owner = owner;
        if (!owner || ["checkpoint", "presentDecision", "admit", "complete", "beginSessionClose", "retireSession", "beginClose", "finish"]
          .some(name => typeof owner[name as keyof NativeResetRuntimeOwner] !== "function"))
          throw new Error("Native reset owner factory returned an invalid lifecycle owner");
        if (this.#closing || entry.closing) throw new Error("Native reset owner group closed during factory creation");
        return this.#expose(entry);
      } catch (error) {
        this.#remember(error);
        if (entry === this.#root) { try { this.beginClose(); } catch { /* Retained independently of setup failure. */ } }
        this.#closeEntry(entry);
        this.#startNativeClose(entry);
        throw error;
      } finally { ready.resolve(); }
    };
  }

  #remember(error: unknown): void {
    this.#errorCount = Math.min(Number.MAX_SAFE_INTEGER, this.#errorCount + 1);
    if (this.#errors.length < MAX_OWNERS) this.#errors.push(error);
  }

  #closeEntry(entry: Entry): void {
    entry.closing = true;
    if (!entry.owner || entry.ownerClosed) return;
    entry.ownerClosed = true;
    try {
      if (entry === this.#root) entry.owner.beginClose();
      else entry.owner.beginSessionClose();
    } catch (error) { this.#remember(error); }
  }

  #drained(entry: Entry): void {
    if (entry.drained) return;
    entry.drained = true; entry.resolveDrained();
    if (entry !== this.#root) void this.#retire(entry);
  }

  #startNativeClose(entry: Entry): void {
    if (entry.nativeCloseStarted || entry.drained) return;
    entry.nativeCloseStarted = true;
    try { entry.session.beginDispose(); } catch (error) { this.#remember(error); }
    if (!entry.registered) {
      // A throwing registrar never exposed an owner. Still use the exact native
      // unbounded drain after fencing, not callback emptiness or a disposal timer.
      void Promise.resolve().then(() => entry.session.drainCodexResetPolicy()).then(
        () => this.#drained(entry), error => this.#remember(error));
    }
  }

  #track<T>(entry: Entry, call: (owner: NativeResetRuntimeOwner) => Promise<T>): Promise<T> {
    if (entry.drained) return Promise.reject(new Error("Native reset session has drained"));
    // Closing does not reject factual callbacks that the native drain still owes.
    const pending = Promise.resolve().then(() => call(entry.owner!)); entry.callbacks.add(pending);
    // Policy refusals belong to the returned native callback/settlement path.
    // The group ledger records lifecycle and local-cleanup failures, not denials.
    void pending.then(() => { entry.callbacks.delete(pending); }, () => { entry.callbacks.delete(pending); });
    return pending;
  }

  #expose(entry: Entry): CodexResetPolicyOwner {
    return Object.freeze({
      checkpoint: (event: ResetCheckpoint) => this.#track(entry, owner => owner.checkpoint(event)),
      presentDecision: (snapshot: ResetPlanSnapshot, select: () => Promise<NativeResetAnswer>) => this.#track(entry, owner => owner.presentDecision(snapshot, select)),
      admit: (snapshot: ResetPlanSnapshot, actionIndex: number) => this.#track(entry, owner => owner.admit(snapshot, actionIndex)),
      complete: (permit: ResetPermit, observation: ResetObservation) => this.#track(entry, owner => owner.complete(permit, observation)),
    });
  }

  async #quiesce(entry: Entry): Promise<void> {
    while (entry.callbacks.size) await Promise.allSettled([...entry.callbacks]);
  }

  #unsubscribe(entry: Entry): void {
    const unsubscribe = entry.unsubscribe; entry.unsubscribe = undefined;
    try { unsubscribe?.(); } catch (error) { this.#remember(error); }
  }

  #retire(entry: Entry): Promise<void> {
    // Publish before any cleanup can synchronously reenter factory or finish.
    return entry.retirement ??= Promise.resolve().then(async () => {
      await entry.ready; await entry.nativeDrained; await this.#quiesce(entry);
      this.#closeEntry(entry);
      try { await entry.owner?.retireSession(); } catch (error) { this.#remember(error); }
      this.#unsubscribe(entry);
      entry.owner = undefined;
      this.#owners.delete(entry);
    });
  }

  beginClose(): void {
    if (this.#closing) return;
    this.#closing = true;
    const previous = this.#errorCount;
    for (const entry of this.#owners) this.#closeEntry(entry);
    if (this.#errorCount !== previous) throw new AggregateError([...this.#errors], "Native reset owners could not begin closing");
  }

  finish(): Promise<void> {
    if (this.#finished) return this.#finished;
    this.#finished = Promise.resolve().then(async () => {
      const entries = [...this.#owners];
      for (const entry of entries) this.#startNativeClose(entry);
      // All sessions are fenced before waiting for any sibling; no error can
      // skip another native drain or release the shared transport underneath it.
      await Promise.all(entries.map(async entry => {
        await entry.ready; await entry.nativeDrained;
        if (entry !== this.#root) await this.#retire(entry);
        else await this.#quiesce(entry);
      }));
      const root = this.#root;
      if (root) {
        this.#closeEntry(root);
        try { await root.owner?.finish(); } catch (error) { this.#remember(error); }
        this.#unsubscribe(root); root.owner = undefined; this.#owners.delete(root);
      }
      if (this.#errorCount) throw new AggregateError([...this.#errors], `Native reset owners did not finish cleanly (${this.#errorCount} failures)`);
    });
    try { this.beginClose(); } catch { /* The terminal result includes these errors. */ }
    return this.#finished;
  }
}
