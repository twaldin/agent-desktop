import { expect, test } from "bun:test";
import { ForceToolState, forceToolReason, forceRecoveryReason, type ForceToolSnapshot, type ForceToolPorts, type ForceToolRead, type ForceToolRecovery } from "./force-tool-state";
const owner = { hostId: "home", sessionId: "session" };
export function snapshot(): ForceToolSnapshot {
  return { epoch: "worker-1", revision: 1, nativeSessionId: "native-1", model: { provider: "openai-codex", id: "model", api: "openai-codex-responses" },
    availability: { state: "supported", reason: "Native named tool requests are supported." }, tools: [{ name: "read", available: true }, { name: "write", available: true }],
    directives: [], canArm: true, canCancel: true };
}
function setup(draft = "inspect this file") {
  let current = snapshot();
  const inserts: unknown[] = [], cancels: unknown[] = [], recoveries: unknown[] = [];
  const ports: ForceToolPorts = {
    read: async (_owner, commandId): Promise<ForceToolRead> => ({ protocolVersion: 1, ...owner, value: current, ...(commandId ? { receipt: { commandId, state: "failed", forceToolReceipt: recovery().receipt } } : {}) }),
    cancel: async (_owner, request) => { cancels.push(request); return { ...current, revision: current.revision + 1, directives: [] }; },
    insertDraft: (_owner, input) => { inserts.push(input); }, recoverPrompt: async (_owner, input) => { recoveries.push(input); },
  };
  const state = new ForceToolState(owner, ports, draft);
  state.configure(true, true, draft);
  return { state, ports, inserts, cancels, recoveries, set: (next: ForceToolSnapshot) => { current = next; } };
}
const recovery = (): ForceToolRecovery => ({ prompt: "original remaining prompt", receipt: { commandId: "original", epoch: "worker-1", directiveId: "sequence-1", toolName: "read", arm: "armed", prompt: "not-recorded" } });
const pending = (): ForceToolSnapshot => ({ ...snapshot(), directives: [{ id: "sequence-1", toolName: "read", phase: "pending-tool", requeued: false }] });

