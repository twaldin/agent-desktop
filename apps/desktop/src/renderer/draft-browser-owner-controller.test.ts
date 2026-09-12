import { afterEach, expect, test } from "bun:test";
import type { CommandEnvelope, CommandResult, Draft, DraftBrowserBridge, DraftBrowserOwnerSnapshot } from "@agent-desktop/shared";
import { DraftController } from "./drafts";
import { DraftBrowserOwnerController as CurrentOwnerController } from "./draft-browser-owner-controller";
import { DraftBrowserOwnerCheckpoint } from "./draft-browser-owner-checkpoint";
import { defaultWindowView } from "../window-state";
import type { DraftBrowserWindowIntent } from "../draft-browser-window-intent";

const DraftBrowserOwnerController: typeof CurrentOwnerController = process.env.AGENT_DESKTOP_DRAFT_OWNER_CONTROLLER
  ? (await import(process.env.AGENT_DESKTOP_DRAFT_OWNER_CONTROLLER)).DraftBrowserOwnerController : CurrentOwnerController;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const tick = async () => { for (let n = 0; n < 24; n++) await Promise.resolve(); };
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const restored = (): DraftBrowserWindowIntent => ({ version: 1, hostId: "host", reference: { ownerId: "original-owner", draftId: "new-conversation", draftRevision: 1 } });
const context = { hostId: "host", draftId: "new-conversation", connected: true, enabled: true };
function fixture(options: { restored?: DraftBrowserWindowIntent; saveGate?: Promise<void>; acquireGate?: Promise<void>; statusGate?: Promise<void>; metadataGate?: Promise<void>; saveFails?: boolean; zeroRevision?: boolean; acquireFails?: boolean } = {}) {
  const commands: CommandEnvelope[] = [], effects: { operation: string; reference: unknown; hostId: string }[] = [];
  const drafts = new DraftController(async (envelope): Promise<CommandResult> => {
    commands.push(structuredClone(envelope)); await options.saveGate;
    if (options.saveFails) throw new Error("Draft save failed");
    if (envelope.command.type !== "draft.put") throw new Error("Unexpected session/model command");
    return { ok: true, commandId: envelope.id, value: { ...envelope.command.draft, revision: options.zeroRevision ? 0 : envelope.command.expectedRevision + 1, updatedAt: 2 } };
  }, "host"); drafts.setConnected(true);
  const cp = new DraftBrowserOwnerCheckpoint(); let windowView = { ...defaultWindowView(), draftBrowserOwners: options.restored ? [options.restored] : [] };
  cp.committed(windowView);
  let status: DraftBrowserOwnerSnapshot["state"] = "ready", wrongMetadata = false;
  let response: DraftBrowserOwnerSnapshot | undefined;
  const snapshot = (ownerId: string): DraftBrowserOwnerSnapshot => response = ({ protocolVersion: 1, hostId: "host", ownerId, state: status,
    ...(status === "ready" ? { workerPid: 21 } : {}), ticket: { controlEpoch: "epoch", observedAt: 1000 } });
  const bridge: Pick<DraftBrowserBridge, "acquire" | "status" | "metadata"> = {
    acquire: async (ref, hostId) => { effects.push({ operation: "acquire", reference: structuredClone(ref), hostId }); await options.acquireGate; if (options.acquireFails) throw new Error("Acquisition response lost"); return snapshot(ref.ownerId); },
    status: async (ref, hostId) => { effects.push({ operation: "status", reference: structuredClone(ref), hostId }); await options.statusGate; return snapshot(ref.ownerId); },
    metadata: async (ref, hostId) => { effects.push({ operation: "metadata", reference: structuredClone(ref), hostId }); await options.metadataGate;
      return { protocolVersion: 1, ownerKind: "draft", hostId, ownerId: ref.ownerId, availability: "running", workerPid: wrongMetadata ? 22 : 21, tabs: [] }; },
  };
  const owner = new DraftBrowserOwnerController(bridge, drafts, "new-conversation", () => {
    windowView = { ...windowView, draftBrowserOwners: owner.intent ? [owner.intent] : [] }; cp.committed(windowView);
  }, (intent, signal) => cp.wait(intent, signal), options.restored);
  owner.observe(context);
  cleanup.push(() => { owner.dispose(); cp.dispose(); drafts.dispose(); });
  return { owner, drafts, bridge, commands, effects, cp, ack: () => cp.saved(windowView),
    mutateResponse: (change: (value: DraftBrowserOwnerSnapshot) => void) => { if (!response) throw new Error("No response yet"); change(response); },
    setStatus: (next: typeof status) => { status = next; }, wrongMetadata: () => { wrongMetadata = true; } };
}

