import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandEnvelope, CommandResult, Draft } from "@agent-desktop/shared";
import { HostStore } from "../../../host/src/store";
import { DraftController, type DraftCache } from "./drafts";
import { applyProjectExecutionMode, projectExecutionModeDraftId, projectExecutionModeView, resolveProjectExecutionMode, sameModeConflict, selectProjectExecutionMode, selectProjectWithExecutionMode } from "./project-execution-mode";

const image = { id: "image", hostId: "host", kind: "image" as const, name: "diagram.png", mimeType: "image/png" as const, bytes: 4, sha256: "a".repeat(64) };
const initial = (patch: Partial<Draft> = {}): Draft => ({ id: "new-conversation", revision: 1, updatedAt: 1, text: "keep prompt", projectId: "a", model: { provider: "native", id: "model" }, thinkingLevel: "high", approvalMode: "always-ask", attachments: [image], execution: { type: "local" }, ...patch });
const memoryCache = (): DraftCache => { const values = new Map<string,string>(); return { read: key => values.get(key) ?? null, write: (key,value) => { values.set(key,value); } }; };
const saver = (calls: CommandEnvelope[]) => async (envelope: CommandEnvelope): Promise<CommandResult> => {
  calls.push(envelope);
  if (envelope.command.type !== "draft.put") throw new Error("Unexpected command");
  return { ok: true, commandId: envelope.id, value: { ...envelope.command.draft, revision: envelope.command.expectedRevision + 1, updatedAt: Date.now() } };
};

