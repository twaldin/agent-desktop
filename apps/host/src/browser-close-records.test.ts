import { afterEach, expect, test } from "bun:test";
import { HostStore } from "./store";
import { closeFixture, closeInput, closeOwner } from "./fixtures/browser-close";
import { parseBrowserCloseRequest, parseBrowserCloseOwner } from "../../../packages/shared/src/browser-close";
import { checkHostStateCompatibility } from "../../../scripts/host-state-compatibility";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const fixture = () => { const f = closeFixture(); cleanups.push(f.cleanup); return f; };
test("close reads leave schema/policy unchanged; first claim atomically fences schema20 and preserves the session", () => {
  const f = fixture(), before = f.metadata(), policy = f.store.getDeviceAccessPolicy();
  expect(f.store.browserCloses.get(closeOwner, closeInput)).toBeUndefined();
  expect(f.metadata()).toEqual(before); expect(f.schema()).toBe(1);
  expect(f.store.browserCloses.claim(closeOwner, closeInput).fresh).toBe(true);
  expect(f.schema()).toBe(20); expect(f.store.getDeviceAccessPolicy()).toEqual(policy); expect(f.store.getSession("session")).toEqual(f.session);
  expect(() => checkHostStateCompatibility({ stateSchemaVersions: [19] }, f.root)).toThrow("schema 20");
  expect(checkHostStateCompatibility({ stateSchemaVersions: [20] }, f.root).checkedSchemaVersion).toBe(20);
});
test("real reopen and independent SQLite connections preserve a single exact immutable reservation", () => {
  const f = fixture(), first = f.store.browserCloses.claim(closeOwner, closeInput);
  const other = new HostStore(f.root);
  try {
    expect(other.browserCloses.claim(closeOwner, closeInput)).toEqual({ fresh: false, record: first.record });
    expect(other.browserCloses.get(closeOwner, closeInput)?.receipt).toBeUndefined();
    for (const changed of [{ ...closeInput, controlEpoch: "new-epoch" }, { ...closeInput, target: { ...closeInput.target, targetId: "replacement" } }, { ...closeInput, observedAt: 1001 }]) {
      expect(() => other.browserCloses.claim(closeOwner, changed)).toThrow("different input");
    }
    other.browserCloses.finish(closeOwner, closeInput, f.completed());
  } finally { other.close(); }
  const reopened = new HostStore(f.root);
  try {
    expect(reopened.browserCloses.get(closeOwner, closeInput)?.receipt).toEqual(f.completed());
    expect(reopened.browserCloses.claim(closeOwner, closeInput).fresh).toBe(false);
  } finally { reopened.close(); }
});
test("claim failure rolls back schema and policy; failed finish leaves a reserved request", () => {
  const f = fixture(), before = f.metadata();
  f.db.exec("CREATE TRIGGER close_claim_failure BEFORE INSERT ON metadata WHEN NEW.key LIKE 'browser-close.v1:%' BEGIN SELECT RAISE(ABORT,'claim failed'); END");
  expect(() => f.store.browserCloses.claim(closeOwner, closeInput)).toThrow("claim failed");
  expect(f.schema()).toBe(1); expect(f.metadata()).toEqual(before);
  f.db.exec("DROP TRIGGER close_claim_failure");
  f.store.browserCloses.claim(closeOwner, closeInput);
  f.db.exec("CREATE TRIGGER close_finish_failure BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'browser-close.v1:%' BEGIN SELECT RAISE(ABORT,'finish failed'); END");
  expect(() => f.store.browserCloses.finish(closeOwner, closeInput, f.completed())).toThrow("finish failed");
  expect(f.store.browserCloses.get(closeOwner, closeInput)?.receipt).toBeUndefined();
  expect(f.store.browserCloses.claim(closeOwner, closeInput).fresh).toBe(false);
});
test("session/draft namespaces, exact revision and retirement do not alias or erase admitted close history", () => {
  const f = fixture(), owner = f.draft();
  f.store.browserCloses.claim(closeOwner, closeInput); f.store.browserCloses.claim(owner, closeInput);
  expect(() => f.store.browserCloses.claim({ ...owner, draftRevision: 2 }, closeInput)).toThrow("different input");
  f.store.draftBrowserOwners.retire(owner.ownerId);
  expect(() => f.store.browserCloses.claim(owner, { ...closeInput, requestId: "new-request" })).toThrow("owner changed");
  expect(f.store.browserCloses.finish(owner, closeInput, f.completed(owner)).receipt).toEqual(f.completed(owner));
  expect(f.store.browserCloses.get(closeOwner, closeInput)?.receipt).toBeUndefined();
  expect(f.store.getDraft("draft")?.text).toBe("keep unsent");
});
test("receipt checks reject wrong owner/target/confirmation and preserve deep input/output ownership", () => {
  const f = fixture(), input = structuredClone(closeInput), owner = structuredClone(closeOwner);
  const claim = f.store.browserCloses.claim(owner, input);
  input.target.name = "caller-mutated"; claim.record.request.target.targetId = "reader-mutated";
  expect(f.store.browserCloses.get(closeOwner, closeInput)?.request).toEqual(closeInput);
  for (const receipt of [{ ...f.completed(), target: { ...closeInput.target, workerPid: 43 } }, { ...f.completed(), owner: { kind: "session", sessionId: "foreign" } }, { ...f.completed(), released: false }]) {
    expect(() => f.store.browserCloses.finish(closeOwner, closeInput, receipt as ReturnType<typeof f.completed>)).toThrow();
  }
  const completed = f.store.browserCloses.finish(closeOwner, closeInput, f.completed());
  completed.receipt!.target.name = "consumer-mutated";
  expect(f.store.browserCloses.get(closeOwner, closeInput)?.receipt).toEqual(f.completed());
  expect(() => f.store.browserCloses.finish(closeOwner, closeInput, f.store.browserCloses.unknown(closeOwner, closeInput))).toThrow("settled differently");
});
test("close parsing rejects malformed identities, additional operations and oversized targets", () => {
  for (const input of [{ ...closeInput, target: { ...closeInput.target, workerPid: 0 } }, { ...closeInput, killBrowser: true },
    { ...closeInput, target: { ...closeInput.target, name: "x".repeat(201) } }, { ...closeInput, requestId: "" }, { ...closeInput, observedAt: NaN }]) expect(() => parseBrowserCloseRequest(input)).toThrow();
  for (const owner of [{ kind: "session", sessionId: "session", draftId: "draft" }, { kind: "draft", ownerId: "one", draftId: "draft", draftRevision: 0 }]) expect(() => parseBrowserCloseOwner(owner)).toThrow();
  const f = fixture();
  expect(() => f.store.browserCloses.claim({ kind: "session", sessionId: "missing" }, closeInput)).toThrow("no longer exists");
  expect(f.schema()).toBe(1);
});
