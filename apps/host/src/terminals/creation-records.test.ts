import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../store";
import { parseTerminalCreationRequest, type TerminalCreationRequest } from "./creation-records";
import { checkHostStateCompatibility } from "../../../../scripts/host-state-compatibility";

const ReopeningHostStore: typeof HostStore = process.env.AGENT_DESKTOP_TERMINAL_JOURNAL_READER
  ? (await import(process.env.AGENT_DESKTOP_TERMINAL_JOURNAL_READER)).HostStore : HostStore;
const roots: string[] = [], stores: HostStore[] = [], databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const epoch = "11111111-1111-1111-1111-111111111111", nextEpoch = "22222222-2222-2222-2222-222222222222";
const target = "33333333-3333-3333-3333-333333333333";
const input: TerminalCreationRequest = { version: 1, requestId: "44444444-4444-4444-4444-444444444444", controlEpoch: epoch,
  target: { projectId: target }, cols: 120, rows: 30 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-terminal-journal-")); roots.push(root);
  const store = new HostStore(root); stores.push(store);
  const db = new Database(join(root, "state.sqlite")); databases.push(db);
  return { root, store, db, schema: () => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version };
}
const metadata = (db: Database) => db.query("SELECT key,data FROM metadata ORDER BY key").all();
function close(store: HostStore) { stores.splice(stores.indexOf(store), 1); store.close(); }

test("terminal creation reads preserve legacy state; first claim reserves UUID and fences schema17", () => {
  const f = fixture(), policy = f.store.getDeviceAccessPolicy(), before = metadata(f.db);
  expect(f.store.terminalCreations.get(input)).toBeUndefined();
  expect(f.store.terminalCreations.observe(input, epoch)).toEqual({ status: "unavailable" });
  expect(f.schema()).toBe(1); expect(metadata(f.db)).toEqual(before);
  f.store.writeMetadata("unrelated", { value: "unchanged" });
  const first = f.store.terminalCreations.claim(input);
  expect(first.fresh).toBe(true); expect(first.record.state).toBe("pending");
  expect(first.record.terminalId).toMatch(/^[a-f0-9-]{36}$/);
  expect(first.record.terminalId).not.toBe(input.requestId);
  expect(f.schema()).toBe(17); expect(f.store.getDeviceAccessPolicy()).toEqual(policy);
  expect(f.store.readMetadata<{ value: string }>("unrelated")).toEqual({ value: "unchanged" });
  const saved = metadata(f.db);
  expect(f.store.terminalCreations.claim(input)).toEqual({ fresh: false, record: first.record });
  expect(f.store.terminalCreations.observe(input, epoch)).toEqual({ status: "pending", terminalId: first.record.terminalId });
  expect(metadata(f.db)).toEqual(saved);
});

test("terminal creation survives actual HostStore reopen with original identity and inspect-only unknown", () => {
  const f = fixture(), policy = f.store.getDeviceAccessPolicy(), hostId = f.store.host.id;
  const claimed = f.store.terminalCreations.claim(input); close(f.store);
  const reopened = new ReopeningHostStore(f.root); stores.push(reopened);
  expect(reopened.host.id).toBe(hostId); expect(reopened.getDeviceAccessPolicy()).toEqual(policy);
  const before = metadata(f.db);
  expect(reopened.terminalCreations.observe(input, nextEpoch)).toMatchObject({ status: "settled", receipt: { outcome: "unknown", terminalId: claimed.record.terminalId } });
  expect(reopened.terminalCreations.get(input)).toEqual(claimed.record);
  expect(reopened.terminalCreations.claim(input).fresh).toBe(false);
  expect(metadata(f.db)).toEqual(before);
  const receipt = { outcome: "completed" as const, terminalId: claimed.record.terminalId };
  reopened.terminalCreations.finish(input, receipt); close(reopened);
  const third = new ReopeningHostStore(f.root); stores.push(third);
  expect(third.terminalCreations.observe(input, nextEpoch)).toEqual({ status: "settled", receipt });
  expect(third.terminalCreations.claim(input).fresh).toBe(false);
  expect(() => checkHostStateCompatibility({ stateSchemaVersions: [16] }, f.root)).toThrow("schema 17");
  expect(checkHostStateCompatibility({ stateSchemaVersions: [17] }, f.root).checkedSchemaVersion).toBe(17);
});

test("two SQLite connections share one reserved identity and reject changed target, epoch or dimensions", () => {
  const f = fixture(), other = new HostStore(f.root); stores.push(other);
  const first = f.store.terminalCreations.claim(input);
  expect(other.terminalCreations.claim(input)).toEqual({ fresh: false, record: first.record });
  for (const changed of [{ ...input, target: { sessionId: target } }, { ...input, target: { projectId: nextEpoch } },
    { ...input, cols: 121 }, { ...input, rows: 31 }, { ...input, controlEpoch: nextEpoch }]) {
    expect(() => other.terminalCreations.claim(changed)).toThrow("different input");
    expect(() => other.terminalCreations.observe(changed, epoch)).toThrow("different input");
  }
  const receipt = { outcome: "completed" as const, terminalId: first.record.terminalId };
  const saved = f.store.terminalCreations.finish(input, receipt);
  expect(other.terminalCreations.finish(input, receipt)).toEqual(saved);
  expect(() => other.terminalCreations.finish(input, { outcome: "unknown", terminalId: first.record.terminalId, message: "different" })).toThrow("settled differently");
  expect(other.terminalCreations.get(input)).toEqual(saved);
});

