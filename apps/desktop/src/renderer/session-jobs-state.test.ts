import { expect, test } from "bun:test";
import type { DesktopEvent } from "../../../../packages/shared/src/protocol";
import type { SessionJobRow, SessionJobsEnvelope, SessionJobsOwner, SessionJobsRequest, SessionJobsResult, SessionJobsSnapshot } from "../../../../packages/shared/src/session-jobs";
import { SESSION_JOBS_COALESCE_MS, SESSION_JOBS_POLL_MS, SessionJobsState, type SessionJobsTimers } from "./session-jobs-state";

const ownerA: SessionJobsOwner = { nativeSessionId: "native-a", epoch: "epoch-1", agentId: "main" };
const ownerB: SessionJobsOwner = { nativeSessionId: "native-b", epoch: "epoch-2", agentId: "main" };
const running: SessionJobRow = { target: { id: "bg_1", startTime: 1000, guard: "g1" }, type: "bash", status: "running", label: "sleep 30", queued: false };
const settled: SessionJobRow = { target: { id: "bg_2", startTime: 900, guard: "g2" }, type: "task", status: "completed", label: "worker", queued: false, agentId: "worker" };
const available = (owner: SessionJobsOwner, rows: { running?: SessionJobRow[]; recent?: SessionJobRow[] } = { running: [running], recent: [settled] }): SessionJobsSnapshot =>
  ({ owner, availability: "available", running: rows.running ?? [], recent: rows.recent ?? [], delivery: { queued: 0, delivering: false, pendingJobIds: [] } });

interface Call { sessionId: string; hostId: string; request: SessionJobsRequest; resolve(result: SessionJobsResult, envelope?: Partial<SessionJobsEnvelope>): void; reject(error: Error): void }

/** Real state machine over a bridge whose responses settle only when the test says so. */
function fixture(options: { supported?: boolean } = {}) {
  const calls: Call[] = [], listeners = new Set<(event: DesktopEvent) => void>();
  const timeouts = new Map<number, { handler: () => void; at: number }>(), intervals = new Map<number, { handler: () => void; every: number; next: number }>();
  let now = 0, handle = 0;
  const timers: SessionJobsTimers = {
    setTimeout: (handler, ms) => { timeouts.set(++handle, { handler, at: now + ms }); return handle; },
    clearTimeout: id => { timeouts.delete(id as number); },
    setInterval: (handler, every) => { intervals.set(++handle, { handler, every, next: now + every }); return handle; },
    clearInterval: id => { intervals.delete(id as number); },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      let soonest: { at: number; fire(): void } | undefined;
      for (const [id, timeout] of timeouts) if (!soonest || timeout.at < soonest.at) soonest = { at: timeout.at, fire: () => { timeouts.delete(id); timeout.handler(); } };
      for (const interval of intervals.values()) if (!soonest || interval.next < soonest.at) soonest = { at: interval.next, fire: () => { interval.next += interval.every; interval.handler(); } };
      if (!soonest || soonest.at > until) break;
      now = soonest.at; soonest.fire();
    }
    now = until;
  };
  const bridge = {
    subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ...(options.supported === false ? {} : { sessionJobs: (sessionId: string, request: SessionJobsRequest, hostId: string) => new Promise<SessionJobsEnvelope>((resolve, reject) => {
      calls.push({ sessionId, hostId, request, reject, resolve: (result, envelope) => resolve({ protocolVersion: 1, hostId, sessionId, result, ...envelope }) });
    }) }),
  };
  const state = new SessionJobsState(bridge, timers);
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const emit = (event: DesktopEvent) => { for (const listener of listeners) listener(event); };
  return { state, calls, advance, settle, emit, get listeners() { return listeners.size; } };
}
const scope = (patch: Partial<{ hostId: string; sessionId: string; connected: boolean; visible: boolean }> = {}) => ({ hostId: "host-1", sessionId: "session-1", connected: true, visible: true, ...patch });

