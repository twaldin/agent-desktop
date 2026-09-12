import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import { checkHostStateCompatibility } from "../../../scripts/host-state-compatibility";
import type { DraftBrowserOwnerInput } from "./browser-draft-owner-records";
const roots: string[] = [], stores: HostStore[] = [], databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(project = true) {
  const root = mkdtempSync(join(tmpdir(), "draft-browser-records-")); roots.push(root);
  const cwd = join(root, "project"); mkdirSync(cwd);
  const directory = join(root, "data"), store = new HostStore(directory); stores.push(store);
  const db = new Database(join(directory, "state.sqlite")); databases.push(db);
  const target = project ? store.addProject({ path: cwd }) : null;
  const write = store.putDraft({ id: "new-draft", text: "keep unsent", projectId: target?.id ?? null, model: null }, 0);
  if (!write.ok) throw new Error("Fixture draft did not save");
  const input: DraftBrowserOwnerInput = { id: "browser-owner-one", draftId: write.draft.id, draftRevision: write.draft.revision, projectId: target?.id ?? null, cwd: target?.path ?? realpathSync(cwd) };
  const schema = () => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  return { root, directory, store, db, input, schema };
}
const rows = (db: Database) => db.query("SELECT key,data FROM metadata ORDER BY key").all();
const ownerKey = "draft-browser-owner.v1:browser-owner-one";
function close(store: HostStore) { stores.splice(stores.indexOf(store), 1); store.close(); }

test("read-only absence, first durable draft identity and schema19 preserve draft and legacy policy", () => {
  const f = fixture(), before = rows(f.db), draft = f.store.getDraft(f.input.draftId), policy = f.store.getDeviceAccessPolicy();
  expect(f.store.draftBrowserOwners.get(f.input.id)).toBeUndefined(); expect(f.store.draftBrowserOwners.retire(f.input.id)).toBeUndefined();
  expect(rows(f.db)).toEqual(before); expect(f.schema()).toBe(1);
  const claimed = f.store.draftBrowserOwners.claim(f.input);
  expect(claimed.fresh).toBe(true); expect(claimed.record).toMatchObject({ ...f.input, kind: "draft", version: 1, hostId: f.store.host.id });
  expect(claimed.record.retiredAt).toBeUndefined(); expect(f.schema()).toBe(19);
  expect(f.store.getDraft(f.input.draftId)).toEqual(draft); expect(f.store.listSessions()).toEqual([]); expect(f.store.getDeviceAccessPolicy()).toEqual(policy);
  claimed.record.cwd = "/changed"; f.input.cwd = "/caller-changed";
  expect(f.store.draftBrowserOwners.get(f.input.id)?.cwd).toBe(realpathSync(join(f.root, "project")));
});

test("new claims atomically require current saved draft revision and actual project binding", () => {
  const f = fixture(); const before = rows(f.db);
  for (const bad of [{ draftId: "absent" }, { draftRevision: 2 }, { projectId: null }, { cwd: "/different" }, { id: "" }]) {
    expect(() => f.store.draftBrowserOwners.claim({ ...f.input, ...bad })).toThrow();
  }
  expect(rows(f.db)).toEqual(before); expect(f.schema()).toBe(1);
  const project = f.store.getProject(f.input.projectId!)!;
  f.db.query("UPDATE projects SET data = ? WHERE id = ?").run(JSON.stringify({ ...project, hostId: "foreign-host" }), project.id);
  expect(() => f.store.draftBrowserOwners.claim(f.input)).toThrow("project changed");
  expect(rows(f.db)).toEqual(before);
});

