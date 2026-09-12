import { afterEach, expect, test } from "bun:test";
import type { DesktopBridge, RepositoryWatchObserverStatus, RepositoryWatchRequest, RepositoryWatchView } from "@agent-desktop/shared";
import { RepositoryWatchRetention } from "./repository-watch-retention";
import { RepositoryWatchWindows } from "../main/repository-watch-windows";
import { RepositoryWatchConnection } from "../main/repository-watch-connection";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function clock() {
  const timers = new Map<number, { at: number; run: () => void }>(); let now = 0, id = 0;
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  globalThis.setTimeout = ((run: () => void, delay = 0) => { const next = ++id; timers.set(next, { at: now + delay, run }); return next; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  cleanups.push(() => { globalThis.setTimeout = set; globalThis.clearTimeout = clear; });
  return { async tick(ms: number) { now += ms; for (const [key, timer] of [...timers]) if (timer.at <= now && timers.delete(key)) timer.run(); await flush(); }, get size() { return timers.size; } };
}
function fixture() {
  const time = clock(), calls: RepositoryWatchRequest[] = [], listeners = new Set<(status: RepositoryWatchObserverStatus) => void>();
  const views: RepositoryWatchView[] = []; let send: (r: RepositoryWatchRequest) => Promise<void> = async () => {};
  const bridge: Pick<DesktopBridge, "repositoryWatch" | "subscribeRepositoryWatch"> = {
    subscribeRepositoryWatch(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    repositoryWatch(request) { expect(listeners.size > 0 || request.action === "release").toBe(true); calls.push(request); return send(request); },
  };
  const source = { projectId: "project" }, owner = new RepositoryWatchRetention(bridge, "host", source);
  cleanups.push(async () => { send = async () => {}; await owner.dispose(); });
  return { time, calls, views, listeners, source, owner, set send(fn: typeof send) { send = fn; },
    retain() { return owner.retain(view => views.push(view)); },
    event(view: RepositoryWatchView, request = calls.find(r => r.action === "retain")!, change: Partial<RepositoryWatchObserverStatus> = {}) {
      for (const fn of [...listeners]) fn({ hostId: request.hostId, subscriptionId: request.subscriptionId, target: { ...request.target }, view, ...change });
    } };
}

test("construction is inert; observers share subscription and status precedes any readiness claim", async () => {
  const f = fixture(); expect(f.calls).toEqual([]); const a = f.retain(), b = f.retain(); await flush();
  expect(f.calls).toHaveLength(1); expect(f.owner.getSnapshot().phase).toBe("connecting");
  f.event({ phase: "pending" }); expect(f.owner.getSnapshot().phase).toBe("pending");
  f.event({ phase: "ready", error: "partial target coverage" }); expect(f.owner.getSnapshot()).toEqual({ phase: "ready", error: "partial target coverage" });
  a(); await f.time.tick(250); expect(f.calls).toHaveLength(1); b(); await f.time.tick(250); expect(f.calls.map(r => r.action)).toEqual(["retain", "release"]);
});

test("last observer grace is250ms and reappearance cancels release without reacquisition", async () => {
  const f = fixture(), a = f.retain(); await flush(); a(); a(); await f.time.tick(249); expect(f.calls).toHaveLength(1);
  const b = f.retain(); await f.time.tick(1); expect(f.calls).toHaveLength(1); b(); await f.time.tick(249); expect(f.calls).toHaveLength(1);
  await f.time.tick(1); expect(f.calls.map(r => r.action)).toEqual(["retain", "release"]); expect(f.listeners.size).toBe(0);
  f.retain(); await flush(); expect(f.calls.at(-1)?.subscriptionId).not.toBe(f.calls[0]?.subscriptionId);
});

test("wrong host/id/target statuses cannot redirect readiness and source mutation cannot change ownership", async () => {
  const f = fixture(); f.source.projectId = "mutated"; f.retain(); await flush(); expect(f.calls[0]?.target).toEqual({ projectId: "project" });
  for (const change of [{ hostId: "other" }, { subscriptionId: "other" }, { target: { sessionId: "other" } }]) f.event({ phase: "ready" }, undefined, change);
  expect(f.owner.getSnapshot().phase).toBe("connecting");
  f.calls[0]!.target = { projectId: "request-mutated" };
  f.event({ phase: "ready" }, undefined, { target: { projectId: "project" } }); expect(f.owner.getSnapshot().phase).toBe("ready");
});

test("failure retries after1s with release acknowledgement before a fresh ID", async () => {
  const f = fixture(); f.retain(); await flush(); const old = f.calls[0]!, release = deferred<void>();
  f.send = r => r.action === "release" ? release.promise : Promise.resolve();
  f.event({ phase: "failed", error: "setup failed" }); expect(f.owner.getSnapshot().phase).toBe("failed");
  await f.time.tick(999); expect(f.calls).toHaveLength(1); await f.time.tick(1); expect(f.calls.map(r => r.action)).toEqual(["retain", "release"]);
  release.resolve(); await flush(); expect(f.calls.map(r => r.action)).toEqual(["retain", "release", "retain"]); expect(f.calls[2]!.subscriptionId).not.toBe(old.subscriptionId);
  f.event({ phase: "ready" }, old); expect(f.owner.getSnapshot().phase).toBe("connecting");
});

test("a rejected release blocks replacement and retry repeats only release until acknowledged", async () => {
  const f = fixture(); f.retain(); await flush(); let reject = true;
  f.send = async r => { if (r.action === "release" && reject) throw new Error("release outcome unknown"); };
  f.event({ phase: "failed" }); await f.time.tick(1000); expect(f.calls.map(r => r.action)).toEqual(["retain", "release"]);
  expect(f.owner.getSnapshot()).toEqual({ phase: "failed", error: "release outcome unknown" }); reject = false;
  await f.time.tick(1000); expect(f.calls.map(r => r.action)).toEqual(["retain", "release", "release", "retain"]);
});

test("last-observer removal cancels retry and late invoke rejection cannot revive disposed ownership", async () => {
  const f = fixture(), gate = deferred<void>(); f.send = r => r.action === "retain" ? gate.promise : Promise.resolve();
  const release = f.retain(); await flush(); release(); await f.time.tick(250); expect(f.calls.map(r => r.action)).toEqual(["retain", "release"]);
  gate.reject(new Error("late")); await flush(); await f.time.tick(1000); expect(f.calls).toHaveLength(2);
  await f.owner.dispose(); expect(f.time.size).toBe(0); expect(() => f.retain()).toThrow("disposed");
});

test("disconnect and unsupported remain attached for main-owned reconnect; invoke fulfillment is not ready", async () => {
  const f = fixture(); f.retain(); await flush();
  f.event({ phase: "ready" }); f.event({ phase: "disconnected" }); await f.time.tick(1000);
  expect(f.calls).toHaveLength(1); expect(f.owner.getSnapshot().phase).toBe("disconnected");
  f.event({ phase: "connecting" }); f.event({ phase: "unsupported" }); await f.time.tick(1000); expect(f.calls).toHaveLength(1);
  f.event({ phase: "pending" }); expect(f.owner.getSnapshot().phase).toBe("pending");
});

test("immediate owner disposal bypasses grace and does not leave delayed admission", async () => {
  const f = fixture(); f.retain(); await f.owner.dispose(); await flush(); expect(f.calls).toEqual([]); expect(f.listeners.size).toBe(0);
});

test("missing bridge surfaces unsupported without manufacturing a subscription", async () => {
  const owner = new RepositoryWatchRetention({}, "host", { projectId: "project" }); const views: RepositoryWatchView[] = [];
  const release = owner.retain(v => views.push(v)); await flush(); expect(views.at(-1)?.phase).toBe("unsupported"); release(); await owner.dispose();
});

test("actual window and connection controllers deliver readiness then release only this retained observer", async () => {
  const time = clock(), client = new RepositoryWatchConnection("host"), sent: RepositoryWatchRequest[] = [], listeners = new Set<(s: RepositoryWatchObserverStatus) => void>();
  const channel = client.attach({ send: r => sent.push(r), close: () => {} });
  const windows = new RepositoryWatchWindows({ connect: async () => client, notify: (_id, s) => { for (const fn of listeners) fn(s); } }); windows.reset(1);
  const owner = new RepositoryWatchRetention({ repositoryWatch: r => windows.dispatch(1, r, () => true, windows.token(1)), subscribeRepositoryWatch: fn => { listeners.add(fn); return () => { listeners.delete(fn); }; } }, "host", { projectId: "project" });
  cleanups.push(async () => { await owner.dispose(); windows.dispose(); client.dispose(); });
  const release = owner.retain(() => {}); await flush(); expect(sent).toEqual([]);
  channel.receive({ type: "state", replayComplete: true, state: { host: { id: "host" }, repositoryWatches: { version: 1 } } });
  expect(sent).toHaveLength(1); expect(owner.getSnapshot().phase).toBe("pending"); const r = sent[0]!;
  channel.receive({ type: "repository-watch", version: 1, hostId: "host", subscriptionId: r.subscriptionId, target: r.target, phase: "ready" });
  expect(owner.getSnapshot().phase).toBe("ready"); release(); await time.tick(250); expect(sent.map(r => r.action)).toEqual(["retain", "release"]);
});

test("loss during connecting notification cannot leave a subscription after owner disposal", async () => {
  const f = fixture(); let closing: Promise<void> | undefined;
  f.owner.retain(view => { if (view.phase === "connecting") closing = f.owner.dispose(); });
  await flush(); await closing;
  expect(f.calls.filter(r => r.action === "retain")).toEqual([]); expect(f.listeners.size).toBe(0); expect(f.time.size).toBe(0);
});

test("reappearance while old release is held waits for its acknowledgement before reacquisition", async () => {
  const f = fixture(), releaseGate = deferred<void>(); f.send = r => r.action === "release" ? releaseGate.promise : Promise.resolve();
  const off = f.retain(); await flush(); off(); await f.time.tick(250);
  f.retain(); await flush(); expect(f.calls.map(r => r.action)).toEqual(["retain", "release"]);
  releaseGate.resolve(); await flush(); expect(f.calls.map(r => r.action)).toEqual(["retain", "release", "retain"]);
});

test("a malformed owned status fails visibly and cannot manufacture readiness", async () => {
  const f = fixture(); f.retain(); await flush();
  f.event({ phase: "ready", error: "x".repeat(1001) }); expect(f.owner.getSnapshot()).toEqual({ phase: "failed", error: "Invalid repository watch response." });
  expect(f.listeners.size).toBe(0); await f.time.tick(1000); expect(f.calls.map(r => r.action)).toEqual(["retain", "release", "retain"]);
});

for (const phase of ["released", "failed"] as const) for (const held of [false, true]) test(`failure ${phase} re-entry waits1000ms and release acknowledgement (held=${held})`, async () => {
  const f = fixture(), gate = deferred<void>();
  cleanups.push(() => { gate.resolve(); }); // Unblock teardown even when an old-source assertion fails.
  let armed = false, reentered = false;
  f.owner.retain(view => {
    if (armed && view.phase === phase) {
      armed = false; reentered = true;
      f.retain(); // Synchronous outward observer re-entry, with start already settled.
    }
  });
  await flush(); const original = f.calls[0]!;
  f.send = request => request.action === "release" && held ? gate.promise : Promise.resolve();
  armed = true; f.event({ phase: "failed", error: "retry required" }); await flush();
  expect(reentered).toBe(true); expect(f.calls.map(r => r.action)).toEqual(["retain"]);
  await f.time.tick(999); expect(f.calls.map(r => r.action)).toEqual(["retain"]);
  await f.time.tick(1);
  if (held) {
    expect(f.calls.map(r => r.action)).toEqual(["retain", "release"]);
    gate.resolve(); await flush();
  }
  expect(f.calls.map(r => r.action)).toEqual(["retain", "release", "retain"]);
  expect(f.calls[2]!.subscriptionId).not.toBe(original.subscriptionId);
  f.event({ phase: "ready" }, original); expect(f.owner.getSnapshot().phase).toBe("connecting");
});

for (const end of ["observer-loss", "dispose"] as const) test(`failure re-entry cannot outlive ${end}`, async () => {
  const f = fixture(); let armed = false, offAdded: (() => void) | undefined, closing: Promise<void> | undefined;
  const off = f.owner.retain(view => {
    if (!armed || view.phase !== "released") return;
    armed = false; offAdded = f.retain();
    if (end === "dispose") closing = f.owner.dispose();
    else { off(); offAdded(); }
  });
  await flush(); armed = true; f.event({ phase: "failed" }); await flush();
  await f.time.tick(1000); await closing;
  expect(f.calls.map(r => r.action)).toEqual(["retain", "release"]);
  expect(f.listeners.size).toBe(0); expect(f.time.size).toBe(0);
});