test("failed SQLite writes roll back admission/schema/policy or leave settlement pending", () => {
  const f = fixture(), before = metadata(f.db);
  f.db.exec("CREATE TRIGGER fail_terminal_claim BEFORE INSERT ON metadata WHEN NEW.key LIKE 'terminal-creation.v1:%' BEGIN SELECT RAISE(ABORT,'claim blocked'); END");
  expect(() => f.store.terminalCreations.claim(input)).toThrow("claim blocked");
  expect(f.schema()).toBe(1); expect(metadata(f.db)).toEqual(before);
  f.db.exec("DROP TRIGGER fail_terminal_claim");
  const claimed = f.store.terminalCreations.claim(input);
  f.db.exec("CREATE TRIGGER fail_terminal_finish BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'terminal-creation.v1:%' BEGIN SELECT RAISE(ABORT,'finish blocked'); END");
  expect(() => f.store.terminalCreations.finish(input, { outcome: "completed", terminalId: claimed.record.terminalId })).toThrow("finish blocked");
  expect(f.store.terminalCreations.get(input)).toEqual(claimed.record);
});

test("only reserved terminal identities settle; malformed and oversized outcomes cannot corrupt pending records", () => {
  const f = fixture(), claimed = f.store.terminalCreations.claim(input), terminalId = claimed.record.terminalId;
  for (const value of [{ outcome: "completed", terminalId: nextEpoch }, { outcome: "completed", terminalId, message: "extra" },
    { outcome: "unknown", terminalId, message: " " }, { outcome: "unknown", terminalId, message: "\ud800".repeat(4096) },
    { outcome: "unknown", terminalId, message: "x".repeat(4097) }]) {
    expect(() => f.store.terminalCreations.finish(input, value as never)).toThrow();
    expect(f.store.terminalCreations.get(input)).toEqual(claimed.record);
  }
  expect(() => f.store.terminalCreations.finish({ ...input, requestId: nextEpoch }, { outcome: "completed", terminalId })).toThrow("unclaimed");
  for (const outcome of ["not-submitted", "unknown"] as const) {
    const request = { ...input, requestId: crypto.randomUUID() };
    const record = f.store.terminalCreations.claim(request).record;
    const receipt = { outcome, terminalId: record.terminalId, message: "Exact outcome" };
    f.store.terminalCreations.finish(request, receipt);
    expect(f.store.terminalCreations.observe(request, nextEpoch)).toEqual({ status: "settled", receipt });
    expect(f.store.terminalCreations.claim(request).fresh).toBe(false);
  }
});

test("strict request parsing preserves exact identity and rejects unsupported fields before migration", () => {
  const f = fixture(), before = metadata(f.db);
  for (const value of [{ ...input, version: 2 }, { ...input, requestId: "bad" }, { ...input, controlEpoch: "" },
    { ...input, cols: 0 }, { ...input, rows: 65536 }, { ...input, cols: 1.5 }, { ...input, rows: undefined },
    { ...input, target: {} }, { ...input, target: { projectId: target, sessionId: target } },
    { ...input, target: { filePath: "/tmp" } }, { ...input, cwd: "/tmp" }, { ...input, environment: {} }]) {
    expect(() => f.store.terminalCreations.claim(value as never)).toThrow();
  }
  expect(metadata(f.db)).toEqual(before); expect(f.schema()).toBe(1);
  expect(parseTerminalCreationRequest({ rows: 65535, cols: 1, target: { sessionId: target }, controlEpoch: epoch, requestId: input.requestId, version: 1 }))
    .toEqual({ ...input, target: { sessionId: target }, cols: 1, rows: 65535 });
});

test("corrupt records and missing fenced policy cannot be repaired into new admission", () => {
  const f = fixture(), record = f.store.terminalCreations.claim(input).record;
  const key = `terminal-creation.v1:${input.requestId}`;
  for (const changed of [{ ...record, requestHash: "0".repeat(64) }, { ...record, hostId: nextEpoch },
    { ...record, terminalId: "bad" }, { ...record, state: "settled" }, { ...record, createdAt: 0 }]) {
    f.db.query("UPDATE metadata SET data=? WHERE key=?").run(JSON.stringify(changed), key);
    const before = metadata(f.db);
    expect(() => f.store.terminalCreations.claim(input)).toThrow();
    expect(() => f.store.terminalCreations.observe(input, nextEpoch)).toThrow();
    expect(metadata(f.db)).toEqual(before);
  }
  f.db.exec("DELETE FROM metadata WHERE key='device-access.v1'");
  expect(() => f.store.terminalCreations.claim({ ...input, requestId: nextEpoch })).toThrow("policy is missing");
  expect(f.store.readMetadata("device-access.v1")).toBeUndefined();
});

test("receipt identity is independent of native catalogue/history and caller object mutations", () => {
  const f = fixture(), request = structuredClone(input), claimed = f.store.terminalCreations.claim(request);
  request.cols = 12; claimed.record.request.rows = 10;
  const saved = f.store.terminalCreations.get(input)!;
  expect(saved.request).toEqual(input);
  f.store.terminalCreations.finish(input, { outcome: "completed", terminalId: saved.terminalId });
  // No native manager/catalogue exists in this fixture; the journal requires neither.
  expect(f.store.terminalCreations.observe(input, nextEpoch)).toMatchObject({ status: "settled", receipt: { terminalId: saved.terminalId } });
  expect(f.store.terminalCreations.claim(input).fresh).toBe(false);
});
