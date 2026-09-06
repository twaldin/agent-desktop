import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCommand, NativeBtwSnapshot } from "@agent-desktop/shared";
import { HostStore } from "./store";

const roots: string[] = [], stores: HostStore[] = [], databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-btw-draft-")); roots.push(root);
  const store = new HostStore(root); stores.push(store);
  const db = new Database(join(root, "state.sqlite")); databases.push(db);
  return { store, db };
}
const snapshot = (runId: string, sessionId: string, question: string): NativeBtwSnapshot => ({
  runId, sessionId, question, status: "running", answer: "", startedAt: 1, updatedAt: 1,
});

test("a matching native side-question receipt and captured draft consume atomically", () => {
  const { store, db } = fixture();
  const saved = store.putDraft({ id: "session:s", text: "/btw why", projectId: null, model: null }, 0);
  if (!saved.ok) throw new Error("fixture draft conflict");
  const command: HostCommand = { type: "session.btw.start", sessionId: "s", question: "why", nativeCommand: "btw", draft: { id: saved.draft.id, revision: 1 } };
  store.claimCommand("side", "hash", command);
  const result = { ok: true as const, commandId: "side", value: { type: "session.btw" as const, snapshot: snapshot("side", "s", "why") } };
  db.exec("CREATE TRIGGER reject_btw_receipt BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");
  expect(() => store.finishCommand("side", "hash", result)).toThrow("fixture receipt failure");
  expect(store.getCommand("side")?.state).toBe("pending");
  expect(store.getDraft("session:s")).toMatchObject({ revision: 1, text: "/btw why" });
  db.exec("DROP TRIGGER reject_btw_receipt");
  expect(store.finishCommand("side", "hash", result).result).toEqual(result);
  expect(store.getDraft("session:s")).toMatchObject({ revision: 2, text: "" });
});

test("foreign receipts, failures, and a newer edit never consume the captured draft", () => {
  const { store } = fixture();
  const saved = store.putDraft({ id: "btw:s", text: "first", projectId: null, model: null }, 0);
  if (!saved.ok) throw new Error("fixture draft conflict");
  const command: HostCommand = { type: "session.btw.start", sessionId: "s", question: "first", draft: { id: "btw:s", revision: 1 } };
  store.claimCommand("failed", "failed-hash", command);
  store.finishCommand("failed", "failed-hash", { ok: false, commandId: "failed", error: { code: "OUTCOME_UNKNOWN", message: "lost" } });
  expect(store.getDraft("btw:s")).toMatchObject({ revision: 1, text: "first" });
  store.claimCommand("foreign", "foreign-hash", command);
  store.finishCommand("foreign", "foreign-hash", { ok: true, commandId: "foreign", value: { type: "session.btw", snapshot: snapshot("other", "s", "first") } });
  expect(store.getDraft("btw:s")).toMatchObject({ revision: 1, text: "first" });
  store.claimCommand("older", "older-hash", command);
  store.putDraft({ ...saved.draft, text: "newer edit" }, 1);
  store.finishCommand("older", "older-hash", { ok: true, commandId: "older", value: { type: "session.btw", snapshot: snapshot("older", "s", "first") } });
  expect(store.getDraft("btw:s")).toMatchObject({ revision: 2, text: "newer edit" });
});
