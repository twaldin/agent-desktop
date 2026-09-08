import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandEnvelope, CommandResult, Draft, SessionSummary } from "../../../../packages/shared/src/protocol";
import type { LocalEnvironmentPreparationPublic } from "../../../../packages/shared/src/environment-preparations";
import { detachedAnswerDraft, type DetachedQuestionAnswer } from "../../../../packages/shared/src/detached-questions";
import { HostStore } from "../../../host/src/store";
import type { DraftCache } from "./drafts";
import { EnvironmentPreparationPause, SubmissionController } from "./submissions";

const original: Draft = { id: "new-conversation", revision: 7, text: "Original submitted input", projectId: "project-a", model: { provider: "fixture", id: "original" }, thinkingLevel: "low", updatedAt: 10 };
const edited: Draft = { ...original, revision: 8, text: "Newer local edit", projectId: "project-b", model: { provider: "fixture", id: "edited" }, thinkingLevel: "high" };
const session: SessionSummary = { id: "session-a", hostId: "host-a", projectId: "project-a", cwd: "/fixture/project", title: "Fixture session", status: "idle", sessionFile: "/fixture/session.jsonl", model: original.model, createdAt: 1, updatedAt: 1, archived: false };
function cache(): DraftCache {
  const values = new Map<string, string>();
  return { read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, value); } };
}
const hash = (envelope: CommandEnvelope) => createHash("sha256").update(JSON.stringify(envelope.command)).digest("hex");
const unknown = (envelope: CommandEnvelope): CommandResult => ({ ok: false, commandId: envelope.id, error: { code: "OUTCOME_UNKNOWN", message: "This command was pending when the service stopped." } });
const environment = { projectId: original.projectId!, configPath: "/fixture/project-a/.agent-desktop/environments/dev.toml", revision: "e".repeat(64) };
const environmentDraft: Draft = { ...original, environment, execution: { type: "worktree", startingState: { type: "branch", branchName: "topic/environment" } } };
const preparation = (id: string, phase: LocalEnvironmentPreparationPublic["phase"], revision = 5, overrides: Partial<LocalEnvironmentPreparationPublic> = {}): LocalEnvironmentPreparationPublic => ({
  id, revision, hostId: "host-a", projectId: original.projectId!, worktreePath: "/fixture/worktrees/environment",
  phase, needsAttention: ["setup-failed", "cleanup-failed", "unknown"].includes(phase),
  environment: { configPath: environment.configPath, revision: environment.revision, name: "Fixture" },
  createdAt: 10, updatedAt: 20 + revision, ...overrides,
});
const environmentSession: SessionSummary = { ...session, cwd: "/fixture/worktrees/environment" };

test('worktree creation and subsequent prompt retain their captured starting state across a lost receipt, edits and restart', async () => {
  const storage = cache(), calls: CommandEnvelope[] = [];
  const draft: Draft = { ...original, execution: { type: 'worktree', startingState: { type: 'branch', branchName: 'topic/original' } } };
  const first = new SubmissionController(async envelope => { calls.push(structuredClone(envelope)); return unknown(envelope); }, 'host-a', storage);
  await expect(first.submit(draft, undefined, 'prompt')).rejects.toThrow('pending');
  if (draft.execution?.type !== 'worktree' || draft.execution.startingState.type !== 'branch') throw new Error('Fixture shape');
  draft.execution.startingState.branchName = 'later-edit';
  const restored = new SubmissionController(async envelope => { calls.push(structuredClone(envelope)); return { ok: true, commandId: envelope.id, value: session }; }, 'host-a', storage);
  const result = await restored.submit({ ...edited, execution: { type: 'local' } }, undefined, 'prompt');
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]).toMatchObject({ commandVersion: 4, command: { type: 'session.create', projectId: original.projectId, worktree: { type: 'branch', branchName: 'topic/original' } } });
  expect(calls[2]).toMatchObject({ commandVersion: 4, command: { type: 'session.prompt', sessionId: session.id, text: original.text } });
  expect(result.submitted.execution).toEqual({ type: 'worktree', startingState: { type: 'branch', branchName: 'topic/original' } });
  expect(restored.entries()).toHaveLength(0);
});

