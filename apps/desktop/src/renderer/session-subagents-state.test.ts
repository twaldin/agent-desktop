import { expect, test } from "bun:test";
import type { DesktopEvent, TranscriptMessage } from "../../../../packages/shared/src/protocol";
import type { SessionSubagentRow, SessionSubagentsEnvelope, SessionSubagentsOwner, SessionSubagentsRequest, SessionSubagentsResult, SessionSubagentTarget } from "../../../../packages/shared/src/session-subagents";
import { decodeSubagentImage, SESSION_SUBAGENTS_POLL_MS, SessionSubagentsState, subagentMediaContext, type SessionSubagentsTimers } from "./session-subagents-state";
import type { AttachmentCache } from "./attachment-cache";

const ownerA: SessionSubagentsOwner = { nativeSessionId: "native-a", epoch: "epoch-1" };
const ownerB: SessionSubagentsOwner = { nativeSessionId: "native-b", epoch: "epoch-2" };
const worker: SessionSubagentTarget = { id: "w-a", sessionId: "child-a", guard: "g-a" };
const auditor: SessionSubagentTarget = { id: "w-b", sessionId: "child-b", guard: "g-b" };
const running: SessionSubagentRow = { target: worker, displayName: "Ui reference fixture", status: "running", running: true, createdAt: 1000, lastActivity: 5000, activity: "building OOXML package" };
const parked: SessionSubagentRow = { target: auditor, displayName: "Evidence audit", status: "parked", running: false, createdAt: 500, lastActivity: 4000 };
const message = (id: string, text: string): TranscriptMessage => ({ id, nativeId: `native-${id}`, role: "assistant", text, lifecycle: "complete", content: [{ type: "text", text }] });
const list = (owner: SessionSubagentsOwner, rows: SessionSubagentRow[] = [running, parked]): SessionSubagentsResult => ({ action: "list", owner, availability: "available", rows, omitted: 0 });
const transcript = (owner: SessionSubagentsOwner, target: SessionSubagentTarget, messages: TranscriptMessage[], cwd = "/work/child"): SessionSubagentsResult =>
  ({ action: "transcript", owner, target, availability: "available", messages, cwd, truncated: false });

interface Call { sessionId: string; hostId: string; request: SessionSubagentsRequest; resolve(result: SessionSubagentsResult, envelope?: Partial<SessionSubagentsEnvelope>): void; reject(error: Error): void }
interface Fixture { state: SessionSubagentsState; calls: Call[]; opened: string[]; advance(ms: number): void; settle(): Promise<void>; emit(event: DesktopEvent): void; readonly last: Call }

/** Real state machine over a bridge whose responses settle only when the test says so. */
function fixture(options: { supported?: boolean } = {}): Fixture {
  const calls: Call[] = [], listeners = new Set<(event: DesktopEvent) => void>(), opened: string[] = [];
  const timeouts = new Map<number, { handler: () => void; at: number }>(), intervals = new Map<number, { handler: () => void; every: number; next: number }>();
  let now = 0, handle = 0;
  const timers: SessionSubagentsTimers = {
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
    openExternal: async (url: string) => { opened.push(url); },
    ...(options.supported === false ? {} : { sessionSubagents: (sessionId: string, request: SessionSubagentsRequest, hostId: string) => new Promise<SessionSubagentsEnvelope>((resolve, reject) => {
      calls.push({ sessionId, hostId, request, reject, resolve: (result, envelope) => resolve({ protocolVersion: 1, hostId, sessionId, result, ...envelope }) });
    }) }),
  };
  const state = new SessionSubagentsState(bridge, timers);
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const emit = (event: DesktopEvent) => { for (const listener of listeners) listener(event); };
  return { state, calls, opened, advance, settle, emit, get last() { return calls[calls.length - 1]!; } };
}
const scope = (patch: Partial<{ hostId: string; sessionId: string; connected: boolean; active: boolean }> = {}) => ({ hostId: "host-1", sessionId: "session-1", connected: true, active: true, ...patch });

