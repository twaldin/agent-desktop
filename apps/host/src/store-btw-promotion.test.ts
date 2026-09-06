import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@agent-desktop/shared";
import type { BtwPromotionIntent } from "./btw-promotion";
import type { LocalEnvironmentWorkerEnvironment } from "./local-environments/environment";
import { HostStore } from "./store";
import { checkHostStateCompatibility } from "../../../scripts/host-state-compatibility";

const roots: string[] = [], stores = new Set<HostStore>(), databases = new Set<Database>();
afterEach(() => {
  for (const database of databases) database.close(); databases.clear();
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-store-btw-promotion-")); roots.push(root);
  const cwd = join(root, "project"); mkdirSync(cwd);
  const store = new HostStore(join(root, "data")); stores.add(store);
  const origin: SessionSummary = { id: "origin", hostId: store.host.id, projectId: null, cwd, title: "Original", status: "idle",
    sessionFile: join(root, "sessions", "origin.jsonl"), model: { provider: "fixture", id: "model" }, createdAt: 1, updatedAt: 1, archived: false };
  const child: SessionSummary = { ...origin, id: "child", title: "Side chat", sessionFile: join(root, "sessions", "child.jsonl"), createdAt: 2, updatedAt: 2 };
  store.upsertSession(origin);
  store.putDraft({ id: "session:origin", text: "new main draft", projectId: null, model: origin.model }, 0);
  store.putDraft({ id: "btw:origin", text: "new side draft", projectId: null, model: origin.model }, 0);
  const command = { type: "session.btw.promote" as const, sessionId: origin.id, runId: "run-one" };
  store.claimCommand("promote-one", "request-hash", command);
  const key = `btw-promotion:${origin.id}:${command.runId}`;
  const pending: BtwPromotionIntent = { commandId: "promote-one", originId: origin.id, runId: command.runId, state: "pending" };
  store.writeMetadata(key, pending);
  const environment: LocalEnvironmentWorkerEnvironment = { sourceRoot: cwd, worktreeRoot: cwd,
    environmentDelta: { version: 1, set: { PRIVATE_PROMOTION_VALUE: "retained" }, unset: ["OLD_PROMOTION_VALUE"] } };
  return { root, data: join(root, "data"), store, origin, child, command, key, pending, environment };
}
function version(data: string) {
  const database = new Database(join(data, "state.sqlite"), { readonly: true });
  try { return database.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version; }
  finally { database.close(); }
}

test("matching promotion atomically binds the child and private inherited environment without consuming either draft", () => {
  const f = fixture();
  const complete: BtwPromotionIntent = { ...f.pending, state: "complete", sessionId: f.child.id, sessionFile: f.child.sessionFile };
  expect(f.store.finishBtwPromotion("promote-one", f.child, f.environment, complete, f.key)).toEqual({ ok: true, commandId: "promote-one",
    value: { type: "session.btw.promote", cancelled: false, session: f.child } });
  expect(f.store.getSession(f.child.id)).toEqual(f.child);
  expect(f.store.getSessionEnvironment(f.child.id)).toEqual(f.environment);
  expect(f.store.readMetadata<BtwPromotionIntent>(f.key)).toEqual(complete);
  expect(f.store.getCommand("promote-one")).toMatchObject({ state: "done", result: { ok: true, value: { type: "session.btw.promote", cancelled: false } } });
  expect(f.store.getDraft("session:origin")).toMatchObject({ revision: 1, text: "new main draft" });
  expect(f.store.getDraft("btw:origin")).toMatchObject({ revision: 1, text: "new side draft" });
  expect(version(f.data)).toBe(7);

  f.store.close(); stores.delete(f.store);
  const reopened = new HostStore(f.data); stores.add(reopened);
  expect(reopened.getSession(f.child.id)).toEqual(f.child);
  expect(reopened.getSessionEnvironment(f.child.id)).toEqual(f.environment);
  reopened.close(); stores.delete(reopened);
  const databaseBytes = readFileSync(join(f.data, "state.sqlite"));
  expect(() => checkHostStateCompatibility({ stateSchemaVersions: [1, 2, 3, 4, 5, 6] }, f.data)).toThrow("schema 7 is incompatible");
  expect(checkHostStateCompatibility({ stateSchemaVersions: [1, 2, 3, 4, 5, 6, 7] }, f.data).checkedSchemaVersion).toBe(7);
  expect(readFileSync(join(f.data, "state.sqlite"))).toEqual(databaseBytes);
});

test("cancelled promotion records its receipt without a child, inherited environment, draft clear, or schema bump", () => {
  const f = fixture();
  const cancelled: BtwPromotionIntent = { ...f.pending, state: "cancelled" };
  expect(f.store.finishBtwPromotion("promote-one", f.origin, f.environment, cancelled, f.key)).toEqual({ ok: true, commandId: "promote-one",
    value: { type: "session.btw.promote", cancelled: true, session: f.origin } });
  expect(f.store.listSessions()).toEqual([f.origin]);
  expect(f.store.getSessionEnvironment(f.origin.id)).toBeUndefined();
  expect(f.store.readMetadata<BtwPromotionIntent>(f.key)).toEqual(cancelled);
  expect(f.store.getDraft("session:origin")?.text).toBe("new main draft");
  expect(f.store.getDraft("btw:origin")?.text).toBe("new side draft");
  expect(version(f.data)).toBe(1);
});

test("receipt persistence failure rolls back child, environment, intent transition, and schema promotion", () => {
  const f = fixture();
  const database = new Database(join(f.data, "state.sqlite"), { strict: true }); databases.add(database);
  database.exec("CREATE TRIGGER reject_promotion_receipt BEFORE UPDATE ON commands WHEN OLD.id = 'promote-one' BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");
  const complete: BtwPromotionIntent = { ...f.pending, state: "complete", sessionId: f.child.id, sessionFile: f.child.sessionFile };
  expect(() => f.store.finishBtwPromotion("promote-one", f.child, f.environment, complete, f.key)).toThrow("fixture receipt failure");
  expect(f.store.getCommand("promote-one")?.state).toBe("pending");
  expect(f.store.getSession(f.child.id)).toBeUndefined();
  expect(f.store.getSessionEnvironment(f.child.id)).toBeUndefined();
  expect(f.store.readMetadata<BtwPromotionIntent>(f.key)).toEqual(f.pending);
  expect(f.store.getDraft("session:origin")?.text).toBe("new main draft");
  expect(f.store.getDraft("btw:origin")?.text).toBe("new side draft");
  expect(version(f.data)).toBe(1);
});
