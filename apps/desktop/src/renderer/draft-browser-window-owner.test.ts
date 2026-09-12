import { afterEach, expect, test } from "bun:test";
import type { CommandEnvelope, CommandResult, DraftBrowserBridge, DraftBrowserOwnerSnapshot } from "@agent-desktop/shared";
import { DraftController } from "./drafts";
import { DraftBrowserWindowOwner } from "./draft-browser-window-owner";
import { defaultWindowView, type WindowViewState } from "../window-state";
import type { DraftBrowserWindowIntent } from "../draft-browser-window-intent";
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const intent = (hostId = "host", ownerId = "saved", draftId = "new-conversation"): DraftBrowserWindowIntent => ({ version: 1, hostId, reference: { ownerId, draftId, draftRevision: 1 } });
function fixture(options: { restored?: DraftBrowserWindowIntent[]; acquireGate?: Promise<void>; saveGate?: Promise<void>; acquireFails?: boolean; saveFails?: boolean; restorationError?: string; noBridge?: boolean } = {}) {
  const calls: { operation: string; hostId: string; ownerId: string }[] = [], commands: CommandEnvelope[] = [];
  const draftControllers = new Map<string, DraftController>();
  function drafts(host = "host") {
    let value = draftControllers.get(host);
    if (!value) {
      value = new DraftController(async (envelope): Promise<CommandResult> => {
        commands.push(structuredClone(envelope)); await options.saveGate;
        if (options.saveFails) throw new Error("Draft save unavailable");
        if (envelope.command.type !== "draft.put") throw new Error("Unexpected submission");
        return { ok: true, commandId: envelope.id, value: { ...envelope.command.draft, revision: envelope.command.expectedRevision + 1, updatedAt: 2 } };
      }, host); value.setConnected(true); draftControllers.set(host, value);
    }
    return value;
  }
  let status: DraftBrowserOwnerSnapshot["state"] = "ready", changes = 0;
  const response = (hostId: string, ownerId: string): DraftBrowserOwnerSnapshot => ({ protocolVersion: 1, hostId, ownerId, state: status,
    ...(status === "ready" ? { workerPid: 55 } : {}), ticket: { controlEpoch: "epoch", observedAt: 2 } });
  const bridge: Pick<DraftBrowserBridge, "acquire" | "status" | "metadata"> = {
    acquire: async (ref, hostId) => { calls.push({ operation: "acquire", hostId, ownerId: ref.ownerId }); await options.acquireGate; if (options.acquireFails) throw new Error("Response lost"); return response(hostId, ref.ownerId); },
    status: async (ref, hostId) => { calls.push({ operation: "status", hostId, ownerId: ref.ownerId }); return response(hostId, ref.ownerId); },
    metadata: async (ref, hostId) => { calls.push({ operation: "metadata", hostId, ownerId: ref.ownerId }); return { protocolVersion: 1, ownerKind: "draft", hostId, ownerId: ref.ownerId, availability: "running", workerPid: 55, tabs: [] }; },
  };
  const owner = new DraftBrowserWindowOwner(options.noBridge ? undefined : bridge, options.restored ?? [], () => { changes++; }, options.restorationError);
  let context = { drafts: drafts(), draftId: "new-conversation", connected: true, enabled: true };
  let view: WindowViewState = { ...defaultWindowView(), draftBrowserOwners: owner.intents };
  owner.commit(context); owner.committed(view); owner.saved(view);
  closes.push(() => { owner.dispose(); for (const value of draftControllers.values()) value.dispose(); });
  return { owner, calls, commands, drafts, changes: () => changes, status: (value: typeof status) => { status = value; },
    commit: (patch: Partial<typeof context>) => { context = { ...context, ...patch }; owner.commit(context); },
    publish: (patch: Partial<WindowViewState> = {}) => { view = { ...view, ...patch, draftBrowserOwners: owner.intents }; owner.committed(view); return view; },
    save: (value = view) => { owner.saved(value); }, view: () => view };
}

