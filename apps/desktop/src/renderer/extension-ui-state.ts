import { parseExtensionUiResult, type ExtensionUiResult, type NativeExtensionUiSnapshot } from "../../../../packages/shared/src/extension-ui";
export interface ExtensionUiView { value?: NativeExtensionUiSnapshot; error?: string; unavailable?: string; observed: boolean }
/** A disconnected renderer retains one owner's last observation, never another's. */
export class ExtensionUiState {
  #view: ExtensionUiView = { observed: false };
  #listeners = new Set<() => void>();
  #generation = 0;
  #active = false;
  #pending = false;
  #again = false;
  #floors = new Map<string, number>();
  #retired = new Set<string>();
  #lastEpoch?: string;
  constructor(readonly hostId: string, readonly sessionId: string, private read: () => Promise<ExtensionUiResult | null>) {}
  snapshot = () => this.#view;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  #set(value: ExtensionUiView) { this.#view = value; for (const listener of this.#listeners) listener(); }
  start() { this.#active = true; void this.refresh(); }
  stop() { this.#active = false; this.#generation++; this.#pending = false; this.#again = false; }
  changed(epoch: string, revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 0 || this.#retired.has(epoch)) return;
    this.#floors.set(epoch, Math.max(revision, this.#floors.get(epoch) ?? 0)); void this.refresh();
  }
  async refresh(): Promise<void> {
    if (!this.#active) return;
    if (this.#pending) { this.#again = true; return; }
    this.#pending = true;
    const generation = this.#generation;
    try {
      const raw = await this.read();
      if (!this.#active || generation !== this.#generation) return;
      const result = raw === null ? null : parseExtensionUiResult(raw, this.hostId, this.sessionId);
      if (!result || result.availability === "unavailable") {
        this.#set({ observed: this.#view.observed, unavailable: result?.reason ?? "This host does not provide extension display." }); return;
      }
      const value = result.value;
      if (this.#retired.has(value.epoch) || value.revision < (this.#floors.get(value.epoch) ?? 0)
        || value.epoch === this.#view.value?.epoch && value.revision < this.#view.value.revision) { this.#set({ ...this.#view, error: "Waiting for the current extension display." }); return; }
      if (this.#lastEpoch && this.#lastEpoch !== value.epoch) this.#retired.add(this.#lastEpoch);
      this.#lastEpoch = value.epoch;
      this.#set({ value, observed: this.#view.observed || value.statuses.length > 0 || value.widgets.length > 0 });
    } catch {
      if (this.#active && generation === this.#generation) this.#set({ ...this.#view, error: "Extension display could not be refreshed." });
    } finally {
      if (generation === this.#generation) { this.#pending = false; if (this.#active && this.#again) { this.#again = false; queueMicrotask(() => void this.refresh()); } }
    }
  }
}
