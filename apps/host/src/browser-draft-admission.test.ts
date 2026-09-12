import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DraftBrowserAdmissions } from "./browser-draft-admission";
import { HostStore } from "./store";

const roots: string[] = [], stores: HostStore[] = [], databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(project = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "browser-draft-admission-"))); roots.push(root);
  const cwd = join(root, "project"), defaultCwd = join(root, "default"), other = join(root, "other");
  for (const path of [cwd, defaultCwd, other]) mkdirSync(path);
  const store = new HostStore(join(root, "data")); stores.push(store);
  const db = new Database(join(root, "data", "state.sqlite")); databases.push(db);
  const target = project ? store.addProject({ path: cwd }) : null;
  const saved = store.putDraft({ id: "draft", text: "unsent text", projectId: target?.id ?? null, model: null }, 0);
  if (!saved.ok) throw new Error("Fixture draft save failed");
  const request = { hostId: store.host.id, ownerId: "draft-browser", draftId: saved.draft.id, draftRevision: saved.draft.revision };
  const admission = new DraftBrowserAdmissions(store, defaultCwd);
  return { root, cwd, defaultCwd, other, store, db, target, request, admission };
}
const metadata = (db: Database) => db.query("SELECT key,data FROM metadata ORDER BY key").all();

test("admission derives the saved project directory, preserves the draft, and ignores caller paths", () => {
  const f = fixture(), draft = f.store.getDraft("draft");
  const input = { ...f.request, cwd: f.other, projectId: null };
  const admitted = f.admission.admit(input);
  expect(admitted.fresh).toBe(true);
  expect(admitted.record).toMatchObject({ kind: "draft", hostId: f.store.host.id, cwd: f.cwd, projectId: f.target!.id, draftRevision: 1 });
  input.ownerId = "different"; input.draftId = "different";
  admitted.assertCurrent();
  expect(f.store.draftBrowserOwners.get(f.request.ownerId)).toEqual(admitted.record);
  expect(f.store.getDraft("draft")).toEqual(draft); expect(f.store.listSessions()).toEqual([]);
});

test("projectless admission uses only the host default; symlink retarget invalidates the original sample", () => {
  const f = fixture(false), link = join(f.root, "default-link"); symlinkSync(f.defaultCwd, link);
  const service = new DraftBrowserAdmissions(f.store, link);
  const admitted = service.admit({ ...f.request, cwd: f.other } as typeof f.request);
  expect(admitted.record.cwd).toBe(f.defaultCwd); expect(admitted.record.projectId).toBeNull();
  admitted.assertCurrent();
  unlinkSync(link); symlinkSync(f.other, link);
  expect(() => admitted.assertCurrent()).toThrow("directory identity changed");
  unlinkSync(link); symlinkSync(f.defaultCwd, link);
  expect(() => admitted.assertCurrent()).toThrow("no longer current");
  expect(service.admit(f.request).fresh).toBe(false);
  expect(() => new DraftBrowserAdmissions(f.store, f.other).admit(f.request)).toThrow("original binding");
});