test("first read is unpinned; every later read carries the original native owner and refuses another owner's rows", async () => {
  const f = fixture(); f.state.configure(scope());
  expect(f.calls[0]!.request).toEqual({ action: "read" });
  f.calls[0]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  expect(f.state.getSnapshot().snapshot?.owner).toEqual(ownerA);
  f.advance(SESSION_JOBS_POLL_MS);
  expect(f.calls[1]!.request).toEqual({ action: "read", owner: ownerA });
  f.calls[1]!.resolve({ action: "read", snapshot: available(ownerB, { running: [], recent: [] }) }); await f.settle();
  const view = f.state.getSnapshot();
  expect(view.snapshot?.owner).toEqual(ownerA);
  expect(view.snapshot?.availability === "available" && view.snapshot.running).toEqual([running]);
  expect(view.stale).toBe(true);
  expect(view.error).toContain("changed");
  // Polling keeps carrying the original owner; only an explicit reload reads the current native owner.
  f.advance(SESSION_JOBS_POLL_MS);
  expect(f.calls[2]!.request).toEqual({ action: "read", owner: ownerA });
  void f.state.reload();
  expect(f.calls[3]!.request).toEqual({ action: "read" });
  f.calls[3]!.resolve({ action: "read", snapshot: available(ownerB, { running: [], recent: [] }) }); await f.settle();
  expect(f.state.getSnapshot()).toMatchObject({ stale: false, error: undefined, snapshot: { owner: ownerB, running: [] } });
});

test("a failed read keeps the last same-owner rows, marks them stale and refuses cancellation without contacting the host", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  f.advance(SESSION_JOBS_POLL_MS);
  f.calls[1]!.reject(new Error("host unreachable")); await f.settle();
  const view = f.state.getSnapshot();
  expect(view.snapshot?.availability === "available" && view.snapshot.running).toEqual([running]);
  expect(view).toMatchObject({ stale: true, error: "host unreachable", loading: false });
  await f.state.cancel(running.target);
  expect(f.calls).toHaveLength(2);
  expect(f.state.getSnapshot().cancellation).toBeUndefined();
  f.advance(SESSION_JOBS_POLL_MS);
  f.calls[2]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  expect(f.state.getSnapshot()).toMatchObject({ stale: false, error: undefined });
});

test("changing host or session drops the old view synchronously and a late old response never paints the new owner", async () => {
  const f = fixture(); f.state.configure(scope());
  const late = f.calls[0]!;
  f.state.configure(scope({ sessionId: "session-2" }));
  expect(f.state.getSnapshot()).toMatchObject({ sessionId: "session-2", loading: true, stale: false });
  expect(f.state.getSnapshot().snapshot).toBeUndefined();
  expect(f.calls[1]!.sessionId).toBe("session-2");
  late.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  expect(f.state.getSnapshot()).toMatchObject({ sessionId: "session-2", loading: true, reading: true });
  expect(f.state.getSnapshot().snapshot).toBeUndefined();
  f.calls[1]!.resolve({ action: "read", snapshot: available(ownerB, { running: [], recent: [] }) }); await f.settle();
  expect(f.state.getSnapshot()).toMatchObject({ loading: false, reading: false, snapshot: { owner: ownerB } });
  // Envelope identity is checked too: a mislabeled response for the current scope is an error, not rows.
  f.advance(SESSION_JOBS_POLL_MS);
  f.calls[2]!.resolve({ action: "read", snapshot: available(ownerB) }, { sessionId: "session-1" }); await f.settle();
  expect(f.state.getSnapshot()).toMatchObject({ stale: true, snapshot: { running: [] } });
});

