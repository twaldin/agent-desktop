import { expect, test } from "bun:test";
import type { BrowserMetadataSnapshot } from "@agent-desktop/shared";
import { browserSearchEntries, browserSearchOwner, matchingBrowserTabs, readWindowBrowserMetadata } from "./command-browser-tabs";
import { dockTabId, type DockTab } from "./dock-state";

function tab(session: string): DockTab {
  const value = { hostId: "home", target: `session:${session}` as const, kind: "browser" as const,
    title: "My custom research", browserTarget: { workerPid: 42, name: "page", targetId: session } };
  return { ...value, id: dockTabId(value) };
}

test("real metadata projection retains custom title alongside page title and URL in the literal corpus", () => {
  const item = tab("one");
  const metadata: BrowserMetadataSnapshot = { protocolVersion: 1, hostId: "home", sessionId: "one", availability: "running", workerPid: 42,
    tabs: [{ name: "page", targetId: "one", title: "Native guide", url: "https://example.com/docs", state: "alive", kindTag: "headless", backend: "worker", viewport: { width: 900, height: 700 } }] };
  const entries = browserSearchEntries([item], new Map([[browserSearchOwner("home", "one"), metadata]]));
  expect(matchingBrowserTabs(entries, "custom native docs").map(value => value.id)).toEqual([item.id]);
  expect(entries[0]).toMatchObject({ title: "My custom research", pageTitle: "Native guide", url: "https://example.com/docs" });
});

test("replacement rounds and bridges wait for uncancellable old reads; aborted queued rounds never dispatch", async () => {
  let active = 0, peak = 0;
  const calls: string[] = [], releases: Array<() => void> = [];
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  const makeBridge = () => ({ getBrowserMetadata: (session: string) => {
    calls.push(session); active++; peak = Math.max(peak, active);
    return new Promise<null>(resolve => releases.push(() => { active--; resolve(null); }));
  } });
  const owners = (prefix: string) => Array.from({ length: 5 }, (_, i) => tab(`${prefix}${i}`));
  const rounds: Array<Promise<Map<string, BrowserMetadataSnapshot>>> = [];
  try {
    rounds.push(readWindowBrowserMetadata(owners("old"), new Set(["home"]), makeBridge(), controllers[0]!.signal));
    expect(calls).toEqual(["old0", "old1", "old2", "old3"]);
    controllers[0]!.abort();
    rounds.push(readWindowBrowserMetadata(owners("discard"), new Set(["home"]), makeBridge(), controllers[1]!.signal));
    controllers[1]!.abort();
    rounds.push(readWindowBrowserMetadata(owners("new"), new Set(["home"]), makeBridge(), controllers[2]!.signal));
    expect(calls).toHaveLength(4);
    releases.shift()!();
    // Promise-only scheduling: no timers, IPC, DOM or application runtime.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(calls).toEqual(["old0", "old1", "old2", "old3", "new0"]);
    expect(active).toBe(4);
    expect(peak).toBe(4);
  } finally {
    controllers.forEach(controller => controller.abort());
    releases.splice(0).forEach(release => release());
    await Promise.all(rounds);
  }
  expect(active).toBe(0);
  expect(calls.some(value => value.startsWith("discard"))).toBe(false);
  expect(calls).not.toContain("old4");
});

test("metadata rejection releases its slot to another round", async () => {
  const controller = new AbortController();
  const failures: Array<() => void> = [];
  const first = readWindowBrowserMetadata(Array.from({ length: 4 }, (_, i) => tab(`fail${i}`)), new Set(["home"]), {
    getBrowserMetadata: () => new Promise((_, reject) => failures.push(() => reject(new Error("read failed")))),
  }, controller.signal);
  const calls: string[] = [];
  const next = readWindowBrowserMetadata([tab("next")], new Set(["home"]), {
    getBrowserMetadata: async session => { calls.push(session); return null; },
  }, new AbortController().signal);
  try { expect(calls).toHaveLength(0); }
  finally { controller.abort(); failures.forEach(fail => fail()); await Promise.all([first, next]); }
  expect(calls).toEqual(["next"]);
});