test("environment-aware worktree retry preserves its exact v5 create, selection, draft reference, and prompt", async () => {
  const storage = cache(), calls: CommandEnvelope[] = [];
  const environment = { projectId: original.projectId!, configPath: "/fixture/project-a/.agent-desktop/environments/dev.toml", revision: "e".repeat(64) };
  const submitted: Draft = { ...original, environment, execution: { type: "worktree", startingState: { type: "branch", branchName: "topic/environment" } } };
  const first = new SubmissionController(async envelope => { calls.push(structuredClone(envelope)); return unknown(envelope); }, "host-a", storage);
  await expect(first.submit(submitted, undefined, "prompt")).rejects.toThrow("pending");

  const restored = new SubmissionController(async envelope => {
    calls.push(structuredClone(envelope));
    return { ok: true, commandId: envelope.id, value: session };
  }, "host-a", storage);
  const result = await restored.submit({ ...edited, environment: null, execution: { type: "local" } }, "different-session", "steer");
  expect(calls).toHaveLength(3);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]).toEqual({
    id: calls[0]!.id,
    commandVersion: 5,
    command: {
      type: "session.create",
      projectId: original.projectId,
      model: original.model!,
      approvalMode: undefined,
      worktree: { type: "branch", branchName: "topic/environment" },
      environment,
      draft: { id: original.id, revision: original.revision },
    },
  });
  expect(calls[2]).toMatchObject({ commandVersion: 5, command: {
    type: "session.prompt", sessionId: session.id, text: original.text,
    draft: { id: original.id, revision: original.revision },
  } });
  expect(result.submitted).toEqual(submitted);
});

test("environment-aware Local, prompt, steer, and no-environment worktree envelopes retain v5 semantics", async () => {
  const calls: CommandEnvelope[] = [];
  const local: Draft = { ...original, execution: { type: "local" }, environment: null };
  const controller = new SubmissionController(async envelope => {
    calls.push(structuredClone(envelope));
    return { ok: true, commandId: envelope.id, value: session };
  }, "host-a", cache());
  await controller.submit(local, undefined, "prompt");
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({ commandVersion: 5, command: { type: "session.create", projectId: original.projectId } });
  if (calls[0]?.command.type !== "session.create") throw new Error("Fixture shape");
  expect(calls[0].command.environment).toBeUndefined();
  expect(calls[0].command.draft).toBeUndefined();
  expect(calls[1]).toMatchObject({ commandVersion: 5, command: { type: "session.prompt", draft: { id: original.id, revision: original.revision } } });
  await controller.submit(local, session.id, "steer");
  expect(calls[2]).toMatchObject({ commandVersion: 5, command: { type: "session.steer", draft: { id: original.id, revision: original.revision } } });

  const worktreeCalls: CommandEnvelope[] = [];
  const noEnvironment: Draft = { ...original, environment: null, execution: { type: "worktree", startingState: { type: "working-tree" } } };
  const worktreeController = new SubmissionController(async envelope => {
    worktreeCalls.push(structuredClone(envelope));
    return { ok: true, commandId: envelope.id, value: session };
  }, "host-a", cache());
  await worktreeController.submit(noEnvironment, undefined, "prompt");
  expect(worktreeCalls[0]).toMatchObject({ commandVersion: 5, command: {
    type: "session.create", worktree: { type: "working-tree" }, environment: null,
    draft: { id: original.id, revision: original.revision },
  } });
});

test("restored environment submissions reject changed ownership, snapshots, worktrees, and downgraded versions", async () => {
  const environment = { projectId: original.projectId!, configPath: "/fixture/project-a/.agent-desktop/environments/dev.toml", revision: "f".repeat(64) };
  const submitted: Draft = { ...original, environment, execution: { type: "worktree", startingState: { type: "branch", branchName: "topic/environment" } } };
  for (const mutate of [
    (pending: any) => { pending.create.commandVersion = 4; },
    (pending: any) => { pending.create.command.environment.revision = "0".repeat(64); },
    (pending: any) => { pending.create.command.draft.revision += 1; },
    (pending: any) => { pending.create.command.worktree.branchName = "other"; },
  ]) {
    const storage = cache();
    const controller = new SubmissionController(async envelope => unknown(envelope), "host-a", storage);
    await expect(controller.submit(submitted, undefined, "prompt")).rejects.toThrow("pending");
    const cached = JSON.parse(storage.read(controller.cacheKey)!);
    mutate(cached[submitted.id]); storage.write(controller.cacheKey, JSON.stringify(cached));
    const restored = new SubmissionController(async () => { throw new Error("Must not deliver"); }, "host-a", storage);
    expect(restored.entries()).toEqual([]);
    expect(restored.cacheWarning).toContain("could not be read");
  }

  const storage = cache();
  const controller = new SubmissionController(async envelope => unknown(envelope), "host-a", storage);
  await expect(controller.submit(submitted, session.id, "prompt")).rejects.toThrow("pending");
  const cached = JSON.parse(storage.read(controller.cacheKey)!);
  cached[submitted.id].send.commandVersion = 4;
  storage.write(controller.cacheKey, JSON.stringify(cached));
  const restored = new SubmissionController(async () => { throw new Error("Must not deliver"); }, "host-a", storage);
  expect(restored.entries()).toEqual([]);
  expect(restored.cacheWarning).toContain("could not be read");
});

