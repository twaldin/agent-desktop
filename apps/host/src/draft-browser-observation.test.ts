import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserFrameTarget, type BrowserMetadataAvailability, type NativeBrowserFrame } from "@agent-desktop/shared";
import { jpeg3x2 } from "../../../packages/shared/src/fixtures/browser-frame";
import { HostStore } from "./store";
import { DraftBrowserWorkers } from "./browser-draft-workers";
import { DraftBrowserHttp } from "./draft-browser-http";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const target: BrowserFrameTarget = { workerPid: 91, name: "browser-one", targetId: "native-one" };
const tab = { name: target.name, targetId: target.targetId, backend: "worker" as const, kindTag: "headless" as const, state: "alive" as const,
  url: "https://example.invalid/observed", title: "Observed page", viewport: { width: 3, height: 2 } };
const frame = (selected = target): NativeBrowserFrame => ({ name: selected.name, targetId: selected.targetId, capturedAt: 100,
  mimeType: "image/jpeg", data: jpeg3x2, width: 3, height: 2, url: tab.url, title: tab.title });
function fixture(options: { metadata?: () => Promise<BrowserMetadataAvailability>; frame?: (selected: BrowserFrameTarget) => Promise<NativeBrowserFrame> } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "draft-browser-observation-"))), store = new HostStore(root);
  const saved = store.putDraft({ id: "draft", text: "unsent draft", projectId: null, model: null }, 0);
  if (!saved.ok) throw new Error("Draft save failed");
  const events: string[] = [];
  const workers = new DraftBrowserWorkers(store, root, { createBrowserOwner: async input => {
    events.push("worker:" + input.id);
    return { ...input, workerPid: 91, workerFailure: undefined, subscribeWorkerFailure: () => () => {}, dispose: async () => { events.push("dispose:" + input.id); },
      openBrowserEvaluation: async () => { throw new Error("Unexpected evaluator allocation in existing fixture"); }, reserveBrowserEvaluation: async () => { throw new Error("Unexpected reservation in this fixture"); },
      inspectBrowserEvaluationReservation: async () => { throw new Error("Unexpected reservation status in this fixture"); },
      inspectBrowserTab: async () => { throw new Error("Unexpected observation in this fixture"); },
      closeBrowserTab: async () => { throw new Error("No close allowed in this fixture"); },
      getBrowserMetadata: async () => { events.push("metadata:" + input.id); return options.metadata ? options.metadata() : { availability: "running", workerPid: 91, tabs: [tab] }; },
      getBrowserFrame: async selected => { events.push("frame:" + input.id + ":" + selected.name); return options.frame ? options.frame(selected) : frame(selected); },
      createBrowserTab: async () => { throw new Error("No native creation allowed"); }, controlBrowser: async () => { throw new Error("No control allowed"); },
    };
  } });
  const handler = new DraftBrowserHttp(store, workers, "epoch-observation", () => 1000);
  cleanups.push(async () => { await handler.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const request = (action: string, extra: Record<string, unknown> = {}, ownerId = "owner", header = store.host.id) => new Request(`http://fixture/v1/draft-browser-owners/${ownerId}/${action}`, {
    method: "POST", headers: { [BROWSER_METADATA_OWNER_HEADER]: header }, body: JSON.stringify({ draftId: "draft", draftRevision: 1, ...extra }),
  });
  const send = async (action: string, extra: Record<string, unknown> = {}, ownerId = "owner", selected = handler) => {
    const response = await selected.route(request(action, extra, ownerId)); if (!response) throw new Error("Observation route missing");
    return { response, status: response.status, body: await response.json() as any };
  };
  return { store, workers, handler, events, request, send };
}

test("read-only missing owners never allocate, and strict host/binding/target gates prevent probes", async () => {
  const f = fixture();
  expect((await f.send("metadata")).body).toMatchObject({ ownerKind: "draft", ownerId: "owner", availability: "not-started" });
  expect((await f.send("frame", { target })).status).toBe(409);
  expect(f.store.draftBrowserOwners.get("owner")).toBeUndefined(); expect(f.events).toEqual([]);
  expect((await f.handler.route(f.request("metadata", {}, "owner", "foreign")))?.status).toBe(409);
  for (const extra of [{ target: { ...target, workerPid: 0 } }, { target: { ...target, targetId: "" } }, { target: { ...target, extra: true } }, {}]) expect((await f.send("frame", extra)).status).toBe(400);
  expect((await f.send("metadata", { target })).status).toBe(400);
  expect((await f.send("metadata", { cwd: "/ignored" })).status).toBe(400);
  await f.send("acquire");
  expect((await f.send("metadata", { draftId: "different" })).status).toBe(503);
  expect((await f.send("frame", { target: { ...target, workerPid: 92 } })).status).toBe(409);
  expect(f.events).toEqual(["worker:owner"]);
});

test("metadata/frame project bounded native fields, keep draft ownership and make no session or journal", async () => {
  const f = fixture({ metadata: async () => ({ availability: "running", workerPid: 91, tabs: [{ ...tab, privateDetail: "omit" }] }),
    frame: async () => ({ ...frame(), privateDetail: "omit" }) });
  await f.send("acquire"); const before = f.store.getDraft("draft");
  const metadata = await f.send("metadata"), image = await f.send("frame", { target });
  expect(metadata.status).toBe(200); expect(image.status).toBe(200);
  expect(metadata.body.controlEpoch).toMatch(/^[a-zA-Z0-9-]{1,100}$/);
  expect(metadata.body).toEqual({ protocolVersion: 1, ownerKind: "draft", hostId: f.store.host.id, ownerId: "owner", workerPid: 91, controlEpoch: metadata.body.controlEpoch, availability: "running", tabs: [tab] });
  expect(image.body).toEqual({ protocolVersion: 1, ownerKind: "draft", hostId: f.store.host.id, ownerId: "owner", workerPid: 91, controlEpoch: metadata.body.controlEpoch, ...frame() });
  expect(image.response.headers.get("Cache-Control")).toBe("no-store"); expect(image.response.headers.get(BROWSER_METADATA_OWNER_HEADER)).toBe(f.store.host.id);
  expect("sessionId" in image.body).toBe(false); expect(f.store.listSessions()).toEqual([]); expect(f.store.getDraft("draft")).toEqual(before);
  expect(f.events).toEqual(["worker:owner", "metadata:owner", "frame:owner:browser-one"]);
});

test("malformed metadata and different worker PID fail closed; unavailable native state remains explicit", async () => {
  let value: unknown = { availability: "running", workerPid: 92, tabs: [tab] };
  const f = fixture({ metadata: async () => value as BrowserMetadataAvailability }); await f.send("acquire");
  for (const invalid of [value, { availability: "running", workerPid: 91, tabs: [tab, tab] }, { availability: "running", workerPid: 91, tabs: Array(1001).fill(tab) },
    { availability: "running", workerPid: 91, tabs: [{ ...tab, targetId: "" }] }, { availability: "unavailable", reason: "" }, null]) {
    value = invalid; const reply = await f.send("metadata"); expect(reply.status).toBe(503); expect(reply.body.tabs).toBeUndefined();
  }
  for (const availability of ["not-started", "unavailable"] as const) {
    const expected = { availability, reason: "Configured browser is unavailable" };
    value = expected;
    expect((await f.send("metadata")).body).toMatchObject(expected);
  }
});

test("malformed JPEG, target mismatch and capture exceptions return no frame and allow a new read", async () => {
  let value: NativeBrowserFrame = frame();
  const f = fixture({ frame: async () => { if (value.title === "throw") throw new Error("private native detail"); return value; } }); await f.send("acquire");
  for (const invalid of [{ ...frame(), targetId: "different" }, { ...frame(), width: 4 }, { ...frame(), data: "AAAA" }, { ...frame(), title: "throw" }]) {
    value = invalid; const reply = await f.send("frame", { target }); expect(reply.status).toBe(503); expect(reply.body.data).toBeUndefined(); expect(JSON.stringify(reply.body)).not.toContain("private native detail");
  }
  value = frame(); expect((await f.send("frame", { target })).status).toBe(200);
});

test("identical active reads coalesce, completed reads are not cached, and owner identities do not share", async () => {
  const gate = Promise.withResolvers<void>();
  const f = fixture({ frame: async selected => { await gate.promise; return frame(selected); } });
  await f.send("acquire"); await f.send("acquire", {}, "other");
  const a = f.send("frame", { target }), b = f.send("frame", { target }), c = f.send("frame", { target }, "other"); await tick();
  const pendingEvents = [...f.events]; gate.resolve(); const replies = await Promise.all([a, b, c]);
  expect(pendingEvents.filter(x => x.startsWith("frame:"))).toEqual(["frame:owner:browser-one", "frame:other:browser-one"]);
  expect(replies.map(reply => reply.status)).toEqual([200, 200, 200]); expect(replies[0]!.body).toEqual(replies[1]!.body);
  expect(replies[2]!.body.ownerId).toBe("other"); await f.send("frame", { target });
  expect(f.events.filter(x => x.startsWith("frame:"))).toHaveLength(3);
});

test("eight shared metadata/frame slots bound pending native reads; joined reads need no extra slot", async () => {
  const gate = Promise.withResolvers<void>();
  const f = fixture({ metadata: async () => { await gate.promise; return { availability: "running", workerPid: 91, tabs: [tab] }; },
    frame: async selected => { await gate.promise; return frame(selected); } }); await f.send("acquire");
  const pending = [f.send("metadata"), ...Array.from({ length: 7 }, (_, i) => f.send("frame", { target: { ...target, name: "tab-" + i } }))];
  await tick(); const joined = f.send("metadata"), refused = await f.send("frame", { target });
  const count = f.events.filter(x => x.startsWith("metadata:") || x.startsWith("frame:")).length;
  gate.resolve(); const replies = await Promise.all([...pending, joined]);
  expect(refused.status).toBe(429); expect(count).toBe(8); expect(replies.every(reply => reply.status === 200)).toBe(true);
  expect((await f.send("frame", { target })).status).toBe(200);
});

for (const action of ["metadata", "frame"] as const) test(`retirement while ${action} is held suppresses the late result without reacquisition`, async () => {
  const gate = Promise.withResolvers<void>();
  const f = fixture({ metadata: async () => { await gate.promise; return { availability: "running", workerPid: 91, tabs: [tab] }; }, frame: async () => { await gate.promise; return frame(); } });
  await f.send("acquire"); const reading = f.send(action, action === "frame" ? { target } : {}); await tick();
  const retired = await f.send("retire"); gate.resolve(); const reply = await reading;
  expect(retired.body.state).toBe("retired"); expect(reply.status).toBe(503); expect(reply.body.data).toBeUndefined(); expect(reply.body.tabs).toBeUndefined();
  expect((await f.send("metadata")).body.availability).toBe("unavailable"); expect(f.events.filter(x => x.startsWith("worker:"))).toEqual(["worker:owner"]);
});

test("shutdown waits for outstanding reads even when worker cleanup finishes first", async () => {
  const gate = Promise.withResolvers<NativeBrowserFrame>(), f = fixture({ frame: async () => gate.promise }); await f.send("acquire");
  const reading = f.send("frame", { target }); await tick();
  let done = false; const closing = f.handler.dispose().then(() => { done = true; }); await tick(); const early = done;
  gate.resolve(frame()); const reply = await reading; await closing;
  expect(early).toBe(false); expect(done).toBe(true); expect(reply.status).toBe(503); expect(reply.body.data).toBeUndefined();
  expect((await f.send("metadata")).status).toBe(503);
});

test("lost registry history remains unavailable after handler recreation, never starts another worker", async () => {
  const f = fixture(); await f.send("acquire"); await f.workers.dispose();
  let starts = 0; const other = new DraftBrowserWorkers(f.store, f.store.draftBrowserOwners.get("owner")!.cwd, { createBrowserOwner: async () => { starts++; throw new Error("No replacement"); } });
  const handler = new DraftBrowserHttp(f.store, other, "next-epoch");
  try {
    expect((await f.send("metadata", {}, "owner", handler)).body.availability).toBe("unavailable");
    expect((await f.send("frame", { target }, "owner", handler)).status).toBe(409); expect(starts).toBe(0);
  } finally { await handler.dispose(); }
});
