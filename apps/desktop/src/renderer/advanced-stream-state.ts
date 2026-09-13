import type { DesktopBridge, OmpSessionControlMutation, OmpSessionControls, OmpStreamField } from "@agent-desktop/shared";

type Bridge = Pick<DesktopBridge, "getSessionControls" | "setSessionControl" | "subscribe">;
type Mutation = Extract<OmpSessionControlMutation, { operation: "advanced-stream" }>;
export interface StreamEdit {
  revision: string;
  model: Mutation["model"];
  action: Mutation["action"];
  text: string;
  error?: string;
}
const message = (error: unknown) => error instanceof Error ? error.message : "Native stream controls could not be loaded.";

/** Same revisioned read/edit/receipt pattern as NativeSettingsState; scoped to one owner/session. */
export class AdvancedStreamState {
  controls?: OmpSessionControls;
  connected = false;
  loading = false;
  saving = false;
  error?: string;
  receipt?: string;
  edits = new Map<OmpStreamField, StreamEdit>();
  #listeners = new Set<() => void>();
  #unsubscribe?: () => void;
  #pending?: Promise<void>;
  #again = false;
  #epoch = 0;
  #stopped = false;
  #modelKey?: string;
  constructor(private bridge: Bridge, readonly hostId: string, readonly sessionId: string) {}
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  notify() { for (const listener of this.#listeners) listener(); }
  start(localHostId?: string) {
    this.#stopped = false;
    this.#unsubscribe ??= this.bridge.subscribe(event => {
      if ((event.hostId ?? localHostId) !== this.hostId) return;
      if (event.type === "settings") { this.#epoch++; void this.refresh(); }
      if (event.type === "state") {
        const session = event.state.sessions.find(item => item.id === this.sessionId);
        const key = session?.model ? `${session.model.provider}\0${session.model.id}` : "";
        if (key !== this.#modelKey) { this.#modelKey = key; this.#epoch++; void this.refresh(); }
      }
    });
  }
  stop() { this.#stopped = true; this.connected = false; this.#epoch++; this.#unsubscribe?.(); this.#unsubscribe = undefined; }
  setConnected(connected: boolean) {
    if (this.connected === connected) return;
    this.connected = connected; this.#epoch++; this.notify();
    if (connected) void this.refresh();
  }
  refresh(): Promise<void> {
    if (!this.connected || this.#stopped) return Promise.resolve();
    if (this.saving || this.#pending) { this.#again = true; return this.#pending ?? Promise.resolve(); }
    this.loading = true; this.notify();
    this.#pending = (async () => {
      do {
        this.#again = false;
        const epoch = this.#epoch;
        try {
          const controls = await this.bridge.getSessionControls(this.sessionId, this.hostId);
          if (epoch !== this.#epoch || !this.connected || this.#stopped) continue;
          this.controls = controls; this.error = undefined;
        } catch (error) {
          if (epoch === this.#epoch && !this.#stopped) this.error = message(error);
        }
        this.notify();
      } while (this.#again && this.connected && !this.#stopped);
    })().finally(() => { this.#pending = undefined; this.loading = false; this.notify(); });
    return this.#pending;
  }
  edit(field: OmpStreamField, action: StreamEdit["action"], text: string) {
    const model = this.controls?.advancedStream?.model;
    if (!model || !this.controls || this.saving) return;
    const previous = this.edits.get(field);
    this.edits.set(field, { model: previous?.model ?? model, revision: previous?.revision ?? this.controls.revision, action, text });
    this.receipt = undefined; this.notify();
  }
  discard(field: OmpStreamField) { this.edits.delete(field); this.notify(); }
  rebase(field: OmpStreamField) {
    const edit = this.edits.get(field), model = this.controls?.advancedStream?.model;
    if (!edit || !model || !this.controls || model.provider !== edit.model.provider || model.id !== edit.model.id || model.api !== edit.model.api) return;
    edit.revision = this.controls.revision; edit.error = undefined; this.notify();
  }
  async save(field: OmpStreamField): Promise<void> {
    const edit = this.edits.get(field);
    if (!edit || !this.connected || this.loading || this.saving || this.error || !this.controls?.advancedStream?.supported) return;
    const value = edit.action === "set" && edit.text.trim() !== "" ? Number(edit.text) : undefined;
    if (edit.action === "set" && (value === undefined || !Number.isFinite(value))) {
      edit.error = "Enter a finite number before saving."; this.notify(); return;
    }
    this.saving = true; this.#epoch++; edit.error = undefined; this.receipt = undefined; this.notify();
    try {
      const controls = await this.bridge.setSessionControl(this.sessionId, { operation: "advanced-stream", model: edit.model,
        expectedRevision: edit.revision, field, action: edit.action, ...(edit.action === "set" ? { value } : {}) }, this.hostId);
      if (this.#stopped) return;
      this.controls = controls; this.error = undefined; this.edits.delete(field);
      for (const other of this.edits.values()) if (other.revision === edit.revision) other.revision = controls.revision;
      this.receipt = "Saved by the owning host to this session branch. No provider request was sent.";
    } catch (error) {
      if (!this.#stopped) { edit.error = message(error); this.#again = true; }
    } finally {
      this.saving = false; this.#epoch++; this.notify();
      if (this.#again && !this.#stopped) await this.refresh();
    }
  }
}