test('restored submission caches cannot move a captured worktree request or prompt to another owner', async () => {
  for (const phase of ['create', 'send'] as const) {
    const storage = cache();
    const controller = new SubmissionController(async envelope => unknown(envelope), 'host-a', storage);
    await expect(controller.submit({ ...original, execution: { type: 'local' } }, phase === 'send' ? session.id : undefined, 'prompt')).rejects.toThrow('pending');
    const pending = JSON.parse(storage.read(controller.cacheKey)!);
    if (phase === 'create') pending[original.id].create.command.projectId = 'another-project';
    else pending[original.id].send.command.sessionId = 'another-session';
    storage.write(controller.cacheKey, JSON.stringify(pending));
    const restored = new SubmissionController(async () => { throw new Error('Must not execute'); }, 'host-a', storage);
    expect(restored.entries()).toHaveLength(0); expect(restored.cacheWarning).toContain('could not be read');
  }
});

describe("resumable environment preparation", () => {
  test("a known failed setup pauses without implicit create or retry and retains newer editor content outside the snapshot", async () => {
    const storage = cache(), calls: CommandEnvelope[] = [];
    let known: LocalEnvironmentPreparationPublic | undefined;
    const controller = new SubmissionController(async envelope => {
      calls.push(structuredClone(envelope));
      known = preparation(envelope.id, "setup-failed");
      return { ok: true, commandId: envelope.id, value: { type: "environment.preparation", preparation: known } };
    }, "host-a", storage);
    let pause: unknown;
    try { await controller.submit(environmentDraft, undefined, "prompt"); } catch (error) { pause = error; }
    expect(pause).toBeInstanceOf(EnvironmentPreparationPause);
    expect((pause as EnvironmentPreparationPause).preparation).toEqual(known!);
    expect(controller.get(original.id)).toMatchObject({ draft: environmentDraft, uncertain: false, preparation: known, create: { commandVersion: 5 } });

    const newer = { ...environmentDraft, revision: 8, text: "Newer editor text remains separate" };
    await expect(controller.submit(newer, undefined, "prompt")).rejects.toBeInstanceOf(EnvironmentPreparationPause);
    expect(calls).toHaveLength(1);
    expect(controller.get(original.id)?.draft.text).toBe(original.text);

    const restored = new SubmissionController(async () => { throw new Error("Must not dispatch during restore"); }, "host-a", storage);
    expect(restored.get(original.id)).toMatchObject({ draft: environmentDraft, uncertain: false, preparation: known });
  });

  test("each definitive failed retry clears its resume identity and requires another explicit resume", async () => {
    const storage = cache(), calls: CommandEnvelope[] = [];
    let failed: LocalEnvironmentPreparationPublic | undefined;
    const controller = new SubmissionController(async envelope => {
      calls.push(structuredClone(envelope));
      if (envelope.command.type === "session.create") {
        failed = preparation(envelope.id, "setup-failed", 5);
      } else if (envelope.command.type === "session.environment.resume") {
        failed = preparation(envelope.command.preparationId, "setup-failed", envelope.command.expectedRevision + 2);
      } else throw new Error("Prompt must not run after failed setup");
      return { ok: true, commandId: envelope.id, value: { type: "environment.preparation", preparation: failed } };
    }, "host-a", storage);
    await expect(controller.submit(environmentDraft, undefined, "prompt")).rejects.toBeInstanceOf(EnvironmentPreparationPause);
    await expect(controller.resumeEnvironment(original.id)).rejects.toBeInstanceOf(EnvironmentPreparationPause);
    const firstResume = calls[1]!;
    expect(firstResume).toMatchObject({ commandVersion: 5, command: { type: "session.environment.resume", expectedRevision: 5 } });
    expect(controller.get(original.id)).toMatchObject({ uncertain: false, preparation: { revision: 7 }, resume: undefined });
    await expect(controller.submit({ ...environmentDraft, revision: 9, text: "do not replace" }, undefined, "prompt")).rejects.toBeInstanceOf(EnvironmentPreparationPause);
    expect(calls).toHaveLength(2);
    await expect(controller.resumeEnvironment(original.id)).rejects.toBeInstanceOf(EnvironmentPreparationPause);
    expect(calls[2]).toMatchObject({ commandVersion: 5, command: { type: "session.environment.resume", expectedRevision: 7 } });
    expect(calls[2]!.id).not.toBe(firstResume.id);
  });

  test("a lost resume response survives restart and continues only the original captured prompt", async () => {
    const storage = cache(), calls: CommandEnvelope[] = [];
    let disconnectResume = true;
    const transport = async (envelope: CommandEnvelope): Promise<CommandResult> => {
      calls.push(structuredClone(envelope));
      if (envelope.command.type === "session.create") {
        const failed = preparation(envelope.id, "setup-failed");
        return { ok: true, commandId: envelope.id, value: { type: "environment.preparation", preparation: failed } };
      }
      if (envelope.command.type === "session.environment.resume" && disconnectResume) {
        disconnectResume = false;
        throw new Error("lost response after durable native creation");
      }
      return { ok: true, commandId: envelope.id, value: environmentSession };
    };
    let controller = new SubmissionController(transport, "host-a", storage);
    await expect(controller.submit(environmentDraft, undefined, "prompt")).rejects.toBeInstanceOf(EnvironmentPreparationPause);
    await expect(controller.resumeEnvironment(original.id)).rejects.toThrow("uncertain");
    const resumeEnvelope = calls[1]!;
    expect(controller.get(original.id)).toMatchObject({ uncertain: true, resume: resumeEnvelope, draft: environmentDraft });

    controller = new SubmissionController(transport, "host-a", storage);
    controller.observePreparation(original.id, preparation(calls[0]!.id, "session-created", 9, { sessionId: environmentSession.id }));
    const sent = await controller.resumeEnvironment(original.id);
    expect(calls[2]).toEqual(resumeEnvelope);
    expect(calls[3]).toMatchObject({ commandVersion: 5, command: {
      type: "session.prompt", sessionId: environmentSession.id, text: original.text,
      model: original.model, draft: { id: original.id, revision: original.revision },
    } });
    expect(sent).toMatchObject({ sessionId: environmentSession.id, submitted: environmentDraft });
    expect(controller.get(original.id)).toBeUndefined();
  });

  test("two concurrent explicit resumes share one native lookup and one prompt", async () => {
    const storage = cache();
    let releaseResume!: (result: CommandResult) => void;
    const waiting = new Promise<CommandResult>(resolve => { releaseResume = resolve; });
    const calls: CommandEnvelope[] = [];
    const controller = new SubmissionController(async envelope => {
      calls.push(structuredClone(envelope));
      if (envelope.command.type === "session.create") {
        const failed = preparation(envelope.id, "setup-failed");
        return { ok: true, commandId: envelope.id, value: { type: "environment.preparation", preparation: failed } };
      }
      if (envelope.command.type === "session.environment.resume") return waiting;
      return { ok: true, commandId: envelope.id, value: environmentSession };
    }, "host-a", storage);
    await expect(controller.submit(environmentDraft, undefined, "prompt")).rejects.toBeInstanceOf(EnvironmentPreparationPause);
    const first = controller.resumeEnvironment(original.id);
    const second = controller.resumeEnvironment(original.id);
    expect(second).toBe(first);
    const resume = calls[1]!;
    releaseResume({ ok: true, commandId: resume.id, value: environmentSession });
    expect(await first).toEqual(await second);
    expect(calls.filter(call => call.command.type === "session.environment.resume")).toHaveLength(1);
    expect(calls.filter(call => call.command.type === "session.prompt")).toHaveLength(1);
  });

  test("observed state is owner-bound and monotonic; unknown and removed phases remain inspect-only", async () => {
    const calls: CommandEnvelope[] = [];
    const controller = new SubmissionController(async envelope => {
      calls.push(structuredClone(envelope));
      if (envelope.command.type !== "session.create") throw new Error("Must not dispatch a recovery");
      return unknown(envelope);
    }, "host-a", cache());
    await expect(controller.submit(environmentDraft, undefined, "prompt")).rejects.toThrow("pending");
    const createId = calls[0]!.id;
    controller.observePreparation(original.id, preparation(createId, "setup-failed", 5));
    controller.observePreparation(original.id, preparation(createId, "worktree-created", 4));
    expect(controller.get(original.id)?.preparation?.revision).toBe(5);
    expect(() => controller.observePreparation(original.id, preparation(createId, "setup-failed", 6, { hostId: "other" }))).toThrow("captured submission");
    expect(() => controller.observePreparation(original.id, preparation("other-preparation", "setup-failed", 6))).toThrow("captured submission");

    await expect(controller.resumeEnvironment(original.id)).rejects.toThrow("uncertain");
    expect(calls).toHaveLength(2);
    controller.observePreparation(original.id, preparation(createId, "unknown", 6, { uncertainOperation: "setup" }));
    await expect(controller.resumeEnvironment(original.id)).rejects.toBeInstanceOf(EnvironmentPreparationPause);
    expect(calls).toHaveLength(2);
    controller.observePreparation(original.id, preparation(createId, "removed", 7));
    await expect(controller.resumeEnvironment(original.id)).rejects.toBeInstanceOf(EnvironmentPreparationPause);
    expect(calls).toHaveLength(2);
  });

  test("an observed session-created preparation checks the original create receipt before sending", async () => {
    const storage = cache(), calls: CommandEnvelope[] = [];
    let first = true;
    const controller = new SubmissionController(async envelope => {
      calls.push(structuredClone(envelope));
      if (first) { first = false; return unknown(envelope); }
      if (envelope.command.type === "session.create") {
        const originalReceipt = preparation(envelope.id, "setup-failed", 5);
        return { ok: true, commandId: envelope.id, value: { type: "environment.preparation", preparation: originalReceipt } };
      }
      return { ok: true, commandId: envelope.id, value: environmentSession };
    }, "host-a", storage);
    await expect(controller.submit(environmentDraft, undefined, "prompt")).rejects.toThrow("pending");
    const originalCreate = calls[0]!;
    controller.observePreparation(original.id, preparation(originalCreate.id, "session-created", 9, { sessionId: environmentSession.id }));
    const result = await controller.resumeEnvironment(original.id);
    expect(calls[1]).toEqual(originalCreate);
    expect(calls[2]).toMatchObject({ commandVersion: 5, command: { type: "session.prompt", sessionId: environmentSession.id, text: original.text } });
    expect(result.submitted).toEqual(environmentDraft);
  });

  test("an observation racing direct create success retains its identity through a lost prompt receipt and restart", async () => {
    const storage = cache(), calls: CommandEnvelope[] = [];
    const createReceipt = Promise.withResolvers<CommandResult>();
    let losePrompt = true;
    const transport = async (envelope: CommandEnvelope): Promise<CommandResult> => {
      calls.push(structuredClone(envelope));
      if (envelope.command.type === "session.create") return createReceipt.promise;
      if (envelope.command.type === "session.prompt" && losePrompt) {
        losePrompt = false;
        throw new Error("lost prompt receipt");
      }
      return { ok: true, commandId: envelope.id, value: environmentSession };
    };
    let controller = new SubmissionController(transport, "host-a", storage);
    const submitting = controller.submit(environmentDraft, undefined, "prompt");
    const originalCreate = calls[0]!;
    controller.observePreparation(original.id, preparation(originalCreate.id, "native-creating", 8));
    createReceipt.resolve({ ok: true, commandId: originalCreate.id, value: environmentSession });
    await expect(submitting).rejects.toThrow("uncertain");
    const originalPrompt = calls[1]!;
    expect(controller.get(original.id)).toMatchObject({
      create: originalCreate,
      preparation: { id: originalCreate.id, phase: "native-creating" },
      sessionId: environmentSession.id,
      send: originalPrompt,
      uncertain: true,
    });

    controller = new SubmissionController(transport, "host-a", storage);
    const completed = await controller.submit({ ...environmentDraft, revision: 12, text: "newer local text" }, undefined, "prompt");
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(originalPrompt);
    expect(calls.filter(call => call.command.type === "session.create")).toHaveLength(1);
    expect(completed.submitted).toEqual(environmentDraft);
    expect(controller.get(original.id)).toBeUndefined();
  });

  test("restored preparation and resume state rejects changed identity, ownership, revision, and protocol", async () => {
    for (const mutate of [
      (pending: any) => { pending.preparation.hostId = "other-host"; },
      (pending: any) => { pending.preparation.projectId = "other-project"; },
      (pending: any) => { pending.preparation.id = "other-preparation"; },
      (pending: any) => { pending.preparation.environment.revision = "f".repeat(64); },
      (pending: any) => { pending.preparation.revision = 0; },
      (pending: any) => { pending.preparation.phase = "unknown"; },
      (pending: any) => { pending.resume.commandVersion = 4; },
      (pending: any) => { pending.resume.id = ""; },
      (pending: any) => { pending.resume.command.preparationId = "other-preparation"; },
      (pending: any) => { pending.resume.command.expectedRevision = -1; },
      (pending: any) => { pending.resume.command.expectedRevision = pending.preparation.revision + 1; },
      (pending: any) => { pending.resume.command.unexpected = true; },
    ]) {
      const storage = cache();
      const controller = new SubmissionController(async envelope => {
        if (envelope.command.type === "session.create") {
          const failed = preparation(envelope.id, "setup-failed");
          return { ok: true, commandId: envelope.id, value: { type: "environment.preparation", preparation: failed } };
        }
        return unknown(envelope);
      }, "host-a", storage);
      await expect(controller.submit(environmentDraft, undefined, "prompt")).rejects.toBeInstanceOf(EnvironmentPreparationPause);
      await expect(controller.resumeEnvironment(original.id)).rejects.toThrow("pending");
      const cached = JSON.parse(storage.read(controller.cacheKey)!);
      mutate(cached[original.id]);
      storage.write(controller.cacheKey, JSON.stringify(cached));
      const restored = new SubmissionController(async () => { throw new Error("Must not dispatch malformed cache"); }, "host-a", storage);
      expect(restored.entries()).toEqual([]);
      expect(restored.cacheWarning).toContain("could not be read");
    }
  });
});