test("restoration and repeated committed renders remain inert and preserve all original owners", async () => {
  const originals = [intent(), intent("other", "foreign"), intent("host", "second", "draft:two")];
  const f = fixture({ restored: originals }); originals[0]!.reference.ownerId = "caller-change";
  f.commit({}); f.publish(); f.save();
  expect(f.calls).toEqual([]); expect(f.commands).toEqual([]); expect(f.changes()).toBe(0);
  const values = f.owner.intents; values[0]!.reference.draftId = "mutated";
  expect(f.owner.intents).toEqual([intent(), intent("other", "foreign"), intent("host", "second", "draft:two")]);
  expect(f.owner.state("saved")).toEqual({ status: "unknown" });
  await f.owner.acquire(); expect(f.calls).toEqual([]);
});

test("new ownership requires a committed then saved projection and keeps the route, settings and sibling owner", async () => {
  const f = fixture({ restored: [intent("other", "foreign")] });
  const pending = f.owner.acquire(); await tick(); expect(f.commands).toHaveLength(1); expect(f.owner.intents).toHaveLength(2); expect(f.calls).toEqual([]);
  const view = f.publish({ route: { hostId: "host", sessionId: null }, settingsPage: "git" });
  expect(f.calls).toEqual([]); f.save(); expect((await pending).status).toBe("ready");
  expect(f.calls.map(x => x.operation)).toEqual(["acquire", "metadata"]); expect(view.settingsPage).toBe("git"); expect(view.route).toEqual({ hostId: "host", sessionId: null }); expect(f.owner.intents[0]).toEqual(intent("other", "foreign"));
  const own = f.owner.intents[1]!; expect(f.owner.attachmentGuard(own.reference.ownerId)()).toBe(true);
  expect(f.commands[0]?.command.type).toBe("draft.put");
});

test("reentrant acquisition while empty draft save is held does not dispose the original admission", async () => {
  const held = gate(), f = fixture({ saveGate: held.promise });
  const first = f.owner.acquire(); await tick(); const second = await f.owner.acquire();
  held.resolve(); await tick(); f.publish(); f.save(); const final = await first;
  expect(second.status).toBe("saving"); expect(final.status).toBe("ready"); expect(f.commands).toHaveLength(1);
  expect(f.calls.map(x => x.operation)).toEqual(["acquire", "metadata"]);
});

test("route loss and return cancels pending acquisition without losing its original window intent", async () => {
  const f = fixture(), pending = f.owner.acquire(); await tick(); const original = f.owner.intents;
  f.commit({ draftId: "session:elsewhere", enabled: false }); f.commit({ draftId: "new-conversation", enabled: true }); f.publish(); f.save();
  expect((await pending).status).toBe("unknown"); expect(f.calls).toEqual([]); expect(f.owner.intents).toEqual(original);
  await f.owner.acquire(); expect(f.calls).toEqual([]);
  await f.owner.inspect(original[0]!.reference.ownerId); expect(f.calls.map(x => x.operation)).toEqual(["status", "metadata"]);
});

test("Send invalidates before the next render and retains sent unknown work through route changes", async () => {
  for (const sent of [false, true]) {
    const held = gate(), f = fixture({ acquireGate: held.promise }), pending = f.owner.acquire(); await tick();
    if (sent) { f.publish(); f.save(); await tick(); }
    f.owner.beforeSubmission(); f.commit({ enabled: false, draftId: "session:created" });
    held.resolve(); const result = await pending; f.publish({ route: { hostId: "host", sessionId: "created" } }); f.save();
    expect(result.status).toBe("unknown"); expect(f.owner.intents).toHaveLength(1); expect(f.calls.map(x => x.operation)).toEqual(sent ? ["acquire"] : []);
    f.commit({ enabled: true, draftId: "new-conversation" }); await f.owner.acquire(); expect(f.calls.map(x => x.operation)).toEqual(sent ? ["acquire"] : []);
  }
});

test("each host uses its actual DraftController; same-ID controller replacement cannot rebind old recovery", async () => {
  const f = fixture(), first = f.owner.acquire(); await tick(); f.publish(); f.save(); await first;
  const original = f.owner.intents[0]!; const guard = f.owner.attachmentGuard(original.reference.ownerId);
  f.commit({ drafts: f.drafts("other") }); const other = f.owner.acquire(); await tick(); f.publish(); f.save(); await other;
  expect(f.calls.map(x => x.hostId)).toEqual(["host", "host", "other", "other"]); expect(f.owner.intents).toHaveLength(2); expect(guard()).toBe(false);
  f.commit({ drafts: f.drafts() }); expect(guard()).toBe(false);
  await f.owner.inspect(original.reference.ownerId); expect(f.owner.attachmentGuard(original.reference.ownerId)()).toBe(true);
  const replacement = new DraftController(async () => { throw new Error("Should not save"); }, "host"); closes.push(() => replacement.dispose());
  f.commit({ drafts: replacement }); await expect(f.owner.inspect(original.reference.ownerId)).rejects.toThrow("original draft controller changed");
});

