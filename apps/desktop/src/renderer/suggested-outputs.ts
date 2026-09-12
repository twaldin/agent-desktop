import { parseSessionOutputs, sessionOutputKey, type DesktopBridge, type SessionOutput, type SessionOutputs } from '@agent-desktop/shared';
type OutputBridge = Pick<DesktopBridge, 'getSessionOutputs'>;
export interface SuggestedOutputOwner { hostId: string; sessionId?: string; connected: boolean; active: boolean; bridge: OutputBridge; entryIds: readonly string[] }
/** Retains the original task's last successful inspection across a failed read.
 * A click still requires a live, unchanged original output and connection. */
export class SuggestedOutputs {
  #owner?: SuggestedOutputOwner;
  #generation = 0;
  #ownership = 0;
  #live = true;
  #pending?: Promise<void>;
  #snapshot?: SessionOutputs;
  #error?: string;
  #entryKey = '';
  constructor(private readonly changed: () => void) {}
  get snapshot() { return this.#snapshot; }
  get error() { return this.#error; }
  get loading() { return Boolean(this.#pending); }
  get enabled() { const owner = this.#owner; return this.#live && Boolean(owner?.active && owner.connected && owner.sessionId && owner.bridge.getSessionOutputs); }
  observe(input: SuggestedOutputOwner) {
    const next = { ...input, entryIds: [...input.entryIds] }, old = this.#owner;
    const changedOwner = !old || old.hostId !== next.hostId || old.sessionId !== next.sessionId || old.bridge !== next.bridge;
    const entryKey = JSON.stringify(next.entryIds);
    const lostEntry = old?.entryIds.some(id => !next.entryIds.includes(id));
    if (changedOwner || old?.connected !== next.connected || lostEntry) this.#ownership++;
    if (changedOwner || old?.connected !== next.connected || old?.active !== next.active || lostEntry) {
      this.#generation++;
      // The old request settles independently, but cannot publish into this owner.
      this.#pending = undefined;
    }
    if (changedOwner) { this.#snapshot = undefined; this.#error = undefined; }
    const entriesChanged = entryKey !== this.#entryKey;
    this.#owner = next; this.#entryKey = entryKey;
    if (entriesChanged && this.#snapshot) {
      const entries = new Set(next.entryIds);
      this.#snapshot = { ...this.#snapshot, outputs: this.#snapshot.outputs.filter(output => entries.has(output.entryId)) };
    }
  }
  read(): Promise<void> {
    if (this.#pending) return this.#pending;
    if (!this.enabled) return Promise.resolve();
    const original = this.#owner!, generation = this.#generation;
    const current = () => this.enabled && this.#generation === generation;
    const run = (async () => {
      try {
        const snapshot = parseSessionOutputs(await original.bridge.getSessionOutputs!(original.sessionId!, original.hostId));
        if (!current()) return;
        const entries = new Set(this.#owner!.entryIds);
        this.#snapshot = { ...snapshot, outputs: snapshot.outputs.filter(output => entries.has(output.entryId)) };
        this.#error = undefined;
      } catch (error) { if (current()) this.#error = error instanceof Error ? error.message : 'Saved outputs could not be refreshed.'; }
    })();
    this.#pending = run;
    const settle = () => { if (this.#pending === run) { this.#pending = undefined; this.changed(); } };
    void run.then(settle, settle);
    return run;
  }
  /** The returned guard also belongs to queued dock admission, not just this click. */
  capture(output: SessionOutput, retained = false): (() => boolean) | undefined {
    const generation = this.#generation, ownership = this.#ownership, epoch = this.#snapshot?.epoch, key = sessionOutputKey(output);
    const current = () => (retained ? this.#live && Boolean(this.#owner?.connected) && this.#ownership === ownership : this.enabled && this.#generation === generation) && this.#snapshot?.epoch === epoch
      && this.#owner!.entryIds.includes(output.entryId)
      && Boolean(this.#snapshot?.outputs.some(value => sessionOutputKey(value) === key && value.entryId === output.entryId && value.revision === output.revision));
    return current() ? current : undefined;
  }
  start() { this.#live = true; }
  async admit(output: SessionOutput): Promise<(() => boolean) | undefined> {
    const original = this.capture(output);
    if (!original) return;
    await this.read();
    return !this.#error && original() ? original : undefined;
  }
  dispose() { this.#live = false; this.#generation++; this.#ownership++; this.#pending = undefined; }
}
