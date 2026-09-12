import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserMetadataSnapshot } from "@agent-desktop/shared";
import { WindowStateStore } from "../main/window-state";
import { defaultWindowView, parseWindowView } from "../window-state";
import { parseSessionBrowserObservations, type SessionBrowserObservation } from "../session-browser-observation";
import { BrowserSearchRegistry } from "./browser-search-registry";
import { browserSearchOwner, matchingBrowserTabs } from "./command-browser-tabs";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, dockTabId, hideDock, insertDockTab, type DockTab } from "./dock-state";
import { reconcileDockPresentations, type DockPresentations } from "./dock-presentations";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), "browser-search-history-")); directories.push(directory); return directory; };
const connected = new Set(["host"]);
function tab(): DockTab {
  const { browserNewTab: _local, ...value } = createBrowserNewTab("host", "session", "page");
  return { ...value, title: "Custom label", browserTarget: { workerPid: 12, name: "page", targetId: "native" } };
}
function layout(items = [tab()], previous?: DockPresentations, seed = "initial") {
  let state = createDockState(); for (const item of items) state = insertDockTab(state, item, "right");
  return reconcileDockPresentations(previous, { tabs: items, state: hideDock(state, "right") }, seed);
}
function metadata(url = "https://example.com/observed"): BrowserMetadataSnapshot {
  return { protocolVersion: 1, hostId: "host", sessionId: "session", availability: "running", workerPid: 12,
    tabs: [{ name: "page", targetId: "native", state: "alive", title: "Observed guide", url, backend: "worker", kindTag: "headless", viewport: { width: 800, height: 600 } }] };
}
const publish = (registry: BrowserSearchRegistry, value = metadata()) => registry.read().publish(new Map([[browserSearchOwner("host", "session"), value]]));
function observed() {
  const presentations = layout(), registry = new BrowserSearchRegistry(); registry.commit(presentations); publish(registry);
  return { presentations, registry, history: registry.persisted(presentations) };
}
const view = (presentations: DockPresentations, history: SessionBrowserObservation[]) => ({ ...defaultWindowView(), dock: presentations.snapshot, sessionBrowserObservations: history });

test("actual window save/reopen preserves observed session text and initial render save without native readiness", () => {
  const s = observed(), directory = temporary(), store = new WindowStateStore(directory, "primary");
  expect(store.saveView(view(s.presentations, s.history))).toEqual({});
  const restored = new WindowStateStore(directory, "primary").bootstrap().state!;
  expect(restored.sessionBrowserObservations?.[0]).toMatchObject({ hostId: "host", sessionId: "session", pageTitle: "Observed guide", url: "https://example.com/observed", target: { workerPid: 12, name: "page", targetId: "native" } });
  const registry = new BrowserSearchRegistry(restored.sessionBrowserObservations), next = reconcileDockPresentations(undefined, restored.dock!, "new-window");
  // Persistence is read during render, before the registry's first layout commit.
  expect(registry.persisted(next)).toEqual(s.history);
  expect(new WindowStateStore(directory, "primary").saveView(view(next, registry.persisted(next)))).toEqual({});
  registry.commit(next);
  expect(matchingBrowserTabs(registry.entries(next, new Set()), "custom observed example.com")[0]).toMatchObject({ detailsUnavailable: true, url: "https://example.com/observed" });
  expect(registry.entries(next, connected)[0]?.detailsUnavailable).toBe(true);
  expect(registry.entries(next, connected)[0]?.sourceKey).not.toBe(s.registry.entries(s.presentations, connected)[0]?.sourceKey);
  expect(new WindowStateStore(directory, "primary").bootstrap().state?.sessionBrowserObservations).toEqual(s.history);
});

test("window slots isolate observation history and malformed binding refuses save without losing prior bytes", () => {
  const s = observed(), directory = temporary(), store = new WindowStateStore(directory, "primary"), original = view(s.presentations, s.history);
  expect(store.saveView(original)).toEqual({}); const bytes = readFileSync(store.file);
  const variants: unknown[] = [
    [{ ...s.history[0]!, hostId: "foreign" }], [{ ...s.history[0]!, sessionId: "other" }],
    [{ ...s.history[0]!, target: { ...s.history[0]!.target, workerPid: 13 } }],
    [{ ...s.history[0]!, target: { ...s.history[0]!.target, name: "replacement" } }],
    [{ ...s.history[0]!, target: { ...s.history[0]!.target, targetId: "replacement" } }],
    [{ ...s.history[0]!, tabId: "another" }], [s.history[0], s.history[0]],
    [{ ...s.history[0]!, url: "" }], [{ ...s.history[0]!, pageTitle: "a".repeat(1_025) }],
    [{ ...s.history[0]!, token: "not-a-search-field" }], [{ ...s.history[0]!, target: { ...s.history[0]!.target, workerPid: 0 } }],
  ];
  for (const sessionBrowserObservations of variants) {
    expect(store.saveView({ ...original, sessionBrowserObservations }).error).toContain("invalid");
    expect(readFileSync(store.file)).toEqual(bytes);
    expect(store.bootstrap().state?.sessionBrowserObservations).toEqual(s.history);
  }
  expect(store.saveView({ ...original, dock: undefined }).error).toContain("invalid");
  const second = new WindowStateStore(directory, "second"); expect(second.saveView(defaultWindowView())).toEqual({});
  expect(new WindowStateStore(directory, "second").bootstrap().state?.sessionBrowserObservations).toBeUndefined();
  expect(new WindowStateStore(directory, "primary").bootstrap().state?.sessionBrowserObservations).toEqual(s.history);
});