/** Configure, answer the first list read with owner A, then open the running worker. */
async function openedWorker(f: Fixture) {
  f.state.configure(scope());
  f.calls[0]!.resolve(list(ownerA)); await f.settle();
  void f.state.open(worker);
  expect(f.last.request).toEqual({ action: "transcript", owner: ownerA, target: worker });
  f.last.resolve(transcript(ownerA, worker, [message("m1", "hello")])); await f.settle();
  expect(f.state.getSnapshot().detail).toMatchObject({ state: "ready", live: true, transcript: { messages: [{ id: "m1" }] } });
}

test("the first list read is unpinned; later reads carry the original owner, and an owner replacement keeps the original rows stale until an explicit reload", async () => {
  const f = fixture(); f.state.configure(scope());
  expect(f.calls[0]!.request).toEqual({ action: "list" });
  f.calls[0]!.resolve(list(ownerA)); await f.settle();
  f.advance(SESSION_SUBAGENTS_POLL_MS);
  expect(f.calls[1]!.request).toEqual({ action: "list", owner: ownerA });
  f.calls[1]!.resolve(list(ownerB, [])); await f.settle();
  let view = f.state.getSnapshot();
  expect(view.list?.owner).toEqual(ownerA);
  expect(view.list?.availability === "available" && view.list.rows.map(row => row.target.id)).toEqual(["w-a", "w-b"]);
  expect(view).toMatchObject({ stale: true, ownerChanged: true });
  // Polling keeps carrying the original owner; nothing retargets to the new generation by itself.
  f.advance(SESSION_SUBAGENTS_POLL_MS);
  expect(f.last.request).toEqual({ action: "list", owner: ownerA });
  void f.state.reload();
  expect(f.last.request).toEqual({ action: "list" });
  f.last.resolve(list(ownerB, [])); await f.settle();
  view = f.state.getSnapshot();
  expect(view).toMatchObject({ stale: false, ownerChanged: false, error: undefined, list: { owner: ownerB, rows: [] } });
});

test("serialized Electron owner retirement keeps the original view until explicit reload", async () => {
  const f = fixture(); f.state.configure(scope());
  f.last.resolve(list(ownerA)); await f.settle();
  f.advance(SESSION_SUBAGENTS_POLL_MS);
  f.last.reject(new Error("Error invoking remote method 'host:session-subagents': HostRequestError: [STALE_OWNER] The original session was retired."));
  await f.settle();
  expect(f.state.getSnapshot()).toMatchObject({ stale: true, ownerChanged: true, list: { owner: ownerA } });
  void f.state.reload(); f.last.resolve(list(ownerB, [])); await f.settle();
  expect(f.state.getSnapshot()).toMatchObject({ stale: false, ownerChanged: false, list: { owner: ownerB } });
});

test("a reply arriving after disconnect stays visibly stale rather than restoring online authority", async () => {
  const f = fixture(); f.state.configure(scope());
  const pending = f.last;
  f.state.configure(scope({ connected: false }));
  pending.resolve(list(ownerA)); await f.settle();
  expect(f.state.getSnapshot()).toMatchObject({ connected: false, stale: true, list: { owner: ownerA } });
  await f.state.open(worker);
  expect(f.state.getSnapshot().detail).toBeUndefined();
});

test("closing and reopening the same child does not admit the old pending link open", async () => {
  const f = fixture(); await openedWorker(f);
  const opening = f.state.openExternal(worker, "https://example.com/original");
  const validation = f.last;
  f.state.back(); void f.state.open(worker);
  validation.resolve({ action: "validate", owner: ownerA, target: worker });
  await expect(opening).rejects.toThrow(/selected subagent changed/);
  expect(f.opened).toEqual([]);
  f.last.resolve(transcript(ownerA, worker, [message("m1", "Reopened original child")])); await f.settle();
});

test("a reload that lands on another owner drops the open child and discards its late transcript", async () => {
  const f = fixture(); await openedWorker(f);
  f.advance(SESSION_SUBAGENTS_POLL_MS);
  f.last.resolve(list(ownerA)); await f.settle();
  const lateTranscript = f.last;
  expect(lateTranscript.request).toEqual({ action: "transcript", owner: ownerA, target: worker });
  void f.state.reload();
  expect(f.last.request).toEqual({ action: "list" });
  f.last.resolve(list(ownerB, [])); await f.settle();
  expect(f.state.getSnapshot().detail).toBeUndefined();
  lateTranscript.resolve(transcript(ownerA, worker, [message("m2", "late")])); await f.settle();
  expect(f.state.getSnapshot().detail).toBeUndefined();
  expect(f.state.getSnapshot().list?.owner).toEqual(ownerB);
});

