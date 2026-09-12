import { afterEach, expect, test } from "bun:test";
import { BROWSER_METADATA_OWNER_HEADER } from "@agent-desktop/shared";
import { BrowserCloseHttp } from "./browser-close-http";
import { BrowserCloseRequests } from "./browser-close-requests";
import { DraftBrowserWorkers } from "./browser-draft-workers";
import { DraftBrowserHttp } from "./draft-browser-http";
import { closeFixture, closeInput, closeOwner, flush } from "./fixtures/browser-close";
import type { WorkerBrowserOwner } from "./omp-workers";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const json = async (response: Response | undefined) => { if (!response) throw new Error("No matching close route"); return { status: response.status, body: await response.json() }; };
function sessionFixture() {
  const f = closeFixture(), calls: string[] = [];
  const manager = new BrowserCloseRequests(f.store.browserCloses, f.store.host.id, "epoch-one", () => 1000);
  const handle = { workerPid: 42, closeBrowserTab: async (target: typeof closeInput.target) => {
    calls.push("close"); expect(f.store.browserCloses.get(closeOwner, closeInput)).toBeDefined(); return { ...target, ownerId: "session", released: true as const };
  } };
  const http = new BrowserCloseHttp(manager, f.store.host.id, id => Boolean(f.store.getSession(id)), async () => { calls.push("lookup"); return handle; });
  const request = (action = "close", body: unknown = closeInput, host = f.store.host.id, method = "POST") => new Request(`http://fixture/v1/sessions/session/browser-${action}`, {
    method, headers: { [BROWSER_METADATA_OWNER_HEADER]: host }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  cleanups.push(async () => { await manager.dispose(); f.cleanup(); });
  return { ...f, manager, http, request, calls };
}
test("session HTTP method/host/body gates precede lookup and read-only observation does not claim", async () => {
  const f = sessionFixture(), before = f.metadata();
  expect((await f.http.route(f.request("close", closeInput, "foreign")))?.status).toBe(409);
  expect((await f.http.route(f.request("close", closeInput, f.store.host.id, "GET")))?.status).toBe(405);
  for (const body of [{ ...closeInput, killBrowser: true }, { ...closeInput, target: { ...closeInput.target, ownerId: "other" } }, { ...closeInput, requestId: "" }, { ...closeInput, target: { ...closeInput.target, name: "x".repeat(33000) } }]) expect((await f.http.route(f.request("close", body)))?.status).toBe(400);
  expect(await json(await f.http.route(f.request("close-status")))).toMatchObject({ status: 200, body: { status: "unavailable" } });
  expect(f.metadata()).toEqual(before); expect(f.calls).toEqual([]);
});
test("session close returns only durable exact completion; conflicting retry is409 and storage outage503", async () => {
  const f = sessionFixture();
  const completed = await json(await f.http.route(f.request())); expect(completed).toEqual({ status: 200, body: f.completed() });
  expect(await json(await f.http.route(f.request()))).toEqual(completed);
  expect((await f.http.route(f.request("close", { ...closeInput, target: { ...closeInput.target, targetId: "reopened" } })))?.status).toBe(409);
  expect((await json(await f.http.route(f.request("close-status")))).body).toMatchObject({ status: "settled", receipt: f.completed() });
  expect(f.calls.filter(x => x === "close")).toHaveLength(1);
  f.db.exec("CREATE TRIGGER close_claim_failure BEFORE INSERT ON metadata WHEN NEW.key LIKE 'browser-close.v1:%' BEGIN SELECT RAISE(ABORT,'claim failed'); END");
  expect((await f.http.route(f.request("close", { ...closeInput, requestId: "second" })))?.status).toBe(503);
  expect(f.calls.filter(x => x === "close")).toHaveLength(1);
});
function draftFixture(close?: WorkerBrowserOwner["closeBrowserTab"], dispose?: () => Promise<void>) {
  const f = closeFixture(), calls: string[] = [], entered = Promise.withResolvers<void>();
  const saved = f.store.putDraft({ id: "draft", text: "keep unsent", projectId: null, model: null }, 0);
  if (!saved.ok) throw new Error("Fixture draft did not save");
  const workers = new DraftBrowserWorkers(f.store, f.root, { createBrowserOwner: async input => {
    calls.push("worker");
    return { ...input, workerPid: 42, workerFailure: undefined, subscribeWorkerFailure: () => () => { calls.push("unsubscribe"); },
      dispose: async () => { calls.push("dispose"); await dispose?.(); },
      openBrowserEvaluation: async () => { throw new Error("Unexpected evaluator allocation in existing fixture"); }, reserveBrowserEvaluation: async () => { throw new Error("Unexpected reservation in this fixture"); },
      inspectBrowserEvaluationReservation: async () => { throw new Error("Unexpected reservation status in this fixture"); },
      inspectBrowserTab: async () => { throw new Error("Unexpected observation in this fixture"); },
      closeBrowserTab: async target => { calls.push("close"); entered.resolve(); return close ? close(target) : { ...target, ownerId: input.id, released: true }; },
      getBrowserMetadata: async () => { throw new Error("No metadata allowed"); }, createBrowserTab: async () => { throw new Error("No creation allowed"); },
      controlBrowser: async () => { throw new Error("No controls allowed"); }, getBrowserFrame: async () => { throw new Error("No frame allowed"); },
    };
  } });
  const http = new DraftBrowserHttp(f.store, workers, "epoch-one", () => 1000);
  const request = (action: string, overrides: Record<string, unknown> = {}) => new Request(`http://fixture/v1/draft-browser-owners/owner/${action}`, {
    method: "POST", headers: { [BROWSER_METADATA_OWNER_HEADER]: f.store.host.id }, body: JSON.stringify({ draftId: "draft", draftRevision: 1,
      ...(["close", "close-status"].includes(action) ? { close: closeInput } : {}), ...overrides }),
  });
  const send = async (action: string, overrides?: Record<string, unknown>) => json(await http.route(request(action, overrides)));
  cleanups.push(async () => { try { await http.dispose(); } catch { /* Owning failure test observes this retained error. */ } finally { f.cleanup(); } });
  return { ...f, calls, entered, workers, http, request, send };
}
test("draft close uses exact existing registry owner, never acquires on absence, and preserves history after retirement", async () => {
  const f = draftFixture();
  expect((await f.send("close-status")).body.status).toBe("unavailable");
  expect((await f.send("close")).status).toBe(503); expect(f.calls).toEqual([]);
  await f.workers.acquire({ hostId: f.store.host.id, ownerId: "owner", draftId: "draft", draftRevision: 1 }); // Controlled factory only.
  expect((await f.send("close", { draftRevision: 2 })).status).toBe(503);
  expect((await f.send("close")).body).toMatchObject({ outcome: "completed", released: true, owner: { kind: "draft", ownerId: "owner", draftRevision: 1 }, target: closeInput.target });
  await f.send("retire");
  expect((await f.send("close-status")).body).toMatchObject({ status: "settled", receipt: { outcome: "completed" } });
  expect((await f.send("close")).body.outcome).toBe("completed");
  expect(f.calls.filter(x => x === "worker")).toHaveLength(1); expect(f.calls.filter(x => x === "close")).toHaveLength(1);
  expect(f.store.getDraft("draft")?.text).toBe("keep unsent"); expect(f.store.getSession("session")).toEqual(f.session);
});
test("draft shutdown drains sent close/history despite independent worker disposal failure", async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<WorkerBrowserOwner["closeBrowserTab"]>>>();
  const f = draftFixture(() => gate.promise, async () => { throw new Error("worker cleanup failed"); });
  await f.workers.acquire({ hostId: f.store.host.id, ownerId: "owner", draftId: "draft", draftRevision: 1 });
  const work = f.send("close"); await f.entered.promise;
  let settled = false;
  const drain = f.http.dispose().then(() => { settled = true; return undefined; }, error => { settled = true; return error as AggregateError; });
  await flush(); expect(settled).toBe(false);
  gate.resolve({ ...closeInput.target, ownerId: "owner", released: true });
  expect((await work).body.outcome).toBe("unknown"); // Registry retirement invalidates the original handle's post-operation check.
  expect(await drain).toBeInstanceOf(AggregateError);
  expect(f.store.browserCloses.get({ kind: "draft", ownerId: "owner", draftId: "draft", draftRevision: 1 }, closeInput)?.receipt?.outcome).toBe("unknown");
  expect(f.calls.filter(x => x === "close")).toHaveLength(1);
  await expect(f.http.dispose()).rejects.toThrow("cleanup failed");
});