describe("unknown submission outcomes", () => {
  for (const phase of ["create", "prompt", "steer"] as const) {
    test(`${phase}: real reopened command ledger keeps one identity until a matching result resolves it`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "agent-submission-unknown-"));
      let store = new HostStore(directory);
      const storage = cache(), calls: CommandEnvelope[] = [];
      let originalEnvelope: CommandEnvelope | undefined;
      let executions = 0;
      // Controlled transport, actual durable SQLite ledger. No native/provider
      // turn is run: "executions" counts newly claimed fixture operations.
      const transport = async (envelope: CommandEnvelope): Promise<CommandResult> => {
        calls.push(structuredClone(envelope));
        const claim = store.claimCommand(envelope.id, hash(envelope), envelope.command);
        if (claim.kind === "done") return claim.record.result!;
        if (claim.kind === "pending") return unknown(envelope);
        if (claim.kind === "conflict") throw new Error("Changed original envelope");
        executions++;
        if (!originalEnvelope) { originalEnvelope = structuredClone(envelope); return unknown(envelope); }
        const result: CommandResult = { ok: true, commandId: envelope.id, value: session };
        store.finishCommand(envelope.id, hash(envelope), result); return result;
      };
      const mode = phase === "steer" ? "steer" : "prompt";
      let controller = new SubmissionController(transport, "host-a", storage);
      try {
        await expect(controller.submit(original, phase === "create" ? undefined : session.id, mode)).rejects.toThrow("pending");
        expect(controller.get(original.id)?.uncertain).toBe(true);
        expect(executions).toBe(1);
        store.close(); store = new HostStore(directory);
        controller = new SubmissionController(transport, "host-a", storage);
        for (let retry = 0; retry < 2; retry++) {
          await expect(controller.submit(edited, "different-session", mode === "prompt" ? "steer" : "prompt")).rejects.toThrow("pending");
          expect(controller.get(original.id)).toMatchObject({ uncertain: true, draft: original, mode });
          expect(calls.at(-1)).toEqual(originalEnvelope);
        }
        expect(executions).toBe(1);
        const receipt: CommandResult = { ok: true, commandId: originalEnvelope!.id, value: session };
        store.finishCommand(originalEnvelope!.id, hash(originalEnvelope!), receipt);
        const accepted = await controller.submit(edited, "different-session", "prompt");
        expect(accepted).toEqual({ sessionId: session.id, submitted: original, commandId: calls.at(-1)!.id });
        expect(controller.get(original.id)).toBeUndefined();
        expect(calls.slice(0, 4).every(call => JSON.stringify(call) === JSON.stringify(originalEnvelope))).toBe(true);
        expect(executions).toBe(phase === "create" ? 2 : 1);
        if (phase === "create") expect(calls.at(-1)?.command).toMatchObject({ type: "session.prompt", sessionId: session.id, text: original.text, draft: { id: original.id, revision: original.revision } });
      } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
    });
  }
  test("pre-lookup and identity-conflict responses cannot resolve an earlier uncertain send", async () => {
    const storage = cache(), calls: CommandEnvelope[] = [];
    const codes = ["OUTCOME_UNKNOWN", "HOST_STOPPING", "COMMAND_ID_REUSED", "OUTCOME_UNKNOWN"];
    const controller = new SubmissionController(async envelope => {
      calls.push(structuredClone(envelope));
      return { ok: false, commandId: envelope.id, error: { code: codes[calls.length - 1]!, message: codes[calls.length - 1]! } };
    }, "host-a", storage);
    for (const code of codes) {
      await expect(controller.submit(calls.length ? edited : original, session.id, "prompt")).rejects.toThrow(code);
      expect(controller.get(original.id)?.uncertain).toBe(true);
      expect(controller.get(original.id)?.draft).toEqual(original);
    }
    expect(calls.every(call => JSON.stringify(call) === JSON.stringify(calls[0]))).toBe(true);
    const restored = new SubmissionController(async () => { throw new Error("Not called"); }, "host-a", storage);
    expect(restored.get(original.id)?.send).toEqual(calls[0]);
  });
  test("a definite recorded rejection resolves uncertainty and permits an edited new command", async () => {
    const calls: CommandEnvelope[] = [];
    const controller = new SubmissionController(async envelope => {
      calls.push(structuredClone(envelope));
      if (calls.length === 1) return unknown(envelope);
      if (calls.length === 2) return { ok: false, commandId: envelope.id, error: { code: "PROMPT_NOT_RECORDED", message: "Native input was not recorded" } };
      return { ok: true, commandId: envelope.id, value: session };
    }, "host-a", cache());
    await expect(controller.submit(original, session.id, "prompt")).rejects.toThrow("pending");
    await expect(controller.submit(edited, session.id, "prompt")).rejects.toThrow("not recorded");
    expect(calls[1]).toEqual(calls[0]);
    expect(controller.get(original.id)?.uncertain).toBe(false);
    await controller.submit(edited, session.id, "prompt");
    expect(calls[2]?.id).not.toBe(calls[0]?.id);
    expect(calls[2]?.command).toMatchObject({ text: edited.text, model: edited.model, draft: { id: edited.id, revision: edited.revision } });
  });

  test("a detached answer retry preserves its exact native question, answers, draft revision, and command identity", async () => {
    const storage = cache(), calls: CommandEnvelope[] = [];
    const answers: DetachedQuestionAnswer[] = [
      { questionId: "density", selectedOptions: ["Compact"] },
      { questionId: "accent", selectedOptions: [], customInput: "Cobalt" },
    ];
    const answerDraft: Draft = { id: "question:session-a:question-a", revision: 4, updatedAt: 20, text: detachedAnswerDraft(answers), projectId: null, model: null };
    const controller = new SubmissionController(async envelope => {
      calls.push(structuredClone(envelope));
      if (calls.length < 3) return unknown(envelope);
      return { ok: true, commandId: envelope.id, value: { type: "session.question.answer", receipt: { questionId: "question-a", acceptanceEntryId: "entry-accepted", delivery: "waiting" } } };
    }, "host-a", storage);
    await expect(controller.submitQuestion(answerDraft, "session-a", "question-a", "entry-opened", answers)).rejects.toThrow("uncertain");
    const edited = { ...answerDraft, revision: 5, text: detachedAnswerDraft([{ questionId: "density", selectedOptions: ["Comfortable"] }, { questionId: "accent", selectedOptions: [], customInput: "Amber" }]) };
    await expect(controller.submitQuestion(edited, "different-session", "different-question", "different-entry", [])).rejects.toThrow("uncertain");
    const restored = new SubmissionController(async envelope => { calls.push(structuredClone(envelope)); return { ok: true, commandId: envelope.id, value: { type: "session.question.answer", receipt: { questionId: "question-a", acceptanceEntryId: "entry-accepted", delivery: "waiting" } } }; }, "host-a", storage);
    const result = await restored.submitQuestion(edited, "different-session", "different-question", "different-entry", []);
    expect(result).toMatchObject({ sessionId: "session-a", submitted: answerDraft });
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[2]).toEqual(calls[0]);
    expect(calls[0]?.command).toEqual({ type: "session.question.answer", sessionId: "session-a", questionId: "question-a", questionEntryId: "entry-opened", answers, draft: { id: answerDraft.id, revision: 4 } });
  });

  test("a detached answer refuses a saved draft that differs from its canonical answer envelope", async () => {
    const controller = new SubmissionController(async envelope => ({ ok: true, commandId: envelope.id }), "host-a", cache());
    const answers: DetachedQuestionAnswer[] = [{ questionId: "density", selectedOptions: ["Compact"] }];
    await expect(controller.submitQuestion({ ...original, id: "question:session-a:question-a" }, "session-a", "question-a", "entry-opened", answers)).rejects.toThrow("does not match");
  });

  test("a mismatched detached question receipt stays uncertain", async () => {
    const answers: DetachedQuestionAnswer[] = [{ questionId: "density", selectedOptions: ["Compact"] }];
    const draft: Draft = { ...original, id: "question:session-a:question-a", text: detachedAnswerDraft(answers) };
    const controller = new SubmissionController(async envelope => ({ ok: true, commandId: envelope.id, value: { type: "session.question.answer", receipt: { questionId: "other-question", acceptanceEntryId: "entry-accepted", delivery: "waiting" } } }), "host-a", cache());
    await expect(controller.submitQuestion(draft, "session-a", "question-a", "entry-opened", answers)).rejects.toThrow("matching detached question receipt");
    expect(controller.get(draft.id)?.uncertain).toBe(true);
  });
});


