import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DesktopBridge, NativeBrowserTabMetadata } from "@agent-desktop/shared";
import { browserCloseIdentity, type BrowserCloseObservation, type BrowserCloseReceipt } from "../../../../packages/shared/src/browser-close";
import { BrowserCloseWindowOwner, type BrowserCloseSelection } from "./browser-close-window-owner";
import type { BrowserCloseWindowIntent } from "../browser-close-window-intent";
import { WindowStateStore } from "../main/window-state";
import { defaultWindowView } from "../window-state";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const gate = () => Promise.withResolvers<void>();
const SelectedWindowOwner: typeof BrowserCloseWindowOwner = process.env.BROWSER_CLOSE_OWNER_MODULE
  ? (await import(process.env.BROWSER_CLOSE_OWNER_MODULE)).BrowserCloseWindowOwner : BrowserCloseWindowOwner;
function fixture(options: { draft?: boolean; restored?: BrowserCloseWindowIntent[]; metadataGate?: Promise<void>; closeGate?: Promise<void>; statusGate?: Promise<void>; lost?: boolean; malformed?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "browser-close-owner-")), store = new WindowStateStore(dir, "primary");
  const events: string[] = []; let enabled = true, changes = 0;
  const target = { workerPid: 50, name: "browser", targetId: "native-target" };
  const tab: NativeBrowserTabMetadata = { ...target, backend: "worker", kindTag: "headless", state: "alive", url: "https://example.com", viewport: { width: 800, height: 600 } };
  const selection: BrowserCloseSelection = { source: { hostId: "host", tabId: "tab", instanceId: '["seed","tab"]', destination: "right", kind: "browser", target: options.draft ? "draft:new-conversation" : "session:session" },
    owner: options.draft ? { kind: "draft", ownerId: "owner", draftId: "new-conversation", draftRevision: 3 } : { kind: "session", sessionId: "session" }, target, isCurrent: () => enabled };
  let observation: "completed" | "pending" | "unavailable" | "rejected" = "completed";
  const bridge: Pick<DesktopBridge, "browserClose" | "getBrowserMetadata" | "draftBrowser"> = {
    getBrowserMetadata: async (sessionId, hostId) => { events.push("metadata"); await options.metadataGate; return { protocolVersion: 1, hostId: hostId!, sessionId, availability: "running", workerPid: 50, tabs: [tab], creationTicket: { controlEpoch: "session-epoch", observedAt: 1 } }; },
    draftBrowser: {
      status: async (ref, hostId) => { events.push("draft-status"); return { protocolVersion: 1, hostId, ownerId: ref.ownerId, state: "ready", workerPid: 50, ticket: { controlEpoch: "owner-epoch", observedAt: 1 } }; },
      metadata: async (ref, hostId) => { events.push("draft-metadata"); await options.metadataGate; return { protocolVersion: 1, ownerKind: "draft", hostId, ownerId: ref.ownerId, availability: "running", workerPid: 50, tabs: [tab], controlEpoch: "different-control-epoch" }; },
      acquire: async () => { throw new Error("Unexpected acquire"); }, create: async () => { throw new Error("Unexpected create"); },
      retire: async () => { throw new Error("Unexpected retire"); }, creationStatus: async () => { throw new Error("Unexpected creation status"); },
      frame: async () => { throw new Error("Unexpected frame"); }, control: async () => { throw new Error("Unexpected control"); },
    },
    browserClose: {
      close: async (owner, request, hostId) => {
        events.push("close"); const identity = browserCloseIdentity(hostId, owner, request);
        // A transport must not own the manager's retained request object.
        request.target.targetId = "transport-mutation";
        await options.closeGate; if (options.lost) throw new Error("Reply lost after dispatch");
        return { ...identity, ...(options.malformed ? { target: { ...identity.target, targetId: "replacement" } } : {}), outcome: "completed", released: true };
      },
      status: async (owner, request, hostId): Promise<BrowserCloseObservation> => {
        events.push("status"); const identity = browserCloseIdentity(hostId, owner, request); await options.statusGate;
        if (observation === "pending" || observation === "unavailable") return { ...identity, status: observation };
        const receipt: BrowserCloseReceipt = observation === "completed" ? { ...identity, outcome: "completed", released: true } : { ...identity, outcome: "rejected", message: "Native preflight rejected" };
        return { ...identity, status: "settled", receipt };
      },
    },
  };
  const manager = new SelectedWindowOwner(bridge, options.restored ?? [], () => { changes++; });
  const view = () => ({ ...defaultWindowView(), route: { hostId: "new-host", sessionId: "new-route" }, expandedProjects: ["new-host:project"], browserCloses: manager.intents });
  const commit = () => manager.committed(view());
  const flush = () => { commit(); expect(store.saveView(view())).toEqual({}); manager.saved(store.bootstrap().state!); };
  const setEnabled = (value: boolean) => { enabled = value; manager.observe(); };
  const reopen = () => new WindowStateStore(dir, "primary").bootstrap().state!;
  cleanup.push(() => { manager.dispose(); rmSync(dir, { recursive: true, force: true }); });
  commit();
  return { manager, events, selection, bridge, tab, flush, commit, setEnabled, reopen, changes: () => changes, setObservation: (value: typeof observation) => { observation = value; } };
}
test.each(["session", "draft"] as const)("explicit close waits for request and outcome saves for %s", async kind => {
  const draft = kind === "draft";
  const f = fixture({ draft }); expect(f.events).toEqual([]); expect(f.manager.intents).toEqual([]);
  let settled = false; const operation = f.manager.close(f.selection).then(value => { settled = true; return value; }); await tick();
  expect(f.events).toEqual(draft ? ["draft-status", "draft-metadata"] : ["metadata"]);
  expect(f.manager.intents).toHaveLength(1); expect(f.manager.intents[0]!.request.controlEpoch).toBe(draft ? "owner-epoch" : "session-epoch");
  f.flush(); await tick(); expect(f.events.at(-1)).toBe("close"); expect(settled).toBe(false);
  expect(f.reopen().browserCloses?.[0]?.receipt).toBeUndefined();
  expect(f.manager.intents[0]!.request.target.targetId).toBe("native-target");
  f.flush(); const result = await operation; expect(result.status).toBe("completed");
  if (result.status !== "completed") throw new Error(result.message);
  expect(result.canRemove()).toBe(true); expect(f.reopen().browserCloses?.[0]?.receipt?.outcome).toBe("completed");
  expect(f.reopen().route).toEqual({ hostId: "new-host", sessionId: "new-route" });
  f.setEnabled(false); f.setEnabled(true); expect(result.canRemove()).toBe(false);
});
test.each(["metadata", "save"] as const)("loss and return during %s never sends close", async phase => {
  const held = gate(), f = fixture({ metadataGate: phase === "metadata" ? held.promise : undefined });
  const operation = f.manager.close(f.selection); await tick();
  f.setEnabled(false); f.setEnabled(true); held.resolve(); await tick(); f.flush();
  expect((await operation).status).toBe("retained"); expect(f.events).toEqual(["metadata"]);
});
test("a sent request preserves its receipt through selection loss but cannot remove the returned presentation", async () => {
  const held = gate(), f = fixture({ closeGate: held.promise }); const operation = f.manager.close(f.selection);
  await tick(); f.flush(); await tick(); expect(f.events).toEqual(["metadata", "close"]);
  f.setEnabled(false); f.setEnabled(true); held.resolve(); await tick(); f.flush();
  const result = await operation; expect(result.status).toBe("completed");
  if (result.status !== "completed") throw new Error(result.message);
  expect(result.canRemove()).toBe(false); expect(f.reopen().browserCloses?.[0]?.receipt?.outcome).toBe("completed");
});
test.each(["lost", "malformed"] as const)("%s reply retains original uncertainty and explicit recovery never repeats close", async kind => {
  const f = fixture({ lost: kind === "lost", malformed: kind === "malformed" }); const operation = f.manager.close(f.selection);
  await tick(); f.flush(); expect((await operation).status).toBe("retained");
  const saved = f.reopen().browserCloses!; expect(saved[0]!.request.target.targetId).toBe("native-target"); expect(saved[0]!.receipt).toBeUndefined();
  await f.manager.close(f.selection); expect(f.events).toEqual(["metadata", "close"]);
  const restored = fixture({ restored: saved }); expect(restored.events).toEqual([]); restored.flush();
  for (const status of ["pending", "unavailable"] as const) {
    restored.setObservation(status); expect((await restored.manager.inspect(saved[0]!, restored.selection.isCurrent)).status).toBe("retained");
    expect(restored.manager.intents).toEqual(saved);
  }
  restored.setObservation("completed"); const recovered = restored.manager.inspect(saved[0]!, restored.selection.isCurrent); await tick(); restored.flush();
  const result = await recovered; expect(result.status).toBe("completed"); expect(restored.events).toEqual(["status", "status", "status"]);
});
test("commit drop and save failure cannot admit close; retained input mutation cannot change target", async () => {
  const f = fixture(); const operation = f.manager.close(f.selection); await tick();
  f.selection.target.targetId = "caller-replacement";
  f.commit(); f.manager.failed("Disk full"); f.manager.saved({ ...defaultWindowView(), browserCloses: f.manager.intents });
  expect((await operation).status).toBe("retained"); expect(f.events).toEqual(["metadata"]);
  expect(f.manager.intents[0]!.request.target.targetId).toBe("native-target");
  const second = fixture(); const pending = second.manager.close(second.selection); await tick(); second.commit();
  second.manager.committed({ ...defaultWindowView(), browserCloses: [] });
  second.manager.saved({ ...defaultWindowView(), browserCloses: second.manager.intents });
  expect((await pending).status).toBe("retained"); expect(second.events).toEqual(["metadata"]);
});
test("wrong or dead target rejects before allocating a close intent", async () => {
  for (const change of ["name", "worker", "dead"] as const) {
    const f = fixture(); if (change === "name") f.tab.name = "replacement"; else if (change === "worker") f.selection.target.workerPid = 51; else f.tab.state = "dead";
    expect((await f.manager.close(f.selection)).status).toBe("retained"); expect(f.manager.intents).toEqual([]); expect(f.events).toEqual(["metadata"]);
  }
});
test("reentrant close joins no second operation and disposal after dispatch leaves saved request recoverable", async () => {
  const held = gate(), f = fixture({ closeGate: held.promise }); const first = f.manager.close(f.selection);
  await tick(); expect(f.manager.retains(f.selection.source)).toBe(true);
  expect((await f.manager.close(f.selection)).status).toBe("retained"); f.flush(); await tick();
  const saved = f.reopen().browserCloses!; f.manager.dispose(); held.resolve();
  expect((await first).status).toBe("retained"); expect(f.events).toEqual(["metadata", "close"]);
  expect(f.reopen().browserCloses).toEqual(saved);
});
test("status loss-return saves known completion without restoring removal permission", async () => {
  const f = fixture({ lost: true }); const original = f.manager.close(f.selection); await tick(); f.flush(); await original;
  const held = gate(), restored = fixture({ restored: f.reopen().browserCloses, statusGate: held.promise }); restored.flush();
  const recovery = restored.manager.inspect(restored.manager.intents[0]!, restored.selection.isCurrent); await tick();
  expect(restored.events).toEqual(["status"]); restored.setEnabled(false); restored.setEnabled(true); held.resolve(); await tick(); restored.flush();
  const result = await recovery; expect(result.status).toBe("completed");
  if (result.status !== "completed") throw new Error(result.message);
  expect(result.canRemove()).toBe(false); expect(restored.reopen().browserCloses?.[0]?.receipt?.outcome).toBe("completed");
});
test("confirmed rejection permits only a fresh deliberate request, preserving the original history", async () => {
  const f = fixture({ lost: true }); const first = f.manager.close(f.selection); await tick(); f.flush(); await first;
  const before = f.manager.intents[0]!; f.setObservation("rejected");
  const rejection = f.manager.inspect(before, f.selection.isCurrent); await tick(); f.flush();
  expect(await rejection).toEqual({ status: "retained", message: "Native preflight rejected" });
  const retry = f.manager.close(f.selection); await tick();
  expect(f.manager.intents).toHaveLength(2); expect(f.manager.intents[0]!.request).toEqual(before.request);
  expect(f.manager.intents[1]!.request.requestId === before.request.requestId).toBe(false);
  f.flush(); await retry; expect(f.events).toEqual(["metadata", "close", "status", "metadata", "close"]);
});
