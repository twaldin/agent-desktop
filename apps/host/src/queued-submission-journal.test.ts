import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostCommand } from "../../../packages/shared/src/protocol";
import { HostStore } from "./store";

const roots: string[] = [], stores = new Set<HostStore>();
const open = (root: string) => { const store = new HostStore(root); stores.add(store); return store; };
const close = (store: HostStore) => { store.close(); stores.delete(store); };
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(text = "captured follow-up") {
  const root = mkdtempSync(join(tmpdir(), "agent-desktop-follow-up-journal-")); roots.push(root);
  const store = open(root), saved = store.putDraft({ id: "session:session", text, projectId: null, model: null }, 0);
  if (!saved.ok) throw new Error("fixture draft conflict");
  const command: HostCommand = { type: "session.follow-up", sessionId: "session", text, delivery: "follow-up", draft: { id: saved.draft.id, revision: saved.draft.revision } };
  return { root, store, command };
}

test("native admission consumes only the exact draft and same command retry returns its receipt", () => {
  const f = fixture(), hash = "hash";
  expect(f.store.claimCommand("follow", hash, f.command).kind).toBe("claimed");
  const admitting = f.store.beginQueuedSubmission("follow", hash);
  expect(admitting).toMatchObject({ commandId: "follow", phase: "admitting", outcome: "pending", revision: 1 });
  expect(f.store.getDraft("session:session")?.text).toBe("captured follow-up");
  const queued = f.store.advanceQueuedSubmission("follow", hash, { phase: "queued" });
  expect(queued).toMatchObject({ phase: "queued", outcome: "pending", revision: 2 });
  expect(f.store.getDraft("session:session")).toMatchObject({ text: "", revision: 2 });
  expect(f.store.claimCommand("follow", hash, f.command)).toMatchObject({ kind: "done", record: { result: { value: { receipt: queued } } } });
  expect(f.store.claimCommand("follow", "changed", { ...f.command, text: "different" }).kind).toBe("conflict");
  const final = f.store.advanceQueuedSubmission("follow", hash, { phase: "settled", outcome: "succeeded", entryId: "entry" });
  expect(final).toMatchObject({ phase: "settled", outcome: "succeeded", entryId: "entry", revision: 3 });
});

test("reopen marks an admitting or queued command unknown without replay and preserves its original identity", () => {
  const f = fixture(), hash = "hash";
  f.store.claimCommand("follow", hash, f.command); f.store.beginQueuedSubmission("follow", hash); f.store.advanceQueuedSubmission("follow", hash, { phase: "queued" });
  close(f.store);
  const reopened = open(f.root), receipt = reopened.getQueuedSubmission("follow");
  expect(receipt).toMatchObject({ commandId: "follow", phase: "settled", outcome: "unknown", revision: 3 });
  expect(reopened.claimCommand("follow", hash, f.command)).toMatchObject({ kind: "done", record: { command: f.command, result: { value: { receipt } } } });
  expect(() => reopened.advanceQueuedSubmission("follow", hash, { phase: "queued" })).not.toThrow();
  expect(reopened.getQueuedSubmission("follow")).toEqual(receipt);
});

test("native rejection retains the captured draft and cannot later become queued", () => {
  const f = fixture(), hash = "hash";
  f.store.claimCommand("follow", hash, f.command); f.store.beginQueuedSubmission("follow", hash);
  const rejected = f.store.advanceQueuedSubmission("follow", hash, { phase: "settled", outcome: "not-recorded", message: "native rejected" });
  expect(rejected).toMatchObject({ outcome: "not-recorded", phase: "settled" });
  expect(f.store.getDraft("session:session")?.text).toBe("captured follow-up");
  expect(f.store.advanceQueuedSubmission("follow", hash, { phase: "queued" })).toEqual(rejected);
});