test("selection prepares exact draft + stale guard without any mutation or send", async () => {
  const f = setup(); await f.state.refresh(); f.state.select("read");
  expect(f.state.prepare()).toBe(true);
  expect(f.inserts).toEqual([{ text: "/force read inspect this file", expectedDraftText: "inspect this file", guard: { epoch: "worker-1", expectedRevision: 1, toolName: "read" } }]);
  expect(f.cancels).toEqual([]); expect(f.recoveries).toEqual([]);
});
test("revision change preserves selected tool and prompt until explicit review", async () => {
  const f = setup(); await f.state.refresh(); f.state.select("read"); f.state.setPrompt("local edit");
  f.set({ ...snapshot(), revision: 2 }); await f.state.refresh();
  expect(f.state.getSnapshot().prompt).toBe("local edit"); expect(f.state.prepare()).toBe(false);
  f.state.reviewSelection(); expect(f.state.prepare()).toBe(true);
  expect(f.inserts).toMatchObject([{ text: "/force read local edit", guard: { expectedRevision: 2 } }]);
});
test("draft edited elsewhere survives refresh and requires explicit text adoption", async () => {
  const f = setup(); await f.state.refresh(); f.state.select("read"); f.state.setPrompt("my optional prompt");
  f.state.configure(true, true, "new composer content"); await f.state.refresh();
  expect(f.state.getSnapshot().prompt).toBe("my optional prompt"); expect(f.state.prepare()).toBe(false); expect(f.inserts).toHaveLength(0);
  f.state.reviewDraft(); expect(f.state.getSnapshot().prompt).toBe("new composer content"); expect(f.state.prepare()).toBe(true);
});
test("native-accepted degraded modes remain usable while unsupported routes refuse", async () => {
  for (const mode of ["unsupported", "degraded"] as const) {
    const f = setup(); f.set({ ...snapshot(), availability: { state: mode, reason: "Pinned native path downgrades or rejects forcing." } });
    await f.state.refresh(); f.state.select("read");
    expect(f.state.prepare()).toBe(mode === "degraded");
    expect(f.inserts).toHaveLength(mode === "degraded" ? 1 : 0);
  }
});
test("removed tools and worker restart keep edits but block a stale selection", async () => {
  const f = setup(); await f.state.refresh(); f.state.select("read");
  f.set({ ...snapshot(), revision: 2, tools: [{ name: "write", available: true }] }); await f.state.refresh(); expect(f.state.prepare()).toBe(false);
  f.set({ ...snapshot(), epoch: "new-worker", revision: 1 }); await f.state.refresh(); expect(f.state.prepare()).toBe(false);
  expect(f.state.getSnapshot().notice).toContain("nothing was rearmed"); expect(f.state.getSnapshot().prompt).toBe("inspect this file");
});
test("late old read cannot replace newest response or revive offline state", async () => {
  const f = setup(), a = Promise.withResolvers<ForceToolRead>(), b = Promise.withResolvers<ForceToolRead>(); let n = 0;
  f.ports.read = () => ++n === 1 ? a.promise : b.promise;
  const first = f.state.refresh(), second = f.state.refresh();
  b.resolve({ protocolVersion: 1, ...owner, value: { ...snapshot(), revision: 9 } }); await second;
  a.resolve({ protocolVersion: 1, ...owner, value: snapshot() }); await first;
  expect(f.state.getSnapshot().snapshot?.revision).toBe(9);
  const c = Promise.withResolvers<ForceToolRead>(); f.ports.read = () => c.promise; const third = f.state.refresh();
  f.state.configure(false, true, "offline edit"); c.resolve({ protocolVersion: 1, ...owner, value: snapshot() }); await third;
  expect(f.state.getSnapshot().fresh).toBe(false); expect(f.state.getSnapshot().connected).toBe(false);
});
test("wrong owner and failed refresh disable stale writes", async () => {
  const f = setup(); await f.state.refresh(); f.state.select("read");
  f.ports.read = async () => ({ protocolVersion: 1, ...owner, hostId: "other-host", value: snapshot() });
  await f.state.refresh(); expect(f.state.getSnapshot().error).toContain("another conversation"); expect(f.state.prepare()).toBe(false);
});
test("partial armed recovery only sends original plain prompt with atomic pending guard", async () => {
  const f = setup("newly edited draft"), r = recovery(); f.set(pending()); f.state.configure(true, true, "newly edited draft", r); await f.state.refresh();
  expect(forceRecoveryReason(f.state.getSnapshot())).toBeUndefined(); await f.state.recover();
  expect(f.recoveries).toEqual([{ text: r.prompt, originalReceipt: r.receipt, ticket: { epoch: "worker-1", revision: 1 }, directiveId: "sequence-1" }]);
  expect(f.inserts).toHaveLength(0); expect(f.state.getSnapshot().prompt).toBe("newly edited draft");
  // An unchanged parent prop cannot reinstate the same failed receipt after acceptance.
  f.state.configure(true, true, "newly edited draft", r); await f.state.refresh(); await f.state.recover(); expect(f.recoveries).toHaveLength(1);
});
test("unknown receipt, later queue leg and missing live worker never authorize recovery", async () => {
  for (const change of ["unknown", "later", "restarted", "absent"] as const) {
    const f = setup(), r = recovery(); let s = pending();
    if (change === "unknown") r.receipt.prompt = "unknown";
    if (change === "later") s.directives[0]!.phase = "pending-final-response";
    if (change === "restarted") s.epoch = "worker-2";
    if (change === "absent") s.directives = [];
    f.set(s); f.state.configure(true, true, "inspect this file", r); await f.state.refresh(); await f.state.recover(); expect(f.recoveries).toHaveLength(0);
  }
});
test("cancel targets exact sequence and uncertain checks reuse captured ticket", async () => {
  const f = setup(); f.set(pending()); await f.state.refresh(); let n = 0; const requests: unknown[] = [];
  f.ports.cancel = async (_owner, request) => { requests.push(request); if (++n === 1) throw new Error("reply lost"); return { ...snapshot(), revision: 4 }; };
  await f.state.cancel("sequence-1"); expect(f.state.getSnapshot().uncertain).toBe("cancel");
  f.set({ ...pending(), revision: 3 }); await f.state.refresh(); await f.state.cancel("sequence-1"); expect(requests).toHaveLength(1);
  await f.state.checkPending(); expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]); expect(f.state.getSnapshot().uncertain).toBeUndefined();
});
test("in-flight cancellation is disabled and failed draft CAS retains optional input", async () => {
  const f = setup(); const s = pending(); s.directives[0]!.phase = "tool-in-flight"; f.set(s); await f.state.refresh();
  await f.state.cancel("sequence-1"); expect(f.cancels).toHaveLength(0);
  f.state.select("read"); f.ports.insertDraft = () => { throw new Error("Composer revision changed"); };
  expect(f.state.prepare()).toBe(false); expect(f.state.getSnapshot().prompt).toBe("inspect this file"); expect(f.state.getSnapshot().error).toContain("revision changed");
});
test("recovery failure never automatically resends and checks use same immutable request", async () => {
  const f = setup(), r = recovery(); f.set(pending()); f.state.configure(true, true, "inspect this file", r); await f.state.refresh();
  const requests: unknown[] = []; let n = 0;
  f.ports.recoverPrompt = async (_owner, request) => { requests.push(request); if (++n === 1) throw new Error("reply lost"); };
  await f.state.recover(); await f.state.refresh(); await f.state.recover(); expect(requests).toHaveLength(1);
  await f.state.checkPending(); expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
});

