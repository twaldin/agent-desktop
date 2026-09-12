import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-desktop-git-submission-")); roots.push(root);
  const store = new HostStore(join(root, "state"));
  const project = store.addProject({ path: root });
  const command = { type: "workspace.mutate" as const, target: { projectId: project.id }, action: { type: "git.submit" as const,
    intent: { operation: "commit-and-push" as const, contextRevision: "a".repeat(64), selectionMode: "staged" as const, message: "message" } } };
  return { root, store, project, command };
}

function toCommitting(store: HostStore, id: string, hash: string, receipt: { revision: number }) {
  const preparing = store.advanceGitSubmission(id, hash, receipt.revision, { phase: "preparing", progress: "Preparing" });
  return store.advanceGitSubmission(id, hash, preparing.revision, { phase: "committing" });
}

test("partial commit survives restart as inspect-only unknown and blocks a new owner submission until acknowledged", async () => {
  const f = await fixture();
  expect(f.store.claimCommand("first", "hash-first", f.command).kind).toBe("claimed");
  const begun = f.store.beginGitSubmission("first", "hash-first");
  const preparing = f.store.advanceGitSubmission("first", "hash-first", begun.revision, { phase: "preparing" });
  const committing = f.store.advanceGitSubmission("first", "hash-first", preparing.revision, { phase: "committing", commit: {
    commit: "b".repeat(40), summary: "message", reviewedTree: "c".repeat(40), committedTree: "c".repeat(40), publishedIndexTree: "c".repeat(40) } });
  f.store.close();
  const reopened = new HostStore(join(f.root, "state"));
  const recovered = reopened.getGitSubmission({ projectId: f.project.id }, "first")!;
  expect(recovered).toMatchObject({ outcome: "unknown", phase: "committing", commit: committing.commit });
  const duplicate = reopened.claimCommand("first", "hash-first", f.command);
  expect(duplicate.kind).toBe("done");
  expect(duplicate.record.result).toMatchObject({ ok: true, value: { type: "git.submit", receipt: recovered } });
  expect(reopened.claimCommand("second", "hash-second", f.command).kind).toBe("claimed");
  expect(() => reopened.beginGitSubmission("second", "hash-second")).toThrow("Inspect the existing");
  const acknowledged = reopened.acknowledgeGitSubmission({ projectId: f.project.id }, "first");
  expect(acknowledged.acknowledgedAt).toBeNumber();
  expect(reopened.beginGitSubmission("second", "hash-second")).toMatchObject({ commandId: "second", outcome: "pending" });
  reopened.close();
});

test("duplicate hashes, cross-owner reads, cancellation and late cancellation use receipt CAS", async () => {
  const f = await fixture();
  f.store.claimCommand("first", "hash", f.command);
  const receipt = f.store.beginGitSubmission("first", "hash");
  expect(f.store.beginGitSubmission("first", "hash")).toEqual(receipt);
  expect(() => f.store.advanceGitSubmission("first", "wrong", receipt.revision, {})).toThrow("Unknown");
  expect(() => f.store.getGitSubmission({ sessionId: "foreign" }, "first")).toThrow("another host");
  const cancelled = f.store.requestGitSubmissionCancel({ projectId: f.project.id }, "first");
  expect(cancelled.cancelRequested).toBe(true);
  expect(f.store.requestGitSubmissionCancel({ projectId: f.project.id }, "first")).toEqual(cancelled);
  const prepared = f.store.advanceGitSubmission("first", "hash", cancelled.revision, { phase: "preparing" });
  expect(() => f.store.advanceGitSubmission("first", "hash", cancelled.revision, { phase: "generating" })).toThrow("changed");
  expect(() => f.store.advanceGitSubmission("first", "hash", prepared.revision, { phase: "committing" })).toThrow("cancellation prevents");
  expect(() => f.store.finishGitSubmission("first", "hash", prepared.revision, { outcome: "succeeded" })).toThrow("cancellation prevents");
  expect(() => f.store.advanceGitSubmission("first", "hash", prepared.revision, { phase: "completed" })).toThrow("finish transaction");
  expect(f.store.finishGitSubmission("first", "hash", prepared.revision, { outcome: "cancelled" })).toMatchObject({ outcome: "cancelled", phase: "completed" });
  expect(f.store.beginGitSubmission("first", "hash")).toMatchObject({ outcome: "cancelled", cancelRequested: true });
  expect(() => f.store.requestGitSubmissionCancel({ projectId: f.project.id }, "first")).toThrow("no longer");
  f.store.close();
});

