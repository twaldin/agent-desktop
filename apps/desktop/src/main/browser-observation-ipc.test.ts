import { afterEach, expect, test } from "bun:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserFrameTarget } from "@agent-desktop/shared";
import type { BrowserObservationOwner, BrowserTargetObservation } from "../../../../packages/shared/src/browser-observation";
import { createBrowserObservationBridge } from "./browser-observation-preload";
import { registerBrowserObservationHandlers } from "./browser-observation-ipc";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const target: BrowserFrameTarget = { workerPid: 51, name: "main", targetId: "original" };
const session: BrowserObservationOwner = { kind: "session", sessionId: "session" };
const draft: BrowserObservationOwner = { kind: "draft", ownerId: "owner", draftId: "draft", draftRevision: 1 };
const result = (owner: BrowserObservationOwner): BrowserTargetObservation => ({ protocolVersion: 1, hostId: "host", owner, ...target,
  ownerId: owner.kind === "session" ? owner.sessionId : owner.ownerId, kindTag: "headless", presence: "present" });
const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: any[]) => unknown>();
  const ipc: Pick<IpcMain, "handle"> = { handle(channel, listener) {
    if (handlers.has(channel)) throw new Error("Duplicate handler"); handlers.set(channel, listener);
  } };
  let trusted = true, foreign = false, endpointGate: Promise<void> | undefined, responseGate: Promise<void> | undefined;
  let selectedOwner: BrowserObservationOwner = session;
  const requests: Request[] = [], lookups: string[] = [], channels: string[] = [];
  registerBrowserObservationHandlers(ipc, () => { if (!trusted) throw new Error("Untrusted sender"); }, async hostId => {
    lookups.push(hostId); await endpointGate; return { hostId: foreign ? "other" : hostId, origin: "https://fixture.invalid", token: "main-fixture-token" };
  });
  const invoke = (channel: string, ...args: unknown[]) => {
    channels.push(channel); const handler = handlers.get(channel); if (!handler) throw new Error("No observation handler");
    return Promise.resolve(handler({} as IpcMainInvokeEvent, ...args));
  };
  const bridge = createBrowserObservationBridge(invoke);
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(new Request(url, init)); await responseGate;
    return Response.json(result(selectedOwner), { headers: { [BROWSER_METADATA_OWNER_HEADER]: "host" } });
  }) as typeof fetch;
  return { bridge, invoke, requests, lookups, channels, owner: (value: BrowserObservationOwner) => { selectedOwner = value; },
    untrust: () => { trusted = false; }, foreign: () => { foreign = true; },
    holdEndpoint: (value: Promise<void>) => { endpointGate = value; }, holdResponse: (value: Promise<void>) => { responseGate = value; } };
}

test("actual preload and registered callback forward session and draft reads with main-only credentials", async () => {
  const f = fixture();
  for (const owner of [session, draft]) {
    f.owner(owner); expect(await f.bridge.inspect(owner, target, "host")).toEqual(result(owner));
  }
  expect(f.channels).toEqual(["host:browser-owner-inspect", "host:browser-owner-inspect"]);
  expect(f.lookups).toEqual(["host", "host"]);
  expect(f.requests.map(request => request.headers.get("authorization"))).toEqual(["Bearer main-fixture-token", "Bearer main-fixture-token"]);
  expect(f.requests.map(request => new URL(request.url).pathname)).toEqual(["/v1/sessions/session/browser-target-observation", "/v1/draft-browser-owners/owner/target-observation"]);
  expect(f.requests[0]!.method).toBe("GET"); expect(f.requests[0]!.body).toBeNull();
  expect(await f.requests[1]!.json()).toEqual({ draftId: "draft", draftRevision: 1, target });
});

test("input remains bound through held endpoint lookup and IPC argument mutation", async () => {
  const f = fixture(), gate = Promise.withResolvers<void>(); f.holdEndpoint(gate.promise); f.owner(draft);
  const owner = { ...draft }, selected = { ...target }, pending = f.bridge.inspect(owner, selected, "host");
  owner.draftId = "replacement"; selected.targetId = "replacement"; selected.workerPid = 80;
  gate.resolve(); expect(await pending).toEqual(result(draft));
  expect(await f.requests[0]!.json()).toEqual({ draftId: "draft", draftRevision: 1, target });
  const controlled = createBrowserObservationBridge(async (_channel, ownerValue, targetValue) => {
    (ownerValue as { draftId: string }).draftId = "foreign";
    (targetValue as BrowserFrameTarget).targetId = "foreign";
    return result(draft);
  });
  expect(await controlled.inspect(draft, target, "host")).toEqual(result(draft));
  expect(draft).toMatchObject({ draftId: "draft" }); expect(target.targetId).toBe("original");
});

test("invalid input cannot resolve endpoint and direct IPC cannot bypass validation", async () => {
  const f = fixture();
  for (const host of [undefined, "", "foreign\0host", "h".repeat(201)]) {
    await expect(f.invoke("host:browser-owner-inspect", session, target, host)).rejects.toThrow();
  }
  await expect(f.invoke("host:browser-owner-inspect", { kind: "session", sessionId: "" }, target, "host")).rejects.toThrow();
  await expect(f.invoke("host:browser-owner-inspect", session, { ...target, workerPid: 0 }, "host")).rejects.toThrow();
  await expect(f.bridge.inspect(session, { ...target, targetId: "" }, "host")).rejects.toThrow();
  expect(f.lookups).toEqual([]); expect(f.requests).toEqual([]);
  f.untrust(); await expect(f.bridge.inspect(session, target, "host")).rejects.toThrow("Untrusted");
  expect(f.lookups).toEqual([]);
});

test("trust or host loss during endpoint lookup suppresses dispatch", async () => {
  for (const kind of ["trust", "host"]) {
    const f = fixture(), gate = Promise.withResolvers<void>(); f.holdEndpoint(gate.promise);
    const pending = f.bridge.inspect(session, target, "host").catch(error => error as Error); await tick();
    if (kind === "trust") f.untrust(); else f.foreign();
    gate.resolve(); expect(await pending).toBeInstanceOf(Error);
    expect(f.lookups).toEqual(["host"]); expect(f.requests).toEqual([]);
  }
});

test("trust loss during dispatched read suppresses delivery without a fallback request", async () => {
  const f = fixture(), gate = Promise.withResolvers<void>(); f.holdResponse(gate.promise);
  const pending = f.bridge.inspect(session, target, "host").catch(error => error as Error); await tick();
  f.untrust(); gate.resolve(); expect(await pending).toMatchObject({ message: "Untrusted sender" });
  expect(f.requests).toHaveLength(1); expect(f.lookups).toEqual(["host"]);
});

test("preload validates the original binding even if its invoke result is malformed", async () => {
  for (const response of [undefined, { ...result(session), ownerId: "foreign" }, { ...result(session), targetId: "foreign" },
    { ...result(session), kindTag: "cmux", presence: "absent" }, { ...result(session), owner: draft }]) {
    let calls = 0; const bridge = createBrowserObservationBridge(async () => { calls++; return response; });
    await expect(bridge.inspect(session, target, "host")).rejects.toThrow(); expect(calls).toBe(1);
  }
});
