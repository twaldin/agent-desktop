import { expect, test } from "bun:test";
import type { BrowserMetadataSnapshot, DesktopBridge } from "@agent-desktop/shared";
import { activateBrowserSearchTab, browserSearchEntries, browserSearchIdentity, browserSearchOwner, matchingBrowserTabs, nextCommandSearchSection, readWindowBrowserMetadata, windowBrowserTabs } from "./command-browser-tabs";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, dockTabId, insertDockTab, type DockTab } from "./dock-state";

function tab(hostId = "home", sessionId = "one", name = "page"): DockTab {
  const value = { hostId, target: `session:${sessionId}` as const, kind: "browser" as const, title: "Saved title", browserTarget: { workerPid: 42, name, targetId: name } };
  return { ...value, id: dockTabId(value) };
}
function metadata(value: DockTab, title = "Native page", url = "https://example.com/docs"): Extract<BrowserMetadataSnapshot, { availability: "running" }> {
  return { hostId: value.hostId, sessionId: value.target.slice(8), protocolVersion: 1, availability: "running", workerPid: 42,
    tabs: [{ name: value.browserTarget!.name, targetId: value.browserTarget!.targetId, title, url, state: "alive", kindTag: "headless", backend: "worker", viewport: { width: 900, height: 700 } }] };
}

test("local New tabs stay out of page search without reading native metadata", async () => {
  const item = createBrowserNewTab("home", "one", "local-search");
  item.browserNewTab!.draft = "https://private.example/unsent";
  const state = insertDockTab(createDockState(), item, "bottom");
  state.bottom.open = false;
  const tabs = windowBrowserTabs({ state, tabs: [item] });
  expect(tabs).toEqual([]);
  let calls = 0;
  const observed = await readWindowBrowserMetadata(tabs, new Set(["home"]), {
    getBrowserMetadata: async () => { calls++; return null; },
  }, new AbortController().signal);
  expect(calls).toBe(0);
  const entries = browserSearchEntries(tabs, observed);
  expect(entries).toEqual([]);
  expect(matchingBrowserTabs(entries, "new tab")).toHaveLength(0);
  expect(matchingBrowserTabs(entries, "private.example")).toHaveLength(0);
  expect(state.bottom.open).toBe(false);
});

test("search observation changes on stable-ID materialization, not on local draft editing", async () => {
  const item = createBrowserNewTab("home", "one", "local-materialization");
  const initial = browserSearchIdentity([item]);
  item.browserNewTab!.draft = "example.com";
  expect(browserSearchIdentity([item])).toBe(initial);
  const { browserNewTab: _newTab, ...rest } = item;
  const materialized: DockTab = { ...rest, browserTarget: tab().browserTarget };
  expect(dockTabId(materialized)).toBe(item.id);
  expect(browserSearchIdentity([materialized])).not.toBe(initial);
  let calls = 0;
  const values = await readWindowBrowserMetadata([materialized], new Set(["home"]), {
    getBrowserMetadata: async () => { calls++; return metadata(materialized); },
  }, new AbortController().signal);
  expect(calls).toBe(1);
  expect(browserSearchEntries([materialized], values)[0]).toMatchObject({ id: item.id, pageTitle: "Native page", url: "https://example.com/docs" });
});

test("window browser inventory keeps insertion order and hidden docks, omits unattached and malformed identities", () => {
  const first = tab(), second = tab("work"), unattached = tab("other");
  const state = insertDockTab(insertDockTab(createDockState(), second, "bottom"), first, "right");
  state.right.open = false; state.bottom.open = false;
  const snapshot = { state, tabs: [first, second, unattached, { ...first, id: "forged" }] };
  expect(windowBrowserTabs(snapshot).map(item => item.id)).toEqual([first.id, second.id]);
  const before = JSON.stringify(snapshot);
  const entry = browserSearchEntries([second], new Map([[browserSearchOwner(second.hostId, "one"), metadata(second)]]))[0]!;
  const next = activateBrowserSearchTab(snapshot, entry)!;
  expect(next.bottom.open).toBe(true); expect(next.bottom.activeTabId).toBe(second.id);
  expect(next.right).toEqual(state.right); expect(next.bottom.tabIds).toEqual(state.bottom.tabIds);
  expect(JSON.stringify(snapshot)).toBe(before);
  expect(activateBrowserSearchTab(snapshot, { ...entry, hostId: "home" })).toBeUndefined();
  expect(activateBrowserSearchTab({ state, tabs: [first] }, entry)).toBeUndefined();
});

