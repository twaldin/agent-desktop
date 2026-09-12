import { afterEach, expect, test } from "bun:test";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { BROWSER_METADATA_OWNER_HEADER } from "@agent-desktop/shared";
import { browserCloseIdentity, type BrowserCloseOwner } from "../../../../packages/shared/src/browser-close";
import { createBrowserCloseBridge } from "./browser-close-preload";
import { registerBrowserCloseHandlers } from "./browser-close-ipc";
import { closeInput, closeOwner, flush } from "../../../host/src/fixtures/browser-close";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const draft: BrowserCloseOwner = { kind: "draft", ownerId: "owner", draftId: "draft", draftRevision: 1 };
function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: any[]) => any>();
  const ipc: Pick<IpcMain, "handle"> = { handle(channel, listener) { if (handlers.has(channel)) throw new Error("Duplicate handler"); handlers.set(channel, listener); } };
  let trusted = true, wrongHost = false, lookupGate: Promise<void> | undefined, selectedOwner = closeOwner;
  const lookups: string[] = [], requests: { path: string; body: any; auth: string | null }[] = [];
  registerBrowserCloseHandlers(ipc, () => { if (!trusted) throw new Error("Untrusted sender"); }, async host => {
    lookups.push(host); await lookupGate; return { hostId: wrongHost ? "foreign" : host, origin: "https://fixture.invalid", token: "main-fixture-token" };
  });
  const bridge = createBrowserCloseBridge((channel, ...args) => {
    const handler = handlers.get(channel); if (!handler) throw new Error("Missing close handler");
    return handler({} as IpcMainInvokeEvent, ...args);
  });
  globalThis.fetch = (async (value: string | URL | Request, init?: RequestInit) => {
    const request = new Request(value, init), path = new URL(request.url).pathname, body = await request.json();
    requests.push({ path, body, auth: request.headers.get("authorization") });
    const identity = browserCloseIdentity("host", selectedOwner, closeInput), receipt = { ...identity, outcome: "completed", released: true };
    return Response.json(path.endsWith("close-status") ? { ...identity, status: "settled", receipt } : receipt, { headers: { [BROWSER_METADATA_OWNER_HEADER]: "host" } });
  }) as typeof fetch;
  return { bridge, requests, lookups, setOwner: (owner: BrowserCloseOwner) => { selectedOwner = owner; },
    untrust: () => { trusted = false; }, wrongHost: () => { wrongHost = true; }, hold: (gate: Promise<void>) => { lookupGate = gate; } };
}
test("actual preload adapter and registered callbacks bind both operations to both original owner kinds", async () => {
  const f = fixture();
  for (const owner of [closeOwner, draft]) {
    f.setOwner(owner);
    expect(await f.bridge.close(owner, closeInput, "host")).toMatchObject({ outcome: "completed", owner });
    expect(await f.bridge.status(owner, closeInput, "host")).toMatchObject({ status: "settled", receipt: { outcome: "completed", owner } });
  }
  expect(f.lookups).toEqual(["host", "host", "host", "host"]);
  expect(f.requests.map(r => r.path)).toEqual(["/v1/sessions/session/browser-close", "/v1/sessions/session/browser-close-status", "/v1/draft-browser-owners/owner/close", "/v1/draft-browser-owners/owner/close-status"]);
  expect(f.requests.map(r => r.auth)).toEqual(Array(4).fill("Bearer main-fixture-token"));
  expect(f.requests[0]!.body).toEqual(closeInput); expect(f.requests[2]!.body).toEqual({ draftId: "draft", draftRevision: 1, close: closeInput });
});
test("caller mutation during endpoint lookup cannot rebind owner or target", async () => {
  const f = fixture(), gate = Promise.withResolvers<void>(); f.hold(gate.promise); f.setOwner(draft);
  const owner = structuredClone(draft), request = structuredClone(closeInput), work = f.bridge.close(owner, request, "host");
  if (owner.kind === "draft") { owner.draftId = "foreign"; owner.draftRevision = 2; }
  request.target.workerPid = 999; request.target.targetId = "replacement"; gate.resolve();
  expect(await work).toMatchObject({ owner: draft, target: closeInput.target });
  expect(f.requests[0]!.body).toEqual({ draftId: "draft", draftRevision: 1, close: closeInput });
});
test("invalid input/untrusted sender fails before endpoint lookup; trust/host loss during lookup cannot send", async () => {
  const invalid = fixture();
  await expect(invalid.bridge.close(closeOwner, { ...closeInput, target: { ...closeInput.target, workerPid: 0 } }, "host")).rejects.toThrow();
  expect(invalid.lookups).toEqual([]); expect(invalid.requests).toEqual([]);
  invalid.untrust(); await expect(invalid.bridge.status(closeOwner, closeInput, "host")).rejects.toThrow("Untrusted"); expect(invalid.lookups).toEqual([]);
  for (const kind of ["trust", "host"]) {
    const f = fixture(), gate = Promise.withResolvers<void>(); f.hold(gate.promise);
    const work = f.bridge.close(closeOwner, closeInput, "host").catch(error => error as Error); await flush();
    if (kind === "trust") f.untrust(); else f.wrongHost(); gate.resolve();
    expect(await work).toBeInstanceOf(Error); expect(f.lookups).toEqual(["host"]); expect(f.requests).toEqual([]);
  }
});
