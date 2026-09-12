import { afterEach, expect, test } from "bun:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserControlRequest, type DraftBrowserBridge } from "@agent-desktop/shared";
import { jpeg3x2 } from "../../../../packages/shared/src/fixtures/browser-frame";
import { registerDraftBrowserHandlers } from "./draft-browser-ipc";
import { createDraftBrowserBridge } from "./draft-browser-preload";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const reference = { ownerId: "owner", draftId: "draft", draftRevision: 1 };
const creation = { requestId: "create-one", controlEpoch: "epoch", observedAt: 1000, initialUrl: "https://example.invalid/a%20b" };
const target = { workerPid: 21, name: "desktop-create-one", targetId: "native-one" };
const context = { documentId: "document", width: 3, height: 2, scrollX: 0, scrollY: 0 };
const tab = { name: target.name, targetId: target.targetId, backend: "worker", kindTag: "headless", state: "alive", url: creation.initialUrl, title: "Observed", viewport: { width: 3, height: 2 } };
const action = (): BrowserControlRequest => ({ requestId: "action-one", controlEpoch: "epoch", capturedAt: 1000,
  target: { ...target }, context: { ...context }, action: { type: "key", key: "Enter", modifiers: ["Shift"] } });
const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(options: { lookup?: Promise<void>; wrongHost?: boolean } = {}) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: any[]) => any>();
  const registered: Pick<IpcMain, "handle"> = { handle: (channel, listener) => { if (handlers.has(channel)) throw new Error("Duplicate handler"); handlers.set(channel, listener); } };
  const event = {} as IpcMainInvokeEvent;
  let trusted = true, unavailable = false, failResponse = false;
  const lookups: string[] = [], requests: { action: string; body: any; host: string | null; authorization: string | null }[] = [];
  registerDraftBrowserHandlers(registered, () => { if (!trusted) throw new Error("Untrusted frame"); }, async hostId => {
    lookups.push(hostId); await options.lookup;
    if (unavailable) throw new Error("Host unavailable");
    return { hostId: options.wrongHost ? "foreign" : hostId, origin: "https://fixture.invalid", token: "main-only-fixture-token" };
  });
  const bridge = createDraftBrowserBridge((channel, ...args) => {
    const handler = handlers.get(channel); if (!handler) return Promise.reject(new Error("Missing handler"));
    return handler(event, ...args);
  });
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url, init), body = await req.json() as any, operation = new URL(req.url).pathname.split("/").at(-1)!;
    requests.push({ action: operation, body, host: req.headers.get(BROWSER_METADATA_OWNER_HEADER), authorization: req.headers.get("authorization") });
    if (failResponse) throw new Error("Response lost");
    const base = { protocolVersion: 1, hostId: "host", ownerId: "owner" };
    const identity = { ...base, ownerKind: "draft" };
    const receipt = { ...identity, requestId: body.creation?.requestId, outcome: "completed", workerPid: 21, tab, targetDisposition: "created-page" };
    let response: unknown;
    if (["acquire", "status", "retire"].includes(operation)) {
      const state = operation === "retire" ? "retired" : "ready";
      response = { ...base, state, ...(state === "ready" ? { workerPid: 21 } : {}), ticket: { controlEpoch: "epoch", observedAt: 1000 },
        record: { version: 1, kind: "draft", hostId: "host", id: "owner", draftId: "draft", draftRevision: 1,
          projectId: null, cwd: "/host-only", createdAt: 1, ...(state === "retired" ? { retiredAt: 2 } : {}) } };
    } else if (operation === "open" || operation === "create") response = receipt;
    else if (operation === "creation-status") response = { ...identity, requestId: body.creation.requestId, status: "settled", receipt };
    else if (operation === "metadata") response = { ...identity, availability: "running", workerPid: 21, tabs: [tab], controlEpoch: "epoch" };
    else if (operation === "frame") response = { ...identity, ...tab, workerPid: 21, width: 3, height: 2, capturedAt: 1000, mimeType: "image/jpeg", data: jpeg3x2, context, controlEpoch: "epoch" };
    else if (operation === "control") response = { ...identity, ...target, requestId: body.control.requestId, outcome: "completed", context, url: creation.initialUrl, title: "Observed" };
    else throw new Error("Unexpected route: " + operation);
    return Response.json(response, { headers: { [BROWSER_METADATA_OWNER_HEADER]: "host" } });
  }) as typeof fetch;
  return { bridge, requests, lookups, untrust: () => { trusted = false; }, loseHost: () => { unavailable = true; }, loseResponse: () => { failResponse = true; } };
}

const calls: ((bridge: DraftBrowserBridge) => Promise<unknown>)[] = [
  b => b.acquire(reference, "host"), b => b.status(reference, "host"), b => b.retire(reference, "host"),
  b => b.create(reference, creation, "host"), b => b.creationStatus(reference, creation, "host"),
  b => b.metadata(reference, "host"), b => b.frame(reference, target, "host"), b => b.control(reference, action(), "host"),
];