test("an older read settling after a newer one never overwrites the newer rows or their freshness", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  void f.state.refresh(); void f.state.refresh();
  expect(f.calls).toHaveLength(3);
  f.calls[2]!.resolve({ action: "read", snapshot: available(ownerA, { running: [], recent: [running, settled] }) }); await f.settle();
  f.calls[1]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  const view = f.state.getSnapshot();
  expect(view.snapshot?.availability === "available" && view.snapshot.running).toEqual([]);
  expect(view.reading).toBe(false);
  void f.state.refresh(); void f.state.refresh();
  f.calls[4]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  f.calls[3]!.reject(new Error("slow failure")); await f.settle();
  expect(f.state.getSnapshot()).toMatchObject({ stale: false, error: undefined });
});

test("cancel sends one guarded request with the exact target and owner, reports a declined native answer and never retries a failure", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  await f.state.cancel(settled.target);
  expect(f.calls).toHaveLength(1);
  const first = f.state.cancel(running.target);
  expect(f.calls[1]!.request).toEqual({ action: "cancel", owner: ownerA, job: running.target });
  expect(f.state.getSnapshot().cancellation).toEqual({ target: running.target, state: "pending" });
  void f.state.cancel(running.target);
  expect(f.calls).toHaveLength(2);
  f.calls[1]!.resolve({ action: "cancel", snapshot: available(ownerA, { running: [], recent: [{ ...running, status: "cancelled" }, settled] }), requested: false }); await first;
  expect(f.state.getSnapshot().cancellation).toEqual({ target: running.target, state: "declined" });
  expect(f.state.getSnapshot().snapshot).toMatchObject({ running: [] });
  f.state.dismissCancellation();
  f.advance(SESSION_JOBS_POLL_MS);
  f.calls[2]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  const failed = f.state.cancel(running.target);
  f.calls[3]!.reject(new Error("worker gone")); await failed; await f.settle();
  expect(f.state.getSnapshot().cancellation).toEqual({ target: running.target, state: "failed", error: "worker gone" });
  expect(f.calls).toHaveLength(4);
  f.advance(SESSION_JOBS_POLL_MS * 3);
  expect(f.calls.slice(4).every(call => call.request.action === "read")).toBe(true);
});

test("a cancellation whose owner moved marks the view stale instead of trusting the new owner's answer", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  const cancel = f.state.cancel(running.target);
  f.calls[1]!.resolve({ action: "cancel", snapshot: available(ownerB, { running: [], recent: [] }), requested: true }); await cancel;
  const view = f.state.getSnapshot();
  expect(view.cancellation?.state).toBe("failed");
  expect(view).toMatchObject({ stale: true, snapshot: { owner: ownerA } });
});

test("reads happen only while visible and connected, coalesce real activity events, and stopping never issues a cancel", async () => {
  const f = fixture(); f.state.configure(scope({ visible: false }));
  expect(f.calls).toHaveLength(0); expect(f.listeners).toBe(0);
  f.state.configure(scope());
  expect(f.calls).toHaveLength(1);
  f.calls[0]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  f.emit({ sequence: 1, type: "runtime", sessionId: "session-1", event: { type: "tool_execution_end", activityChanged: true } });
  f.emit({ sequence: 2, type: "runtime", sessionId: "session-1", event: { type: "message_update" } });
  f.emit({ sequence: 3, type: "runtime", sessionId: "other", event: { type: "agent_end", activityChanged: true } });
  f.emit({ sequence: 4, type: "runtime", sessionId: "session-1", hostId: "host-2", event: { type: "agent_end", activityChanged: true } });
  f.emit({ sequence: 5, type: "runtime", sessionId: "session-1", event: { type: "agent_end", activityChanged: true } });
  expect(f.calls).toHaveLength(1);
  f.advance(SESSION_JOBS_COALESCE_MS);
  expect(f.calls).toHaveLength(2);
  f.calls[1]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  f.state.configure(scope({ connected: false }));
  expect(f.listeners).toBe(0);
  expect(f.state.getSnapshot()).toMatchObject({ connected: false, stale: true, snapshot: { owner: ownerA } });
  f.advance(SESSION_JOBS_POLL_MS * 2);
  expect(f.calls).toHaveLength(2);
  f.state.configure(scope());
  expect(f.calls).toHaveLength(3);
  const inFlight = f.calls[2]!;
  f.state.stop();
  f.advance(SESSION_JOBS_POLL_MS * 2);
  inFlight.resolve({ action: "read", snapshot: available(ownerA, { running: [], recent: [] }) }); await f.settle();
  expect(f.calls).toHaveLength(3);
  expect(f.calls.every(call => call.request.action === "read")).toBe(true);
});