test("bootstrap history binds once to exact native identity and never seeds later reopened or retargeted presentation", () => {
  const s = observed();
  for (const items of [[], [{ ...tab(), browserTarget: { ...tab().browserTarget!, workerPid: 99 } }]]) {
    const registry = new BrowserSearchRegistry(s.history), wrong = layout(items);
    expect(registry.persisted(wrong)).toEqual([]); registry.commit(wrong); expect(registry.entries(wrong, connected)).toEqual([]);
    const returned = layout([tab()], wrong, "return"); registry.commit(returned); expect(registry.entries(returned, connected)).toEqual([]);
  }
  const registry = new BrowserSearchRegistry(s.history), original = layout(); registry.commit(original);
  const empty = layout([], original, "close"); registry.commit(empty);
  const reopened = layout([tab()], empty, "reopen"); registry.commit(reopened);
  expect(registry.entries(reopened, connected)).toEqual([]); expect(registry.persisted(reopened)).toEqual([]);
  publish(registry); expect(registry.entries(reopened, connected)[0]?.detailsUnavailable).toBe(false);
});

test("live refresh updates persistence; failed refresh retains text and confirmed absence clears only that observation", () => {
  const s = observed(), directory = temporary(), store = new WindowStateStore(directory, "primary"), registry = new BrowserSearchRegistry(s.history);
  registry.commit(s.presentations); publish(registry, metadata("https://example.com/new")); registry.read().publish(new Map());
  expect(registry.persisted(s.presentations)[0]?.url).toBe("https://example.com/new");
  expect(store.saveView(view(s.presentations, registry.persisted(s.presentations)))).toEqual({});
  expect(new WindowStateStore(directory, "primary").bootstrap().state?.sessionBrowserObservations?.[0]?.url).toBe("https://example.com/new");
  const missing = metadata(); if (missing.availability !== "running") throw new Error("Fixture must be running"); missing.tabs = [];
  publish(registry, missing); expect(registry.persisted(s.presentations)[0]?.url).toBe("https://example.com/new");
  const read = registry.read(), selected = read.targets[0]!;
  read.publish(new Map(), new Map(), new Map([[selected.key, { protocolVersion: 1, hostId: selected.hostId, owner: selected.owner,
    ...selected.target, ownerId: selected.owner.kind === "session" ? selected.owner.sessionId : selected.owner.ownerId, kindTag: "headless", presence: "absent" }]]));
  expect(registry.persisted(s.presentations)).toEqual([]);
  expect(store.saveView(view(s.presentations, registry.persisted(s.presentations)))).toEqual({});
  const restored = new WindowStateStore(directory, "primary").bootstrap().state!;
  expect(restored.sessionBrowserObservations).toEqual([]); expect(restored.dock?.tabs).toEqual(s.presentations.snapshot.tabs);
  const next = new BrowserSearchRegistry(restored.sessionBrowserObservations); next.commit(s.presentations); expect(next.entries(s.presentations, connected)).toEqual([]);
});

test("render-only projections cannot mutate committed history and inputs/outputs do not share native identity objects", () => {
  const s = observed(), incoming = structuredClone(s.history), registry = new BrowserSearchRegistry(incoming);
  incoming[0]!.target.workerPid = 42; incoming[0]!.url = "https://caller.invalid";
  registry.persisted(layout([])); registry.commit(s.presentations);
  const saved = registry.persisted(s.presentations); saved[0]!.target.targetId = "caller"; saved[0]!.url = "https://caller.invalid";
  expect(registry.persisted(s.presentations)).toEqual(s.history);
  const mismatched = layout([{ ...tab(), browserTarget: { ...tab().browserTarget!, targetId: "replacement" } }], s.presentations);
  expect(registry.persisted(mismatched)).toEqual([]); expect(registry.persisted(s.presentations)).toEqual(s.history);
});

test("valid maximum native identity, URL and empty title survive; unknown keys and excess count reject", () => {
  const item = { ...tab(), browserInstanceId: undefined, browserTarget: { workerPid: Number.MAX_SAFE_INTEGER, name: "漢".repeat(200), targetId: "字".repeat(200) } };
  item.id = dockTabId(item);
  const history: SessionBrowserObservation[] = [{ version: 1, tabId: item.id, hostId: "host", sessionId: "session", target: item.browserTarget, pageTitle: "", url: "a".repeat(8_192) }];
  const value = view(layout([item]), history); expect(parseWindowView(value)?.sessionBrowserObservations).toEqual(history);
  expect(() => parseSessionBrowserObservations(Array(101).fill(history[0]))).toThrow("Invalid saved browser observations");
  expect(parseWindowView({ ...defaultWindowView(), sessionBrowserObservations: [] })?.sessionBrowserObservations).toEqual([]);
  expect(parseWindowView({ ...defaultWindowView(), sessionBrowserObservations: history })).toBeUndefined();
  const local = createBrowserNewTab("host", "session", "page");
  expect(parseWindowView(view(layout([local]), [{ ...history[0]!, tabId: local.id }]))).toBeUndefined();
});