test("Back before the transcript lands discards it; opening another row supersedes the first row's late reply", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve(list(ownerA)); await f.settle();
  void f.state.open(worker);
  const first = f.last;
  expect(first.request).toEqual({ action: "transcript", owner: ownerA, target: worker });
  f.state.back();
  expect(f.state.getSnapshot().detail).toBeUndefined();
  first.resolve(transcript(ownerA, worker, [message("m1", "late")])); await f.settle();
  expect(f.state.getSnapshot().detail).toBeUndefined();

  void f.state.open(worker);
  const second = f.last;
  void f.state.open(auditor);
  const third = f.last;
  expect(third.request).toMatchObject({ action: "transcript", target: auditor });
  second.resolve(transcript(ownerA, worker, [message("m1", "worker")])); await f.settle();
  expect(f.state.getSnapshot().detail).toMatchObject({ target: auditor, state: "pending" });
  third.resolve(transcript(ownerA, auditor, [message("m9", "auditor")])); await f.settle();
  expect(f.state.getSnapshot().detail).toMatchObject({ target: auditor, state: "ready", live: false, transcript: { messages: [{ id: "m9" }] } });
});

test("a host or session change never lets the previous session's replies touch the new view", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve(list(ownerA)); await f.settle();
  void f.state.open(worker);
  const stale = f.last;
  f.state.configure(scope({ sessionId: "session-2" }));
  let view = f.state.getSnapshot();
  expect([view.sessionId, view.list, view.detail, view.loading]).toEqual(["session-2", undefined, undefined, true]);
  expect(f.last.request).toEqual({ action: "list" });
  stale.resolve(transcript(ownerA, worker, [message("m1", "old session")])); await f.settle();
  view = f.state.getSnapshot();
  expect([view.sessionId, view.list, view.detail]).toEqual(["session-2", undefined, undefined]);
  const cross = f.last;
  cross.resolve(list(ownerB, []), { sessionId: "session-1" }); await f.settle();
  expect(f.state.getSnapshot().list).toBeUndefined();
  expect(f.state.getSnapshot().error).toContain("different session");
});

test("a live child is re-read on every poll while running, then exactly once more after it settles", async () => {
  const f = fixture(); await openedWorker(f);
  f.advance(SESSION_SUBAGENTS_POLL_MS);
  expect(f.last.request).toEqual({ action: "list", owner: ownerA });
  f.last.resolve(list(ownerA)); await f.settle();
  expect(f.last.request).toEqual({ action: "transcript", owner: ownerA, target: worker });
  f.last.resolve(transcript(ownerA, worker, [message("m1", "hello"), message("m2", "more")])); await f.settle();
  expect(f.state.getSnapshot().detail?.transcript?.messages).toHaveLength(2);
  // The row settles: one more transcript read captures its final content.
  f.advance(SESSION_SUBAGENTS_POLL_MS);
  f.last.resolve(list(ownerA, [{ ...running, status: "idle", running: false }, parked])); await f.settle();
  expect(f.last.request.action).toBe("transcript");
  f.last.resolve(transcript(ownerA, worker, [message("m1", "hello"), message("m2", "more"), message("m3", "done")])); await f.settle();
  expect(f.state.getSnapshot().detail).toMatchObject({ live: false, transcript: { messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] } });
  const reads = f.calls.length;
  f.advance(SESSION_SUBAGENTS_POLL_MS);
  f.last.resolve(list(ownerA, [{ ...running, status: "idle", running: false }, parked])); await f.settle();
  expect(f.calls.slice(reads).map(call => call.request.action)).toEqual(["list"]);
});

