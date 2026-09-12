import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserCreateReceipt, BrowserCreateRequest } from "@agent-desktop/shared";
import { HostStore } from "./store";
const ReopeningHostStore: typeof HostStore = process.env.AGENT_DESKTOP_BROWSER_JOURNAL_READER
  ? (await import(process.env.AGENT_DESKTOP_BROWSER_JOURNAL_READER)).HostStore : HostStore;
import { checkHostStateCompatibility } from "../../../scripts/host-state-compatibility";

const roots: string[] = [], stores: HostStore[] = [], databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const input: BrowserCreateRequest = { requestId: "durable-browser", controlEpoch: "first-epoch", observedAt: 1_000_000,
  initialUrl: "https://private.example/initial?query=not-stored" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-browser-journal-")); roots.push(root);
  const store = new HostStore(root); stores.push(store);
  const db = new Database(join(root, "state.sqlite")); databases.push(db);
  const schema = () => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  return { root, store, db, schema };
}
const metadata = (db: Database) => db.query("SELECT key,data FROM metadata ORDER BY key").all();
function completed(hostId: string): BrowserCreateReceipt {
  return { protocolVersion: 1, hostId, sessionId: "session", requestId: input.requestId, outcome: "completed", workerPid: 42,
    targetDisposition: "created-page", tab: { name: `desktop-${input.requestId}`, targetId: "native", backend: "worker", kindTag: "headless", state: "alive",
      url: "https://example.invalid/result", title: "Page", viewport: { width: 640, height: 480 } } };
}
function closeStore(store: HostStore) { stores.splice(stores.indexOf(store), 1); store.close(); }

test("journal reads do not migrate; first claim persists schema16 and exact legacy policy without storing initial URL", () => {
  const f = fixture(), before = metadata(f.db), policy = f.store.getDeviceAccessPolicy();
  expect(f.schema()).toBe(1);
  expect(f.store.browserCreations.get("session", input)).toBeUndefined();
  expect(f.store.browserCreations.observe("session", input, "first-epoch").status).toBe("unavailable");
  expect(metadata(f.db)).toEqual(before); expect(f.schema()).toBe(1);
  f.store.writeMetadata("unrelated", { keep: "exact" });
  const claimed = f.store.browserCreations.claim("session", input);
  expect(claimed.fresh).toBe(true); expect(claimed.record).toMatchObject({ state: "pending", controlEpoch: "first-epoch", sessionId: "session", requestId: input.requestId });
  expect(f.schema()).toBe(16); expect(f.store.getDeviceAccessPolicy()).toEqual(policy);
  expect(f.store.readMetadata<{ keep: string }>("unrelated")).toEqual({ keep: "exact" });
  expect(JSON.stringify(metadata(f.db))).not.toContain(input.initialUrl!);
  const saved = metadata(f.db);
  expect(f.store.browserCreations.claim("session", input)).toEqual({ fresh: false, record: claimed.record });
  expect(f.store.browserCreations.observe("session", input, "first-epoch").status).toBe("pending");
  expect(metadata(f.db)).toEqual(saved);
});

test("pending and confirmed creation survive actual database reopen; epoch changes never make prior IDs fresh", () => {
  const f = fixture(), policy = f.store.getDeviceAccessPolicy(), host = f.store.host.id;
  f.store.browserCreations.claim("session", input);
  closeStore(f.store);
  const reopened = new ReopeningHostStore(f.root); stores.push(reopened);
  expect(reopened.host.id).toBe(host); expect(reopened.getDeviceAccessPolicy()).toEqual(policy);
  const before = metadata(f.db);
  expect(reopened.browserCreations.observe("session", input, "next-epoch")).toMatchObject({ status: "settled", receipt: { outcome: "unknown", hostId: host, sessionId: "session", requestId: input.requestId } });
  expect(reopened.browserCreations.claim("session", input).fresh).toBe(false);
  expect(() => reopened.browserCreations.claim("session", { ...input, controlEpoch: "next-epoch" })).toThrow("different input");
  expect(metadata(f.db)).toEqual(before);
  const receipt = completed(host); reopened.browserCreations.finish("session", input, receipt);
  closeStore(reopened);
  const third = new ReopeningHostStore(f.root); stores.push(third);
  expect(third.browserCreations.observe("session", input, "third-epoch")).toMatchObject({ status: "settled", receipt });
  expect(third.browserCreations.claim("session", input).fresh).toBe(false);
  expect(() => checkHostStateCompatibility({ stateSchemaVersions: Array.from({ length: 15 }, (_, i) => i + 1) }, f.root)).toThrow("schema 16");
  expect(checkHostStateCompatibility({ stateSchemaVersions: [16] }, f.root).checkedSchemaVersion).toBe(16);
});