test("inspection results attach only to the row that asked and a cross-owner answer is refused", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  const first = f.state.inspect(settled.target);
  expect(f.calls[1]!.request).toEqual({ action: "inspect", owner: ownerA, job: settled.target });
  f.state.closeInspection();
  expect(f.state.getSnapshot().inspection?.state).toBe("pending");
  f.state.configure(scope({ sessionId: "session-2" }));
  f.calls[1]!.resolve({ action: "inspect", snapshot: available(ownerA), detail: { target: settled.target, resultText: "done", truncated: false, consumed: false } }); await first;
  expect(f.state.getSnapshot().sessionId).toBe("session-2");
  expect(f.state.getSnapshot().inspection).toBeUndefined();
  expect(f.state.getSnapshot().snapshot).toBeUndefined();
  f.calls[2]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  const second = f.state.inspect(settled.target);
  f.calls[3]!.resolve({ action: "inspect", snapshot: available(ownerB), detail: { target: settled.target, resultText: "other", truncated: false, consumed: true } }); await second;
  expect(f.state.getSnapshot()).toMatchObject({ stale: true, inspection: { state: "failed" }, snapshot: { owner: ownerA } });
});

test("reloading a replacement owner drops prior output and ignores an outstanding old-owner cancellation", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  const inspect = f.state.inspect(settled.target);
  f.calls[1]!.resolve({ action: "inspect", snapshot: available(ownerA), detail: { target: settled.target, resultText: "old output", truncated: false, consumed: false } }); await inspect;
  const cancel = f.state.cancel(running.target);
  const reload = f.state.reload();
  f.advance(SESSION_JOBS_POLL_MS * 2);
  expect(f.calls).toHaveLength(4);
  f.calls[3]!.resolve({ action: "read", snapshot: available(ownerB, { running: [], recent: [] }) }); await reload;
  f.calls[2]!.resolve({ action: "cancel", snapshot: available(ownerA), requested: true }); await cancel;
  expect(f.state.getSnapshot()).toMatchObject({ snapshot: { owner: ownerB }, stale: false, inspection: undefined, cancellation: undefined });
});

test("wrong-action and wrong-target answers never replace trustworthy rows or expose another job's output", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve({ action: "read", snapshot: available(ownerA) }); await f.settle();
  const refresh = f.state.refresh();
  f.calls[1]!.resolve({ action: "cancel", snapshot: available(ownerA, { running: [], recent: [] }), requested: true }); await refresh;
  expect(f.state.getSnapshot()).toMatchObject({ stale: true, snapshot: { running: [running] } });
  const inspect = f.state.inspect(settled.target);
  f.calls[2]!.resolve({ action: "inspect", snapshot: available(ownerA), detail: { target: running.target, resultText: "wrong output", truncated: false, consumed: false } }); await inspect;
  expect(f.state.getSnapshot()).toMatchObject({ stale: true, inspection: { state: "failed" } });
  expect(f.state.getSnapshot().inspection?.detail).toBeUndefined();
});

test("a bridge without native jobs reports unsupported and never polls", () => {
  const f = fixture({ supported: false }); f.state.configure(scope());
  expect(f.state.getSnapshot()).toMatchObject({ supported: false, loading: false });
  f.advance(SESSION_JOBS_POLL_MS);
  expect(f.calls).toHaveLength(0); expect(f.listeners).toBe(0);
});