test("a failed re-read keeps the retained transcript and marks it stale; the next successful read clears it", async () => {
  const f = fixture(); await openedWorker(f);
  f.advance(SESSION_SUBAGENTS_POLL_MS);
  f.last.resolve(list(ownerA)); await f.settle();
  f.last.reject(new Error("journal unreadable")); await f.settle();
  expect(f.state.getSnapshot().detail).toMatchObject({ state: "ready", stale: true, error: "journal unreadable", transcript: { messages: [{ id: "m1" }] } });
  f.advance(SESSION_SUBAGENTS_POLL_MS);
  f.last.resolve(list(ownerA)); await f.settle();
  f.last.resolve(transcript(ownerA, worker, [message("m1", "hello")])); await f.settle();
  expect(f.state.getSnapshot().detail).toMatchObject({ stale: false, error: undefined });
});

test("going offline stops reads, keeps the roster and transcript visibly stale, refuses opening rows, and reconnecting resumes from the pinned owner", async () => {
  const f = fixture(); await openedWorker(f);
  const before = f.calls.length;
  f.state.configure(scope({ connected: false }));
  f.advance(SESSION_SUBAGENTS_POLL_MS * 3);
  expect(f.calls).toHaveLength(before);
  let view = f.state.getSnapshot();
  expect(view).toMatchObject({ connected: false, stale: true, list: { owner: ownerA }, detail: { stale: true, transcript: { messages: [{ id: "m1" }] } } });
  f.state.back();
  await f.state.open(auditor);
  expect(f.calls).toHaveLength(before);
  expect(f.state.getSnapshot().detail).toBeUndefined();
  f.state.configure(scope({ connected: true }));
  expect(f.last.request).toEqual({ action: "list", owner: ownerA });
  f.last.resolve(list(ownerA)); await f.settle();
  view = f.state.getSnapshot();
  expect(view).toMatchObject({ connected: true, stale: false });
});

test("an inactive tab stops polling without dropping the view; activating polls again immediately", async () => {
  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve(list(ownerA)); await f.settle();
  f.state.configure(scope({ active: false }));
  const before = f.calls.length;
  f.advance(SESSION_SUBAGENTS_POLL_MS * 2);
  f.emit({ type: "runtime", hostId: "host-1", sessionId: "session-1", sessionActivity: true } as unknown as DesktopEvent);
  f.advance(SESSION_SUBAGENTS_POLL_MS);
  expect(f.calls).toHaveLength(before);
  expect(f.state.getSnapshot()).toMatchObject({ active: false, stale: false, list: { owner: ownerA } });
  f.state.configure(scope({ active: true }));
  expect(f.calls).toHaveLength(before + 1);
  expect(f.last.request).toEqual({ action: "list", owner: ownerA });
});

test("file preview is bound to the child cwd: absolute paths are refused without a request, a closed preview discards its late reply, and a mismatched path is rejected", async () => {
  const f = fixture(); await openedWorker(f);
  const before = f.calls.length;
  await expect(f.state.openFile(worker, "/etc/passwd")).rejects.toThrow(/working directory/);
  expect(f.calls).toHaveLength(before);
  const pending = f.state.openFile(worker, "src/index.ts");
  expect(f.last.request).toEqual({ action: "file", owner: ownerA, target: worker, path: "src/index.ts" });
  expect(f.state.getSnapshot().detail?.preview).toEqual({ path: "src/index.ts", state: "pending" });
  const reply = f.last;
  f.state.closePreview();
  reply.resolve({ action: "file", owner: ownerA, target: worker, path: "src/index.ts", text: "export {}", truncated: false }); await pending;
  expect(f.state.getSnapshot().detail?.preview).toBeUndefined();

  const second = f.state.openFile(worker, "README.md");
  f.last.resolve({ action: "file", owner: ownerA, target: worker, path: "OTHER.md", text: "nope", truncated: false }); await second;
  expect(f.state.getSnapshot().detail?.preview).toMatchObject({ path: "README.md", state: "failed", error: expect.stringContaining("different file") });

  const third = f.state.openFile(worker, "README.md");
  f.last.resolve({ action: "file", owner: ownerA, target: worker, path: "README.md", text: "# Child", truncated: true }); await third;
  expect(f.state.getSnapshot().detail?.preview).toEqual({ path: "README.md", state: "ready", text: "# Child", truncated: true });
  // Opening a file that is no longer the selected child's is refused before any request.
  f.state.back();
  await expect(f.state.openFile(worker, "README.md")).rejects.toThrow(/no longer open/);
});