test("a recorded create failure after preparation observation retains recovery ownership across restart", async () => {
  const storage = cache(), calls: CommandEnvelope[] = [];
  let finish!: (result: CommandResult) => void;
  const controller = new SubmissionController(envelope => {
    calls.push(structuredClone(envelope));
    return new Promise(resolve => { finish = resolve; });
  }, "host-a", storage);
  const outcome = controller.submit(environmentDraft, undefined, "prompt");
  const observed = preparation(calls[0]!.id, "setup-failed");
  controller.observePreparation(environmentDraft.id, observed);
  const rejection = outcome.catch(error => error as Error);
  finish({ ok: false, commandId: calls[0]!.id, error: { code: "COMMAND_FAILED", message: "Publication failed" } });
  expect(await rejection).toEqual(new Error("Publication failed"));
  const restored = new SubmissionController(async envelope => {
    calls.push(structuredClone(envelope));
    return { ok: true, commandId: envelope.id, value: environmentSession };
  }, "host-a", storage);
  expect(restored.cacheWarning).toBeUndefined();
  expect(restored.get(environmentDraft.id)?.create).toEqual(calls[0]);
  expect(restored.get(environmentDraft.id)?.preparation).toEqual(observed);
  await restored.resumeEnvironment(environmentDraft.id);
  expect(calls.map(item => item.command.type)).toEqual(["session.create", "session.environment.resume", "session.prompt"]);
  expect(calls[2]?.command).toMatchObject({ text: environmentDraft.text, sessionId: environmentSession.id });
});


