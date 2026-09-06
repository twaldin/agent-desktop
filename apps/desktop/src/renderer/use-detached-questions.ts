import { useCallback, useEffect, useMemo, useReducer } from "react";
import { parseDetachedQuestionsSnapshot, type DetachedQuestionsSnapshot } from "../../../../packages/shared/src/detached-questions";
import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import type { OfflineCache } from "./offline-cache";
import { offlineCache } from "./offline-cache";

export type DetachedQuestionsBridge = Pick<DesktopBridge, "getDetachedQuestions" | "subscribe">;

/** Owner-bound native question projection with a last-known offline snapshot. */
export class DetachedQuestionsState {
  value?: DetachedQuestionsSnapshot | null;
  loading = false;
  error?: string;
  cacheWarning?: string;
  connected = false;
  private pending?: Promise<void>;
  private again = false;
  private listeners = new Set<() => void>();
  private unsubscribe?: () => void;
  private scheduled?: ReturnType<typeof setTimeout>;
  readonly cacheKey: string;

  constructor(private bridge: DetachedQuestionsBridge, readonly hostId: string, readonly sessionId: string, private localHostId?: string, private cache: OfflineCache = offlineCache) {
    this.cacheKey = `agent-desktop:detached-questions:v1:${hostId}:${sessionId}`;
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  async restore() {
    try {
      const raw = await this.cache.read(this.cacheKey);
      if (!raw || this.value !== undefined) return;
      const value = parseDetachedQuestionsSnapshot(JSON.parse(raw));
      if (value.hostId !== this.hostId || value.sessionId !== this.sessionId) throw new Error("Cached questions belong to another conversation.");
      this.value = value; this.changed();
    } catch { this.cacheWarning = "Saved question status could not be read. Refresh before answering an earlier question."; this.changed(); }
  }
  setConnected(value: boolean) { this.connected = value; this.changed(); if (value) void this.refresh(); }
  start() {
    this.unsubscribe ??= this.bridge.subscribe(event => {
      if ((event.hostId ?? this.localHostId) !== this.hostId) return;
      if (event.type === "runtime" && event.sessionId === this.sessionId) this.schedule();
      if (event.type === "interactions" && event.sessionId === this.sessionId) this.schedule();
      if (event.type === "state" && event.state.sessions.some(session => session.id === this.sessionId)) this.schedule();
    });
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = setTimeout(() => { this.scheduled = undefined; void this.refresh(); }, 90);
  }
  stop() { this.unsubscribe?.(); this.unsubscribe = undefined; clearTimeout(this.scheduled); this.scheduled = undefined; }
  refresh(): Promise<void> {
    if (!this.connected) return Promise.resolve();
    if (this.pending) { this.again = true; return this.pending; }
    this.pending = this.load().finally(() => { this.pending = undefined; if (this.again) { this.again = false; void this.refresh(); } });
    return this.pending;
  }
  private async load() {
    this.loading = true; this.changed();
    try {
      if (!this.bridge.getDetachedQuestions) { this.value = null; this.error = undefined; return; }
      const response = await this.bridge.getDetachedQuestions(this.sessionId, this.hostId);
      if (response === null) { this.value = null; this.error = undefined; return; }
      const value = parseDetachedQuestionsSnapshot(response);
      if (value.hostId !== this.hostId || value.sessionId !== this.sessionId) throw new Error("The question response belongs to another conversation.");
      this.value = value; this.error = undefined;
      try { await this.cache.write(this.cacheKey, JSON.stringify(value)); this.cacheWarning = undefined; }
      catch { this.cacheWarning = "Question status could not be cached for offline viewing."; }
    } catch (cause) { this.error = cause instanceof Error ? cause.message : String(cause); }
    finally { this.loading = false; this.changed(); }
  }
}

export function useDetachedQuestions(bridge: DesktopBridge, hostId: string, sessionId: string, connected: boolean, localHostId?: string) {
  const data = useMemo(() => new DetachedQuestionsState(bridge, hostId, sessionId, localHostId), [bridge, hostId, sessionId, localHostId]);
  const [, redraw] = useReducer(value => value + 1, 0);
  useEffect(() => {
    const off = data.subscribe(redraw); data.start(); void data.restore();
    return () => { off(); data.stop(); };
  }, [data]);
  useEffect(() => data.setConnected(connected), [data, connected]);
  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => void data.refresh(), 5_000);
    return () => clearInterval(timer);
  }, [data, connected]);
  return { data, refresh: useCallback(() => data.refresh(), [data]) };
}