test("external links open only after the host validates the exact child and the selection is still current", async () => {
  const f = fixture(); await openedWorker(f);
  const open = f.state.openExternal(worker, "https://example.com/a");
  expect(f.last.request).toEqual({ action: "validate", owner: ownerA, target: worker });
  f.last.resolve({ action: "validate", owner: ownerA, target: worker }); await open;
  expect(f.opened).toEqual(["https://example.com/a"]);

  const changed = f.state.openExternal(worker, "https://example.com/b");
  const validation = f.last;
  f.state.back();
  validation.resolve({ action: "validate", owner: ownerA, target: worker });
  await expect(changed).rejects.toThrow(/selected subagent changed/);
  expect(f.opened).toEqual(["https://example.com/a"]);

  void f.state.open(worker); f.last.resolve(transcript(ownerA, worker, [message("m1", "hello")])); await f.settle();
  const refused = f.state.openExternal(worker, "https://example.com/c");
  f.last.reject(new Error("child generation retired"));
  await expect(refused).rejects.toThrow("child generation retired");
  expect(f.opened).toEqual(["https://example.com/a"]);
});

test("child images are requested through the captured owner and target, decoded from base64 in the panel, and refused once the child is closed", async () => {
  const f = fixture(); await openedWorker(f);
  const cache = { put: async () => {}, get: async () => null, close() {} } satisfies AttachmentCache;
  const attachments: string[] = [];
  const media = subagentMediaContext(f.state, worker, { cache, bridge: { getImageAttachment: async sha256 => { attachments.push(sha256); return { data: new Uint8Array(0), sha256, bytes: 0, mimeType: "image/png" }; } } });
  const bytes = new Uint8Array([137, 80, 78, 71]), base64 = btoa(String.fromCharCode(...bytes));
  const loading = media.bridge.getTranscriptImage!("parent-session-id", "entry-7", 2, "host-1", "generated");
  expect(f.last.request).toEqual({ action: "image", owner: ownerA, target: worker, nativeEntryId: "entry-7", blockIndex: 2, source: "generated" });
  f.last.resolve({ action: "image", owner: ownerA, target: worker, image: { base64, mimeType: "image/png", bytes: 4, sha256: "f".repeat(64) } });
  const recorded = await loading;
  expect(Array.from(recorded.data)).toEqual([137, 80, 78, 71]);
  expect(recorded).toMatchObject({ sha256: "f".repeat(64), bytes: 4, mimeType: "image/png" });
  await media.bridge.getImageAttachment!("a".repeat(64), "host-1");
  expect(attachments).toEqual(["a".repeat(64)]);
  expect(() => decodeSubagentImage({ base64, mimeType: "image/png", bytes: 5, sha256: "f".repeat(64) })).toThrow(/size differs/);

  f.state.back();
  const before = f.calls.length;
  await expect(media.bridge.getTranscriptImage!("parent-session-id", "entry-7", 2, "host-1")).rejects.toThrow(/no longer open/);
  expect(f.calls).toHaveLength(before);
});

test("an unsupported bridge never reads, and missing or unavailable child logs reach the view as the host reported them", async () => {
  const unsupported = fixture({ supported: false }); unsupported.state.configure(scope());
  expect(unsupported.calls).toHaveLength(0);
  expect(unsupported.state.getSnapshot()).toMatchObject({ supported: false, loading: false });

  const f = fixture(); f.state.configure(scope());
  f.calls[0]!.resolve(list(ownerA)); await f.settle();
  void f.state.open(auditor);
  f.last.resolve({ action: "transcript", owner: ownerA, target: auditor, availability: "missing", messages: [], truncated: false, reason: "No journal for child-b" }); await f.settle();
  expect(f.state.getSnapshot().detail).toMatchObject({ state: "ready", transcript: { availability: "missing", reason: "No journal for child-b" } });
  f.advance(SESSION_SUBAGENTS_POLL_MS);
  f.last.resolve({ action: "list", owner: ownerA, availability: "unavailable", rows: [], omitted: 0, reason: "Registry not attached" }); await f.settle();
  expect(f.state.getSnapshot().list).toMatchObject({ availability: "unavailable", reason: "Registry not attached" });
});
