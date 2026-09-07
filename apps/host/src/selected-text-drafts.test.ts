import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DraftInput, HostCommand, SelectedTextAttachment } from "@agent-desktop/shared";
import { HostStore } from "./store";

const roots: string[] = [], stores = new Set<HostStore>(), databases = new Set<Database>();
afterEach(() => {
  for (const database of databases) database.close(); databases.clear();
  for (const store of stores) store.close(); stores.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-selected-text-draft-")); roots.push(root);
  const store = new HostStore(root); stores.add(store);
  const database = new Database(join(root, "state.sqlite")); databases.add(database);
  const selected: SelectedTextAttachment = {
    id: "selection-one", text: "unsaved α\nsecond line",
    source: { kind: "file", hostId: "another-host", path: "/not/this/host/unsaved.ts",
      range: { start: { line: 9, column: 3 }, end: { line: 10, column: 12 } } },
  };
  const draft: DraftInput = { id: "new-conversation", text: "author text", projectId: null, model: null, selectedTextAttachments: [selected] };
  return { root, store, database, selected, draft, version: () => database.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version };
}

test("selected snapshots retain remote provenance, survive CAS conflict, and remain sticky after clear", () => {
  const { root, store, selected, draft, version } = fixture();
  const written = store.putDraft(draft, 0);
  expect(written.ok).toBe(true); expect(version()).toBe(8);
  selected.text = "mutated outside store";
  expect(store.getDraft(draft.id)?.selectedTextAttachments).toEqual([{
    id: "selection-one", text: "unsaved α\nsecond line", source: { kind: "file", hostId: "another-host", path: "/not/this/host/unsaved.ts",
      range: { start: { line: 9, column: 3 }, end: { line: 10, column: 12 } } },
  }]);
  const stale = store.putDraft({ ...draft, selectedTextAttachments: [{ ...selected, id: "selection-two", text: "other", source: { ...selected.source,
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } } } }] }, 0);
  expect(stale.ok).toBe(false);
  expect(store.getDraft(draft.id)?.selectedTextAttachments?.map(item => item.id)).toEqual(["selection-one"]);
  expect(store.listDraftConflicts()[0]?.attempted.selectedTextAttachments?.map(item => item.id)).toEqual(["selection-two"]);
  const cleared = store.putDraft({ ...draft, selectedTextAttachments: [] }, 1);
  expect(cleared.ok).toBe(true); expect(store.getDraft(draft.id)?.selectedTextAttachments).toEqual([]);
  const { selectedTextAttachments: _selected, ...oldWriter } = draft;
  expect(() => store.putDraft(oldWriter, 2)).toThrow("selected-text");
  const reopened = new HostStore(root); stores.add(reopened);
  expect(reopened.getDraft(draft.id)?.selectedTextAttachments).toEqual([]);
  expect(version()).toBe(8);
});

test("claimed selected-text prompt upgrades schema and only an accepted receipt consumes its exact draft", () => {
  const { store, draft, selected, version } = fixture();
  expect(version()).toBe(1);
  const command: HostCommand = { type: "session.prompt", sessionId: "session", text: draft.text, selectedTextAttachments: [selected], draft: { id: draft.id, revision: 1 } };
  expect(store.claimCommand("selected-send", "hash", command).kind).toBe("claimed");
  expect(version()).toBe(8);
  expect(store.putDraft(draft, 0).ok).toBe(true);
  store.finishCommand("selected-send", "hash", { ok: false, commandId: "selected-send", error: { code: "OUTCOME_UNKNOWN", message: "receipt unavailable" } });
  expect(store.getDraft(draft.id)).toMatchObject({ revision: 1, text: draft.text, selectedTextAttachments: [selected] });
  expect(store.claimCommand("selected-accepted", "accepted-hash", { ...command, draft: { id: draft.id, revision: 1 } }).kind).toBe("claimed");
  store.finishCommand("selected-accepted", "accepted-hash", { ok: true, commandId: "selected-accepted", admission: { kind: "user-message", entryId: "native-user" } });
  expect(store.getDraft(draft.id)).toMatchObject({ revision: 2, text: "", selectedTextAttachments: [],
    lastConsumption: { commandId: "selected-accepted", submittedRevision: 1 } });
});


test("receipt and draft clear rollback together, while later edits survive an earlier accepted send", () => {
  const { store, database, draft, selected } = fixture();
  store.putDraft(draft, 0);
  const command: HostCommand = { type: "session.prompt", sessionId: "session", text: draft.text, selectedTextAttachments: [selected], draft: { id: draft.id, revision: 1 } };
  store.claimCommand("send", "hash", command);
  expect(() => store.finishCommand("send", "hash", { ok: true, commandId: "send", admission: { kind: "native-command", command: "local" } })).toThrow("ordinary native");
  database.exec("CREATE TRIGGER selected_receipt_failure BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT, 'selected receipt disk failure'); END");
  expect(() => store.finishCommand("send", "hash", { ok: true, commandId: "send", admission: { kind: "user-message", entryId: "user" } })).toThrow("disk failure");
  expect(store.getDraft(draft.id)).toMatchObject({ revision: 1, selectedTextAttachments: [selected] });
  expect(store.getCommand("send")?.state).toBe("pending");
  database.exec("DROP TRIGGER selected_receipt_failure");
  store.putDraft({ ...draft, text: "later edit", selectedTextAttachments: [{ ...selected, id: "later" }] }, 1);
  store.finishCommand("send", "hash", { ok: true, commandId: "send", admission: { kind: "user-message", entryId: "user" } });
  expect(store.getDraft(draft.id)).toMatchObject({ revision: 2, text: "later edit", selectedTextAttachments: [{ id: "later" }] });
  expect(store.getDraft(draft.id)?.lastConsumption).toBeUndefined();
});
