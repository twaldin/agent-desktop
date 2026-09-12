import { expect, test } from "bun:test";
import { DefaultBranchCache } from "./default-branch-cache";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test("default dependencies preserve null/false and invalidate only their matching tags", async () => {
  const cache = new DefaultBranchCache(), calls = { ordered: 0, local: 0, advertised: 0, branch: 0 };
  const read = () => Promise.all([
    cache.orderedRemotes("/repo", "identity", async () => { calls.ordered++; return ["origin"]; }),
    cache.localDefault("/repo", "identity", "origin", async () => { calls.local++; return null; }),
    cache.advertisedDefault("/repo", "identity", "origin", async () => { calls.advertised++; return null; }),
    cache.remoteBranch("/repo", "identity", "origin", "main", async () => { calls.branch++; return false; }),
  ]);
  try {
    expect(await read()).toEqual([["origin"], null, null, false]);
    for (const kind of ["head", "index", "local-refs", "working-tree", "worktree-topology"] as const) { cache.invalidate("/repo", kind); await read(); }
    expect(calls).toEqual({ ordered: 1, local: 1, advertised: 1, branch: 1 });
    cache.invalidate("/repo", "remote-refs"); await read();
    expect(calls).toEqual({ ordered: 1, local: 2, advertised: 2, branch: 2 });
    cache.invalidate("/repo", "config"); await read();
    expect(calls).toEqual({ ordered: 2, local: 3, advertised: 3, branch: 3 });
    cache.invalidate("/repo"); await read();
    expect(calls).toEqual({ ordered: 3, local: 4, advertised: 4, branch: 4 });
  } finally { await cache.dispose(); }
});

test("same-identity pending dependencies survive matching and full invalidation, then finish fresh", async () => {
  for (const kind of ["config", "remote-refs", undefined] as const) {
    const cache = new DefaultBranchCache(), gate = deferred<string | null>(); let calls = 0;
    const read = () => cache.advertisedDefault("/repo", "identity", "origin", () => { calls++; return gate.promise; });
    const first = read(); cache.invalidate("/repo", kind); const joined = read();
    gate.resolve("prior-result");
    expect(await Promise.all([first, joined])).toEqual(["prior-result", "prior-result"]);
    expect(await read()).toBe("prior-result"); expect(calls).toBe(1);
    cache.invalidate("/repo", kind); expect(await read()).toBe("prior-result"); expect(calls).toBe(2);
    await cache.dispose();
  }
});

test("default dependency keys distinguish method, remote and branch without slash collisions", async () => {
  const cache = new DefaultBranchCache();
  try {
    expect(await cache.localDefault("/repo", "id", "origin", async () => "local")).toBe("local");
    expect(await cache.advertisedDefault("/repo", "id", "origin", async () => "advertised")).toBe("advertised");
    expect(await cache.remoteBranch("/repo", "id", "origin/team", "main", async () => true)).toBe(true);
    expect(await cache.remoteBranch("/repo", "id", "origin", "team/main", async () => false)).toBe(false);
    expect(await cache.localDefault("/repo", "id", "other", async () => "other")).toBe("other");
  } finally { await cache.dispose(); }
});

test("observed repository replacement fences old fills; roots and host instances remain separate", async () => {
  const cache = new DefaultBranchCache(), otherHost = new DefaultBranchCache(), old = deferred<string | null>();
  const first = cache.localDefault("/repo", "old", "origin", () => old.promise);
  try {
    expect(await cache.localDefault("/repo", "new", "origin", async () => "new")).toBe("new");
    expect(await cache.localDefault("/other", "new", "origin", async () => "other")).toBe("other");
    expect(await otherHost.localDefault("/repo", "new", "origin", async () => "host")).toBe("host");
    old.resolve("old"); expect(await first).toBe("old");
    expect(await cache.localDefault("/repo", "new", "origin", async () => "wrong")).toBe("new");
  } finally { old.resolve("old"); await cache.dispose(); await otherHost.dispose(); }
});

test("one canceled caller cannot cancel a shared dependency or corrupt another caller's array", async () => {
  const cache = new DefaultBranchCache(), gate = deferred<string[]>(), abort = new AbortController();
  let sentSignal: AbortSignal | undefined, calls = 0;
  const load = (signal: AbortSignal) => { sentSignal = signal; calls++; return gate.promise; };
  const first = cache.orderedRemotes("/repo", "id", load, abort.signal);
  const second = cache.orderedRemotes("/repo", "id", load);
  await Promise.resolve(); abort.abort(); const producer = ["origin"]; gate.resolve(producer);
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  const delivered = await second; delivered.push("caller"); producer.push("producer");
  expect(await cache.orderedRemotes("/repo", "id", load)).toEqual(["origin"]);
  expect(sentSignal?.aborted).toBe(false); expect(calls).toBe(1); await cache.dispose();
});

test("operational failures remain errors and stop awaits an uncooperative sent read", async () => {
  const cache = new DefaultBranchCache(); let calls = 0;
  const failing = () => cache.localDefault("/repo", "id", "origin", async () => { calls++; throw new Error("timeout"); });
  await expect(failing()).rejects.toThrow("timeout"); await expect(failing()).rejects.toThrow("timeout"); expect(calls).toBe(2);
  const gate = deferred<string | null>(); let sentSignal: AbortSignal | undefined, stopped = false;
  const pending = cache.advertisedDefault("/repo", "id", "origin", signal => { sentSignal = signal; return gate.promise; });
  await Promise.resolve(); const shutdown = cache.dispose().then(() => { stopped = true; });
  await Promise.resolve(); expect(sentSignal?.aborted).toBe(true); expect(stopped).toBe(false);
  await expect(cache.localDefault("/repo", "id", "origin", async () => "never")).rejects.toMatchObject({ name: "AbortError" });
  gate.resolve("completed"); await pending; await shutdown; expect(stopped).toBe(true);
});
