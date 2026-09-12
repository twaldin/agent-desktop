import { expect, test } from "bun:test";
import type { CommandEnvelope, CommandResult, DesktopEvent } from "../../../../packages/shared/src/protocol";
import type { GitSubmissionReceipt } from "../../../../packages/shared/src/git-submissions";
import type { GitSubmissionIntent } from "../../../../packages/shared/src/git-submissions";
import type { WorkspaceQueryResult } from "../../../../packages/shared/src/workspace-protocol";
import { WorkspaceState } from "./workspace-state";
import type { OfflineCache } from "./offline-cache";

const target = { projectId: "project" } as const;
function cache(): OfflineCache & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, read: async key => values.get(key) ?? null, write: async (key, value) => { values.set(key, value); } };
}
function receipt(commandId: string, outcome: GitSubmissionReceipt["outcome"] = "pending", revision = 1): GitSubmissionReceipt {
  return { commandId, hostId: "host", target, operation: "commit", revision, phase: outcome === "pending" ? "committing" : "completed", outcome, cancelRequested: false, createdAt: 1, updatedAt: revision };
}
function fixture() {
  const values = cache(), commands: CommandEnvelope[] = [], listeners = new Set<(event: DesktopEvent) => void>();
  const receipts = new Map<string, GitSubmissionReceipt>(); let latest: GitSubmissionReceipt | null = null;
  let unacknowledged = false;
  let heldSubmit: { started: () => void; wait: Promise<void> } | undefined;
  let heldControl: { started: () => void; wait: Promise<void> } | undefined;
  let heldLatest: { started: () => void; wait: Promise<void> } | undefined;
  const bridge = {
    workspaceQuery: async (_target: unknown, query: { type: string; commandId?: string }): Promise<WorkspaceQueryResult> => {
      if (query.type === "git.submission") {
        if (!query.commandId && heldLatest) { heldLatest.started(); await heldLatest.wait; heldLatest = undefined; }
        return { type: "git.submission", receipt: query.commandId ? receipts.get(query.commandId) ?? null : latest };
      }
      if (query.type === "git.status") return { type: "git.status", status: { branch: "main", revision: "r", head: "r", upstream: null, ahead: 0, behind: 0, entries: [] } };
      if (query.type === "files.list") return { type: "files.list", entries: [] };
      if (query.type === "git.action-context") throw new Error("not requested");
      throw new Error(`unexpected read ${query.type}`);
    },
    command: async (envelope: CommandEnvelope): Promise<CommandResult> => {
      commands.push(envelope); const action = envelope.command.type === "workspace.mutate" ? envelope.command.action : undefined;
      if (!action || !action.type.startsWith("git.submit")) throw new Error("unexpected mutation");
      if (action.type === "git.submit" && heldSubmit) { heldSubmit.started(); await heldSubmit.wait; }
      if (action.type !== "git.submit" && heldControl) { heldControl.started(); await heldControl.wait; heldControl = undefined; }
      const id = action.type === "git.submit" ? envelope.id : (action as Extract<typeof action, { commandId: string }>).commandId;
      const prior = receipts.get(id) ?? receipt(id);
      const next = action.type === "git.submit.cancel" ? { ...prior, revision: prior.revision + 1, outcome: "cancelled" as const, phase: "completed" as const, cancelRequested: true }
        : action.type === "git.submit.acknowledge" && !unacknowledged ? { ...prior, revision: prior.revision + 1, acknowledgedAt: 9 }
        : prior;
      receipts.set(id, next); latest = next;
      return { ok: true, commandId: envelope.id, value: { type: action.type, receipt: next } } as CommandResult;
    },
    subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const state = new WorkspaceState(bridge, "host", target, values); state.setConnected(true);
  return { state, bridge, values, commands, receipts, setLatest: (value: GitSubmissionReceipt | null) => { latest = value; if (value) receipts.set(value.commandId, value); }, listeners,
    holdSubmit: () => { let release!: () => void, started!: () => void; const wait = new Promise<void>(done => { release = done; }); const begun = new Promise<void>(done => { started = done; }); heldSubmit = { started, wait }; return { begun, release: () => release() }; },
    holdControl: () => { let release!: () => void, started!: () => void; const wait = new Promise<void>(done => { release = done; }); const begun = new Promise<void>(done => { started = done; }); heldControl = { started, wait }; return { begun, release: () => release() }; },
    holdLatest: () => { let release!: () => void, started!: () => void; const wait = new Promise<void>(done => { release = done; }); const begun = new Promise<void>(done => { started = done; }); heldLatest = { started, wait }; return { begun, release: () => release() }; },
    leaveAcknowledgeUnknown: () => { unacknowledged = true; } };
}
const intent: GitSubmissionIntent = { operation: "commit", contextRevision: "r", selectionMode: "include-unstaged", message: "draft" };

test("submission keeps one original command through recovery and preserves newer draft text", async () => {
  const f = fixture(); await f.state.restore(); f.state.setCommitMessage("draft");
  await f.state.submitGit(intent); const original = f.commands[0]!;
  expect(original.commandVersion).toBe(10); expect(f.state.pending?.envelope.id).toBe(original.id);
  const recovered = new WorkspaceState(f.bridge, "host", target, f.values); recovered.setConnected(true); await recovered.restore();
  recovered.setCommitMessage("newer");
  f.receipts.set(original.id, { ...receipt(original.id, "succeeded", 2), commit: { commit: "abc", summary: "draft", reviewedTree: "a", committedTree: "b", publishedIndexTree: "b" } });
  await recovered.retry();
  expect(f.commands.map(command => command.id)).toEqual([original.id, original.id]);
  expect(recovered.pending).toBeUndefined(); expect(recovered.commitMessage).toBe("newer");
});

test("an exact terminal receipt settles the retained command without resending it", async () => {
  const f = fixture(); await f.state.restore(); f.state.setCommitMessage("draft");
  await f.state.submitGit(intent); const original = f.commands[0]!;
  f.receipts.set(original.id, { ...receipt(original.id, "succeeded", 2), commit: { commit: "abc", summary: "draft", reviewedTree: "a", committedTree: "b", publishedIndexTree: "b" } });
  await f.state.loadGitSubmission();
  expect(f.commands).toHaveLength(1); expect(f.state.pending).toBeUndefined(); expect(f.state.commitMessage).toBe("");
});

test("a failed local recovery write retains the original id without sending it", async () => {
  const f = fixture(); await f.state.restore();
  f.values.write = async () => { throw new Error("cache full"); };
  expect(await f.state.submitGit(intent)).toBe(true);
  expect(f.commands).toHaveLength(0); expect(f.state.pending?.uncertain).toBe(true);
});

test("foreign and stale receipts do not replace a newer owner-scoped receipt", async () => {
  const f = fixture(); await f.state.restore();
  f.setLatest(receipt("mine", "pending", 4)); await f.state.loadGitSubmission();
  expect(f.state.gitSubmission?.revision).toBe(4);
  f.setLatest(receipt("mine", "pending", 3)); await f.state.loadGitSubmission();
  expect(f.state.gitSubmission?.revision).toBe(4);
  f.setLatest({ ...receipt("other"), hostId: "elsewhere" }); await f.state.loadGitSubmission();
  expect(f.state.gitSubmission?.commandId).toBe("mine"); expect(f.state.errors["git-submission"]).toContain("another workspace");
});

test("another client pending or unknown receipt fences mutations; native acknowledge clears only unknown", async () => {
  const f = fixture(); await f.state.restore();
  f.setLatest(receipt("other", "pending")); await f.state.loadGitSubmission();
  expect(await f.state.submitGit(intent)).toBe(false); expect(f.commands).toHaveLength(0);
  f.setLatest(receipt("other", "unknown", 2)); await f.state.loadGitSubmission();
  await f.state.acknowledgeUnknown();
  expect(f.state.gitSubmission?.acknowledgedAt).toBeUndefined();
  expect(await f.state.acknowledgeGitSubmission()).toBe(true);
  expect(f.commands[0]?.commandVersion).toBe(10); expect(f.commands[0]?.command.type === "workspace.mutate" && f.commands[0].command.action.type).toBe("git.submit.acknowledge");
  expect(await f.state.submitGit(intent)).toBe(true);
});

test("reads do not send mutations and cancellation uses a separate v10 receipt command", async () => {
  const f = fixture(); await f.state.restore(); f.setLatest(receipt("remote", "pending"));
  await f.state.loadGitSubmission(); await f.state.loadGit();
  expect(f.commands).toHaveLength(0); f.state.busy = true; expect(await f.state.cancelGitSubmission()).toBe(true);
  expect(f.commands).toHaveLength(1); expect(f.commands[0]?.commandVersion).toBe(10);
  expect(f.state.gitSubmission).toMatchObject({ commandId: "remote", outcome: "cancelled", cancelRequested: true });
});

test("cancellation reaches the host while the original submission delivery is still busy", async () => {
  const f = fixture(); await f.state.restore(); const held = f.holdSubmit();
  const submitting = f.state.submitGit(intent); await held.begun;
  expect(f.state.busy).toBe(true); f.setLatest(receipt(f.commands[0]!.id, "pending")); await f.state.loadGitSubmission();
  expect(await f.state.cancelGitSubmission()).toBe(true);
  expect(f.commands.map(command => command.command.type === "workspace.mutate" ? command.command.action.type : "other")).toEqual(["git.submit", "git.submit.cancel"]);
  held.release(); await submitting;
});

test("a stale terminal receipt cannot settle a newer unknown receipt", async () => {
  const f = fixture(); await f.state.restore(); await f.state.submitGit(intent); const id = f.commands[0]!.id;
  f.setLatest(receipt(id, "unknown", 2)); await f.state.loadGitSubmission();
  f.setLatest(receipt(id, "succeeded", 1)); await f.state.loadGitSubmission();
  expect(f.state.gitSubmission).toMatchObject({ commandId: id, outcome: "unknown", revision: 2 }); expect(f.state.pending?.envelope.id).toBe(id);
});

test("an acknowledgement response without an acknowledgement cannot unlock a submission", async () => {
  const f = fixture(); await f.state.restore(); f.setLatest(receipt("unknown", "unknown")); await f.state.loadGitSubmission(); f.leaveAcknowledgeUnknown();
  expect(await f.state.acknowledgeGitSubmission()).toBe(true);
  expect(f.state.gitSubmissionBlocked).toBe(true); expect(await f.state.submitGit(intent)).toBe(false);
});

test("a recorded commit consumes only its unchanged submitted draft when push later fails", async () => {
  const f = fixture(); await f.state.restore(); f.state.setCommitMessage("draft"); await f.state.submitGit(intent); const id = f.commands[0]!.id;
  f.receipts.set(id, { ...receipt(id, "failed", 2), commit: { commit: "abc", summary: "draft", reviewedTree: "a", committedTree: "b", publishedIndexTree: "b" }, push: { outcome: "failed", sourceCommit: "abc", remote: "origin", targetRef: "main", upstreamRequested: false, applied: { remote: "rejected", upstream: "not-requested" }, summary: "push failed" } });
  await f.state.retry(); expect(f.state.commitMessage).toBe("");
});

test("an observed empty journal discovers another client's pending receipt on a workspace event", async () => {
  const f = fixture(); await f.state.restore(); await f.state.loadGitSubmission();
  f.state.start(); f.setLatest(receipt("other", "pending"));
  for (const listener of f.listeners) listener({ type: "workspace", hostId: "host", target } as DesktopEvent);
  while (!f.state.gitSubmission) await Bun.sleep(1);
  expect(f.state.gitSubmission).toMatchObject({ commandId: "other", outcome: "pending" }); expect(await f.state.submitGit(intent)).toBe(false);
  f.state.stop();
});

test("a delayed latest reply cannot replace a submission admitted while it was in flight", async () => {
  const f = fixture(); await f.state.restore(); f.setLatest(receipt("old", "pending")); const held = f.holdLatest();
  const oldRead = f.state.loadGitSubmission(); await held.begun;
  const submitting = f.state.submitGit(intent); while (!f.commands.length) await Bun.sleep(1); const id = f.commands[0]!.id; held.release(); await Promise.all([oldRead, submitting]);
  expect(f.state.gitSubmission?.commandId).toBe(id); expect(f.state.pending?.envelope.id).toBe(id);
});

test("submission retains the staged choice captured by its caller despite later include toggle changes", async () => {
  const f = fixture(); await f.state.restore(); f.state.setIncludeUnstaged(false);
  await f.state.submitGit({ ...intent, selectionMode: "staged" }); f.state.setIncludeUnstaged(true);
  const action = f.commands[0]!.command.type === "workspace.mutate" ? f.commands[0]!.command.action : undefined;
  expect(action).toMatchObject({ type: "git.submit", intent: { selectionMode: "staged" } });
});

test("a fenced remote submission suppresses autosave delivery attempts", async () => {
  const f = fixture(); await f.state.restore(); f.state.documents.set("dirty.txt", { content: null, text: "dirty", dirty: true, autosave: true });
  f.setLatest(receipt("remote", "pending")); await f.state.loadGitSubmission(); f.state.start(); await Bun.sleep(20);
  expect(f.commands).toHaveLength(0); f.state.stop();
});

test("a late control reply cannot replace a newer latest submission", async () => {
  const f = fixture(); await f.state.restore(); f.setLatest(receipt("old", "pending")); await f.state.loadGitSubmission(); const held = f.holdControl();
  const cancelling = f.state.cancelGitSubmission(); await held.begun;
  f.setLatest(receipt("new", "pending")); await f.state.loadGitSubmission(); held.release(); expect(await cancelling).toBe(false);
  expect(f.state.gitSubmission).toMatchObject({ commandId: "new", outcome: "pending" });
});

/** Abort only to fail a spinning implementation; successful calls must settle without cancellation. */
async function withoutMicrotaskSpin(operation: (signal: AbortSignal) => Promise<boolean>): Promise<boolean> {
  const controller = new AbortController();
  let settled = false;
  const watchdog = (async () => {
    for (let turn = 0; turn < 1_000 && !settled; turn++) await Promise.resolve();
    if (!settled) controller.abort(new Error("close did not settle: microtask save loop"));
  })();
  try {
    const result = await operation(controller.signal);
    expect(controller.signal.aborted).toBe(false);
    return result;
  } finally {
    settled = true;
    await watchdog;
  }
}

for (const outcome of ["pending", "unknown"] as const) {
  for (const method of ["saveUntilClean", "prepareWindowClose"] as const) {
    test(`remote ${outcome} receipt stops ${method} without dispatch or losing the dirty draft`, async () => {
      const f = fixture();
      await f.state.restore();
      const document = { content: null, text: "unsaved local edit", dirty: true, autosave: true };
      f.state.documents.set("dirty.txt", document);
      const original = receipt("remote-original-id", outcome, 4);
      f.setLatest(original);
      await f.state.loadGitSubmission();
      expect(f.state.pending).toBeUndefined();
      expect(f.state.busy).toBe(false);
      const cachedBefore = new Map(f.values.values);
      try {
        const result = await withoutMicrotaskSpin(signal => method === "saveUntilClean"
          ? f.state.saveUntilClean("dirty.txt", signal)
          : f.state.prepareWindowClose(signal));
        expect(result).toBe(false);
        expect(f.commands).toHaveLength(0);
        expect(f.state.gitSubmission).toEqual(receipt("remote-original-id", outcome, 4));
        expect(f.state.pending).toBeUndefined();
        expect(f.state.documents.get("dirty.txt")).toEqual({ content: null, text: "unsaved local edit", dirty: true, autosave: true });
        expect(f.values.values).toEqual(cachedBefore);
      } finally {
        f.state.stop();
      }
    });
  }
}
