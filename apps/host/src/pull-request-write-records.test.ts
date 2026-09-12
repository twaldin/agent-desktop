import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import { parsePullRequestWriteRequest, parsePullRequestWriteReceipt, type PullRequestWriteRequest, type PullRequestWriteReceipt } from "../../../packages/shared/src/pull-request-write";
import { checkHostStateCompatibility } from "../../../scripts/host-state-compatibility";

export const submission: PullRequestWriteRequest = { requestId: "original-request-0001", accountId: "account-one", pullRequest: { hostname: "github.com", owner: "owner", repository: "repo", number: 42 }, action: "comment", expectedHeadOid: "a".repeat(40), body: "Keep this text" };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pr-write-records-")), store = new HostStore(root), db = new Database(join(root, "state.sqlite"));
  cleanups.push(() => { db.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const schema = () => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  const metadata = () => db.query("SELECT key,data FROM metadata ORDER BY key").all();
  const completed = (): PullRequestWriteReceipt => ({ hostId: store.host.id, request: structuredClone(submission), outcome: "succeeded", message: "Submitted to GitHub.", url: "https://github.com/owner/repo/pull/42#issuecomment-123" });
  return { root, store, db, schema, metadata, completed };
}
test("read-only lookup preserves schema; first reservation atomically fences schema24 and legacy policy", () => {
  const f = fixture(), before = f.metadata(), policy = f.store.getDeviceAccessPolicy();
  expect(f.store.pullRequestWrites.get(submission)).toBeUndefined();
  expect(f.metadata()).toEqual(before); expect(f.schema()).toBe(1);
  expect(f.store.pullRequestWrites.claim(submission).fresh).toBe(true);
  expect(f.schema()).toBe(24); expect(f.store.getDeviceAccessPolicy()).toEqual(policy);
  expect(() => checkHostStateCompatibility({ stateSchemaVersions: [23] }, f.root)).toThrow("schema 24");
  expect(checkHostStateCompatibility({ stateSchemaVersions: [24] }, f.root).checkedSchemaVersion).toBe(24);
});
test("two SQLite connections and reopen retain original identity and immutable completion", () => {
  const f = fixture(), first = f.store.pullRequestWrites.claim(submission);
  const other = new HostStore(f.root);
  try {
    expect(other.pullRequestWrites.claim(submission)).toEqual({ fresh: false, record: first.record });
    for (const change of [{ body: "changed" }, { action: "approve" as const }, { accountId: "other" }, { pullRequest: { ...submission.pullRequest, number: 43 } }, { expectedHeadOid: "b".repeat(40) }])
      expect(() => other.pullRequestWrites.claim({ ...submission, ...change })).toThrow("different input");
    other.pullRequestWrites.finish(submission, f.completed());
  } finally { other.close(); }
  const reopened = new HostStore(f.root);
  try {
    expect(reopened.pullRequestWrites.get(submission)?.receipt).toEqual(f.completed());
    expect(reopened.pullRequestWrites.claim(submission).fresh).toBe(false);
    expect(() => reopened.pullRequestWrites.finish(submission, { ...f.completed(), outcome: "unknown" })).toThrow("differently");
  } finally { reopened.close(); }
});
test("claim failure rolls back policy/schema; failed finish cannot authorize a second dispatch", () => {
  const f = fixture(), before = f.metadata();
  f.db.exec("CREATE TRIGGER pr_claim_fail BEFORE INSERT ON metadata WHEN NEW.key LIKE 'pull-request-write.v1:%' BEGIN SELECT RAISE(ABORT,'claim failed'); END");
  expect(() => f.store.pullRequestWrites.claim(submission)).toThrow("claim failed");
  expect(f.schema()).toBe(1); expect(f.metadata()).toEqual(before);
  f.db.exec("DROP TRIGGER pr_claim_fail"); f.store.pullRequestWrites.claim(submission);
  f.db.exec("CREATE TRIGGER pr_finish_fail BEFORE UPDATE ON metadata WHEN NEW.key LIKE 'pull-request-write.v1:%' BEGIN SELECT RAISE(ABORT,'finish failed'); END");
  expect(() => f.store.pullRequestWrites.finish(submission, f.completed())).toThrow("finish failed");
  expect(f.store.pullRequestWrites.claim(submission).fresh).toBe(false);
  expect(f.store.pullRequestWrites.get(submission)?.receipt).toBeUndefined();
  expect(f.store.pullRequestWrites.unresolved(submission, false).outcome).toBe("unknown");
});
test("saved values isolate nested caller and reader mutations; no unclaimed or foreign confirmation", () => {
  const f = fixture(), input = structuredClone(submission);
  const saved = f.store.pullRequestWrites.claim(input);
  input.pullRequest.owner = "mutated"; saved.record.request.pullRequest.repository = "mutated";
  expect(f.store.pullRequestWrites.get(submission)?.request).toEqual(submission);
  for (const receipt of [{ ...f.completed(), hostId: "foreign" }, { ...f.completed(), url: "https://github.com/foreign/repo/pull/42" }, { ...f.completed(), url: null }])
    expect(() => f.store.pullRequestWrites.finish(submission, receipt)).toThrow();
  const receipt = f.store.pullRequestWrites.finish(submission, f.completed()); receipt.request.pullRequest.owner = "consumer";
  expect(f.store.pullRequestWrites.get(submission)?.receipt).toEqual(f.completed());
  expect(() => f.store.pullRequestWrites.finish({ ...submission, requestId: "unclaimed-request-001" }, { ...f.completed(), request: { ...submission, requestId: "unclaimed-request-001" } })).toThrow("not durably");
});
test("parser rejects malformed and oversized submissions, and validates success URL ownership", () => {
  for (const input of [{ ...submission, requestId: "" }, { ...submission, action: "merge" }, { ...submission, body: "  " }, { ...submission, expectedHeadOid: "main" }, { ...submission, body: "💾".repeat(15001) }, { ...submission, command: "extra" }])
    expect(() => parsePullRequestWriteRequest(input)).toThrow();
  expect(parsePullRequestWriteRequest({ ...submission, action: "approve", body: "" }).body).toBe("");
  const f = fixture();
  for (const url of ["https://github.com.evil/owner/repo/pull/42", "https://user@github.com/owner/repo/pull/42", "https://github.com/owner/repo/pull/420", "http://github.com/owner/repo/pull/42"])
    expect(() => parsePullRequestWriteReceipt({ ...f.completed(), url }, f.store.host.id, submission)).toThrow();
});