test("selected-text retry retains the original snapshot, v6 envelope and command identity across edits and reload", async () => {
  const storage = cache(), calls: CommandEnvelope[] = [];
  const selected: Draft = { ...original, selectedTextAttachments: [{ id: "excerpt", text: "raw excerpt", source: { kind: "file", hostId: "different-owner", path: "/unsaved/code.ts", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 12 } } } }] };
  const first = new SubmissionController(async envelope => { calls.push(structuredClone(envelope)); return unknown(envelope); }, "host-a", storage);
  await expect(first.submit(selected, session.id, "prompt")).rejects.toThrow("pending");
  selected.selectedTextAttachments![0]!.source.path = "/changed/after-send.ts";
  const restored = new SubmissionController(async envelope => { calls.push(structuredClone(envelope)); return { ok: true, commandId: envelope.id, admission: { kind: "user-message", entryId: "native" } }; }, "host-a", storage);
  const result = await restored.submit({ ...edited, selectedTextAttachments: [] }, session.id, "prompt");
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]).toMatchObject({ commandVersion: 6, command: { selectedTextAttachments: [{ source: { hostId: "different-owner", path: "/unsaved/code.ts" } }] } });
  expect(result.submitted.selectedTextAttachments![0]!.source.path).toBe("/unsaved/code.ts");
  expect(restored.entries()).toHaveLength(0);
});