test("multiple historical owners require explicit selection and inspect each without acquisition", async () => {
  const f = fixture({ restored: [intent(), intent("host", "second")] });
  await expect(f.owner.acquire()).rejects.toThrow("explicitly"); expect(f.calls).toEqual([]);
  await f.owner.inspect("saved"); await f.owner.inspect("second");
  expect(f.calls.map(x => x.ownerId)).toEqual(["saved", "saved", "second", "second"]);
  expect(f.owner.state("saved")?.status).toBe("ready"); expect(f.owner.state("second")?.status).toBe("ready");
  await expect(f.owner.inspect("unknown")).rejects.toThrow("explicitly"); expect(f.owner.intents).toHaveLength(2);
});

test("failed or dropped window persistence invalidates guards, retains records and requires fresh inspection", async () => {
  const f = fixture({ restored: [intent()] }); await f.owner.inspect("saved"); const guard = f.owner.attachmentGuard("saved"); expect(guard()).toBe(true);
  f.owner.failed("Disk failed"); expect(guard()).toBe(false); await expect(f.owner.inspect("saved")).rejects.toThrow("Disk failed");
  f.publish(); f.save(); expect(guard()).toBe(false); await f.owner.inspect("saved"); const next = f.owner.attachmentGuard("saved"); expect(next()).toBe(true);
  f.owner.committed({ ...f.view(), draftBrowserOwners: [] }); expect(next()).toBe(false); expect(f.owner.intents).toEqual([intent()]);
  f.publish(); f.save(); await f.owner.inspect("saved"); const third = f.owner.attachmentGuard("saved"); expect(third()).toBe(true);
  f.owner.saved({ ...f.view(), draftBrowserOwners: [] }); expect(third()).toBe(false); expect(f.owner.intents).toEqual([intent()]);
});

test("capacity includes in-flight reservations and never evicts original records", async () => {
  const originals = Array.from({ length: 63 }, (_, i) => intent("old", `owner${i}`, `draft${i}`));
  const held = gate(), f = fixture({ restored: originals, saveGate: held.promise });
  const pending = f.owner.acquire(); await tick(); f.commit({ drafts: f.drafts("other") });
  let error: unknown; try { await f.owner.acquire(); } catch (cause) { error = cause; }
  held.resolve(); await pending;
  expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain("recovery records"); expect(f.owner.intents).toEqual(originals);
  expect(f.calls).toEqual([]); expect(f.commands).toHaveLength(1);
});

test("failed draft saves release unused reservation and missing bridge or restoration error never dispatch", async () => {
  const f = fixture({ saveFails: true });
  expect((await f.owner.acquire()).status).toBe("error"); expect((await f.owner.acquire()).status).toBe("error");
  expect(f.owner.intents).toEqual([]); expect(f.calls).toEqual([]);
  for (const options of [{ noBridge: true }, { restorationError: "Invalid original window" }]) {
    const blocked = fixture(options); await expect(blocked.owner.acquire()).rejects.toThrow(); expect(blocked.commands).toEqual([]); expect(blocked.calls).toEqual([]);
  }
});

test("dispose preserves pending recovery knowledge and cannot retire an admitted host worker", async () => {
  const held = gate(), f = fixture({ acquireGate: held.promise }), pending = f.owner.acquire(); await tick(); f.publish(); f.save(); await tick();
  const original = f.owner.intents; f.owner.dispose(); const changes = f.changes(); held.resolve(); await pending;
  f.commit({}); f.publish(); f.save(); expect(f.changes()).toBe(changes); expect(f.owner.intents).toEqual(original); expect(f.calls.map(x => x.operation)).toEqual(["acquire"]);
  await expect(f.owner.inspect(original[0]!.reference.ownerId)).rejects.toThrow();
});