test("rapid project switches retain independent modes and all global composer content", async () => {
  const calls: CommandEnvelope[] = [], drafts = new DraftController(saver(calls), "host");
  try {
    drafts.ingest(initial()); drafts.setConnected(true);
    const worktree = { type: "worktree" as const, startingState: { type: "branch" as const, branchName: "main" } };
    selectProjectExecutionMode(drafts, "new-conversation", "a", worktree);
    selectProjectWithExecutionMode(drafts, "new-conversation", "b");
    selectProjectWithExecutionMode(drafts, "new-conversation", "a");
    const restored = drafts.get("new-conversation").draft;
    expect(restored).toMatchObject({ projectId: "a", text: "keep prompt", model: { id: "model" }, thinkingLevel: "high", approvalMode: "always-ask", attachments: [{ id: "image" }], execution: { type: "worktree" } });
    await drafts.flush(projectExecutionModeDraftId("a"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toMatchObject({ type: "draft.put", draft: { id: projectExecutionModeDraftId("a"), text: "", projectId: "a", model: null, execution: { type: "worktree" } } });
  } finally { drafts.dispose(); }
});

test("starting-state changes stay in the submission draft and do not rewrite the mode slot", async () => {
  const calls: CommandEnvelope[] = [], drafts = new DraftController(saver(calls), "host");
  try {
    const worktree = { type: "worktree" as const, startingState: { type: "branch" as const, branchName: "main" } };
    drafts.ingest(initial({ execution: worktree })); drafts.setConnected(true);
    selectProjectExecutionMode(drafts, "new-conversation", "a", worktree);
    await drafts.flush(projectExecutionModeDraftId("a")); calls.length = 0;
    drafts.update("new-conversation", { execution: { type: "worktree", startingState: { type: "branch", branchName: "feature" } } });
    expect(projectExecutionModeView(drafts, "a").draft.execution).toEqual(worktree);
    await drafts.flush("new-conversation");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toMatchObject({ type: "draft.put", draft: { text: "keep prompt", execution: { type: "worktree", startingState: { branchName: "feature" } } } });
  } finally { drafts.dispose(); }
});

test("offline mode survives renderer restart and flushes against its owner revision", async () => {
  const storage = memoryCache(), calls: CommandEnvelope[] = [];
  const savedMode = initial({ id: projectExecutionModeDraftId("a"), revision: 4, text: "", model: null, attachments: undefined });
  const first = new DraftController(saver(calls), "host", storage);
  first.ingest(initial()); first.ingest(savedMode);
  selectProjectExecutionMode(first, "new-conversation", "a", { type: "worktree", startingState: { type: "working-tree" } });
  first.dispose();
  const restored = new DraftController(saver(calls), "host", storage);
  try {
    expect(projectExecutionModeView(restored, "a")).toMatchObject({ status: "offline", draft: { execution: { type: "worktree" } } });
    restored.setConnected(true); await restored.flush(projectExecutionModeDraftId("a"));
    expect(calls[0]?.command).toMatchObject({ type: "draft.put", expectedRevision: 4, draft: { projectId: "a", execution: { type: "worktree" } } });
  } finally { restored.dispose(); }
});

test("a genuine cross-client mode conflict stays visible and resolves without touching content", () => {
  const drafts = new DraftController(saver([]), "host");
  try {
    const mine = initial({ id: projectExecutionModeDraftId("a"), revision: 1, text: "", model: null, attachments: undefined, execution: { type: "worktree", startingState: { type: "branch", branchName: "main" } } });
    drafts.ingest(initial({ execution: { type: "worktree", startingState: { type: "branch", branchName: "feature" } } }));
    drafts.ingest(mine); drafts.update(mine.id, { execution: { type: "worktree", startingState: { type: "branch", branchName: "mine" } } });
    drafts.ingest({ ...mine, revision: 3, execution: { type: "local" } });
    const conflict = drafts.get(mine.id);
    expect(conflict.status).toBe("conflict"); expect(sameModeConflict(conflict)).toBe(false);
    resolveProjectExecutionMode(drafts, "new-conversation", "a", "remote");
    expect(drafts.get("new-conversation").draft).toMatchObject({ text: "keep prompt", model: { id: "model" }, attachments: [{ id: "image" }], execution: { type: "local" } });
  } finally { drafts.dispose(); }
});

test("same-mode remote updates adopt their revision without replacing the active starting state", () => {
  const drafts = new DraftController(saver([]), "host");
  try {
    const current = initial({ execution: { type: "worktree", startingState: { type: "branch", branchName: "active" } } });
    const slot = initial({ id: projectExecutionModeDraftId("a"), text: "", model: null, attachments: undefined, execution: { type: "worktree", startingState: { type: "branch", branchName: "old" } } });
    drafts.ingest(current); drafts.ingest(slot); drafts.update(slot.id, { execution: { type: "worktree", startingState: { type: "branch", branchName: "mine" } } });
    drafts.ingest({ ...slot, revision: 2, execution: { type: "worktree", startingState: { type: "branch", branchName: "remote" } } });
    expect(sameModeConflict(drafts.get(slot.id))).toBe(true);
    drafts.resolve(slot.id, "remote"); applyProjectExecutionMode(drafts, current.id, drafts.get(slot.id).draft);
    expect(drafts.get(current.id).draft.execution).toEqual({ type: "worktree", startingState: { type: "branch", branchName: "active" } });
  } finally { drafts.dispose(); }
});

test("the real host store preserves mode revisions, restart state, and stale-client conflicts", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-desktop-project-mode-"));
  let first: HostStore | undefined, stale: HostStore | undefined, reopened: HostStore | undefined;
  try {
    first = new HostStore(directory);
    const id = projectExecutionModeDraftId("project-a");
    const local = { id, text: "", projectId: "project-a", model: null, execution: { type: "local" as const } };
    expect(first.putDraft(local, 0)).toMatchObject({ ok: true, draft: { revision: 1, execution: { type: "local" } } });
    stale = new HostStore(directory);
    expect(stale.getDraft(id)?.revision).toBe(1);
    const worktree = { ...local, execution: { type: "worktree" as const, startingState: { type: "branch" as const, branchName: "main" } } };
    expect(first.putDraft(worktree, 1)).toMatchObject({ ok: true, draft: { revision: 2, execution: { type: "worktree" } } });
    const conflict = stale.putDraft(local, 1);
    expect(conflict).toMatchObject({ ok: false, currentDraft: { revision: 2, execution: { type: "worktree" } }, conflict: { attempted: { execution: { type: "local" } }, expectedRevision: 1 } });
    first.close(); first = undefined; stale.close(); stale = undefined;
    reopened = new HostStore(directory);
    expect(reopened.getDraft(id)).toMatchObject({ revision: 2, projectId: "project-a", text: "", model: null, execution: { type: "worktree", startingState: { branchName: "main" } } });
    expect(reopened.listDraftConflicts(id)).toHaveLength(1);
  } finally {
    first?.close(); stale?.close(); reopened?.close(); rmSync(directory, { recursive: true, force: true });
  }
});
