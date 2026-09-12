import { expect, test } from "bun:test";
import type { BrowserMetadataSnapshot, NativeBrowserTabMetadata } from "@agent-desktop/shared";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, dockTabId, insertDockTab, type DockTab } from "./dock-state";
import { activateBrowserSearchTab, browserSearchEntries, browserSearchOwner, matchingBrowserTabs, readWindowBrowserMetadata, windowBrowserTabs } from "./command-browser-tabs";

function page(name: string, url: string) {
  const value = { kind: "browser" as const, hostId: "host", target: "session:conversation" as const,
    title: `Custom ${name}`, browserTarget: { workerPid: 12, name, targetId: `target-${name}` } };
  const tab: DockTab = { ...value, id: dockTabId(value) };
  const native: NativeBrowserTabMetadata = { name, targetId: `target-${name}`, state: "alive" as const, title: `Observed ${name}`, url,
    backend: "worker", kindTag: "headless" as const, viewport: { width: 800, height: 600 } };
  return { tab, native };
}
const observed = (tabs: NativeBrowserTabMetadata[]): BrowserMetadataSnapshot => ({ protocolVersion: 1,
  hostId: "host", sessionId: "conversation", availability: "running", workerPid: 12, tabs });
const map = (value: BrowserMetadataSnapshot) => new Map([[browserSearchOwner("host", "conversation"), value]]);

test("local NEW_TAB_PAGE cannot enter search through its title, unsent address or unrelated page metadata", async () => {
  const local = createBrowserNewTab("host", "conversation", "local");
  local.title = "Find this title"; local.browserNewTab!.draft = "https://secret.invalid/unsent";
  const unrelated = page("other", "https://example.com"), state = insertDockTab(createDockState(), local, "right");
  const before = structuredClone(local);
  expect(browserSearchEntries([local], map(observed([unrelated.native])))).toEqual([]);
  expect(windowBrowserTabs({ state, tabs: [local] })).toEqual([]);
  let reads = 0;
  await readWindowBrowserMetadata(windowBrowserTabs({ state, tabs: [local] }), new Set(["host"]), {
    getBrowserMetadata: async () => { reads++; return observed([unrelated.native]); },
  }, new AbortController().signal);
  expect(reads).toBe(0); expect(local).toEqual(before);
});

test("missing or empty observed URL cannot promote a native identity or custom title", () => {
  const item = page("saved", "");
  expect(browserSearchEntries([item.tab], new Map())).toEqual([]);
  expect(browserSearchEntries([item.tab], map(observed([item.native])))).toEqual([]);
  expect(browserSearchEntries([item.tab], map({ protocolVersion: 1, hostId: "host", sessionId: "conversation", availability: "unavailable", reason: "Not available" }))).toEqual([]);
});

test("real WEB about:blank and hidden native pages remain searchable in insertion order, without taking unsent drafts", () => {
  const blank = page("blank", "about:blank"), second = page("guide", "https://example.com/a+b");
  const state = insertDockTab(insertDockTab(createDockState(), second.tab, "bottom"), blank.tab, "right");
  state.right.open = false; state.bottom.open = false;
  const snapshot = { state, tabs: [blank.tab, second.tab] }, before = structuredClone(snapshot);
  const entries = browserSearchEntries(windowBrowserTabs(snapshot), map(observed([second.native, blank.native])));
  expect(entries.map(entry => entry.id)).toEqual([blank.tab.id, second.tab.id]);
  expect(matchingBrowserTabs(entries, "observed blank about:blank").map(entry => entry.id)).toEqual([blank.tab.id]);
  expect(matchingBrowserTabs(entries, "custom GUIDE a+b").map(entry => entry.id)).toEqual([second.tab.id]);
  const selected = activateBrowserSearchTab(snapshot, entries[1]!);
  expect(selected?.bottom.open).toBe(true); expect(selected?.bottom.activeTabId).toBe(second.tab.id);
  expect(selected?.right).toEqual(state.right); expect(snapshot).toEqual(before);
});

test("unrelated or malformed observed metadata cannot supply the page's search eligibility", () => {
  const item = page("owned", "https://example.com");
  for (const value of [
    { ...observed([item.native]), hostId: "foreign" }, { ...observed([item.native]), sessionId: "foreign" },
    { ...observed([item.native]), workerPid: 13 }, observed([{ ...item.native, targetId: "replacement" }]),
    observed([{ ...item.native, state: "dead" }]),
    observed([{ ...item.native, viewport: { width: 0, height: 0 } }]),
  ]) expect(browserSearchEntries([item.tab], map(value))).toEqual([]);
  // An inconsistent local-launcher/native-target combination is not a WEB snapshot.
  expect(browserSearchEntries([{ ...item.tab, browserNewTab: { status: "idle" } }], map(observed([item.native])))).toEqual([]);
});