test("terminal unknown acknowledgement updates its durable command receipt and partials cannot be replaced", async () => {
  const f = await fixture();
  f.store.claimCommand("first", "hash", f.command);
  const begun = f.store.beginGitSubmission("first", "hash");
  const commit = { commit: "d".repeat(40), summary: "message", reviewedTree: "e".repeat(40), committedTree: "e".repeat(40), publishedIndexTree: "e".repeat(40) };
  const committing = toCommitting(f.store, "first", "hash", begun);
  const withCommit = f.store.advanceGitSubmission("first", "hash", committing.revision, { commit });
  expect(() => f.store.advanceGitSubmission("first", "hash", withCommit.revision, { commit: { ...commit, summary: "changed" } })).toThrow("cannot replace");
  const unknown = f.store.finishGitSubmission("first", "hash", withCommit.revision, { outcome: "unknown", error: { code: "OUTCOME_UNKNOWN", message: "inspect" } });
  const acknowledged = f.store.acknowledgeGitSubmission({ projectId: f.project.id }, "first");
  expect(acknowledged).toMatchObject({ outcome: "unknown", commit: unknown.commit });
  const command = f.store.getCommand("first")!;
  expect(command.result).toMatchObject({ ok: true, value: { type: "git.submit", receipt: { acknowledgedAt: acknowledged.acknowledgedAt } } });
  expect(f.store.acknowledgeGitSubmission({ projectId: f.project.id }, "first")).toEqual(acknowledged);
  f.store.close();
});

test("only real operation phase paths and confirmed receipts can finish succeeded", async () => {
  const f = await fixture();
  f.store.claimCommand("first", "hash", f.command);
  const queued = f.store.beginGitSubmission("first", "hash");
  expect(() => f.store.advanceGitSubmission("first", "hash", queued.revision, { phase: "committing" })).toThrow("transition");
  const preparing = f.store.advanceGitSubmission("first", "hash", queued.revision, { phase: "preparing", progress: "Preparing" });
  expect(() => f.store.advanceGitSubmission("first", "hash", preparing.revision, { phase: "pushing" })).toThrow("transition");
  const committing = f.store.advanceGitSubmission("first", "hash", preparing.revision, { phase: "committing", generatedMessage: "message" });
  expect(() => f.store.finishGitSubmission("first", "hash", committing.revision, { outcome: "succeeded" })).toThrow("confirmed");
  const commit = { commit: "f".repeat(40), summary: "message", reviewedTree: "a".repeat(40), committedTree: "a".repeat(40), publishedIndexTree: "a".repeat(40) };
  const withCommit = f.store.advanceGitSubmission("first", "hash", committing.revision, { commit });
  const pushing = f.store.advanceGitSubmission("first", "hash", withCommit.revision, { phase: "pushing" });
  const push = { outcome: "succeeded" as const, sourceCommit: commit.commit, remote: "origin", targetRef: "refs/heads/main", upstreamRequested: false,
    applied: { remote: "confirmed" as const, upstream: "not-requested" as const }, summary: "pushed" };
  expect(f.store.finishGitSubmission("first", "hash", pushing.revision, { outcome: "succeeded", push })).toMatchObject({ outcome: "succeeded", commit, push });
  f.store.close();
});