test("selected-text steering is rejected before a command or pending submission is created", async () => {
  const calls: CommandEnvelope[] = [];
  const controller = new SubmissionController(async envelope => { calls.push(envelope); return unknown(envelope); }, "host-a", cache());
  const draft: Draft = { ...original, selectedTextAttachments: [{ id: "s", text: "x", source: { kind: "file", hostId: "remote", path: "/file", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } } }] };
  await expect(controller.submit(draft, session.id, "steer")).rejects.toThrow("Selected text");
  expect(calls).toEqual([]); expect(controller.entries()).toEqual([]);
});


test("selected-text success without native user admission remains pending for the original command", async () => {
  const storage = cache();
  const draft: Draft = { ...original, selectedTextAttachments: [{ id: "s", text: "x", source: { kind: "file", hostId: "remote", path: "/file", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } } } }] };
  const controller = new SubmissionController(async envelope => ({ ok: true, commandId: envelope.id }), "host-a", storage);
  await expect(controller.submit(draft, session.id, "prompt")).rejects.toThrow("native user receipt");
  const pending = controller.get(draft.id)!;
  expect(pending.uncertain).toBe(true);
  expect(pending.draft.selectedTextAttachments).toEqual(draft.selectedTextAttachments);
  const restored = new SubmissionController(async envelope => ({ ok: true, commandId: envelope.id, admission: { kind: "user-message", entryId: "actual-native-entry" } }), "host-a", storage);
  const result = await restored.submit({ ...draft, selectedTextAttachments: [] }, session.id, "prompt");
  expect(result.commandId).toBe(pending.send!.id);
});

