import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCommand, ImageAttachmentRef } from "@agent-desktop/shared";
import { HostStore, type DraftInput } from "./store";

const roots: string[] = [], stores: HostStore[] = [], databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-image-draft-")); roots.push(root);
  const store = new HostStore(root); stores.push(store);
  const db = new Database(join(root, "state.sqlite")); databases.push(db);
  const image: ImageAttachmentRef = { id: "chip", hostId: store.host.id, kind: "image", sha256: "a".repeat(64), name: "雪.png", bytes: 128, mimeType: "image/png" };
  const draft: DraftInput = { id: "new-conversation", text: "", projectId: null, model: null, attachments: [image] };
  return { root, store, db, image, draft, version: () => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version };
}

test("image draft format survives conflicts and removal without a schema downgrade", () => {
  const { root, store, image, draft, version } = fixture();
  expect(store.putDraft(draft, 0).ok).toBe(true); expect(version()).toBe(3);
  const stale = store.putDraft({ ...draft, attachments: [{ ...image, id: "other", name: "other.png" }] }, 0);
  expect(stale.ok).toBe(false);
  expect(store.listDraftConflicts()[0]!.attempted.attachments?.[0]?.id).toBe("other");
  const { attachments: _attachments, ...legacy } = draft;
  expect(() => store.putDraft(legacy, 1)).toThrow("attachment");
  expect(store.getDraft(draft.id)?.attachments).toEqual([image]);
  expect(store.putDraft({ ...draft, attachments: [], approvalMode: "write" }, 1).ok).toBe(true);
  expect(version()).toBe(3);
  const reopened = new HostStore(root); stores.push(reopened);
  expect(reopened.getDraft(draft.id)?.attachments).toEqual([]);
  expect(reopened.listDraftConflicts()[0]!.attempted.attachments?.[0]?.id).toBe("other");
  expect(() => reopened.putDraft({ ...legacy, lastConsumption: { commandId: "forged", submittedRevision: 1 } } as DraftInput, 2)).toThrow("consumption");
});

test("native admission receipt and matching image draft clear commit together", () => {
  const { store, db, draft } = fixture(); store.putDraft(draft, 0);
  const command: HostCommand = { type: "session.prompt", sessionId: "native-session", text: "", attachments: draft.attachments, draft: { id: draft.id, revision: 1 } };
  store.claimCommand("send", "hash", command);
  const result = { ok: true as const, commandId: "send", admission: { kind: "user-message" as const, entryId: "native-user-entry" } };
  db.exec("CREATE TRIGGER reject_receipt BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END");
  expect(() => store.finishCommand("send", "hash", result)).toThrow("fixture receipt failure");
  expect(store.getCommand("send")?.state).toBe("pending");
  expect(store.getDraft(draft.id)).toMatchObject({ revision: 1, attachments: draft.attachments });
  expect(store.getDraft(draft.id)?.lastConsumption).toBeUndefined();
  db.exec("DROP TRIGGER reject_receipt");
  store.finishCommand("send", "hash", result);
  expect(store.getDraft(draft.id)).toMatchObject({ revision: 2, text: "", attachments: [], lastConsumption: { commandId: "send", submittedRevision: 1 } });
  expect(store.getCommand("send")?.result).toEqual(result);
  store.finishCommand("send", "hash", result);
  expect(store.getDraft(draft.id)?.revision).toBe(2);
});

test("newer image edits and unknown admission remain intact", () => {
  const { store, draft, image } = fixture(); store.putDraft(draft, 0);
  const command: HostCommand = { type: "session.prompt", sessionId: "native-session", text: "", attachments: draft.attachments, draft: { id: draft.id, revision: 1 } };
  store.claimCommand("old-send", "old-hash", command);
  store.putDraft({ ...draft, attachments: [{ ...image, id: "new-chip" }] }, 1);
  store.finishCommand("old-send", "old-hash", { ok: true, commandId: "old-send", admission: { kind: "user-message", entryId: "native-user" } });
  expect(store.getDraft(draft.id)).toMatchObject({ revision: 2, attachments: [{ id: "new-chip" }] });
  expect(store.getDraft(draft.id)?.lastConsumption).toBeUndefined();
  store.claimCommand("unknown", "unknown-hash", { ...command, draft: { id: draft.id, revision: 2 } });
  store.finishCommand("unknown", "unknown-hash", { ok: false, commandId: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "Native receipt lost" } });
  expect(store.getDraft(draft.id)?.revision).toBe(2);
  expect(() => store.consumeDraft({ id: draft.id, revision: 2 })).toThrow("command");
});

test("failed image-format writes never promote state and foreign references never enter the ledger", () => {
  const { store, db, draft, image, version } = fixture();
  db.exec("CREATE TRIGGER reject_draft BEFORE INSERT ON drafts BEGIN SELECT RAISE(ABORT, 'fixture draft failure'); END");
  expect(() => store.putDraft(draft, 0)).toThrow("fixture draft failure");
  expect(version()).toBe(1);
  db.exec("DROP TRIGGER reject_draft");
  expect(() => store.putDraft({ ...draft, attachments: [{ ...image, hostId: "foreign" }] }, 0)).toThrow("another host");
  expect(() => store.claimCommand("foreign-send", "hash", { type: "session.prompt", sessionId: "session", text: "", attachments: [{ ...image, hostId: "foreign" }] })).toThrow("another host");
  expect(store.getCommand("foreign-send")).toBeUndefined(); expect(version()).toBe(1);
  store.claimCommand("image-send", "hash", { type: "session.prompt", sessionId: "session", text: "", attachments: [image] });
  expect(version()).toBe(3);
  store.claimCommand("permissions", "hash", { type: "session.prompt", sessionId: "session", text: "hello", approvalMode: "write" });
  expect(version()).toBe(3);
});
