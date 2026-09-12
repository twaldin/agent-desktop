import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserCreateRequest, type BrowserControlRequest } from "@agent-desktop/shared";
import { jpeg3x2 } from "../../../../packages/shared/src/fixtures/browser-frame";
import { HostStore } from "../../../host/src/store";
import { DraftBrowserWorkers } from "../../../host/src/browser-draft-workers";
import { DraftBrowserHttp } from "../../../host/src/draft-browser-http";
import { DraftBrowserTransport } from "./draft-browser-transport";

const originalFetch = globalThis.fetch;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { globalThis.fetch = originalFetch; for (const cleanup of cleanups.splice(0)) await cleanup(); });
const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const target = { workerPid: 21, name: "desktop-create-one", targetId: "native-one" };
const context = { documentId: "document", width: 3, height: 2, scrollX: 0, scrollY: 0, navigation: { entryId: 1, canGoBack: false, canGoForward: false } };
const tab = { name: target.name, targetId: target.targetId, backend: "worker" as const, kindTag: "headless" as const, state: "alive" as const,
  url: "https://example.invalid/observed", title: "Observed", viewport: { width: 3, height: 2 } };
const input: BrowserCreateRequest = { requestId: "create-one", controlEpoch: "creation-epoch", observedAt: 1_000_000, initialUrl: "https://example.invalid/one%20two" };
function fixture(options: { createGate?: Promise<void>; failure?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "draft-browser-transport-"))), store = new HostStore(root);
  if (!store.putDraft({ id: "draft", text: "unsent text", projectId: null, model: null }, 0).ok) throw new Error("Draft save failed");
  const effects: string[] = [], requests: Request[] = [];
  const workers = new DraftBrowserWorkers(store, root, { createBrowserOwner: async owner => {
    effects.push("acquire");
    return { ...owner, workerPid: 21, workerFailure: undefined, subscribeWorkerFailure: () => () => {}, dispose: async () => { effects.push("dispose"); },
      openBrowserEvaluation: async () => { throw new Error("Unexpected evaluator allocation in existing fixture"); }, reserveBrowserEvaluation: async () => { throw new Error("Unexpected reservation in this fixture"); },
      inspectBrowserEvaluationReservation: async () => { throw new Error("Unexpected reservation status in this fixture"); },
      inspectBrowserTab: async () => { throw new Error("Unexpected observation in this fixture"); },
      closeBrowserTab: async () => { throw new Error("No close allowed in this fixture"); },
      getBrowserMetadata: async () => ({ availability: "running", workerPid: 21, tabs: [tab] }),
      getBrowserFrame: async () => ({ ...tab, context, capturedAt: 1_000_000, mimeType: "image/jpeg", data: jpeg3x2, width: 3, height: 2 }),
      createBrowserTab: async (name, url) => {
        effects.push("create:" + String(url)); expect(store.draftBrowserCreations.get("owner", { ...input, requestId: name.slice(8), initialUrl: url })?.state).toBe("pending");
        await options.createGate; if (options.failure) throw new Error(options.failure);
        return { tab: { ...tab, name }, targetDisposition: "created-page" };
      },
      controlBrowser: async request => { effects.push("control:" + request.action.type); return { ...tab, context }; },
    };
  } });
  const handler = new DraftBrowserHttp(store, workers, "creation-epoch", () => 1_000_000);
  let alter: ((response: Response, request: Request) => Promise<Response>) | undefined;
  const endpoint = { hostId: store.host.id, origin: "http://fixture.invalid", token: "fixture-token" }, reference = { ownerId: "owner", draftId: "draft", draftRevision: 1 };
  const transport = new DraftBrowserTransport(endpoint, reference);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const request = new Request(url, init); requests.push(request.clone());
    expect(request.headers.get("authorization")).toBe("Bearer fixture-token"); expect(request.redirect).toBe("error");
    const response = await handler.route(request); if (!response) throw new Error("Unexpected transport route");
    return alter ? alter(response, request) : response;
  }) as typeof fetch;
  cleanups.push(async () => { await handler.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const change = (fn: (body: any) => void, status?: number) => {
    alter = async response => { const body = await response.json(); fn(body); return Response.json(body, { status: status ?? response.status, headers: response.headers }); };
  };
  return { store, handler, transport, effects, requests, endpoint, reference, change,
    alter: (fn?: (response: Response, request: Request) => Promise<Response>) => { alter = fn; } };
}

test("draft transport covers actual owner/create/observe/metadata/frame/control/retire handlers without session fallback", async () => {
  const f = fixture(), before = f.store.getDraft("draft");
  expect((await f.transport.owner("status")).state).toBe("absent"); expect(f.effects).toEqual([]);
  expect((await f.transport.creationStatus(input)).status).toBe("unavailable");
  const ready = await f.transport.owner("acquire"); expect(ready.state).toBe("ready"); expect(ready.ticket).toEqual({ controlEpoch: input.controlEpoch, observedAt: input.observedAt });
  expect("record" in ready).toBe(false); expect("cwd" in ready).toBe(false);
  const created = await f.transport.create(input); expect(created).toMatchObject({ ownerKind: "draft", ownerId: "owner", outcome: "completed", tab });
  expect((await f.transport.creationStatus(input))).toMatchObject({ status: "settled", receipt: created });
  expect((await f.transport.metadata())).toMatchObject({ availability: "running", tabs: [tab] });
  const captured = await f.transport.frame(target);
  const control: BrowserControlRequest = { requestId: "action-one", controlEpoch: captured.controlEpoch, capturedAt: captured.capturedAt, target, context: captured.context!, action: { type: "click", x: 1, y: 1 } };
  expect(await f.transport.control(control)).toMatchObject({ ownerKind: "draft", ownerId: "owner", requestId: "action-one", outcome: "completed", context });
  expect((await f.transport.owner("retire")).state).toBe("retired");
  expect((await f.transport.metadata()).availability).toBe("unavailable");
  expect(f.effects).toEqual(["acquire", "create:" + input.initialUrl, "control:click", "dispose"]);
  expect(f.store.getDraft("draft")).toEqual(before); expect(f.store.listSessions()).toEqual([]);
  expect(f.requests.every(request => new URL(request.url).pathname.startsWith("/v1/draft-browser-owners/owner/"))).toBe(true);
});

test("transport captures original endpoint, reference and input before asynchronous submission", async () => {
  const gate = Promise.withResolvers<void>(), f = fixture({ createGate: gate.promise }); await f.transport.owner("acquire");
  const submitted = { ...input }, pending = f.transport.create(submitted); await tick();
  f.endpoint.hostId = "different-host"; f.endpoint.origin = "http://other.invalid"; f.endpoint.token = "different-token";
  f.reference.ownerId = "different-owner"; f.reference.draftId = "different-draft"; f.reference.draftRevision = 9; submitted.initialUrl = "https://example.invalid/changed";
  gate.resolve(); const receipt = await pending;
  expect(receipt).toMatchObject({ hostId: f.store.host.id, ownerId: "owner", requestId: input.requestId, outcome: "completed" });
  expect(f.effects).toEqual(["acquire", "create:" + input.initialUrl]);
  expect((await f.transport.owner("status")).ownerId).toBe("owner");
  const sent = await f.requests[1]!.json(); expect(sent).toEqual({ draftId: "draft", draftRevision: 1, creation: input });
});

test("transport distinguishes pending, retained completion and unknown without automatic resubmission", async () => {
  const gate = Promise.withResolvers<void>(), f = fixture({ createGate: gate.promise }); await f.transport.owner("acquire");
  const pending = f.transport.create(input); await tick(); const observed = await f.transport.creationStatus(input);
  gate.resolve(); const done = await pending; expect(observed.status).toBe("pending");
  expect(await f.transport.create(input)).toEqual(done); expect(f.effects.filter(effect => effect.startsWith("create:"))).toHaveLength(1);
  const g = fixture({ failure: "lost native response" }); await g.transport.owner("acquire");
  const unknown = await g.transport.create(input); expect(unknown.outcome).toBe("unknown");
  expect(await g.transport.creationStatus(input)).toMatchObject({ status: "settled", receipt: unknown }); expect(g.effects.filter(effect => effect.startsWith("create:"))).toHaveLength(1);
});

test("network loss after actual creation does not retry or replace with a blank request", async () => {
  const f = fixture(); await f.transport.owner("acquire");
  f.alter(async () => { throw new Error("Connection lost after response"); });
  await expect(f.transport.create(input)).rejects.toThrow("Connection lost");
  expect(f.requests.map(request => new URL(request.url).pathname.split("/").at(-1))).toEqual(["acquire", "open"]);
  expect(f.effects).toEqual(["acquire", "create:" + input.initialUrl]);
  f.alter(); expect(await f.transport.creationStatus(input)).toMatchObject({ status: "settled", receipt: { outcome: "completed" } });
  expect(f.effects.filter(effect => effect.startsWith("create:"))).toHaveLength(1);
});

test("coded HTTP errors, missing endpoints and foreign response headers never turn into creation rejection or fallback", async () => {
  const f = fixture(); await f.transport.owner("acquire");
  for (const status of [400, 401, 404, 409, 503]) {
    f.alter(async response => Response.json({ error: { code: "DRAFT_BROWSER_UNAVAILABLE", message: "private error" } }, { status, headers: response.headers }));
    const count = f.requests.length; await expect(f.transport.owner("status")).rejects.toThrow(`(${status})`); expect(f.requests).toHaveLength(count + 1);
  }
  f.alter(async response => { const headers = new Headers(response.headers); headers.set(BROWSER_METADATA_OWNER_HEADER, "foreign"); return new Response(response.body, { headers }); });
  const count = f.requests.length; await expect(f.transport.create(input)).rejects.toThrow("another host"); expect(f.requests).toHaveLength(count + 1);
  expect(f.effects.filter(effect => effect.startsWith("create:"))).toHaveLength(1);
});

test("owner status requires the original record and rejects contradictory availability without exporting paths", async () => {
  const f = fixture(); await f.transport.owner("acquire");
  for (const change of [(b: any) => { b.ownerId = "other"; }, (b: any) => { b.sessionId = "invented"; }, (b: any) => { b.record.draftRevision = 9; },
    (b: any) => { delete b.record; }, (b: any) => { delete b.workerPid; }, (b: any) => { b.error = "failed worker"; }, (b: any) => { b.state = "absent"; }, (b: any) => { b.record.retiredAt = b.record.createdAt; }]) {
    f.change(change); await expect(f.transport.owner("status")).rejects.toThrow();
  }
  f.alter(); expect((await f.transport.owner("status")).state).toBe("ready");
});

test("shared creation projection rejects changed owner/request/PID/native target and nested observation corruption", async () => {
  const f = fixture(); await f.transport.owner("acquire"); await f.transport.create(input);
  for (const change of [(b: any) => { b.requestId = "other"; }, (b: any) => { b.ownerKind = "session"; }, (b: any) => { b.workerPid = 0; },
    (b: any) => { b.tab.name = "other"; }, (b: any) => { b.targetDisposition = "adopted-existing-target"; }]) {
    f.change(change); await expect(f.transport.create(input)).rejects.toThrow();
  }
  f.change(b => { b.receipt.ownerId = "other"; }); await expect(f.transport.creationStatus(input)).rejects.toThrow();
  f.change(b => { b.status = "pending"; }); await expect(f.transport.creationStatus(input)).rejects.toThrow();
  f.alter(); expect(f.effects.filter(effect => effect.startsWith("create:"))).toHaveLength(1);
});

test("metadata/frame/control responses are projected and checked against exact target and document bounds", async () => {
  const f = fixture(); await f.transport.owner("acquire");
  f.change(b => { b.tabs.push(b.tabs[0]); }); await expect(f.transport.metadata()).rejects.toThrow("Duplicate");
  f.change(b => { b.workerPid = 22; }); await expect(f.transport.frame(target)).rejects.toThrow("worker");
  f.change(b => { b.width = 4; }); await expect(f.transport.frame(target)).rejects.toThrow("dimensions");
  f.change(b => { b.extra = "private"; }); const captured = await f.transport.frame(target); expect("extra" in captured).toBe(false);
  const control: BrowserControlRequest = { requestId: "control-one", controlEpoch: captured.controlEpoch, capturedAt: captured.capturedAt, target, context: captured.context!, action: { type: "reload" } };
  f.change(b => { b.targetId = "different"; }); await expect(f.transport.control(control)).rejects.toThrow("unconfirmed");
  f.change(b => { b.context.documentId = ""; }); await expect(f.transport.control(control)).rejects.toThrow("document context");
  f.alter(); expect((await f.transport.control(control)).outcome).toBe("completed"); expect(f.effects.filter(effect => effect.startsWith("control:"))).toHaveLength(1);
});

test("bounded reads cancel oversized responses, and invalid caller input performs no fetch", async () => {
  const f = fixture();
  expect(() => new DraftBrowserTransport(f.endpoint, { ...f.reference, draftRevision: 0 })).toThrow();
  expect(() => new DraftBrowserTransport({ ...f.endpoint, origin: "https://example.invalid/path" }, f.reference)).toThrow();
  await expect(f.transport.create({ ...input, initialUrl: "javascript:alert(1)" })).rejects.toThrow();
  await expect(f.transport.frame({ ...target, workerPid: 0 })).rejects.toThrow(); expect(f.requests).toHaveLength(0);
  await f.transport.owner("acquire"); let cancelled = false;
  f.alter(async response => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('"' + 'x'.repeat(33000) + '"')); }, cancel() { cancelled = true; } }), { headers: response.headers }));
  await expect(f.transport.create(input)).rejects.toThrow("exceeds"); expect(cancelled).toBe(true); expect(f.effects.filter(effect => effect.startsWith("create:"))).toHaveLength(1);
});