test("pristine empty draft receives a real saved revision before owner intent acknowledgement and acquisition", async () => {
  const f = fixture(); expect(f.effects).toEqual([]); expect(f.commands).toEqual([]);
  const running = f.owner.acquire(); await tick();
  expect(f.commands).toHaveLength(1); expect(f.commands[0]?.command).toMatchObject({ type: "draft.put", draft: { text: "", model: null, projectId: null }, expectedRevision: 0 });
  expect(f.owner.intent?.reference).toMatchObject({ draftId: "new-conversation", draftRevision: 1 });
  expect(f.effects).toEqual([]); f.ack(); await running;
  expect(f.effects.map(x => x.operation)).toEqual(["acquire", "metadata"]);
  expect(f.owner.state).toMatchObject({ status: "ready", snapshot: { workerPid: 21 } });
  expect(f.drafts.get("new-conversation").draft.text).toBe("");
  await f.owner.acquire(); expect(f.commands).toHaveLength(1); expect(f.effects).toHaveLength(2);
});

test("saved prompt and model are not consumed; owned revision and references are detached from caller copies", async () => {
  const f = fixture(); f.drafts.update("new-conversation", { text: "keep unsent", model: { provider: "controlled", id: "model" } });
  const running = f.owner.acquire(); await tick();
  const original = f.owner.intent!, copy = f.owner.intent!; copy.reference.ownerId = "wrong"; copy.hostId = "foreign";
  f.ack(); await running;
  expect(f.effects[0]).toEqual({ operation: "acquire", reference: original.reference, hostId: "host" });
  expect(f.drafts.get("new-conversation")).toMatchObject({ status: "saved", draft: { text: "keep unsent", model: { provider: "controlled", id: "model" } } });
  expect(f.commands.map(command => command.command.type)).toEqual(["draft.put"]);
  const state = f.owner.state; state.snapshot!.workerPid = 99; expect(f.owner.state.snapshot?.workerPid).toBe(21);
});

test("draft save failure or unacknowledged revision cannot allocate an owner or acquire", async () => {
  for (const options of [{ saveFails: true }, { zeroRevision: true }]) {
    const f = fixture(options); await f.owner.acquire();
    expect(f.owner.intent).toBeUndefined(); expect(f.owner.state.status).toBe("error"); expect(f.effects).toEqual([]);
  }
});

test("failed window save retains original identity, explicit absent check allows only same-ID acquisition", async () => {
  const f = fixture(), running = f.owner.acquire(); await tick(); const original = f.owner.intent;
  f.cp.failed("Disk acknowledgement failed"); await running;
  expect(f.owner.state.status).toBe("unknown"); expect(f.effects).toEqual([]);
  await f.owner.acquire(); expect(f.effects).toEqual([]);
  f.setStatus("absent"); await f.owner.inspect(); expect(f.owner.state.status).toBe("absent");
  f.setStatus("ready"); const retry = f.owner.acquire(); await tick();
  expect(f.effects.map(x => x.operation)).toEqual(["status"]); f.ack(); await retry;
  expect(f.owner.intent).toEqual(original);
  expect(f.effects.map(x => x.operation)).toEqual(["status", "acquire", "metadata"]);
  expect(f.effects.every(x => JSON.stringify(x.reference) === JSON.stringify(original!.reference))).toBe(true);
  expect(f.commands).toHaveLength(1);
});

test("lost acquisition response remains unknown with no repeated acquire until an explicit read-only check", async () => {
  const f = fixture({ acquireFails: true }), running = f.owner.acquire(); await tick(); f.ack(); await running;
  expect(f.owner.state).toMatchObject({ status: "unknown", message: "Acquisition response lost" }); const original = f.owner.intent;
  await f.owner.acquire(); expect(f.effects.map(x => x.operation)).toEqual(["acquire"]);
  await f.owner.inspect(); expect(f.effects.map(x => x.operation)).toEqual(["acquire", "status", "metadata"]);
  expect(f.owner.intent).toEqual(original); expect(f.owner.state.status).toBe("ready");
});

test("restoration does not acquire or save and unavailable or retired history never triggers replacement", async () => {
  const f = fixture({ restored: restored() }); expect(f.owner.state.status).toBe("unknown"); expect(f.effects).toEqual([]); expect(f.commands).toEqual([]);
  await f.owner.acquire(); expect(f.effects).toEqual([]);
  for (const status of ["starting", "unavailable", "retired"] as const) {
    f.setStatus(status); await f.owner.inspect(); expect(f.owner.state.status).toBe(status === "starting" ? "unknown" : status);
    await f.owner.acquire();
  }
  expect(f.effects.map(x => x.operation)).toEqual(["status", "status", "status"]); expect(f.owner.intent).toEqual(restored());
});

