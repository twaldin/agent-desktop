import { afterEach, expect, test } from "bun:test";
import { BROWSER_METADATA_OWNER_HEADER } from "@agent-desktop/shared";
import { BrowserCloseTransport } from "./browser-close-transport";
import { browserCloseIdentity, type BrowserCloseOwner, type BrowserCloseReceipt, type BrowserCloseObservation } from "../../../../packages/shared/src/browser-close";
import { closeFixture, closeInput, closeOwner, flush } from "../../../host/src/fixtures/browser-close";
import { BrowserCloseRequests } from "../../../host/src/browser-close-requests";
import { BrowserCloseHttp } from "../../../host/src/browser-close-http";
import { DraftBrowserHttp } from "../../../host/src/draft-browser-http";
import { DraftBrowserWorkers } from "../../../host/src/browser-draft-workers";

const originalFetch = globalThis.fetch, originalTimeout = AbortSignal.timeout;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout; for (const cleanup of cleanups.splice(0)) await cleanup(); });
const endpoint = { hostId: "host", origin: "https://fixture.invalid", token: "fixture-main-token" };
const draft: BrowserCloseOwner = { kind: "draft", ownerId: "draft-owner", draftId: "draft", draftRevision: 1 };
const base = (owner = closeOwner) => browserCloseIdentity(endpoint.hostId, owner, closeInput);
const completed = (owner = closeOwner): BrowserCloseReceipt => ({ ...base(owner), outcome: "completed", released: true });
const reply = (body: unknown, status = 200, host = "host") => Response.json(body, { status, headers: { [BROWSER_METADATA_OWNER_HEADER]: host } });
function responseFrom(make: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => { const req = new Request(input, init); requests.push(req); return await make(req); }) as typeof fetch;
  return requests;
}
test("session/draft wire routes capture exact endpoint/owner/input and use main-only credentials once", async () => {
  for (const owner of [closeOwner, draft]) {
    const captured: { url: string; body: unknown; authorization: string | null; redirect: string }[] = [];
    const selectedEndpoint = { ...endpoint }, selectedOwner = structuredClone(owner), input = structuredClone(closeInput);
    const gate = Promise.withResolvers<Response>();
    const requests = responseFrom(async req => { captured.push({ url: req.url, body: await req.json(), authorization: req.headers.get("authorization"), redirect: req.redirect }); return await gate.promise; });
    const transport = new BrowserCloseTransport(selectedEndpoint, selectedOwner), work = transport.close(input);
    selectedEndpoint.hostId = "foreign"; selectedEndpoint.token = "other";
    if (selectedOwner.kind === "session") selectedOwner.sessionId = "other"; else selectedOwner.draftId = "other";
    input.target.targetId = "replacement"; await flush(); gate.resolve(reply(completed(owner)));
    expect(await work).toEqual(completed(owner)); expect(requests).toHaveLength(1);
    expect(captured[0]).toEqual({ url: owner.kind === "session" ? "https://fixture.invalid/v1/sessions/session/browser-close" : "https://fixture.invalid/v1/draft-browser-owners/draft-owner/close",
      body: owner.kind === "session" ? closeInput : { draftId: "draft", draftRevision: 1, close: closeInput }, authorization: "Bearer fixture-main-token", redirect: "error" });
  }
});
test("strict positive confirmation rejects owner, PID, target, request, protocol and false release", async () => {
  const transport = new BrowserCloseTransport(endpoint, closeOwner);
  const values = [{ ...completed(), hostId: "foreign" }, { ...completed(), owner: draft }, { ...completed(), requestId: "other" },
    { ...completed(), target: { ...closeInput.target, workerPid: 43 } }, { ...completed(), target: { ...closeInput.target, targetId: "new" } },
    { ...completed(), protocolVersion: 2 }, { ...completed(), released: false }, { ...completed(), unexpected: true }];
  for (const value of values) { const requests = responseFrom(() => reply(value)); await expect(transport.close(closeInput)).rejects.toThrow(); expect(requests).toHaveLength(1); }
});
test("explicit status returns only original pending/unavailable/settled and never sends a close fallback", async () => {
  const transport = new BrowserCloseTransport(endpoint, draft);
  for (const status of ["pending", "unavailable", "settled"] as const) {
    const observation: BrowserCloseObservation = status === "settled" ? { ...base(draft), status, receipt: completed(draft) } : { ...base(draft), status };
    const requests = responseFrom(() => reply(observation));
    expect(await transport.status(closeInput)).toEqual(observation); expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).pathname).toEndWith("/close-status");
  }
  for (const body of [{ ...base(draft), status: "pending", receipt: completed(draft) }, { ...base(draft), status: "settled", receipt: completed() },
    { ...base(draft), status: "unavailable", target: { ...closeInput.target, name: "replacement" } }]) {
    const requests = responseFrom(() => reply(body)); await expect(transport.status(closeInput)).rejects.toThrow(); expect(requests).toHaveLength(1);
  }
});
test("only explicit host pre-admission failures become rejected;404/401/conflict/storage/network never replay", async () => {
  const transport = new BrowserCloseTransport(endpoint, closeOwner);
  for (const [status, code] of [[400, "INVALID_REQUEST"], [405, "INVALID_REQUEST"], [409, "OWNER_MISMATCH"]] as const) {
    const requests = responseFrom(() => reply({ error: { code, message: "Pre-admission refusal" } }, status));
    expect(await transport.close(closeInput)).toMatchObject({ outcome: "rejected", target: closeInput.target }); expect(requests).toHaveLength(1);
  }
  for (const [status, code] of [[404, "NOT_FOUND"], [401, "UNAUTHORIZED"], [409, "BROWSER_CLOSE_INPUT_MISMATCH"], [503, "BROWSER_CLOSE_UNAVAILABLE"], [500, "INVALID_REQUEST"]] as const) {
    const requests = responseFrom(() => reply({ error: { code, message: "Unconfirmed" } }, status));
    await expect(transport.close(closeInput)).rejects.toThrow("unconfirmed"); expect(requests).toHaveLength(1);
    await expect(transport.status(closeInput)).rejects.toThrow("history is unavailable"); expect(requests).toHaveLength(2);
  }
  const lost = responseFrom(() => { throw new Error("Response lost"); });
  await expect(transport.close(closeInput)).rejects.toThrow("Response lost"); expect(lost).toHaveLength(1);
});
test("foreign body is cancelled before read; oversized response and timeout cannot produce confirmation", async () => {
  const transport = new BrowserCloseTransport(endpoint, closeOwner); let cancelled = 0;
  responseFrom(() => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { [BROWSER_METADATA_OWNER_HEADER]: "foreign" } }));
  await expect(transport.close(closeInput)).rejects.toThrow("another host"); expect(cancelled).toBe(1);
  responseFrom(() => reply({ ...completed(), padding: "x".repeat(32768) }));
  await expect(transport.close(closeInput)).rejects.toThrow("exceeds its limit");
  const abort = new AbortController(); const timeouts: number[] = [];
  AbortSignal.timeout = ms => { timeouts.push(ms); return abort.signal; };
  const requests = responseFrom(req => new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true })));
  const work = transport.close(closeInput); const result = work.catch(error => error as Error); abort.abort(new Error("Controlled timeout"));
  expect((await result as Error).message).toBe("Controlled timeout"); expect(requests).toHaveLength(1); expect(timeouts).toEqual([60000]);
});
test("actual host journal/route receives one controlled close and retains completion across route recreation", async () => {
  const f = closeFixture(), manager = new BrowserCloseRequests(f.store.browserCloses, f.store.host.id, "epoch-one", () => 1000);
  let calls = 0;
  const handle = { workerPid: 42, closeBrowserTab: async (target: typeof closeInput.target) => { calls++; return { ...target, ownerId: "session", released: true as const }; } };
  let http = new BrowserCloseHttp(manager, f.store.host.id, id => Boolean(f.store.getSession(id)), async () => handle);
  cleanups.push(async () => { await manager.dispose(); f.cleanup(); });
  const transport = new BrowserCloseTransport({ ...endpoint, hostId: f.store.host.id }, closeOwner);
  responseFrom(async request => { expect(request.headers.get("authorization")).toBe("Bearer fixture-main-token"); return (await http.route(request)) ?? new Response(null, { status: 404 }); });
  const receipt = await transport.close(closeInput); expect(receipt).toEqual(f.completed());
  const next = new BrowserCloseRequests(f.store.browserCloses, f.store.host.id, "new-epoch", () => 999999);
  http = new BrowserCloseHttp(next, f.store.host.id, () => false, async () => { throw new Error("Historical read must not lookup"); });
  expect(await transport.close(closeInput)).toEqual(receipt); expect(await transport.status(closeInput)).toMatchObject({ status: "settled", receipt });
  expect(calls).toBe(1); await next.dispose();
});
test("actual draft route forwards only the admitted original existing handle and preserves unsent draft", async () => {
  const f = closeFixture(); f.store.putDraft({ id: "draft", text: "keep unsent", projectId: null, model: null }, 0); let closes = 0, starts = 0;
  const workers = new DraftBrowserWorkers(f.store, f.root, { createBrowserOwner: async input => { starts++; return { ...input, workerPid: 42, workerFailure: undefined,
    openBrowserEvaluation: async () => { throw new Error("Unexpected evaluator allocation in existing fixture"); }, reserveBrowserEvaluation: async () => { throw new Error("Unexpected reservation in this fixture"); },
    inspectBrowserEvaluationReservation: async () => { throw new Error("Unexpected reservation status in this fixture"); },
    inspectBrowserTab: async () => { throw new Error("Unexpected observation in this fixture"); },
    subscribeWorkerFailure: () => () => {}, dispose: async () => {}, closeBrowserTab: async target => { closes++; return { ...target, ownerId: input.id, released: true }; },
    createBrowserTab: async () => { throw new Error("No create"); }, getBrowserMetadata: async () => { throw new Error("No metadata"); },
    getBrowserFrame: async () => { throw new Error("No frame"); }, controlBrowser: async () => { throw new Error("No control"); },
  }; } });
  const http = new DraftBrowserHttp(f.store, workers, "epoch-one", () => 1000);
  cleanups.push(async () => { await http.dispose(); f.cleanup(); });
  responseFrom(async request => (await http.route(request)) ?? new Response(null, { status: 404 }));
  const transport = new BrowserCloseTransport({ ...endpoint, hostId: f.store.host.id }, draft);
  expect((await transport.status(closeInput)).status).toBe("unavailable"); await expect(transport.close(closeInput)).rejects.toThrow("unconfirmed"); expect(starts).toBe(0);
  await workers.acquire({ hostId: f.store.host.id, ownerId: "draft-owner", draftId: "draft", draftRevision: 1 });
  expect(await transport.close(closeInput)).toMatchObject({ outcome: "completed", owner: draft, target: closeInput.target });
  expect((await transport.status(closeInput)).status).toBe("settled"); expect(starts).toBe(1); expect(closes).toBe(1); expect(f.store.getDraft("draft")?.text).toBe("keep unsent");
});