test("actual preload adapter and registered handlers route all eight operations only to explicit draft host", async () => {
  const f = fixture(), results: unknown[] = [];
  for (const call of calls) results.push(await call(f.bridge));
  expect(f.requests.map(r => r.action)).toEqual(["acquire", "status", "retire", "open", "creation-status", "metadata", "frame", "control"]);
  expect(f.lookups).toEqual(Array(8).fill("host"));
  for (const request of f.requests) {
    expect(request.host).toBe("host"); expect(request.authorization).toBe("Bearer main-only-fixture-token");
    expect(request.body).toMatchObject({ draftId: "draft", draftRevision: 1 });
    expect("sessionId" in request.body).toBe(false);
  }
  expect(results[0]).toMatchObject({ state: "ready", workerPid: 21 });
  expect(results[2]).toMatchObject({ state: "retired" });
  expect(results[3]).toMatchObject({ outcome: "completed", tab });
  expect(results[4]).toMatchObject({ status: "settled" });
  expect(results[5]).toMatchObject({ availability: "running", tabs: [tab] });
  expect(results[6]).toMatchObject({ data: jpeg3x2, context });
  expect(results[7]).toMatchObject({ outcome: "completed", context });
  expect(JSON.stringify(results)).not.toContain("main-only-fixture-token");
  expect(JSON.stringify(results)).not.toContain("/host-only");
});

test("every operation rejects an untrusted caller before host lookup or dispatch", async () => {
  const f = fixture(); f.untrust();
  for (const call of calls) await expect(call(f.bridge)).rejects.toThrow("Untrusted frame");
  expect(f.lookups).toEqual([]); expect(f.requests).toEqual([]);
});

test("invalid host, draft and payload do not discover or dispatch to a default host", async () => {
  const f = fixture();
  for (const host of [undefined, "", "bad\0host", "h".repeat(201)]) await expect(f.bridge.status(reference, host as string)).rejects.toThrow("owning host");
  for (const bad of [null, [], { ...reference, ownerId: "" }, { ...reference, draftId: "bad\n" }, { ...reference, draftRevision: 0 }]) {
    await expect(f.bridge.acquire(bad as typeof reference, "host")).rejects.toThrow("original draft");
  }
  await expect(f.bridge.create(reference, { ...creation, initialUrl: "file:///tmp/private" }, "host")).rejects.toThrow();
  await expect(f.bridge.frame(reference, { ...target, workerPid: 0 }, "host")).rejects.toThrow("viewport");
  await expect(f.bridge.control(reference, { ...action(), requestId: "" }, "host")).rejects.toThrow();
  expect(f.lookups).toEqual([]); expect(f.requests).toEqual([]);
});

test("held host lookup keeps original draft, URL, frame and nested action ownership", async () => {
  const g = gate(), f = fixture({ lookup: g.promise });
  const ref = { ...reference }, request = { ...creation }, frame = { ...target }, control = action();
  const pending = [f.bridge.create(ref, request, "host"), f.bridge.frame(ref, frame, "host"), f.bridge.control(ref, control, "host")];
  ref.ownerId = "replacement"; ref.draftId = "other"; ref.draftRevision = 2;
  request.initialUrl = "https://wrong.invalid"; frame.targetId = "replacement";
  control.target.targetId = "replacement"; control.context.documentId = "replacement";
  if (control.action.type === "key") control.action.modifiers!.push("Meta");
  expect(f.requests).toEqual([]); g.resolve();
  await Promise.all(pending);
  expect(f.requests.map(r => r.body.draftId)).toEqual(["draft", "draft", "draft"]);
  expect(f.requests[0]!.body.creation.initialUrl).toBe(creation.initialUrl);
  expect(f.requests[1]!.body.target).toEqual(target);
  expect(f.requests[2]!.body.control).toEqual(action());
});

test("untrusted frame after asynchronous lookup suppresses every not-yet-sent operation", async () => {
  const g = gate(), f = fixture({ lookup: g.promise });
  const pending = calls.map(call => call(f.bridge).then(() => "sent", e => (e as Error).message));
  await tick(); expect(f.lookups).toHaveLength(8); f.untrust(); g.resolve();
  expect(await Promise.all(pending)).toEqual(Array(8).fill("Untrusted frame")); expect(f.requests).toEqual([]);
});

test("foreign or unavailable resolved endpoint does not fall back or acquire", async () => {
  const f = fixture({ wrongHost: true });
  await expect(f.bridge.metadata(reference, "host")).rejects.toThrow("host changed"); expect(f.requests).toEqual([]);
  const missing = fixture(); missing.loseHost();
  await expect(missing.bridge.status(reference, "host")).rejects.toThrow("Host unavailable"); expect(missing.requests).toEqual([]);
});

test("lost mutation responses propagate unconfirmed failure with no bridge retry or retirement", async () => {
  const f = fixture(); f.loseResponse();
  await expect(f.bridge.create(reference, creation, "host")).rejects.toThrow("Response lost");
  await tick(); expect(f.requests.map(r => r.action)).toEqual(["open"]);
  expect(f.requests[0]!.body.creation).toEqual(creation);
});