test("disconnect-return across draft save, window acknowledgement, acquisition, status and metadata cannot revive an attempt", async () => {
  for (const stage of ["save", "window", "acquire", "status", "metadata"] as const) {
    const held = gate(), f = fixture({ ...(stage === "status" || stage === "metadata" ? { restored: restored() } : {}),
      ...(stage === "save" ? { saveGate: held.promise } : {}), ...(stage === "acquire" ? { acquireGate: held.promise } : {}),
      ...(stage === "status" ? { statusGate: held.promise } : {}), ...(stage === "metadata" ? { metadataGate: held.promise } : {}) });
    const running = stage === "status" || stage === "metadata" ? f.owner.inspect() : f.owner.acquire();
    await tick(); if (stage === "acquire") { f.ack(); await tick(); }
    f.owner.observe({ ...context, connected: false }); f.owner.observe(context); held.resolve(); f.ack(); await running;
    expect(f.owner.state.status).not.toBe("ready");
    if (stage === "save" || stage === "window") expect(f.effects).toEqual([]);
    else if (stage === "acquire") expect(f.effects.map(x => x.operation)).toEqual(["acquire"]);
    else if (stage === "status") expect(f.effects.map(x => x.operation)).toEqual(["status"]);
    else expect(f.effects.map(x => x.operation)).toEqual(["status", "metadata"]);
  }
});

test("project round trip and committed action or route loss cancel pre-dispatch owner preparation", async () => {
  for (const change of ["project", "enabled", "route"] as const) {
    const f = fixture(), running = f.owner.acquire(); await tick();
    if (change === "project") { f.drafts.update("new-conversation", { projectId: "other" }); f.drafts.update("new-conversation", { projectId: null }); }
    else { f.owner.observe(change === "enabled" ? { ...context, enabled: false } : { ...context, draftId: "different" }); f.owner.observe(context); }
    f.ack(); await running; expect(f.effects).toEqual([]); expect(f.owner.state.status).toBe("unknown");
  }
});

test("conflict blocks save/admission and a foreign restored binding is rejected", async () => {
  const f = fixture(); f.drafts.ingest({ id: "new-conversation", revision: 1, updatedAt: 1, projectId: null, text: "base", model: null });
  f.drafts.update("new-conversation", { text: "local" }); f.drafts.ingest({ id: "new-conversation", revision: 2, updatedAt: 2, projectId: null, text: "remote", model: null });
  await f.owner.acquire(); expect(f.commands).toEqual([]); expect(f.effects).toEqual([]); expect(f.owner.intent).toBeUndefined();
  expect(() => new DraftBrowserOwnerController(f.bridge, f.drafts, "new-conversation", () => {}, async () => {}, { ...restored(), hostId: "foreign" })).toThrow("another draft or host");
});

test("same PID metadata is required after ready status and owner changes invalidate queued readiness guards", async () => {
  const f = fixture({ restored: restored() }); f.wrongMetadata(); await f.owner.inspect(); expect(f.owner.state.status).toBe("unknown");
  const ready = fixture({ restored: restored() }); await ready.owner.inspect(); const guard = ready.owner.attachmentGuard();
  expect(guard()).toBe(true); ready.owner.observe(context); expect(guard()).toBe(true);
  ready.owner.observe({ ...context, hostId: "other-host" }); ready.owner.observe(context); expect(guard()).toBe(false);
  expect(ready.owner.state.status).toBe("unknown"); await ready.owner.inspect(); expect(ready.owner.attachmentGuard()()).toBe(true); expect(guard()).toBe(false);
});

test("disposal prevents unsent acquisition and preserves sent identity without automatic host retirement", async () => {
  const before = fixture(), blocked = before.owner.acquire(); await tick(); const saved = before.owner.intent;
  before.owner.dispose(); before.ack(); await blocked; expect(before.effects).toEqual([]); expect(before.owner.intent).toEqual(saved);
  const held = gate(), after = fixture({ acquireGate: held.promise }), sent = after.owner.acquire(); await tick(); after.ack(); await tick();
  const original = after.owner.intent; after.owner.dispose(); held.resolve(); await sent;
  expect(after.effects.map(x => x.operation)).toEqual(["acquire"]); expect(after.owner.intent).toEqual(original);
  await after.owner.inspect(); await after.owner.acquire(); expect(after.effects).toHaveLength(1);
});

test("fresh explicit inspection retires an earlier ready guard even when the same owner returns", async () => {
  const f = fixture({ restored: restored() }); await f.owner.inspect();
  const previous = f.owner.attachmentGuard(); expect(previous()).toBe(true);
  await f.owner.inspect(); expect(previous()).toBe(false); expect(f.owner.attachmentGuard()()).toBe(true);
  expect(f.effects.map(x => x.operation)).toEqual(["status", "metadata", "status", "metadata"]);
});

test("status projection stays captured while guarded metadata is pending", async () => {
  const held = gate(), f = fixture({ restored: restored(), metadataGate: held.promise }), checking = f.owner.inspect();
  await tick(); expect(f.effects.map(x => x.operation)).toEqual(["status", "metadata"]);
  f.mutateResponse(value => { value.state = "absent"; value.workerPid = 99; value.ticket.controlEpoch = "changed"; });
  held.resolve(); await checking;
  expect(f.owner.state).toMatchObject({ status: "ready", snapshot: { state: "ready", workerPid: 21, ticket: { controlEpoch: "epoch" } } });
  await f.owner.acquire(); expect(f.effects.map(x => x.operation)).toEqual(["status", "metadata"]);
});
