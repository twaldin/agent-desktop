import { expect, test } from "bun:test";
import type { CommandEnvelope, CommandResult, Draft, SessionSummary } from "../../../../packages/shared/src/protocol";
import type { LocalEnvironmentPreparationPublic } from "../../../../packages/shared/src/environment-preparations";
import { DraftController, type DraftCache } from "./drafts";
import { EnvironmentPreparationPause, SubmissionController } from "./submissions";

const remote: Draft = {
  id: "remote-draft", revision: 7, updatedAt: 10, text: "Original input", projectId: "project-a",
  model: { provider: "fixture", id: "original" }, thinkingLevel: "low", environment: null,
  execution: { type: "worktree", startingState: { type: "branch", branchName: "Display topic", remoteRef: "refs/remotes/team/origin/topic" } },
};
const local: Draft = { ...remote, execution: { type: "local" } };
const session: SessionSummary = { id: "session-a", hostId: "host-a", projectId: "project-a", cwd: "/fixture/worktree", title: "Fixture", status: "idle", sessionFile: "/fixture/session", model: null, createdAt: 1, updatedAt: 1, archived: false };
function cache(): DraftCache {
  const values = new Map<string, string>();
  return { read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, value); } };
}
function saved(envelope: CommandEnvelope): CommandResult {
  if (envelope.command.type !== "draft.put") throw new Error("Unexpected command");
  return { ok: true, commandId: envelope.id, value: { ...envelope.command.draft, revision: envelope.command.expectedRevision! + 1, updatedAt: 20 } };
}
const unknown = (envelope: CommandEnvelope): CommandResult => ({ ok: false, commandId: envelope.id, error: { code: "OUTCOME_UNKNOWN", message: "Saved outcome is unknown" } });
const prepared = (id: string): LocalEnvironmentPreparationPublic => ({ id, revision: 3, hostId: "host-a", projectId: "project-a", worktreePath: session.cwd, phase: "validated", needsAttention: false, environment: null, createdAt: 1, updatedAt: 2 });

test("remote save and explicit Local clear retain v12 across draft cache recreation", async () => {
  const storage = cache(), calls: CommandEnvelope[] = [];
  const first = new DraftController(async e => { calls.push(structuredClone(e)); return saved(e); }, "host-a", storage);
  first.ingest(remote); first.update(remote.id, { text: "Saved remote edit" }); first.setConnected(true);
  try {
    const captured = await first.prepareSubmission(remote.id);
    expect(captured.execution).toEqual(remote.execution);
    expect(calls[0]).toMatchObject({ commandVersion: 12, command: { type: "draft.put", expectedRevision: 7, draft: { execution: remote.execution } } });
    first.finishSubmission(remote.id, captured, false);
    first.update(remote.id, { execution: { type: "local" } });
  } finally { first.dispose(); }
  const restored = new DraftController(async e => { calls.push(structuredClone(e)); return saved(e); }, "host-a", storage);
  try {
    restored.setConnected(true); await restored.flush(remote.id);
    expect(calls[1]).toMatchObject({ commandVersion: 12, command: { expectedRevision: 8, draft: { execution: { type: "local" }, text: "Saved remote edit" } } });
    expect(restored.get(remote.id).status).toBe("saved");
  } finally { restored.dispose(); }
});

test("unacknowledged remote save retains v12 after both base and local choice become Local", async () => {
  const storage = cache(), calls: CommandEnvelope[] = [];
  const first = new DraftController(async e => { calls.push(structuredClone(e)); throw new Error("Lost save reply"); }, "host-a", storage);
  try {
    first.ingest(local); first.update(local.id, { execution: remote.execution }); first.setConnected(true);
    await expect(first.flush(local.id)).rejects.toThrow("Lost save reply");
    first.update(local.id, { execution: { type: "local" }, text: "New edit after loss" });
    expect(calls[0]?.commandVersion).toBe(12);
  } finally { first.dispose(); }
  const stored = JSON.parse(storage.read(first.cacheKey)!);
  expect(stored[0].base.execution).toEqual({ type: "local" });
  expect(stored[0].draft.execution).toEqual({ type: "local" });
  const restored = new DraftController(async e => {
    calls.push(structuredClone(e));
    return { ok: false, commandId: e.id, error: { code: "DRAFT_CONFLICT", message: "Remote save arrived" }, currentDraft: { ...remote, revision: 8 } };
  }, "host-a", storage);
  try {
    restored.setConnected(true);
    await expect(restored.flush(local.id)).rejects.toThrow("Remote save arrived");
    expect(calls[1]?.commandVersion).toBe(12);
    expect(restored.get(local.id)).toMatchObject({ status: "conflict", draft: { text: "New edit after loss", execution: { type: "local" } }, conflict: { execution: remote.execution } });
    expect(calls).toHaveLength(2);
  } finally { restored.dispose(); }
});

test("an unsupported remote save keeps the draft and never sends a legacy fallback", async () => {
  const calls: CommandEnvelope[] = [], controller = new DraftController(async e => {
    calls.push(structuredClone(e)); return { ok: false, commandId: e.id, error: { code: "REMOTE_WORKTREE_PROTOCOL_UNSUPPORTED", message: "Update the owning host" } };
  }, "host-a");
  try {
    controller.ingest(remote); controller.update(remote.id, { text: "Preserve me" }); controller.setConnected(true);
    await expect(controller.prepareSubmission(remote.id)).rejects.toThrow("Update the owning host");
    expect(calls).toHaveLength(1); expect(calls[0]?.commandVersion).toBe(12);
    expect(controller.get(remote.id)).toMatchObject({ status: "error", draft: { text: "Preserve me", execution: remote.execution } });
  } finally { controller.dispose(); }
});

