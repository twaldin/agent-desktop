import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserFrameTarget } from "@agent-desktop/shared";
import { HostStore } from "./store";
import { DraftBrowserWorkers } from "./browser-draft-workers";
import { BrowserObservationHttp } from "./browser-observation-http";
import type { WorkerBrowserObservation } from "./omp-browser/observation";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const target: BrowserFrameTarget = { workerPid: 91, name: "main", targetId: "original" };
function fixture(inspect?: (ownerId: string, target: BrowserFrameTarget) => Promise<WorkerBrowserObservation>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-observation-registry-"))), store = new HostStore(root);
  const saved = store.putDraft({ id: "draft", text: "Unsent", projectId: null, model: null }, 0);
  if (!saved.ok) throw new Error("Draft save failed");
  const events: string[] = [];
  const workers = new DraftBrowserWorkers(store, root, { createBrowserOwner: async input => {
    events.push("worker:" + input.id);
    return { ...input, workerPid: 91, workerFailure: undefined, subscribeWorkerFailure: () => () => {}, dispose: async () => { events.push("dispose:" + input.id); },
      openBrowserEvaluation: async () => { throw new Error("Unexpected evaluator allocation in existing fixture"); }, reserveBrowserEvaluation: async () => { throw new Error("Unexpected reservation in this fixture"); },
      inspectBrowserEvaluationReservation: async () => { throw new Error("Unexpected reservation status in this fixture"); },
      inspectBrowserTab: async selected => { events.push("inspect:" + input.id); return inspect ? inspect(input.id, selected)
        : { ...selected, ownerId: input.id, kindTag: "headless", presence: "present" }; },
      getBrowserMetadata: async () => { throw new Error("Unexpected metadata"); },
      getBrowserFrame: async () => { throw new Error("Unexpected frame"); },
      createBrowserTab: async () => { throw new Error("Unexpected create"); },
      closeBrowserTab: async () => { throw new Error("Unexpected close"); },
      controlBrowser: async () => { throw new Error("Unexpected control"); },
    };
  } });
  const http = new BrowserObservationHttp({ hostId: store.host.id, sessionExists: () => false, getSessionHandle: async () => undefined,
    draftReady: owner => workers.inspect(owner).state === "ready", getDraftHandle: owner => workers.getExisting(owner) });
  cleanups.push(async () => {
    try { await Promise.allSettled([http.dispose(), workers.dispose()]); }
    finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
  const owner = { hostId: store.host.id, ownerId: "owner", draftId: "draft", draftRevision: 1 };
  const request = (extra: Record<string, unknown> = {}) => new Request("http://fixture/v1/draft-browser-owners/owner/target-observation", {
    method: "POST", headers: { [BROWSER_METADATA_OWNER_HEADER]: store.host.id },
    body: JSON.stringify({ draftId: "draft", draftRevision: 1, target, ...extra }),
  });
  const send = async (extra: Record<string, unknown> = {}) => {
    const response = await http.route(request(extra)); if (!response) throw new Error("Missing observation route");
    return { status: response.status, body: await response.json() };
  };
  return { root, store, workers, http, owner, events, request, send };
}

test("real draft registry observation never acquires and preserves saved drafts and owner records", async () => {
  const f = fixture();
  expect((await f.send()).status).toBe(409); expect(f.events).toEqual([]);
  expect(f.store.draftBrowserOwners.get("owner")).toBeUndefined();
  await f.workers.acquire(f.owner);
  const draft = f.store.getDraft("draft"), owner = f.store.draftBrowserOwners.get("owner");
  const result = await f.send();
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ protocolVersion: 1, hostId: f.store.host.id,
    owner: { kind: "draft", ownerId: "owner", draftId: "draft", draftRevision: 1 },
    ...target, ownerId: "owner", kindTag: "headless", presence: "present" });
  expect((await f.send({ draftRevision: 2 })).status).toBe(503);
  expect((await f.send({ draftId: "other" })).status).toBe(503);
  expect(f.events).toEqual(["worker:owner", "inspect:owner"]);
  expect(f.store.getDraft("draft")).toEqual(draft); expect(f.store.draftBrowserOwners.get("owner")).toEqual(owner);
  expect(f.store.listSessions()).toEqual([]);
});

test("retired draft registry suppresses a held original read and never reopens its durable history", async () => {
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<WorkerBrowserObservation>();
  const f = fixture(async () => { entered.resolve(); return gate.promise; }); await f.workers.acquire(f.owner);
  const pending = f.send(); await entered.promise; await f.workers.retire(f.owner);
  gate.resolve({ ...target, ownerId: "owner", kindTag: "headless", presence: "present" });
  const result = await pending;
  expect(result.status).toBe(503); expect(result.body).not.toHaveProperty("presence");
  expect((await f.send()).status).toBe(409); expect(f.store.draftBrowserOwners.get("owner")?.retiredAt).toBeNumber();
  let starts = 0;
  const restored = new DraftBrowserWorkers(f.store, f.root, { createBrowserOwner: async () => { starts++; throw new Error("No recreation allowed"); } });
  try {
    expect(restored.inspect(f.owner).state).toBe("retired"); expect(await restored.getExisting(f.owner)).toBeUndefined();
    expect(starts).toBe(0); expect(f.events).toEqual(["worker:owner", "inspect:owner", "dispose:owner"]);
  } finally { await restored.dispose(); }
});

test("bounded draft request body rejects oversize input before registry lookup or acquisition", async () => {
  const f = fixture();
  const response = await f.http.route(new Request(f.request().url, { method: "POST",
    headers: { [BROWSER_METADATA_OWNER_HEADER]: f.store.host.id }, body: JSON.stringify({ draftId: "x".repeat(33 * 1024) }) }));
  expect(response?.status).toBe(400); expect(f.events).toEqual([]); expect(f.store.draftBrowserOwners.get("owner")).toBeUndefined();
});
