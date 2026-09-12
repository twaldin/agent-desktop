import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopBridge, NativeBrowserTabMetadata } from "@agent-desktop/shared";
import { browserCloseIdentity } from "../../../../packages/shared/src/browser-close";
import { parseBrowserCloseWindowIntent, type BrowserCloseWindowIntent } from "../browser-close-window-intent";
import { BrowserCloseWindowOwner } from "./browser-close-window-owner";
import { BrowserCloseDockOwner } from "./browser-close-dock-owner";
import { BrowserCloseCheckpoint } from "./browser-close-checkpoint";
import { WindowStateStore } from "../main/window-state";
import { defaultWindowView, type WindowViewState } from "../window-state";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab } from "./dock-state";
import { captureDockPresentation, reconcileDockPresentations } from "./dock-presentations";
const SelectedWindowOwner: typeof BrowserCloseWindowOwner = process.env.BROWSER_CLOSE_HISTORY_OWNER_SOURCE
  ? (await import(process.env.BROWSER_CLOSE_HISTORY_OWNER_SOURCE)).BrowserCloseWindowOwner : BrowserCloseWindowOwner;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function intent(id: string, outcome?: "completed" | "rejected" | "unknown"): BrowserCloseWindowIntent {
  const value: BrowserCloseWindowIntent = { version: 1, hostId: "host", owner: { kind: "session", sessionId: "session" },
    source: { hostId: "host", target: "session:session", tabId: `tab-${id}`, instanceId: `instance-${id}`, kind: "browser", destination: "right" },
    request: { requestId: id, controlEpoch: "epoch", observedAt: 1, target: { workerPid: 50, name: "page", targetId: "target" } } };
  if (outcome) value.receipt = outcome === "completed" ? { ...browserCloseIdentity(value.hostId, value.owner, value.request), outcome, released: true }
    : { ...browserCloseIdentity(value.hostId, value.owner, value.request), outcome, message: "Recorded host result" };
  return parseBrowserCloseWindowIntent(value);
}
function fixture(history: BrowserCloseWindowIntent[]) {
  const dir = mkdtempSync(join(tmpdir(), "close-history-")), store = new WindowStateStore(dir, "primary");
  const events: string[] = []; let changes = 0;
  const tab: NativeBrowserTabMetadata = { name: "page", targetId: "target", state: "alive", backend: "worker", kindTag: "headless", url: "https://example.com", viewport: { width: 800, height: 600 } };
  const held = Promise.withResolvers<void>(); let hold = false;
  const bridge: Pick<DesktopBridge, "browserClose" | "getBrowserMetadata"> = {
    getBrowserMetadata: async (sessionId, hostId) => { events.push("metadata"); if (hold) await held.promise; return { protocolVersion: 1, hostId: hostId!, sessionId, availability: "running", workerPid: 50, tabs: [tab], creationTicket: { controlEpoch: "epoch", observedAt: 1 } }; },
    browserClose: {
      close: async (owner, request, hostId) => { events.push("close"); return { ...browserCloseIdentity(hostId, owner, request), outcome: "completed", released: true }; },
      status: async () => { events.push("status"); throw new Error("Unexpected status"); },
    },
  };
  const manager = new SelectedWindowOwner(bridge, history, () => changes++);
  const view = (): WindowViewState => ({ ...defaultWindowView(), route: { hostId: "other-host", sessionId: "unrelated-route" }, expandedProjects: ["other-host:project"], browserCloses: manager.intents });
  const commit = () => manager.committed(view());
  const save = () => { commit(); const value = view(); expect(store.saveView(value)).toEqual({}); manager.saved(store.bootstrap().state!); };
  const selection = { source: intent("fresh").source, owner: intent("fresh").owner, target: intent("fresh").request.target, isCurrent: () => true };
  cleanup.push(() => { manager.dispose(); held.resolve(); rmSync(dir, { recursive: true, force: true }); }); commit();
  return { manager, events, changes: () => changes, view, save, commit, selection, bridge, held,
    holdMetadata: () => { hold = true; }, disk: () => new WindowStateStore(dir, "primary").bootstrap().state! };
}
test.each(["completed", "rejected"] as const)("explicit %s retirement waits for exact reduced history save", async outcome => {
  const original = intent("closed", outcome), sibling = intent("unresolved"), f = fixture([original, sibling]);
  expect(f.manager.canRetire(original)).toBe(false); f.save(); expect(f.manager.canRetire(original)).toBe(true);
  let settled = false; const retirement = f.manager.retire(original).then(value => { settled = true; return value; }); await tick();
  expect(settled).toBe(false); expect(f.manager.intents).toEqual([sibling]); expect(f.disk().browserCloses).toEqual([original, sibling]);
  f.save(); expect((await retirement).retired).toBe(true); expect(f.disk().browserCloses).toEqual([sibling]);
  expect(f.disk().route.sessionId).toBe("unrelated-route"); expect(f.events).toEqual([]);
});
test.each(["pending", "unknown"] as const)("%s record is never retirement authority", outcome => {
  const original = intent("uncertain", outcome === "pending" ? undefined : outcome), f = fixture([original]); f.save();
  expect(f.manager.canRetire(original)).toBe(false);
  return f.manager.retire(original).then(result => { expect(result.retired).toBe(false); expect(f.manager.intents).toEqual([original]); expect(f.events).toEqual([]); });
});
test("caller cannot substitute a completed receipt for an original unknown result", async () => {
  const unknown = intent("request", "unknown"), forged = intent("request", "completed"), f = fixture([unknown]); f.save();
  expect((await f.manager.retire(forged)).retired).toBe(false); expect(f.manager.intents).toEqual([unknown]); expect(f.disk().browserCloses).toEqual([unknown]);
});
test("100 retained rows gain capacity only through explicit confirmed retirement; all unknown rows survive", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => intent(`request-${i}`, i === 0 ? "completed" : "unknown")), f = fixture(rows); f.save();
  expect((await f.manager.close(f.selection)).status).toBe("retained"); expect(f.manager.intents).toHaveLength(100); expect(f.events).toEqual(["metadata"]);
  const retirement = f.manager.retire(rows[0]!); f.save(); expect((await retirement).retired).toBe(true);
  const close = f.manager.close(f.selection); await tick(); f.save(); await tick(); f.save(); const result = await close;
  expect(result.status).toBe("completed"); expect(f.manager.intents).toHaveLength(100); expect(f.manager.intents.slice(0, 99)).toEqual(rows.slice(1));
  expect(f.events).toEqual(["metadata", "metadata", "close"]); expect(f.disk().browserCloses).toHaveLength(100);
});
test("save failure restores the known record for a later save, without claiming rollback", async () => {
  const original = intent("closed", "completed"), unknown = intent("other"), f = fixture([original, unknown]); f.save();
  const retirement = f.manager.retire(original); f.commit(); f.manager.failed("Directory acknowledgement failed");
  const result = await retirement; expect(result.retired).toBe(false); expect(result.message).toBe("Directory acknowledgement failed");
  expect(f.manager.intents).toEqual([original, unknown]); expect(f.manager.canRetire(original)).toBe(false);
  f.save(); expect(f.manager.canRetire(original)).toBe(true); expect(f.disk().browserCloses).toEqual([original, unknown]); expect(f.events).toEqual([]);
});
test("sibling projection loss rejects retirement and retains original unresolved knowledge", async () => {
  const original = intent("closed", "completed"), unknown = intent("unresolved"), f = fixture([original, unknown]); f.save();
  const retirement = f.manager.retire(original); f.manager.committed({ ...f.view(), browserCloses: [] });
  expect((await retirement).retired).toBe(false); expect(f.manager.intents).toEqual([original, unknown]); expect(f.disk().browserCloses).toEqual([original, unknown]);
});
test("retirement serializes against active Close and other retirement/status without dispatch", async () => {
  const original = intent("closed", "completed"), other = intent("other", "rejected"), f = fixture([original, other]); f.save();
  f.holdMetadata(); const close = f.manager.close(f.selection); await tick(); expect((await f.manager.retire(original)).retired).toBe(false);
  f.manager.dispose(); f.held.resolve(); await close;
  const g = fixture([original, other]); g.save(); const first = g.manager.retire(original);
  expect((await g.manager.retire(other)).retired).toBe(false); expect((await g.manager.close(g.selection)).status).toBe("retained");
  expect((await g.manager.inspect(other, () => true)).status).toBe("retained"); expect(g.events).toEqual([]);
  g.save(); expect((await first).retired).toBe(true); expect(g.manager.intents).toEqual([other]);
});
test("quiet save acknowledgement updates eligibility once, without a save/render notification loop", () => {
  const original = intent("closed", "completed"), f = fixture([original]); const before = f.changes(); f.save();
  expect(f.changes()).toBe(before + 1); expect(f.manager.canRetire(original)).toBe(true);
  f.save(); f.save(); expect(f.changes()).toBe(before + 1);
});
test("checkpoint retirement rejects late old ACK, return-after-drop and abort", async () => {
  const original = intent("closed", "completed"), unknown = intent("unknown"), previous = { ...defaultWindowView(), browserCloses: [original, unknown] }, next = { ...previous, browserCloses: [unknown] };
  for (const kind of ["old-save", "return", "abort"] as const) {
    const checkpoint = new BrowserCloseCheckpoint(), cancellation = new AbortController(); checkpoint.committed(previous); checkpoint.saved(previous);
    const outcome = checkpoint.waitRemoval(original, cancellation.signal).then(() => "ack", error => error.message as string);
    checkpoint.committed(next);
    if (kind === "old-save") checkpoint.saved(previous);
    if (kind === "return") checkpoint.committed(previous);
    if (kind === "abort") cancellation.abort();
    expect(await outcome).not.toBe("ack"); checkpoint.dispose();
  }
});
test("App coordinator offers completed dismissal only after its tab is absent", async () => {
  const tab = createBrowserNewTab("host", "session", "page"), presentations = reconcileDockPresentations(undefined, { state: insertDockTab(createDockState(), tab, "right"), tabs: [tab] }, "original");
  const row = { ...intent("request", "completed"), source: captureDockPresentation(presentations, tab.id)! };
  const f = fixture([]), manager = new BrowserCloseDockOwner(f.bridge, [row], () => {}, () => { throw new Error("Unexpected tab removal"); });
  cleanup.push(() => manager.dispose());
  const context = { route: "route", enabled: true, connected: new Set<string>(), presentations, drafts: new Map(), pages: [], launcher: () => tab.browserNewTab, protected: () => false };
  manager.commit(context); const saved = { ...defaultWindowView(), browserCloses: manager.intents }; manager.committed(saved); manager.saved(saved);
  expect(manager.canDismiss(row)).toBe(false);
  manager.commit({ ...context, presentations: reconcileDockPresentations(presentations, { state: createDockState(), tabs: [] }, "removed") });
  expect(manager.canDismiss(row)).toBe(true); const operation = manager.dismiss(row);
  const next = { ...defaultWindowView(), browserCloses: manager.intents }; manager.committed(next); manager.saved(next); await operation;
  expect(manager.intents).toEqual([]); expect(manager.message).toBe("Confirmed Close history dismissed from this window."); expect(f.events).toEqual([]);
});

test("disposed owner ignores late observations and retirement cannot report success", async () => {
  const original = intent("closed", "completed"), f = fixture([original]); f.save();
  const operation = f.manager.retire(original); f.manager.dispose(); const changes = f.changes();
  f.manager.committed(f.view()); f.manager.saved(f.view()); f.manager.failed("Late failure");
  expect((await operation).retired).toBe(false); expect(f.changes()).toBe(changes); expect(f.events).toEqual([]);
});