test("remote captured create and prompt retry preserve the exact v12 envelope despite newer Local input", async () => {
  const storage = cache(), calls: CommandEnvelope[] = [];
  const first = new SubmissionController(async e => { calls.push(structuredClone(e)); return unknown(e); }, "host-a", storage);
  await expect(first.submit(remote, undefined, "prompt")).rejects.toThrow("pending");
  expect(calls[0]).toMatchObject({ commandVersion: 12, command: { type: "session.create", worktree: remote.execution!.type === "worktree" ? remote.execution!.startingState : undefined, environment: null, draft: { id: remote.id, revision: 7 } } });
  const restored = new SubmissionController(async e => { calls.push(structuredClone(e)); return { ok: true, commandId: e.id, value: session }; }, "host-a", storage);
  const result = await restored.submit({ ...local, revision: 9, text: "Keep newer Local edit", model: null }, "different-session", "steer");
  expect(restored.cacheWarning).toBeUndefined(); expect(calls).toHaveLength(3); expect(calls[1]).toEqual(calls[0]);
  expect(calls[2]).toMatchObject({ commandVersion: 12, command: { type: "session.prompt", sessionId: session.id, text: remote.text, draft: { id: remote.id, revision: 7 } } });
  expect(result.submitted).toEqual(remote); expect(restored.entries()).toHaveLength(0);
});

test("remote resume retains v12 and original identity after loss and cache recreation", async () => {
  const storage = cache(), calls: CommandEnvelope[] = [];
  const first = new SubmissionController(async e => {
    calls.push(structuredClone(e));
    return e.command.type === "session.create" ? { ok: true, commandId: e.id, value: { type: "environment.preparation", preparation: prepared(e.id) } } : unknown(e);
  }, "host-a", storage);
  await expect(first.submit(remote, undefined, "prompt")).rejects.toBeInstanceOf(EnvironmentPreparationPause);
  await expect(first.resumeEnvironment(remote.id)).rejects.toThrow("pending");
  expect(calls[1]).toMatchObject({ commandVersion: 12, command: { type: "session.environment.resume", preparationId: calls[0]!.id, expectedRevision: 3 } });
  const restored = new SubmissionController(async e => { calls.push(structuredClone(e)); return { ok: true, commandId: e.id, value: session }; }, "host-a", storage);
  expect(restored.cacheWarning).toBeUndefined(); expect(restored.get(remote.id)?.draft).toEqual(remote);
  const result = await restored.resumeEnvironment(remote.id);
  expect(calls).toHaveLength(4); expect(calls[2]).toEqual(calls[1]);
  expect(calls[3]).toMatchObject({ commandVersion: 12, command: { type: "session.prompt", text: remote.text } });
  expect(result.submitted).toEqual(remote);
});

test("cached remote create, send and resume cannot downgrade independently", async () => {
  const storage = cache();
  const first = new SubmissionController(async e => e.command.type === "session.create"
    ? { ok: true, commandId: e.id, value: { type: "environment.preparation", preparation: prepared(e.id) } } : unknown(e), "host-a", storage);
  await expect(first.submit(remote, undefined, "prompt")).rejects.toBeInstanceOf(EnvironmentPreparationPause);
  await expect(first.resumeEnvironment(remote.id)).rejects.toThrow("pending");
  const original = JSON.parse(storage.read(first.cacheKey)!);
  for (const phase of ["create", "resume"] as const) {
    const altered = structuredClone(original); altered[remote.id][phase].commandVersion = 5;
    storage.write(first.cacheKey, JSON.stringify(altered));
    let dispatches = 0;
    const restored = new SubmissionController(async e => { dispatches++; return unknown(e); }, "host-a", storage);
    expect(restored.cacheWarning).toBeDefined(); expect(restored.entries()).toHaveLength(0); expect(dispatches).toBe(0);
  }
  const sendStorage = cache(), sender = new SubmissionController(async e => unknown(e), "host-a", sendStorage);
  await expect(sender.submit(remote, session.id, "steer")).rejects.toThrow("pending");
  const altered = JSON.parse(sendStorage.read(sender.cacheKey)!); altered[remote.id].send.commandVersion = 5;
  sendStorage.write(sender.cacheKey, JSON.stringify(altered));
  const restored = new SubmissionController(async e => unknown(e), "host-a", sendStorage);
  expect(restored.cacheWarning).toBeDefined(); expect(restored.entries()).toHaveLength(0);
});

test("local environment flows remain v5 and legacy worktrees v4", async () => {
  const calls: CommandEnvelope[] = [];
  const controller = new SubmissionController(async e => { calls.push(structuredClone(e)); return { ok: true, commandId: e.id, value: session }; }, "host-a");
  await controller.submit(local, undefined, "prompt");
  expect(calls.map(e => e.commandVersion)).toEqual([5, 5]);
  await controller.submit({ ...local, environment: undefined, execution: { type: "worktree", startingState: { type: "branch", branchName: "local-topic" } } }, undefined, "prompt");
  expect(calls.slice(2).map(e => e.commandVersion)).toEqual([4, 4]);
});