test("two real SQLite store connections share one claim and immutable settled result", () => {
  const f = fixture(), second = new HostStore(f.root); stores.push(second);
  const a = f.store.browserCreations.claim("session", input), b = second.browserCreations.claim("session", input);
  expect(a.fresh).toBe(true); expect(b).toEqual({ fresh: false, record: a.record });
  for (const changed of [{ ...input, initialUrl: "https://example.invalid/other" }, { ...input, initialUrl: undefined }, { ...input, observedAt: input.observedAt + 1 }]) {
    expect(() => second.browserCreations.claim("session", changed)).toThrow("different input");
    expect(() => second.browserCreations.get("session", changed)).toThrow("different input");
  }
  const receipt = completed(f.store.host.id), settled = f.store.browserCreations.finish("session", input, receipt);
  expect(second.browserCreations.finish("session", input, receipt)).toEqual(settled);
  expect(() => second.browserCreations.finish("session", input, { protocolVersion: 1, hostId: f.store.host.id, sessionId: "session", requestId: input.requestId, outcome: "unknown", message: "conflicting" })).toThrow("settled differently");
  expect(second.browserCreations.get("session", input)).toEqual(settled);
  expect(second.browserCreations.get("other-session", input)).toBeUndefined();
});

test("failed admission rolls schema and default-policy seeding back; failed settlement retains pending", () => {
  const f = fixture(), before = metadata(f.db);
  f.db.exec("CREATE TRIGGER fail_browser_claim BEFORE INSERT ON metadata WHEN NEW.key LIKE 'browser-creation.v1:%' BEGIN SELECT RAISE(ABORT,'claim blocked'); END");
  expect(() => f.store.browserCreations.claim("session", input)).toThrow("claim blocked");
  expect(f.schema()).toBe(1); expect(metadata(f.db)).toEqual(before);
  f.db.exec("DROP TRIGGER fail_browser_claim");
  const claimed = f.store.browserCreations.claim("session", input);
  f.db.exec("CREATE TRIGGER fail_browser_finish BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'browser-creation.v1:%' BEGIN SELECT RAISE(ABORT,'finish blocked'); END");
  expect(() => f.store.browserCreations.finish("session", input, completed(f.store.host.id))).toThrow("finish blocked");
  expect(f.store.browserCreations.get("session", input)).toEqual(claimed.record);
});

test("receipt validation refuses foreign target/owner and preserves bounded unknown or rejection", () => {
  const f = fixture(); f.store.browserCreations.claim("session", input);
  const valid = completed(f.store.host.id);
  if (valid.outcome !== "completed") throw new Error("Expected completed fixture");
  for (const invalid of [{ ...valid, hostId: "foreign" }, { ...valid, sessionId: "other" }, { ...valid, requestId: "other" },
    { ...valid, workerPid: 0 }, { ...valid, tab: { ...valid.tab, name: "other" } }, { ...valid, targetDisposition: "adopted-existing-target" as const }]) {
    expect(() => f.store.browserCreations.finish("session", input, invalid)).toThrow();
    expect(f.store.browserCreations.get("session", input)?.state).toBe("pending");
  }
  for (const outcome of ["unknown", "rejected"] as const) {
    const request = { ...input, requestId: outcome }; f.store.browserCreations.claim("session", request);
    const receipt = { protocolVersion: 1 as const, hostId: f.store.host.id, sessionId: "session", requestId: outcome, outcome, message: "Recorded outcome" };
    expect(f.store.browserCreations.finish("session", request, receipt).receipt).toEqual(receipt);
    expect(f.store.browserCreations.observe("session", request, "later-epoch")).toMatchObject({ status: "settled", receipt });
  }
  expect(() => f.store.browserCreations.finish("unclaimed", input, valid)).toThrow("unclaimed");
});

test("corrupt records and already-fenced missing policy fail closed without repairing authority", () => {
  const f = fixture(); f.store.browserCreations.claim("session", input);
  const key = `browser-creation.v1:${JSON.stringify(["session", input.requestId])}`;
  f.db.query("UPDATE metadata SET data=? WHERE key=?").run('{"version":1}', key);
  const before = metadata(f.db);
  expect(() => f.store.browserCreations.get("session", input)).toThrow("Invalid browser admission");
  expect(() => f.store.browserCreations.claim("session", input)).toThrow(); expect(metadata(f.db)).toEqual(before);
  f.db.exec("DELETE FROM metadata WHERE key='device-access.v1'");
  expect(() => f.store.browserCreations.claim("different", input)).toThrow("policy is missing");
  expect(f.store.readMetadata("device-access.v1")).toBeUndefined();
});