test("metadata cannot retarget a dock identity or leak another owner or worker's URL", () => {
  const item = tab(), key = browserSearchOwner(item.hostId, "one"), own = metadata(item);
  const read = (value: BrowserMetadataSnapshot) => browserSearchEntries([item], new Map([[key, value]]))[0]!;
  expect(read(own)).toMatchObject({ title: "Saved title", pageTitle: "Native page", url: "https://example.com/docs", detailsUnavailable: false });
  for (const value of [{ ...own, hostId: "foreign" }, { ...own, sessionId: "foreign" }, { ...own, workerPid: 43 },
    { ...own, tabs: [{ ...own.tabs[0]!, targetId: "replaced" }] }, { ...own, tabs: [{ ...own.tabs[0]!, state: "dead" as const }] }]) {
    expect(read(value)).toBeUndefined();
  }
});

test("browser matching is AND of literal lowercase words across title/page/URL, preserves order, caps ten", () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ id: String(i), hostId: "home", sessionId: "one", title: `Custom ${i}`, pageTitle: "Native Guide", url: "https://example.com/a+b", detailsUnavailable: false }));
  expect(matchingBrowserTabs(entries, "  GUIDE\tEXAMPLE custom ").map(item => item.id)).toEqual(entries.slice(0, 10).map(item => item.id));
  expect(matchingBrowserTabs(entries, "a+b")).toHaveLength(10);
  expect(matchingBrowserTabs(entries, "ngd")).toHaveLength(0);
  expect(matchingBrowserTabs(entries, " ")).toHaveLength(0);
  expect(matchingBrowserTabs(entries, "guide missing")).toHaveLength(0);
});

test("metadata reads dedupe by full owner and skip offline hosts without creating tabs", async () => {
  const a = tab(), a2 = tab("home", "one", "second"), b = tab("work"), off = tab("offline");
  const calls: string[] = [];
  const bridge: Pick<DesktopBridge, "getBrowserMetadata"> = { getBrowserMetadata: async (session, host) => {
    calls.push(browserSearchOwner(host!, session));
    return host === "home" ? metadata(a) : { ...metadata(b), hostId: "foreign" };
  } };
  const result = await readWindowBrowserMetadata([a, a2, b, off], new Set(["home", "work"]), bridge, new AbortController().signal);
  expect(calls).toEqual([browserSearchOwner("home", "one"), browserSearchOwner("work", "one")]);
  expect([...result.keys()]).toEqual([browserSearchOwner("home", "one")]);
});

test("closing search stops further read admission and discards already-sent metadata, maximum four at once", async () => {
  const tabs = Array.from({ length: 7 }, (_, i) => tab("home", String(i))), controller = new AbortController();
  const releases: Array<() => void> = [], calls: string[] = [];
  const pending = readWindowBrowserMetadata(tabs, new Set(["home"]), { getBrowserMetadata: (session) => {
    calls.push(session);
    return new Promise(resolve => releases.push(() => resolve(metadata(tabs[Number(session)]!))));
  } }, controller.signal);
  expect(calls).toEqual(["0", "1", "2", "3"]);
  controller.abort(); releases.forEach(release => release());
  expect((await pending).size).toBe(0); expect(calls).toHaveLength(4);
});

test("unsupported metadata cannot promote a saved identity into page search", async () => {
  const item = tab();
  const values = await readWindowBrowserMetadata([item], new Set(["home"]), { getBrowserMetadata: async () => null }, new AbortController().signal);
  expect(values.size).toBe(0);
  expect(browserSearchEntries([item], values)).toEqual([]);
});

test("section cycling starts from first/last after query reset, then follows selected section", () => {
  const values = ["chat:one", "browser:one"];
  expect(nextCommandSearchSection(values, 1, false, false)).toBe("chat:one");
  expect(nextCommandSearchSection(values, 0, false, true)).toBe("browser:one");
  expect(nextCommandSearchSection(values, 0, true, false)).toBe("browser:one");
  expect(nextCommandSearchSection(values, 1, true, false)).toBe("chat:one");
  expect(nextCommandSearchSection(values, 0, true, true)).toBe("browser:one");
  expect(nextCommandSearchSection(values, -1, true, false)).toBe("chat:one");
  expect(nextCommandSearchSection(["browser:one"], 0, true, false)).toBeUndefined();
  expect(nextCommandSearchSection([], -1, false, true)).toBeUndefined();
});
