import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserControlRequest, type BrowserHumanAction, type NativeBrowserFrame } from "@agent-desktop/shared";
import { jpeg3x2 } from "../../../packages/shared/src/fixtures/browser-frame";
import { HostStore } from "./store";
import { DraftBrowserWorkers } from "./browser-draft-workers";
import { DraftBrowserHttp } from "./draft-browser-http";
import { BrowserControlRequests } from "./browser-control-requests";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const target = { workerPid: 77, name: "main", targetId: "native-main" };
const context = { documentId: "document-one", width: 3, height: 2, scrollX: 0, scrollY: 0, navigation: { entryId: 1, canGoBack: true, canGoForward: true } };
const result = { name: target.name, targetId: target.targetId, context, url: "https://example.invalid/observed", title: "Observed" };
const frame = (): NativeBrowserFrame => ({ ...result, capturedAt: 1_000_000, width: 3, height: 2, mimeType: "image/jpeg", data: jpeg3x2 });
function fixture(control?: (input: BrowserControlRequest) => Promise<typeof result>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "draft-browser-control-"))), store = new HostStore(root);
  const saved = store.putDraft({ id: "draft", text: "unsent text", projectId: null, model: null }, 0);
  if (!saved.ok) throw new Error("Draft save failed");
  let now = 1_000_000;
  const calls: { ownerId: string; input: BrowserControlRequest }[] = [], events: string[] = [];
  const workers = new DraftBrowserWorkers(store, root, { createBrowserOwner: async input => {
    events.push("worker:" + input.id); const inputOwner = input.id;
    return { ...input, workerPid: 77, workerFailure: undefined, subscribeWorkerFailure: () => () => {}, dispose: async () => { events.push("dispose:" + input.id); },
      openBrowserEvaluation: async () => { throw new Error("Unexpected evaluator allocation in existing fixture"); }, reserveBrowserEvaluation: async () => { throw new Error("Unexpected reservation in this fixture"); },
      inspectBrowserEvaluationReservation: async () => { throw new Error("Unexpected reservation status in this fixture"); },
      inspectBrowserTab: async () => { throw new Error("Unexpected observation in this fixture"); },
      closeBrowserTab: async () => { throw new Error("No close allowed in this fixture"); },
      getBrowserMetadata: async () => ({ availability: "running", workerPid: 77, tabs: [] }), getBrowserFrame: async () => frame(),
      createBrowserTab: async () => { throw new Error("Control may not create a tab"); },
      controlBrowser: async input => { calls.push({ ownerId: inputOwner, input }); return control ? control(input) : result; },
    };
  } });
  const handler = new DraftBrowserHttp(store, workers, "creation-epoch", () => now);
  cleanups.push(async () => { await handler.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const request = (action: string, extra: Record<string, unknown> = {}, ownerId = "owner", header = store.host.id) => new Request(`http://fixture/v1/draft-browser-owners/${ownerId}/${action}`, {
    method: "POST", headers: { [BROWSER_METADATA_OWNER_HEADER]: header }, body: JSON.stringify({ draftId: "draft", draftRevision: 1, ...extra }),
  });
  const send = async (action: string, extra: Record<string, unknown> = {}, ownerId = "owner", selected = handler) => {
    const response = await selected.route(request(action, extra, ownerId)); if (!response) throw new Error("Control route missing");
    return { status: response.status, body: await response.json() as any };
  };
  const prepare = async (ownerId = "owner", selected = handler): Promise<BrowserControlRequest> => {
    await send("acquire", {}, ownerId, selected); const captured = await send("frame", { target }, ownerId, selected);
    expect(captured.status).toBe(200);
    return { requestId: "action-one", controlEpoch: captured.body.controlEpoch, capturedAt: captured.body.capturedAt, target, context: captured.body.context,
      action: { type: "text", text: "private typed text" } };
  };
  return { root, store, workers, handler, request, send, prepare, calls, events, advance: (ms: number) => { now += ms; } };
}

test("draft controls consume frame epoch, preserve actual owner envelope and dispatch every supported action", async () => {
  const f = fixture(), input = await f.prepare(), before = f.store.getDraft("draft");
  const actions: BrowserHumanAction[] = [{ type: "click", x: 1, y: 1 }, { type: "wheel", x: 0, y: 0, deltaX: 2, deltaY: -2 },
    { type: "key", key: "Enter", modifiers: ["Meta"] }, { type: "text", text: "private typed text" },
    { type: "navigate", url: "https://example.invalid/exact?x=1%20two" }, { type: "reload" }, { type: "back" }, { type: "forward" }, { type: "resize", width: 800, height: 600 }];
  for (const [i, action] of actions.entries()) {
    const sent = { ...input, requestId: "action-" + i, action }, reply = await f.send("control", { control: sent });
    expect(reply.status).toBe(200); expect(reply.body).toEqual({ protocolVersion: 1, hostId: f.store.host.id, ownerKind: "draft", ownerId: "owner",
      requestId: sent.requestId, workerPid: 77, name: target.name, targetId: target.targetId, outcome: "completed", context, url: result.url, title: result.title });
    expect(f.calls.at(-1)).toEqual({ ownerId: "owner", input: sent }); expect(JSON.stringify(reply.body)).not.toContain("private typed text");
  }
  expect(f.calls).toHaveLength(9); expect(f.events).toEqual(["worker:owner"]);
  expect(f.store.getDraft("draft")).toEqual(before); expect(f.store.listSessions()).toEqual([]);
  expect((await f.send("status")).body.ticket.controlEpoch).toBe("creation-epoch");
});

test("owner header, original binding, PID, context, body and URL validation precede control dispatch", async () => {
  const f = fixture(), input = await f.prepare();
  expect((await f.handler.route(f.request("control", { control: input }, "owner", "foreign")))?.status).toBe(409);
  expect((await f.send("control", { control: input, draftRevision: 2 })).status).toBe(503);
  expect((await f.send("control", { control: input, cwd: f.root })).status).toBe(400);
  expect((await f.send("control", { control: { ...input, action: { type: "navigate", url: "javascript:alert(1)" } } })).status).toBe(400);
  expect((await f.send("control", { control: { ...input, action: { type: "click", x: 3, y: 0 } } })).status).toBe(400);
  expect((await f.send("control", { control: { ...input, context: { ...context, documentId: "" } } })).status).toBe(400);
  expect((await f.send("control", { control: { ...input, controlEpoch: "creation-epoch" } })).body.outcome).toBe("rejected");
  expect((await f.send("control", { control: { ...input, target: { ...target, workerPid: 99 } } })).body.outcome).toBe("rejected");
  expect((await f.send("control", { control: input }, "absent")).body.outcome).toBe("rejected");
  const large = new Request("http://fixture/v1/draft-browser-owners/owner/control", { method: "POST", headers: { [BROWSER_METADATA_OWNER_HEADER]: f.store.host.id }, body: "x".repeat(131073) });
  expect((await f.handler.route(large))?.status).toBe(400); expect(f.calls).toHaveLength(0); expect(f.events).toEqual(["worker:owner"]);
});

test("full supported unicode text survives the control-specific body bound", async () => {
  const f = fixture(), input = await f.prepare();
  const action: BrowserHumanAction = { type: "text", text: "界".repeat(16384) };
  expect((await f.send("control", { control: { ...input, action } })).body.outcome).toBe("completed");
  expect(f.calls[0]!.input.action).toEqual(action);
});

test("concurrent exact retries join before dispatch; different input and foreign binding cannot retrieve receipt", async () => {
  const gate = Promise.withResolvers<typeof result>(), f = fixture(() => gate.promise), input = await f.prepare();
  const first = f.send("control", { control: input }), second = f.send("control", { control: input }); await tick(); const count = f.calls.length;
  gate.resolve(result); const [a, b] = await Promise.all([first, second]);
  expect(count).toBe(1); expect(a.body).toEqual(b.body); expect(a.body.outcome).toBe("completed");
  expect((await f.send("control", { control: { ...input, action: { type: "reload" } } })).body.outcome).toBe("rejected");
  expect((await f.send("control", { control: input, draftId: "foreign" })).status).toBe(503);
  expect((await f.send("control", { control: input })).body).toEqual(a.body); expect(f.calls).toHaveLength(1);
  f.advance(121000); expect((await f.send("control", { control: input })).body.outcome).toBe("rejected"); expect(f.calls).toHaveLength(1);
});

test("receipt identity is scoped by actual draft owner even when PID and native target coincide", async () => {
  const f = fixture(), a = await f.prepare(), b = await f.prepare("other");
  expect((await f.send("control", { control: a })).body.ownerId).toBe("owner");
  expect((await f.send("control", { control: b }, "other")).body.ownerId).toBe("other");
  expect(f.calls.map(call => call.ownerId)).toEqual(["owner", "other"]);
});

test("handler reconstruction rotates control epoch without resetting creation epoch or replaying an action", async () => {
  const f = fixture(), input = await f.prepare(); await f.send("control", { control: input });
  const next = new DraftBrowserHttp(f.store, f.workers, "creation-epoch", () => 1_000_000);
  try {
    expect((await f.send("control", { control: input }, "owner", next)).body.outcome).toBe("rejected"); expect(f.calls).toHaveLength(1);
    const fresh = await f.prepare("owner", next);
    expect((await f.send("control", { control: { ...fresh, requestId: "deliberate-next" } }, "owner", next)).body.outcome).toBe("completed");
    expect((await f.send("status", {}, "owner", next)).body.ticket.controlEpoch).toBe("creation-epoch");
    expect(f.calls).toHaveLength(2); expect(f.events).toEqual(["worker:owner"]);
  } finally { await next.dispose(); }
});

test("known preflight rejection, lost response and malformed results remain distinct with no automatic replay", async () => {
  for (const mode of ["rejected", "lost", "wrong-target", "bad-context"] as const) {
    const f = fixture(async () => {
      if (mode === "wrong-target") return { ...result, targetId: "other" };
      if (mode === "bad-context") return { ...result, context: { ...context, documentId: "" } };
      const error = new Error("private native failure"); if (mode === "rejected") error.name = "BrowserActionRejected"; throw error;
    });
    const input = await f.prepare(), a = await f.send("control", { control: input }), b = await f.send("control", { control: input });
    expect(a.body.outcome).toBe(mode === "rejected" ? "rejected" : "unknown"); expect(b.body).toEqual(a.body);
    expect(JSON.stringify(a.body)).not.toContain("private native"); expect(f.calls).toHaveLength(1);
  }
});

for (const mode of ["retire", "shutdown"] as const) test(`late control completion after ${mode} remains unknown and is drained`, async () => {
  const gate = Promise.withResolvers<typeof result>(), f = fixture(() => gate.promise), input = await f.prepare();
  const pending = f.send("control", { control: input }); await tick();
  let done = false;
  const closing = mode === "shutdown" ? f.handler.dispose().then(() => { done = true; }) : f.send("retire");
  await tick(); const early = done; gate.resolve(result); const reply = await pending; await closing;
  expect(reply.body.outcome).toBe("unknown"); expect(f.calls).toHaveLength(1);
  if (mode === "shutdown") { expect(early).toBe(false); expect(done).toBe(true); }
  else expect((await f.send("control", { control: input })).body).toEqual(reply.body);
});

test("shared action admission rechecks owner after a delayed lookup before native dispatch", async () => {
  const engine = new BrowserControlRequests(() => 1000), gate = Promise.withResolvers<void>(); let current = true, calls = 0;
  const handle = { workerPid: 77, controlBrowser: async () => { calls++; return result; } };
  const input: BrowserControlRequest = { requestId: "one", controlEpoch: engine.epoch, capturedAt: 1000, target, context, action: { type: "reload" } };
  const pending = engine.execute("owner", input, { isCurrent: () => current, getExistingHandle: async () => { await gate.promise; return handle; } });
  await tick(); current = false; gate.resolve(); expect((await pending).outcome).toBe("rejected"); expect(calls).toBe(0);
  current = true; expect((await engine.execute("owner", { ...input, requestId: "two" }, { isCurrent: () => current, getExistingHandle: async () => handle })).outcome).toBe("completed"); expect(calls).toBe(1);
});

test("shared action receipts remain bounded and stale evicted requests do not become fresh", async () => {
  let now = 1000, calls = 0; const engine = new BrowserControlRequests(() => now);
  const input: BrowserControlRequest = { requestId: "one", controlEpoch: engine.epoch, capturedAt: now, target, context, action: { type: "reload" } };
  const handle = { workerPid: 77, controlBrowser: async () => { calls++; return result; } };
  const owner = { isCurrent: () => true, getExistingHandle: async () => handle };
  const unavailable = { isCurrent: () => false, getExistingHandle: owner.getExistingHandle };
  for (let i = 0; i < 4096; i++) await engine.execute("owner", { ...input, requestId: "held-" + i }, unavailable);
  expect((await engine.execute("owner", input, owner)).message).toContain("too many"); expect(calls).toBe(0);
  now += 121000; expect((await engine.execute("owner", { ...input, requestId: "held-0" }, owner)).outcome).toBe("rejected"); expect(calls).toBe(0);
  expect((await engine.execute("owner", { ...input, capturedAt: now }, owner)).outcome).toBe("completed"); expect(calls).toBe(1);
});

test("late owner loss during final control lookup cannot publish a successful action", async () => {
  const engine = new BrowserControlRequests(() => 1000), gate = Promise.withResolvers<void>(); let current = true, lookups = 0, calls = 0;
  const handle = { workerPid: 77, controlBrowser: async () => { calls++; return result; } };
  const input: BrowserControlRequest = { requestId: "one", controlEpoch: engine.epoch, capturedAt: 1000, target, context, action: { type: "reload" } };
  const owner = { isCurrent: () => current, getExistingHandle: async () => { if (++lookups === 2) await gate.promise; return handle; } };
  const pending = engine.execute("owner", input, owner); await tick(); const reached = lookups;
  current = false; gate.resolve(); const receipt = await pending;
  expect(reached).toBe(2); expect(receipt.outcome).toBe("unknown"); expect(calls).toBe(1);
  current = true; expect(await engine.execute("owner", input, owner)).toEqual(receipt); expect(calls).toBe(1);
  expect((await engine.execute("owner", { ...input, requestId: "fresh" }, owner)).outcome).toBe("completed"); expect(calls).toBe(2);
});