test('whole-file uncertain submissions retain exact v7 path identity across edits and restart',async()=>{
 const storage=cache(),calls:CommandEnvelope[]=[];
 const draft:Draft={...original,wholeFileAttachments:[{id:'whole',source:{kind:'file',hostId:'host-a',path:'/fixture/a #.ts'}}]};
 const first=new SubmissionController(async envelope=>{calls.push(structuredClone(envelope));return unknown(envelope);},'host-a',storage);
 await expect(first.submit(draft,session.id,'prompt')).rejects.toThrow('pending');
 draft.wholeFileAttachments![0]!.source.path='/changed.ts';
 const restored=new SubmissionController(async envelope=>{calls.push(structuredClone(envelope));return{ok:true,commandId:envelope.id,admission:{kind:'user-message',entryId:'native'}};},'host-a',storage);
 const result=await restored.submit({...edited,wholeFileAttachments:[]},session.id,'prompt');
 expect(calls[1]).toEqual(calls[0]);expect(calls[0]).toMatchObject({commandVersion:7,command:{wholeFileAttachments:[{source:{path:'/fixture/a #.ts'}}]}});
 expect(result.submitted.wholeFileAttachments?.[0]?.source.path).toBe('/fixture/a #.ts');expect(restored.entries()).toHaveLength(0);
});
test('whole-file submission without attributable user receipt remains uncertain',async()=>{
 const controller=new SubmissionController(async envelope=>({ok:true,commandId:envelope.id,admission:{kind:'native-command',command:'compact'}}),'host-a',cache());
 const draft:Draft={...original,wholeFileAttachments:[{id:'whole',source:{kind:'file',hostId:'host-a',path:'/fixture/a.ts'}}]};
 await expect(controller.submit(draft,session.id,'prompt')).rejects.toThrow('uncertain');expect(controller.entries()[0]?.uncertain).toBe(true);
});