test("confirmed cancellation releases historical recovery without changing its receipt or prompt", async () => {
  const f = setup(), r = recovery(); f.set(pending()); f.state.configure(true, true, "inspect this file", r); await f.state.refresh();
  await f.state.cancel("sequence-1"); f.state.configure(true, true, "inspect this file", r);
  expect(f.state.getSnapshot().recovery?.receipt.arm).toBe("armed"); expect(f.state.getSnapshot().recoveryResolved).toBe(true);
  f.state.select("read"); expect(f.state.prepare()).toBe(true); expect(f.recoveries).toHaveLength(0);
});
test("unsettled read receipts do not authorize recovery even with an old local armed receipt", async () => {
  for (const state of ["unknown", "absent", "pending"] as const) {
    const f = setup(), r = recovery(); f.state.configure(true, true, "inspect this file", r);
    f.ports.read = async () => ({ protocolVersion: 1, ...owner, value: pending(), receipt: { commandId: "original", state } });
    await f.state.refresh(); await f.state.recover(); expect(f.recoveries).toHaveLength(0);
  }
});

test("recovery preserves native FIFO authority without guessing eligibility from the visible force list", async () => {
  const f = setup(), r = recovery(), s = pending();
  s.directives.unshift({ id: "earlier", toolName: "write", phase: "pending-tool", requeued: false });
  f.set(s); f.state.configure(true, true, "inspect this file", r); await f.state.refresh();
  expect(forceRecoveryReason(f.state.getSnapshot())).toBeUndefined(); await f.state.recover(); expect(f.recoveries).toHaveLength(1);
});

test("a newer journal receipt or missing receipt never permits stale local prompt recovery", async () => {
  for (const receipt of [undefined, {commandId:"original",state:"failed" as const}, {commandId:"original",state:"succeeded" as const,forceToolReceipt:{...recovery().receipt,prompt:"recorded" as const,promptEntryId:"already-recorded"}}]) {
    const f=setup(); f.set(pending());f.state.configure(true,true,"edited",recovery());
    f.ports.read=async()=>({protocolVersion:1,...owner,value:pending(),receipt});
    await f.state.refresh();await f.state.recover();expect(f.recoveries).toHaveLength(0);
  }
});
test("definite stale refusal exits uncertainty so refreshed native state can be reviewed", async () => {
  const { ForceToolOperationRefused } = await import("./force-tool-state");
  const f=setup();f.set(pending());await f.state.refresh();
  f.ports.cancel=async()=>{throw new ForceToolOperationRefused("Native ticket changed. Refresh.");};
  await f.state.cancel("sequence-1");expect(f.state.getSnapshot().uncertain).toBeUndefined();expect(f.state.getSnapshot().fresh).toBe(false);
  await f.state.refresh();expect(f.state.canCancel(pending().directives[0]!)).toBe(true);
});
