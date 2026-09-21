import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { DesktopBridge, HostCommand, TranscriptMessage } from "../../../../packages/shared/src/protocol";

import { HostCatalog } from "./host-catalog";
import { offlineCache } from "./offline-cache";

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
export function useDesktop(bridge: DesktopBridge | undefined, requestedHostId?: string) {
  const catalog = useMemo(() => new HostCatalog(bridge, offlineCache), [bridge]);
  const requestedHost = useRef(requestedHostId); requestedHost.current = requestedHostId;
  const [, redraw] = useReducer(value => value + 1, 0);
  useEffect(() => {
    const unsubscribe = catalog.subscribe(redraw); catalog.start(); void catalog.restore(); void catalog.refresh(requestedHost.current);
    const interval = setInterval(() => { void catalog.refresh(requestedHost.current); }, 15_000);
    return () => { clearInterval(interval); unsubscribe(); catalog.stop(); };
  }, [catalog]);
  useEffect(() => { if (requestedHostId) void catalog.refreshHost(requestedHostId); }, [catalog, requestedHostId]);
  const hostId = requestedHostId ?? catalog.localHostId;
  const record = hostId ? catalog.records.get(hostId) : undefined;
  const refresh = useCallback(() => catalog.refreshHost(hostId), [catalog, hostId]);
  const command = useCallback(async (command: HostCommand) => {
    if (!bridge || !hostId) throw new Error("The desktop host is unavailable.");
    const result = await bridge.command({ id: crypto.randomUUID(), command }, hostId);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }, [bridge, hostId]);
  return { state: record?.state ?? null, connected: record?.connected ?? false, loading: record?.loading ?? (!catalog.localError && !record),
    error: record?.error ?? (!hostId || hostId === catalog.localHostId ? catalog.localError : undefined), cacheWarning: catalog.cacheWarning,
    refresh, command, catalog, catalogRevision: catalog.revision, hosts: catalog.options(), localHostId: catalog.localHostId,
    network: catalog.network, networkError: catalog.networkError, refreshNetwork: () => catalog.refresh() };
}

export function useTranscript(bridge: Pick<DesktopBridge, "getMessages" | "subscribe"> | undefined, sessionId: string | null, hostId: string | undefined, connected: boolean, localHostId?: string, activitySequence = 0) {
  const key = `agent-desktop:transcript:v1:${hostId}:${sessionId}`;
  type Snapshot = { key: string; owner: { hostId: string; sessionId: string } | null; source: "host" | "cache" | null; messages: TranscriptMessage[]; readSequence?: number; loaded: boolean; loading: boolean; error: string | null; cacheWarning: string | null };
  const empty = (): Snapshot => ({ key, owner: null, source: null, messages: [], loaded: false, loading: Boolean(sessionId && connected), error: null, cacheWarning: null });
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const current = useRef(snapshot); current.current = snapshot;
  const refreshRef = useRef<() => void>(() => {});
  const activityRef = useRef(activitySequence); activityRef.current = activitySequence;
  useEffect(() => {
    const owner = hostId && sessionId ? { hostId, sessionId } : null;
    let cancelled = false; let pending = false; let again = false; let receivedLive = false; let historyGeneration = 0; let timer: ReturnType<typeof setTimeout> | undefined;
    const hasCurrentSnapshot = current.current.key === key && current.current.loaded;
    const update = (patch: Partial<Snapshot>) => { if (!cancelled) setSnapshot(previous => ({ ...(previous.key === key ? previous : empty()), ...patch, key })); };
    update({ error: null, loading: false });
    // A transport reconnect does not change the conversation. Keep its real DOM
    // rows, selection and focus while the next live snapshot is being fetched.
    if (!hasCurrentSnapshot && sessionId && hostId) void offlineCache.read(key).then(value => {
      const cached = JSON.parse(value ?? "[]");
      if (!cancelled && !receivedLive && historyGeneration === 0 && Array.isArray(cached)) update({ messages: cached, owner, source: "cache", loaded: true, cacheWarning: null });
    }).catch(() => { if (historyGeneration === 0) update({ cacheWarning: "The cached transcript could not be read. Reconnect to load it from its host." }); });
    async function load() {
      if (!bridge || !sessionId || !connected || cancelled) return;
      if (pending) { again = true; return; }
      pending = true; update({ loading: true });
      const readSequence = activityRef.current, readHistoryGeneration = historyGeneration;
      try {
        const next = await bridge.getMessages(sessionId, hostId);
        if (cancelled || readHistoryGeneration !== historyGeneration) return;
        receivedLive = true; update({ messages: next, owner, source: "host", loaded: true, readSequence, error: null });
        void offlineCache.write(key, JSON.stringify(next)).then(() => update({ cacheWarning: null }), () => update({ cacheWarning: "This transcript could not be cached for offline reading." }));
      } catch (cause) { if (readHistoryGeneration === historyGeneration) update({ error: errorMessage(cause) }); }
      finally { pending = false; if (!cancelled) { update({ loading: false }); if (again) { again = false; schedule(); } } }
    }
    function schedule() {
      if (timer || cancelled) return;
      timer = setTimeout(() => { timer = undefined; void load(); }, 90);
    }
    refreshRef.current = () => { void load(); };
    const unsubscribe = bridge?.subscribe(event => {
      if ((event.hostId ?? localHostId) !== hostId) return;
      if (event.type === "runtime" && event.sessionId === sessionId) {
        if (event.event && typeof event.event === "object" && "type" in event.event && event.event.type === "tree_changed") { historyGeneration++; again = pending; }
        schedule();
      }
      if (event.type === "state" && event.state.sessions.some(session => session.id === sessionId)) schedule();
    });
    void load();
    return () => { cancelled = true; if (timer) clearTimeout(timer); unsubscribe?.(); };
  }, [bridge, sessionId, hostId, connected, localHostId]);
  useEffect(() => { refreshRef.current(); }, [activitySequence]);
  // Do not paint the previous host/session for one render before effect cleanup.
  const visible = snapshot.key === key ? snapshot : empty();
  return { ...visible, refresh: () => refreshRef.current() };
}
