import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_METADATA_OWNER_HEADER, type BrowserCreateRequest } from "@agent-desktop/shared";
import { HostStore } from "./store";
import { DraftBrowserWorkers } from "./browser-draft-workers";
import { DraftBrowserHttp } from "./draft-browser-http";
import type { WorkerBrowserOwner } from "./omp-workers";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const creation: BrowserCreateRequest = { requestId: "one-create", controlEpoch: "epoch-one", observedAt: 1000, initialUrl: "https://example.invalid/request" };
const result = (name: string) => ({ tab: { name, targetId: "target-" + name, backend: "worker" as const, kindTag: "headless" as const, state: "alive" as const,
  url: "https://example.invalid/observed", title: "Observed", viewport: { width: 640, height: 480 } }, targetDisposition: "created-page" as const });
function fixture(create?: WorkerBrowserOwner["createBrowserTab"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "draft-browser-http-")));
  const store = new HostStore(root), db = new Database(join(root, "state.sqlite"));
  const saved = store.putDraft({ id: "draft", text: "keep draft", projectId: null, model: null }, 0);
  if (!saved.ok) throw new Error("Fixture draft save failed");
  const events: string[] = [];
  const workers = new DraftBrowserWorkers(store, root, { createBrowserOwner: async input => {
    events.push("worker");
    return { ...input, workerPid: 99, workerFailure: undefined,
      subscribeWorkerFailure: () => () => { events.push("unsubscribe"); }, dispose: async () => { events.push("dispose"); },
      createBrowserTab: async (name, url) => { events.push("create:" + name); expect(store.draftBrowserCreations.get("owner", { ...creation, requestId: name.slice(8), initialUrl: url })?.state).toBe("pending"); return create ? create(name, url) : result(name); },
      openBrowserEvaluation: async () => { throw new Error("Unexpected evaluator allocation in existing fixture"); }, reserveBrowserEvaluation: async () => { throw new Error("Unexpected reservation in this fixture"); },
      inspectBrowserEvaluationReservation: async () => { throw new Error("Unexpected reservation status in this fixture"); },
      inspectBrowserTab: async () => { throw new Error("Unexpected observation in this fixture"); },
      closeBrowserTab: async () => { throw new Error("No close allowed"); },
      getBrowserMetadata: async () => { throw new Error("No metadata probe allowed"); }, controlBrowser: async () => { throw new Error("No controls allowed"); }, getBrowserFrame: async () => { throw new Error("No frame allowed"); },
    };
  } });
  const handler = new DraftBrowserHttp(store, workers, "epoch-one", () => 1000);
  cleanups.push(async () => { await handler.dispose(); db.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const request = (action: string, input?: BrowserCreateRequest, overrides: Record<string, unknown> = {}, host = store.host.id) => new Request(`http://fixture/v1/draft-browser-owners/owner/${action}`, {
    method: "POST", headers: { [BROWSER_METADATA_OWNER_HEADER]: host }, body: JSON.stringify({ draftId: "draft", draftRevision: 1, ...(input ? { creation: input } : {}), ...overrides }),
  });
  const send = async (action: string, input?: BrowserCreateRequest, overrides: Record<string, unknown> = {}, selected = handler) => {
    const response = await selected.route(request(action, input, overrides)); if (!response) throw new Error("Route did not match");
    return { status: response.status, body: await response.json() as any };
  };
  return { root, store, db, workers, handler, request, send, events };
}

test("owner-header, method and strict body gates precede mutation; status is read-only", async () => {
  const f = fixture();
  expect((await f.handler.route(f.request("acquire", undefined, {}, "foreign")))?.status).toBe(409);
  expect((await f.handler.route(new Request("http://fixture/v1/draft-browser-owners/owner/acquire", { headers: { [BROWSER_METADATA_OWNER_HEADER]: f.store.host.id } })))?.status).toBe(405);
  for (const change of [{ cwd: f.root }, { projectId: "other" }, { draftRevision: 0 }, { draftId: "" }]) expect((await f.send("acquire", undefined, change)).status).toBe(400);
  expect((await f.send("status")).body.state).toBe("absent");
  expect(f.events).toEqual([]); expect(f.store.draftBrowserOwners.get("owner")).toBeUndefined();
  expect((await f.send("open", creation)).status).toBe(503); expect(f.events).toEqual([]);
  expect((await f.send("acquire")).body).toMatchObject({ state: "ready", ownerId: "owner", workerPid: 99, ticket: { controlEpoch: "epoch-one", observedAt: 1000 } });
  expect(f.events).toEqual(["worker"]); expect(f.store.getDraft("draft")?.text).toBe("keep draft"); expect(f.store.listSessions()).toEqual([]);
});

test("one native creation with exact concurrent requests, completed receipt and no historical replay", async () => {
  const gate = Promise.withResolvers<ReturnType<typeof result>>(), f = fixture(() => gate.promise);
  await f.send("acquire");
  const first = f.send("open", creation), second = f.send("open", creation);
  await tick();
  const pending = await f.send("creation-status", creation), count = f.events.filter(x => x.startsWith("create:")).length;
  gate.resolve(result("desktop-one-create")); const a = await first, b = await second;
  expect(pending.body.status).toBe("pending"); expect(count).toBe(1);
  expect(a.body).toMatchObject({ outcome: "completed", ownerKind: "draft", ownerId: "owner", workerPid: 99 }); expect(b.body).toEqual(a.body);
  const nextHandler = new DraftBrowserHttp(f.store, f.workers, "epoch-two", () => 999999);
  expect((await f.send("open", creation, {}, nextHandler)).body).toEqual(a.body);
  expect((await f.send("creation-status", creation, {}, nextHandler)).body).toMatchObject({ status: "settled", receipt: a.body });
  expect(f.events.filter(x => x.startsWith("create:")).length).toBe(1);
});

test("expired, contradictory and reused inputs cannot dispatch or replace history", async () => {
  const f = fixture(); await f.send("acquire");
  expect((await f.send("create", creation)).status).toBe(400);
  expect((await f.send("open", { ...creation, controlEpoch: "old" })).body.outcome).toBe("rejected");
  expect((await f.send("open", { ...creation, observedAt: 100000 })).body.outcome).toBe("rejected");
  expect(f.store.draftBrowserCreations.get("owner", creation)).toBeUndefined();
  await f.send("open", creation);
  expect((await f.send("open", { ...creation, initialUrl: "https://example.invalid/other" })).status).toBe(409);
  expect((await f.send("creation-status", creation, { draftRevision: 2 })).status).toBe(503);
  expect(f.events.filter(x => x.startsWith("create:")).length).toBe(1);
});

test("failed claim cannot call native creation; failed finish remains unknown without replay", async () => {
  const f = fixture(); await f.send("acquire");
  f.db.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON metadata WHEN NEW.key LIKE 'draft-browser-creation.v1:%' BEGIN SELECT RAISE(ABORT,'claim failed'); END");
  expect((await f.send("open", creation)).status).toBe(503); expect(f.events).toEqual(["worker"]);
  f.db.exec("DROP TRIGGER fail_claim");
  f.db.exec("CREATE TRIGGER fail_finish BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'draft-browser-creation.v1:%' BEGIN SELECT RAISE(ABORT,'finish failed'); END");
  expect((await f.send("open", creation)).body.outcome).toBe("unknown");
  expect(f.store.draftBrowserCreations.get("owner", creation)?.state).toBe("pending");
  expect((await f.send("creation-status", creation)).body).toMatchObject({ status: "settled", receipt: { outcome: "unknown" } });
  const recreated = new DraftBrowserHttp(f.store, f.workers, "epoch-one", () => 1000);
  expect((await f.send("open", creation, {}, recreated)).body.outcome).toBe("unknown");
  expect(f.events.filter(x => x.startsWith("create:")).length).toBe(1);
});

test("registry loss never starts a replacement from the creation route", async () => {
  const f = fixture(); await f.send("acquire"); await f.workers.dispose();
  let replacements = 0;
  const absent = new DraftBrowserWorkers(f.store, f.root, { createBrowserOwner: async () => { replacements++; throw new Error("must not spawn"); } });
  const next = new DraftBrowserHttp(f.store, absent, "epoch-one", () => 1000);
  try {
    const reply = await f.send("open", creation, {}, next); expect(reply.body.outcome).toBe("rejected");
    expect(replacements).toBe(0); expect(f.store.draftBrowserCreations.get("owner", creation)?.receipt?.outcome).toBe("rejected");
  } finally { await next.dispose(); }
});

test("native exception or malformed completion records no false success", async () => {
  const f = fixture(async () => { throw new Error("lost native response"); }); await f.send("acquire");
  expect((await f.send("open", creation)).body.outcome).toBe("unknown");
  expect(f.store.draftBrowserCreations.get("owner", creation)?.receipt?.outcome).toBe("unknown");
  const g = fixture(async name => ({ ...result(name), tab: { ...result(name).tab, name: "different" } })); await g.send("acquire");
  expect((await g.send("open", creation)).body.outcome).toBe("unknown");
  expect(g.store.draftBrowserCreations.get("owner", creation)?.state).toBe("pending");
});

test("shutdown drains late creation settlement before completing and blocks new route admission", async () => {
  const gate = Promise.withResolvers<ReturnType<typeof result>>(), f = fixture(() => gate.promise); await f.send("acquire");
  const creating = f.send("open", creation); await tick();
  let done = false; const closing = f.handler.dispose().then(() => { done = true; });
  await tick(); const early = done;
  gate.resolve(result("desktop-one-create")); const reply = await creating; await closing;
  expect(early).toBe(false); expect(reply.body.outcome).toBe("unknown"); expect(done).toBe(true);
  expect(f.store.draftBrowserCreations.get("owner", creation)?.receipt?.outcome).toBe("unknown");
  expect((await f.send("acquire")).status).toBe(503);
});

test("eight pending requests bound native concurrency; the ninth is refused before durable claim", async () => {
  const gate = Promise.withResolvers<void>(), f = fixture(async name => { await gate.promise; return result(name); }); await f.send("acquire");
  const pending = Array.from({ length: 8 }, (_, i) => f.send("open", { ...creation, requestId: "request-" + i })); await tick();
  const ninthInput = { ...creation, requestId: "ninth" }, ninth = await f.send("open", ninthInput);
  const recorded = f.store.draftBrowserCreations.get("owner", ninthInput), count = f.events.filter(x => x.startsWith("create:")).length;
  gate.resolve(); const replies = await Promise.all(pending);
  expect(ninth.body.outcome).toBe("rejected"); expect(recorded).toBeUndefined(); expect(count).toBe(8);
  expect(replies.every(reply => reply.body.outcome === "completed")).toBe(true);
});

test("blank creation, explicit retirement and unavailable observation preserve their distinct meanings", async () => {
  const f = fixture(); await f.send("acquire");
  const blank = { ...creation, initialUrl: undefined };
  expect((await f.send("creation-status", blank)).body.status).toBe("unavailable");
  expect((await f.send("create", blank)).body.outcome).toBe("completed");
  expect((await f.send("retire")).body.state).toBe("retired");
  expect((await f.send("status")).body.state).toBe("retired");
  expect((await f.send("creation-status", blank)).body).toMatchObject({ status: "settled", receipt: { outcome: "completed" } });
  expect((await f.send("create", { ...blank, requestId: "later" })).status).toBe(503);
  expect(f.events.filter(x => x.startsWith("create:")).length).toBe(1);
});

test("known native rejection settles once and oversized bodies cannot reach owner admission", async () => {
  const f = fixture(async () => { const error = new Error("native preflight refused"); error.name = "BrowserTabCreateRejected"; throw error; });
  const large = new Request("http://fixture/v1/draft-browser-owners/owner/acquire", { method: "POST", headers: { [BROWSER_METADATA_OWNER_HEADER]: f.store.host.id }, body: "x".repeat(33000) });
  expect((await f.handler.route(large))?.status).toBe(400); expect(f.events).toEqual([]);
  await f.send("acquire");
  expect((await f.send("open", creation)).body.outcome).toBe("rejected");
  expect((await f.send("open", creation)).body.outcome).toBe("rejected");
  expect(f.events.filter(x => x.startsWith("create:")).length).toBe(1);
});