test("invalid host/draft/revision admission cannot create identity or migrate schema", () => {
  const f = fixture(), before = metadata(f.db);
  for (const change of [{ hostId: "foreign" }, { draftId: "missing" }, { draftRevision: 2 }, { draftRevision: 0 }, { ownerId: "" }, { hostId: "\0" }]) {
    expect(() => f.admission.admit({ ...f.request, ...change })).toThrow();
  }
  expect(metadata(f.db)).toEqual(before);
  expect(f.db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  expect(() => new DraftBrowserAdmissions(f.store, "relative")).toThrow("absolute");
});

test("missing, non-directory and symlink-substituted project paths fail before durable claim", () => {
  const f = fixture(), before = metadata(f.db), held = join(f.root, "original");
  renameSync(f.cwd, held);
  expect(() => f.admission.admit(f.request)).toThrow();
  writeFileSync(f.cwd, "not a directory");
  expect(() => f.admission.admit(f.request)).toThrow("not a directory");
  unlinkSync(f.cwd); symlinkSync(f.other, f.cwd);
  expect(() => f.admission.admit(f.request)).toThrow("project directory changed");
  expect(metadata(f.db)).toEqual(before);
  unlinkSync(f.cwd); renameSync(held, f.cwd);
  expect(f.admission.admit(f.request).fresh).toBe(true);
});

test("same canonical path with a new directory inode invalidates an admitted owner permanently", () => {
  const f = fixture(), admitted = f.admission.admit(f.request), held = join(f.root, "original");
  renameSync(f.cwd, held); mkdirSync(f.cwd);
  expect(() => admitted.assertCurrent()).toThrow("directory identity changed");
  rmSync(f.cwd, { recursive: true }); renameSync(held, f.cwd);
  expect(() => admitted.assertCurrent()).toThrow("no longer current");
  expect(f.store.draftBrowserOwners.get(f.request.ownerId)).toEqual(admitted.record);
});

test("actual catalog retarget, removal and foreign ownership cannot authorize another directory", () => {
  const f = fixture(), original = f.target!, admitted = f.admission.admit(f.request);
  f.db.query("UPDATE projects SET data = ? WHERE id = ?").run(JSON.stringify({ ...original, path: f.other }), original.id);
  expect(() => admitted.assertCurrent()).toThrow("project binding changed");
  expect(() => f.admission.admit(f.request)).toThrow("original binding");
  f.db.query("UPDATE projects SET data = ? WHERE id = ?").run(JSON.stringify({ ...original, hostId: "foreign" }), original.id);
  expect(() => f.admission.admit(f.request)).toThrow("not owned by this host");
  f.db.query("UPDATE projects SET data = ? WHERE id = ?").run(JSON.stringify(original), original.id);
  expect(() => admitted.assertCurrent()).toThrow("no longer current");
  const next = f.admission.admit(f.request);
  f.db.query("DELETE FROM projects WHERE id = ?").run(original.id);
  expect(() => next.assertCurrent()).toThrow("not owned by this host");
});

test("exact historical retry preserves original project after draft edits; retirement prevents readmission", () => {
  const f = fixture(), first = f.admission.admit(f.request), draft = f.store.getDraft("draft")!;
  expect(f.store.putDraft({ id: draft.id, text: "new text", projectId: null, model: null }, draft.revision).ok).toBe(true);
  first.assertCurrent();
  const again = f.admission.admit(f.request);
  expect(again.fresh).toBe(false); expect(again.record).toEqual(first.record);
  expect(() => f.admission.admit({ ...f.request, draftRevision: 2 })).toThrow("different input");
  expect(() => f.admission.admit({ ...f.request, draftId: "other" })).toThrow("different input");
  f.store.draftBrowserOwners.retire(f.request.ownerId);
  expect(() => first.assertCurrent()).toThrow("changed or retired");
  expect(() => f.admission.admit(f.request)).toThrow("retired");
  const deliberate = f.admission.admit({ ...f.request, ownerId: "new-deliberate-owner", draftRevision: 2 });
  expect(deliberate.record.cwd).toBe(f.defaultCwd); expect(deliberate.fresh).toBe(true);
  expect(f.store.getDraft("draft")?.text).toBe("new text"); expect(f.store.listSessions()).toEqual([]);
});

test("failed durable claim does not return admission; retry observes actual SQLite ownership", () => {
  const f = fixture();
  f.db.exec("CREATE TRIGGER fail_owner BEFORE INSERT ON metadata WHEN NEW.key LIKE 'draft-browser-owner.v1:%' BEGIN SELECT RAISE(ABORT,'disk claim failed'); END");
  expect(() => f.admission.admit(f.request)).toThrow("disk claim failed");
  expect(f.store.draftBrowserOwners.get(f.request.ownerId)).toBeUndefined();
  f.db.exec("DROP TRIGGER fail_owner");
  const first = f.admission.admit(f.request), secondStore = new HostStore(join(f.root, "data")); stores.push(secondStore);
  const second = new DraftBrowserAdmissions(secondStore, f.defaultCwd).admit(f.request);
  expect(first.fresh).toBe(true); expect(second.fresh).toBe(false); expect(second.record).toEqual(first.record);
  secondStore.draftBrowserOwners.retire(f.request.ownerId);
  expect(() => first.assertCurrent()).toThrow("changed or retired");
});

test("directory replacement after durable claim prevents return but does not erase claimed history", () => {
  const f = fixture(), records = f.store.draftBrowserOwners, claim = records.claim.bind(records);
  records.claim = input => {
    const result = claim(input);
    renameSync(f.cwd, join(f.root, "original")); mkdirSync(f.cwd);
    return result;
  };
  try { expect(() => f.admission.admit(f.request)).toThrow("directory identity changed"); }
  finally { records.claim = claim; }
  expect(records.get(f.request.ownerId)).toMatchObject({ id: f.request.ownerId, cwd: f.cwd });
  expect(records.get(f.request.ownerId)?.retiredAt).toBeUndefined();
  // A later lookup is history, never a fresh authorization to replay acquisition.
  expect(f.admission.admit(f.request).fresh).toBe(false);
  expect(f.store.listSessions()).toEqual([]);
});
