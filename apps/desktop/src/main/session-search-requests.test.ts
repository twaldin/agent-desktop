import { expect, test } from "bun:test";
import { SessionSearchRequests } from "./session-search-requests";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
test("replacement aborts only the same native window/host and late old cleanup cannot cancel the new request", async () => {
  const registry = new SessionSearchRequests(), old = deferred<number>(), current = deferred<number>(), foreign = deferred<number>();
  let oldSignal!: AbortSignal, currentSignal!: AbortSignal, foreignSignal!: AbortSignal;
  const first = registry.run(1, "host", "old", signal => { oldSignal = signal; return old.promise; });
  const firstOutcome = first.then(() => "returned", () => "cancelled");
  const other = registry.run(2, "host", "old", signal => { foreignSignal = signal; return foreign.promise; });
  const next = registry.run(1, "host", "new", signal => { currentSignal = signal; return current.promise; });
  registry.cancel(1, "host", "old");
  expect(oldSignal.aborted).toBe(true); expect(currentSignal.aborted).toBe(false); expect(foreignSignal.aborted).toBe(false);
  old.resolve(1); expect(await firstOutcome).toBe("cancelled");
  registry.cancel(1, "host", "new"); expect(currentSignal.aborted).toBe(true);
  const nextOutcome = next.then(() => "returned", () => "cancelled"); current.resolve(2); expect(await nextOutcome).toBe("cancelled");
  foreign.resolve(3); expect(await other).toBe(3);
});
test("closing one native window cancels its hosts without affecting another native window", async () => {
  const registry = new SessionSearchRequests(), wait = deferred<number>(), signals: AbortSignal[] = [];
  const calls = [[1, "a"], [1, "b"], [2, "a"]] as const;
  const pending = calls.map(([owner, host]) => registry.run(owner, host, "id", signal => { signals.push(signal); return wait.promise; }));
  const outcomes = pending.map(promise => promise.then(() => "returned", () => "cancelled"));
  registry.close(1); expect(signals.map(s => s.aborted)).toEqual([true, true, false]);
  wait.resolve(1); expect(await Promise.all(outcomes)).toEqual(["cancelled", "cancelled", "returned"]);
});
