import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import { parseNativeQueuedMessagesSnapshot, type NativeQueuedMessageMutation, type NativeQueuedMessagesSnapshot } from "../../../../packages/shared/src/queued-messages";

type QueueBridge = Pick<DesktopBridge, "getQueuedMessages" | "mutateQueuedMessages" | "subscribeQueuedMessages">;
export interface QueuedMessagesView { snapshot?: NativeQueuedMessagesSnapshot; loading: boolean; busy: boolean; error?: string }
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** A live selected-session queue. Reconnection always reads fresh worker identities. */
export class QueuedMessagesState {
  value: QueuedMessagesView = { loading: true, busy: false };
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private active = false;
  private generation = 0;
  private request = 0;
  private reading = false;
  private again = false;
  constructor(private bridge: QueueBridge, readonly hostId: string, readonly sessionId: string) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.value;
  private publish(value: QueuedMessagesView) { this.value = value; for (const listener of this.listeners) listener(); }
  start() {
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    this.publish({ loading: true, busy: false });
    if (!this.active || generation !== this.generation) return;
    this.unsubscribe = this.bridge.subscribeQueuedMessages?.(event => {
      if (generation === this.generation && event.hostId === this.hostId && event.sessionId === this.sessionId && !this.value.error) void this.refresh();
    });
    void this.refresh();
  }
  stop() {
    this.active = false; ++this.generation; ++this.request;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.reading = this.again = false;
  }
  refresh = async () => {
    if (!this.active || !this.bridge.getQueuedMessages) return;
    if (this.reading) { this.again = true; return; }
    this.reading = true;
    const generation = this.generation, request = ++this.request;
    try {
      const response = await this.bridge.getQueuedMessages(this.sessionId, this.hostId);
      if (!this.active || generation !== this.generation || request !== this.request) return;
      if (response.protocolVersion !== 1 || response.hostId !== this.hostId || response.sessionId !== this.sessionId) throw new Error("The queued messages belong to a different conversation.");
      this.publish({ snapshot: parseNativeQueuedMessagesSnapshot(response), loading: false, busy: this.value.busy });
    } catch (cause) {
      if (this.active && generation === this.generation && request === this.request) this.publish({ ...this.value, loading: false, error: message(cause) });
    } finally {
      if (generation === this.generation) {
        this.reading = false;
        if (this.active && this.again) { this.again = false; void this.refresh(); }
      }
    }
  };
  mutate = async (mutation: NativeQueuedMessageMutation) => {
    if (!this.active || this.value.busy || this.value.loading || this.value.error || !this.value.snapshot || !this.bridge.mutateQueuedMessages) return;
    if (mutation.expectedRevision !== this.value.snapshot.revision) return;
    const generation = this.generation, request = ++this.request;
    const command = mutation.type === "reorder" ? { ...mutation, messageIds: [...mutation.messageIds] } : { ...mutation };
    let failed = false;
    this.publish({ ...this.value, busy: true, error: undefined });
    try {
      if (!this.active || generation !== this.generation) return;
      const receipt = await this.bridge.mutateQueuedMessages(this.sessionId, command, this.hostId);
      if (!this.active || generation !== this.generation) return;
      if (receipt.type !== "native-queued-messages" || receipt.mutation !== command.type || (command.type !== "reorder" && receipt.messageId !== command.messageId)) throw new Error("The queue update returned a different action.");
      const snapshot = parseNativeQueuedMessagesSnapshot(receipt.snapshot);
      if (request === this.request) this.publish({ snapshot, loading: false, busy: false });
    } catch (cause) {
      if (this.active && generation === this.generation) { failed = true; ++this.request; this.again = false; this.publish({ ...this.value, busy: false, error: message(cause) }); }
    } finally {
      if (this.active && generation === this.generation) {
        if (this.value.busy) this.publish({ ...this.value, busy: false });
        // Reconcile an invalidation received during the command; never replay it.
        if (!failed) void this.refresh();
      }
    }
  };
}
