import type { CodexResetPolicyOwner, CodexResetPolicyOwnerFactory, CodexResetPolicySessionBinding, NativeResetAnswer, ResetCheckpoint, ResetObservation, ResetPermit, ResetPlanSnapshot } from "@oh-my-pi/pi-coding-agent";
import type { AuthStorage, ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import type { ResetPolicySettingsWriter } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { OmpInteractionBridge } from "./interactions";

export interface NativeResetRuntimeOwner extends CodexResetPolicyOwner { beginClose(): void; finish(): Promise<void> }
export type CreateNativeResetRuntimeOwner = (binding: Readonly<CodexResetPolicySessionBinding>, interactions: Pick<OmpInteractionBridge, "runWithDecisionBinding">) => NativeResetRuntimeOwner;
type Entry = { owner: NativeResetRuntimeOwner; callbacks: Set<Promise<unknown>> };
const MAX_OWNERS = 128;

/** Owns all native reset owners created by one Omp root session. */
export class NativeResetRuntimeOwners {
  readonly factory: CodexResetPolicyOwnerFactory;
  readonly #owners = new Set<Entry>();
  readonly #errors: unknown[] = [];
  readonly #interactions: Pick<OmpInteractionBridge, "runWithDecisionBinding">;
  #creating = 0;
  #rootAttempted = false;
  #closing = false;
  #finished?: Promise<void>;

  constructor(root: Readonly<{ settings: Settings; modelRegistry: ModelRegistry; authStorage: AuthStorage; writer: ResetPolicySettingsWriter }>, getBridge: () => OmpInteractionBridge | undefined, create: CreateNativeResetRuntimeOwner) {
    this.#interactions = Object.freeze({ runWithDecisionBinding: <T>(bind: (interactionId: string) => Promise<void>, select: () => Promise<T>) => {
      const bridge = getBridge(); if (!bridge) throw new Error("OMP interaction bridge is unavailable for the native reset decision");
      return bridge.runWithDecisionBinding(bind, select);
    } });
    this.factory = binding => {
      if (this.#closing || this.#owners.size + this.#creating >= MAX_OWNERS) throw new Error("Native reset owner group is unavailable");
      if (binding.session.settings !== binding.settings || binding.session.modelRegistry !== binding.modelRegistry || binding.modelRegistry.authStorage !== binding.authStorage)
        throw new Error("Native reset owner is not bound to its exact SDK session objects");
      const rootCall = !this.#rootAttempted;
      if (rootCall) {
        this.#rootAttempted = true;
        if (binding.settings !== root.settings || binding.modelRegistry !== root.modelRegistry || binding.authStorage !== root.authStorage)
          throw new Error("Native reset root owner is not bound to the original OMP objects");
      } else if (binding.settings.getResetPolicySettingsWriter() !== root.writer)
        throw new Error("Native reset child owner did not inherit the original Settings writer");
      this.#creating++;
      let owner: NativeResetRuntimeOwner;
      try { owner = create(binding, this.#interactions); }
      finally { this.#creating--; }
      if (!owner || typeof owner.beginClose !== "function" || typeof owner.finish !== "function") throw new Error("Native reset owner factory returned an invalid lifecycle owner");
      const entry: Entry = { owner, callbacks: new Set() };
      const exposed = this.#expose(entry);
      if (this.#closing) {
        this.#owners.add(entry);
        try { owner.beginClose(); } catch (error) { this.#errors.push(error); }
        throw new Error("Native reset owner group closed during factory creation");
      }
      this.#owners.add(entry);
      return exposed;
    };
  }

  #track<T>(entry: Entry, call: () => Promise<T>): Promise<T> {
    if (this.#finished) return Promise.reject(new Error("Native reset owner group is finishing"));
    const pending = Promise.resolve().then(call); entry.callbacks.add(pending);
    void pending.finally(() => entry.callbacks.delete(pending)).catch(() => {}); return pending;
  }
  #expose(entry: Entry): CodexResetPolicyOwner {
    return Object.freeze({
      checkpoint: (event: ResetCheckpoint) => this.#track(entry, () => entry.owner.checkpoint(event)),
      presentDecision: (snapshot: ResetPlanSnapshot, select: () => Promise<NativeResetAnswer>) => this.#track(entry, () => entry.owner.presentDecision(snapshot, select)),
      admit: (snapshot: ResetPlanSnapshot, actionIndex: number) => this.#track(entry, () => entry.owner.admit(snapshot, actionIndex)),
      complete: (permit: ResetPermit, observation: ResetObservation) => this.#track(entry, () => entry.owner.complete(permit, observation)),
    });
  }
  async #quiesce(): Promise<void> {
    while (true) {
      const pending = [...this.#owners].flatMap(entry => [...entry.callbacks]);
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }

  beginClose(): void {
    if (this.#closing) return; this.#closing = true;
    const failures: unknown[] = [];
    for (const { owner } of this.#owners) try { owner.beginClose(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "Native reset owners could not begin closing");
  }

  finish(): Promise<void> {
    this.#closing = true;
    if (!this.#finished) {
      // Publish before any outward finish callback can synchronously reenter.
      this.#finished = Promise.resolve();
      this.#finished = this.#finished.then(async () => {
        await this.#quiesce();
        const work = [...this.#owners].map(entry => Promise.resolve().then(() => entry.owner.finish()));
        const results = await Promise.allSettled(work); this.#owners.clear();
        const failures = [...this.#errors, ...results.flatMap(result => result.status === "rejected" ? [result.reason] : [])];
        if (failures.length) throw new AggregateError(failures, "Native reset owners did not finish cleanly");
      });
    }
    return this.#finished;
  }
}
