import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import type { DraftBrowserCreationReceipt } from "./draft-browser-creation-records";
import type { BrowserCreateRequest } from "@agent-desktop/shared";

const roots: string[] = [], stores: HostStore[] = [], databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const request: BrowserCreateRequest = { requestId: "draft-tab", controlEpoch: "epoch-one", observedAt: 1000, initialUrl: "https://example.invalid/private-initial-query" };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "draft-browser-journal-"))); roots.push(root);
  const store = new HostStore(root); stores.push(store);
  const db = new Database(join(root, "state.sqlite")); databases.push(db);
  const saved = store.putDraft({ id: "draft", text: "unsent", projectId: null, model: null }, 0);
  if (!saved.ok) throw new Error("Fixture draft save failed");
  const owner = { id: "draft-owner", draftId: saved.draft.id, draftRevision: saved.draft.revision, projectId: null, cwd: root };
  return { root, store, db, owner, createOwner: () => store.draftBrowserOwners.claim(owner) };
}
const rows = (db: Database) => db.query("SELECT key,data FROM metadata ORDER BY key").all();
const key = (ownerId: string) => "draft-browser-creation.v1:" + JSON.stringify([ownerId, request.requestId]);
const close = (store: HostStore) => { stores.splice(stores.indexOf(store), 1); store.close(); };
function completed(hostId: string, ownerId = "draft-owner"): DraftBrowserCreationReceipt {
  return { protocolVersion: 1, ownerKind: "draft", hostId, ownerId, requestId: request.requestId, outcome: "completed", workerPid: 42,
    targetDisposition: "created-page", tab: { name: `desktop-${request.requestId}`, targetId: "native-target", backend: "worker", kindTag: "headless", state: "alive",
      title: "Observed", url: "https://example.invalid/observed", viewport: { width: 640, height: 480 } } };
}

