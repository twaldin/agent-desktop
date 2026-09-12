import type { SessionSummary } from "../../../../packages/shared/src/protocol";
import { sessionHasUnreadActivity, sessionReadKey } from "../../../../packages/shared/src/session-read";
import type { PreferencesState } from "./preferences-state";

export function sessionUnreadKey(hostId: string, sessionId: string): string { return JSON.stringify([hostId, sessionId]); }

/** Read marks use the existing durable, replicated preference command receipts. */
export class SessionReadState {
  error?: string;
  busy = false;
  private listeners = new Set<() => void>();
  constructor(private preferences: PreferencesState) {}
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  isUnread(session: Pick<SessionSummary, "hostId" | "id" | "activitySequence">) {
    return sessionHasUnreadActivity(session.activitySequence, this.preferences.get(sessionReadKey(session.hostId, session.id)));
  }
  unreadKeys(sessions: readonly SessionSummary[]): ReadonlySet<string> {
    return new Set(sessions.filter(session => this.isUnread(session)).map(session => sessionUnreadKey(session.hostId, session.id)));
  }
  async mark(session: Pick<SessionSummary, "hostId" | "id" | "activitySequence">, unread: boolean): Promise<boolean> {
    if (this.busy || this.preferences.busy || this.preferences.pending.length) {
      this.error = "Read marks are waiting for the current preference change. Retry after it finishes."; this.changed(); return false;
    }
    if (!this.preferences.ready || !this.preferences.connected) {
      this.error = "Reconnect to this device’s host to save read marks. Cached conversations remain readable."; this.changed(); return false;
    }
    // Capture exactly the output the user has seen before any restore/command await.
    const key = sessionReadKey(session.hostId, session.id);
    const value = { sequence: session.activitySequence ?? 0, unread };
    this.busy = true; this.error = undefined; this.changed();
    try {
      await this.preferences.put({ key, value });
      const confirmed = this.preferences.get(key);
      if (this.preferences.pending.length || this.preferences.error || confirmed?.sequence !== value.sequence || confirmed.unread !== value.unread) {
        this.error = this.preferences.error ?? "The read mark has not been confirmed. Retry its original preference command."; return false;
      }
      return true;
    } catch (cause) { this.error = cause instanceof Error ? cause.message : String(cause); return false; }
    finally { this.busy = false; this.changed(); }
  }
  dismissError() { this.error = undefined; this.changed(); }
  async retry() {
    // Only an already admitted command has an identity that Retry can recover.
    if (!this.preferences.pending.length || !this.preferences.connected || this.preferences.busy) return;
    await this.preferences.retry(); this.error = this.preferences.error; this.changed();
  }
}