test("exact historical identity survives later draft edits; retired identities cannot become fresh", () => {
  const f = fixture(), original = f.store.draftBrowserOwners.claim(f.input).record;
  const draft = f.store.getDraft(f.input.draftId)!;
  expect(f.store.putDraft({ id: draft.id, text: "newer unsent text", projectId: draft.projectId, model: null }, draft.revision).ok).toBe(true);
  const saved = rows(f.db);
  expect(f.store.draftBrowserOwners.claim(f.input)).toEqual({ fresh: false, record: original }); expect(rows(f.db)).toEqual(saved);
  for (const changed of [{ draftId: "other" }, { draftRevision: 2 }, { projectId: null }, { cwd: "/other" }]) expect(() => f.store.draftBrowserOwners.claim({ ...f.input, ...changed })).toThrow("different input");
  const retired = f.store.draftBrowserOwners.retire(f.input.id)!; expect(retired.retiredAt).toBeGreaterThanOrEqual(original.createdAt);
  const after = rows(f.db); expect(f.store.draftBrowserOwners.retire(f.input.id)).toEqual(retired);
  expect(f.store.draftBrowserOwners.claim(f.input)).toEqual({ fresh: false, record: retired }); expect(rows(f.db)).toEqual(after);
  expect(f.store.draftBrowserOwners.claim({ ...f.input, id: "deliberate-new-owner", draftRevision: 2 }).fresh).toBe(true);
  expect(f.store.getDraft(f.input.draftId)?.text).toBe("newer unsent text");
});

test("two store connections and actual reopen preserve immutable owner and retirement history", () => {
  const f = fixture(), second = new HostStore(f.directory); stores.push(second);
  const original = f.store.draftBrowserOwners.claim(f.input).record;
  expect(second.draftBrowserOwners.claim(f.input)).toEqual({ fresh: false, record: original });
  const retired = second.draftBrowserOwners.retire(f.input.id); close(second); close(f.store);
  const reopened = new HostStore(f.directory); stores.push(reopened);
  expect(reopened.draftBrowserOwners.get(f.input.id)).toEqual(retired);
  expect(reopened.draftBrowserOwners.claim(f.input).fresh).toBe(false);
  expect(() => checkHostStateCompatibility({ stateSchemaVersions: Array.from({ length: 18 }, (_, i) => i + 1) }, f.directory)).toThrow("incompatible");
  expect(checkHostStateCompatibility({ stateSchemaVersions: [19] }, f.directory).checkedSchemaVersion).toBe(19);
});

test("failed durable insert rolls policy/schema back; failed retirement leaves prior record", () => {
  const f = fixture(), before = rows(f.db);
  f.db.exec("CREATE TRIGGER reject_owner BEFORE INSERT ON metadata WHEN NEW.key LIKE 'draft-browser-owner.v1:%' BEGIN SELECT RAISE(ABORT,'owner insert failed'); END");
  expect(() => f.store.draftBrowserOwners.claim(f.input)).toThrow("owner insert failed");
  expect(rows(f.db)).toEqual(before); expect(f.schema()).toBe(1);
  f.db.exec("DROP TRIGGER reject_owner"); const original = f.store.draftBrowserOwners.claim(f.input).record;
  f.db.exec("CREATE TRIGGER reject_retirement BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'draft-browser-owner.v1:%' BEGIN SELECT RAISE(ABORT,'retirement failed'); END");
  expect(() => f.store.draftBrowserOwners.retire(f.input.id)).toThrow("retirement failed");
  expect(f.store.draftBrowserOwners.get(f.input.id)).toEqual(original);
});

test("corrupt, foreign or session-shaped records fail closed without repair", () => {
  const f = fixture(), original = f.store.draftBrowserOwners.claim(f.input).record;
  for (const invalid of [{ hostId: "other" }, { kind: "session" }, { id: "other" }, { createdAt: -1 }, { retiredAt: null }, { draftRevision: 0 }]) {
    f.db.query("UPDATE metadata SET data = ? WHERE key = ?").run(JSON.stringify({ ...original, ...invalid }), ownerKey);
    const before = rows(f.db);
    expect(() => f.store.draftBrowserOwners.get(f.input.id)).toThrow(); expect(() => f.store.draftBrowserOwners.claim(f.input)).toThrow();
    expect(rows(f.db)).toEqual(before);
  }
});

test("projectless persistence keeps the supplied host directory distinct from any session", () => {
  const f = fixture(false);
  const record = f.store.draftBrowserOwners.claim(f.input).record;
  expect(record.projectId).toBeNull(); expect(record.cwd).toBe(f.input.cwd); expect(record.kind).toBe("draft");
  expect(f.store.getSession(record.id)).toBeUndefined(); expect(f.store.listSessions()).toEqual([]);
  // Host default-directory authorization and filesystem identity are not this store's API.
});