test("absence is read-only; new requests require actual durable draft owners, not sessions", () => {
  const f = fixture(), initial = rows(f.db), journal = f.store.draftBrowserCreations;
  expect(journal.get(f.owner.id, request)).toBeUndefined();
  expect(journal.observe(f.owner.id, request, "epoch-one")).toMatchObject({ ownerKind: "draft", ownerId: f.owner.id, status: "unavailable" });
  expect(() => journal.claim(f.owner.id, request)).toThrow("missing or retired");
  expect(rows(f.db)).toEqual(initial); expect(f.db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  f.createOwner(); const draft = f.store.getDraft("draft"), owner = f.store.draftBrowserOwners.get(f.owner.id);
  const claimed = journal.claim(f.owner.id, request);
  expect(claimed.fresh).toBe(true); expect(claimed.record).toMatchObject({ ownerKind: "draft", ownerId: f.owner.id, state: "pending", controlEpoch: request.controlEpoch });
  expect("sessionId" in claimed.record).toBe(false);
  expect(f.store.getDraft("draft")).toEqual(draft); expect(f.store.draftBrowserOwners.get(f.owner.id)).toEqual(owner); expect(f.store.listSessions()).toEqual([]);
  expect(f.db.query("PRAGMA user_version").get()).toEqual({ user_version: 19 });
  expect(JSON.stringify(rows(f.db))).not.toContain(request.initialUrl!);
  const saved = rows(f.db); claimed.record.requestHash = "changed returned object";
  expect(journal.claim(f.owner.id, request).fresh).toBe(false); expect(rows(f.db)).toEqual(saved);
});

test("same request ID binds exact parsed input across store connections and distinct draft owners", () => {
  const f = fixture(); f.createOwner(); const second = new HostStore(f.root); stores.push(second);
  const input = { ...request }, first = f.store.draftBrowserCreations.claim(f.owner.id, input);
  input.initialUrl = "https://example.invalid/mutated";
  expect(second.draftBrowserCreations.claim(f.owner.id, request)).toEqual({ fresh: false, record: first.record });
  const before = rows(f.db);
  for (const change of [{ initialUrl: input.initialUrl }, { initialUrl: undefined }, { controlEpoch: "epoch-two" }, { observedAt: 1001 }]) {
    expect(() => second.draftBrowserCreations.claim(f.owner.id, { ...request, ...change })).toThrow("different input");
    expect(() => second.draftBrowserCreations.observe(f.owner.id, { ...request, ...change }, "epoch-two")).toThrow("different input");
  }
  expect(rows(f.db)).toEqual(before);
  const otherOwner = { ...f.owner, id: "other-draft-owner" }; f.store.draftBrowserOwners.claim(otherOwner);
  expect(second.draftBrowserCreations.claim(otherOwner.id, request).fresh).toBe(true);
  expect(second.draftBrowserCreations.get(otherOwner.id, request)?.ownerId).toBe(otherOwner.id);
});

test("actual reopen makes old pending inspect-only unknown without rewriting it; completed history survives", () => {
  const f = fixture(); f.createOwner(); const initial = f.store.draftBrowserCreations.claim(f.owner.id, request).record;
  close(f.store); const next = new HostStore(f.root); stores.push(next);
  const before = rows(f.db);
  expect(next.draftBrowserCreations.observe(f.owner.id, request, "epoch-two")).toMatchObject({ status: "settled", receipt: { outcome: "unknown", ownerId: f.owner.id, ownerKind: "draft" } });
  expect(next.draftBrowserCreations.claim(f.owner.id, request)).toEqual({ fresh: false, record: initial }); expect(rows(f.db)).toEqual(before);
  const receipt = completed(next.host.id), settled = next.draftBrowserCreations.finish(f.owner.id, request, receipt);
  close(next); const third = new HostStore(f.root); stores.push(third);
  expect(third.draftBrowserCreations.observe(f.owner.id, request, "epoch-three")).toMatchObject({ status: "settled", receipt });
  expect(third.draftBrowserCreations.claim(f.owner.id, request)).toEqual({ fresh: false, record: settled });
});

test("retirement blocks new requests but permits exact observation and finishing an already sent request", () => {
  const f = fixture(); f.createOwner(); const journal = f.store.draftBrowserCreations;
  const prior = journal.claim(f.owner.id, request).record;
  f.store.draftBrowserOwners.retire(f.owner.id);
  expect(() => journal.claim(f.owner.id, { ...request, requestId: "new-request" })).toThrow("missing or retired");
  expect(journal.claim(f.owner.id, request)).toEqual({ fresh: false, record: prior });
  expect(journal.observe(f.owner.id, request, "epoch-one").status).toBe("pending");
  const receipt = completed(f.store.host.id); expect(journal.finish(f.owner.id, request, receipt).receipt).toEqual(receipt);
  expect(journal.observe(f.owner.id, request, "other-epoch")).toMatchObject({ status: "settled", receipt });
});

test("settlement validates actual owner/target shape and preserves the first exact result", () => {
  const f = fixture(); f.createOwner(); const journal = f.store.draftBrowserCreations; journal.claim(f.owner.id, request);
  const valid = completed(f.store.host.id); if (valid.outcome !== "completed") throw new Error("Invalid completion fixture");
  for (const change of [{ ownerKind: "session" }, { hostId: "foreign" }, { ownerId: "other" }, { requestId: "other" }, { workerPid: 0 },
    { tab: { ...valid.tab, name: "wrong" } }, { tab: { ...valid.tab, state: "closed" } }, { targetDisposition: "adopted-existing-target" }]) {
    expect(() => journal.finish(f.owner.id, request, { ...valid, ...change } as DraftBrowserCreationReceipt)).toThrow();
    expect(journal.get(f.owner.id, request)?.state).toBe("pending");
  }
  const settled = journal.finish(f.owner.id, request, valid), before = rows(f.db);
  expect(journal.finish(f.owner.id, request, valid)).toEqual(settled);
  expect(() => journal.finish(f.owner.id, request, { ...valid, tab: { ...valid.tab, targetId: "different" } })).toThrow("settled differently");
  valid.tab.title = "caller mutation"; settled.receipt!.outcome = "unknown";
  expect(journal.get(f.owner.id, request)?.receipt).toMatchObject({ outcome: "completed", tab: { title: "Observed" } }); expect(rows(f.db)).toEqual(before);
});

test("unknown and rejected results are bounded and never turn into fresh claims", () => {
  const f = fixture(); f.createOwner(); const journal = f.store.draftBrowserCreations;
  for (const outcome of ["unknown", "rejected"] as const) {
    const input = { ...request, requestId: outcome }; journal.claim(f.owner.id, input);
    const receipt: DraftBrowserCreationReceipt = { protocolVersion: 1, ownerKind: "draft", hostId: f.store.host.id, ownerId: f.owner.id, requestId: outcome, outcome, message: "actual recorded result" };
    expect(() => journal.finish(f.owner.id, input, { ...receipt, message: "" })).toThrow("message");
    expect(() => journal.finish(f.owner.id, input, { ...receipt, message: "x".repeat(4097) })).toThrow("message");
    journal.finish(f.owner.id, input, receipt);
    expect(journal.observe(f.owner.id, input, "later-epoch")).toMatchObject({ status: "settled", receipt });
    expect(journal.claim(f.owner.id, input).fresh).toBe(false);
  }
});

test("failed insert/settlement preserve owner and pending records for honest recovery", () => {
  const f = fixture(); f.createOwner(); const journal = f.store.draftBrowserCreations, before = rows(f.db);
  f.db.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON metadata WHEN NEW.key LIKE 'draft-browser-creation.v1:%' BEGIN SELECT RAISE(ABORT,'claim failed'); END");
  expect(() => journal.claim(f.owner.id, request)).toThrow("claim failed"); expect(rows(f.db)).toEqual(before);
  f.db.exec("DROP TRIGGER fail_claim"); const pending = journal.claim(f.owner.id, request).record;
  f.db.exec("CREATE TRIGGER fail_finish BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'draft-browser-creation.v1:%' BEGIN SELECT RAISE(ABORT,'finish failed'); END");
  expect(() => journal.finish(f.owner.id, request, completed(f.store.host.id))).toThrow("finish failed");
  expect(journal.get(f.owner.id, request)).toEqual(pending);
  expect(journal.observe(f.owner.id, request, "different-epoch")).toMatchObject({ status: "settled", receipt: { outcome: "unknown" } });
});

test("corrupt or orphaned records fail closed without erasing request identity", () => {
  const f = fixture(); f.createOwner(); const journal = f.store.draftBrowserCreations, original = journal.claim(f.owner.id, request).record;
  for (const change of [{ ownerKind: "session" }, { ownerId: "other" }, { hostId: "foreign" }, { requestHash: "bad" }, { controlEpoch: "bad epoch" }, { state: "settled" }, { createdAt: 0 }]) {
    f.db.query("UPDATE metadata SET data=? WHERE key=?").run(JSON.stringify({ ...original, ...change }), key(f.owner.id)); const before = rows(f.db);
    expect(() => journal.get(f.owner.id, request)).toThrow(); expect(() => journal.claim(f.owner.id, request)).toThrow(); expect(rows(f.db)).toEqual(before);
  }
  f.db.query("UPDATE metadata SET data=? WHERE key=?").run(JSON.stringify(original), key(f.owner.id));
  f.db.query("DELETE FROM metadata WHERE key=?").run("draft-browser-owner.v1:" + f.owner.id);
  expect(() => journal.observe(f.owner.id, request, "epoch-one")).toThrow("lost its owner");
  expect(() => journal.finish("unclaimed", request, completed(f.store.host.id, "unclaimed"))).toThrow("unclaimed");
});
