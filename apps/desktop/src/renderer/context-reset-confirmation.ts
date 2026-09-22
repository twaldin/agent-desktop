import type { Draft } from "@agent-desktop/shared";
import type { TreeMutationRequest, TreeTicket } from "../../../../packages/shared/src/session-tree";
import type { SessionTreeView } from "./use-session-tree";
import { sameDraftContent } from "./drafts";

export interface ContextResetSource {
  hostId: string; sessionId: string; connected: boolean; available: boolean; idle: boolean; visible: boolean;
  tree: SessionTreeView; draft: Draft;
}

/** A confirmation belongs to the originally displayed context. Losing that
 * context cancels admission permanently, even if it later appears again. */
export class ContextResetConfirmation {
  readonly hostId: string; readonly sessionId: string; readonly ticket: TreeTicket;
  readonly draft?: Draft;
  error?: string;
  submitted = false;
  constructor(source: ContextResetSource, fromComposer = false) {
    this.hostId = source.hostId; this.sessionId = source.sessionId;
    if (!source.tree.value || source.tree.owner.hostId !== source.hostId || source.tree.owner.sessionId !== source.sessionId || source.tree.value.ticket.nativeSessionId !== source.sessionId) throw new Error("Refresh History before clearing context.");
    this.ticket = { ...source.tree.value.ticket };
    if (fromComposer) this.draft = structuredClone(source.draft);
    this.update(source);
    if (this.error) throw new Error(this.error);
  }
  update(source: ContextResetSource) {
    if (this.submitted || this.error) return this.error;
    const view = source.tree, ticket = view.value?.ticket;
    this.error = source.hostId !== this.hostId || source.sessionId !== this.sessionId || !source.visible
      ? "The original conversation is no longer open. Close this confirmation and try again."
      : !source.connected ? "The owning host disconnected. Reconnect and open a new confirmation."
      : !source.available ? "Update the owning host to clear context."
      : !source.idle || view.value?.busyReason ? "Stop the current operation before clearing context."
      : !view.fresh || view.pending || view.uncertain || view.value?.reconciliationRequired
        ? "Refresh History and check any original command before clearing context."
      : !ticket || ticket.nativeSessionId !== this.ticket.nativeSessionId || ticket.epoch !== this.ticket.epoch || ticket.revision !== this.ticket.revision
        ? "The context changed. Review History and open a new confirmation."
      : this.draft && !sameDraftContent(this.draft, source.draft)
        ? "The composer changed. Its contents were retained; open a new confirmation."
      : undefined;
    return this.error;
  }
  take(source: ContextResetSource): TreeMutationRequest {
    if (this.submitted) throw new Error("This confirmation was already submitted. Check its original status in History.");
    this.update(source);
    if (this.error) throw new Error(this.error);
    this.submitted = true;
    return { sessionId: this.sessionId, ticket: { ...this.ticket }, mutation: { action: "reset-context", ...(this.draft ? { origin: "clear-command" as const } : {}) } };
  }
}
