import { describe, expect, test } from "bun:test";
import type { CommandEnvelope, CommandResult, Draft, SelectedTextAttachment, SessionSummary } from "../../../../packages/shared/src/protocol";
import { DraftController, type DraftCache } from "./drafts";
import { SubmissionController } from "./submissions";

const draft = (patch: Partial<Draft> = {}): Draft => ({ id: "new-conversation", revision: 1, text: "first prompt", projectId: "project-1", model: null, updatedAt: 1, ...patch });
const selected = (id = "selection-one", text = "unsaved"): SelectedTextAttachment => ({ id, text,
  source: { kind: "file", hostId: "another-host", path: "/outside/project/unsaved.ts",
    range: { start: { line: 4, column: 1 }, end: { line: 4, column: text.length + 1 } } } });
function cache(): DraftCache { const values = new Map<string, string>(); return { read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, value); } }; }
function saver(calls: CommandEnvelope[]) { return async (envelope: CommandEnvelope): Promise<CommandResult> => { calls.push(envelope); if (envelope.command.type !== "draft.put") throw new Error("Unexpected command"); return { ok: true, commandId: envelope.id, value: { ...envelope.command.draft, revision: envelope.command.expectedRevision + 1, updatedAt: 2 } }; }; }
const session: SessionSummary = { id: "session-1", hostId: "host", projectId: "project-1", cwd: "/project", title: "New conversation", status: "idle", sessionFile: "/session.jsonl", model: null, createdAt: 1, updatedAt: 1, archived: false };

test("selected snapshots survive offline cache restore with remote provenance detached", () => {
  const local = cache(), controller = new DraftController(saver([]), "host", local);
  try {
    controller.get("selected-offline");
    const snapshot = selected(); controller.update("selected-offline", { selectedTextAttachments: [snapshot] });
    snapshot.text = "caller mutation";
    const restored = new DraftController(saver([]), "host", local);
    try {
      expect(restored.get("selected-offline")).toMatchObject({ status: "offline", draft: { selectedTextAttachments: [{ id: "selection-one", text: "unsaved", source: { hostId: "another-host" } }] } });
    } finally { restored.dispose(); }
  } finally { controller.dispose(); }
});

test("missing selected snapshot metadata conflicts without dropping local intent", () => {
  const controller = new DraftController(saver([]), "host");
  try {
    const original = draft({ selectedTextAttachments: [selected()] });
    controller.ingest(original);
    controller.ingest({ ...original, revision: 2, selectedTextAttachments: undefined });
    expect(controller.get(original.id)).toMatchObject({ status: "conflict", draft: { selectedTextAttachments: [{ id: "selection-one" }] }, conflict: { revision: 2 } });
  } finally { controller.dispose(); }
});

test("a newer selected-text draft never acknowledges a legacy plain-text clear", () => {
  const controller = new DraftController(saver([]), "host");
  try {
    const original = draft();
    controller.ingest(original);
    controller.beginPendingSubmission(original, "legacy-command");
    controller.finishSubmission(original.id, original, true, false, "legacy-command");
    expect(controller.get(original.id).draft.text).toBe("");
    controller.ingest({ ...original, revision: 2, text: "", selectedTextAttachments: [selected()] });
    expect(controller.get(original.id)).toMatchObject({ status: "conflict", draft: { text: original.text },
      conflict: { revision: 2, selectedTextAttachments: [{ id: "selection-one" }] } });
  } finally { controller.dispose(); }
});

test("delayed selected-text consumption clears only the sent selection and preserves a newer offline edit", async () => {
  const calls: CommandEnvelope[] = [], controller = new DraftController(saver(calls), "host");
  try {
    const original = draft({ selectedTextAttachments: [selected()] });
    controller.ingest(original); controller.setConnected(true);
    const submitted = await controller.prepareSubmission(original.id);
    controller.beginPendingSubmission(submitted, "selected-command");
    controller.update(original.id, { selectedTextAttachments: [selected("newer", "newer")] });
    controller.finishSubmission(original.id, submitted, true, false, "selected-command");
    controller.ingest({ ...original, revision: 2, text: "", selectedTextAttachments: [], lastConsumption: { commandId: "selected-command", submittedRevision: 1 } });
    // The local view keeps its pre-save revision until its newer edit is saved
    // against the advanced base; it must not be overwritten by consumption.
    expect(controller.get(original.id)).toMatchObject({ status: "unsaved", draft: { text: original.text, selectedTextAttachments: [{ id: "newer", text: "newer" }], revision: 1 } });
    const saved = await controller.flush(original.id);
    expect(calls).toHaveLength(1);
    const save = calls[0]!;
    if (save.command.type !== "draft.put") throw new Error("Expected draft save");
    expect(save.command).toMatchObject({ expectedRevision: 2, draft: { selectedTextAttachments: [{ id: "newer", text: "newer" }] } });
    expect(saved).toMatchObject({ revision: 3, selectedTextAttachments: [{ id: "newer", text: "newer" }] });
  } finally { controller.dispose(); }
});

test('execution selections require the matching consumption receipt and preserve unrelated clears as conflicts', async () => {
  const controller = new DraftController(saver([]), 'host');
  try {
    const original = draft({ execution: { type: 'worktree', startingState: { type: 'branch', branchName: 'main' } } });
    controller.ingest(original); controller.setConnected(true);
    const submitted = await controller.prepareSubmission(original.id);
    controller.beginPendingSubmission(submitted, 'accepted-command');
    controller.finishSubmission(original.id, submitted, true, false, 'accepted-command');
    expect(controller.get(original.id).draft.text).toBe(original.text);
    await expect(controller.prepareSubmission(original.id)).rejects.toThrow('confirm consumption');
    controller.ingest({ ...original, revision: 2, text: '' });
    expect(controller.get(original.id)).toMatchObject({ status: 'conflict', draft: { text: original.text, execution: original.execution } });
    controller.ingest({ ...original, revision: 2, text: '', lastConsumption: { commandId: 'accepted-command', submittedRevision: 1 } });
    expect(controller.get(original.id)).toMatchObject({ status: 'saved', draft: { text: '', execution: original.execution, revision: 2 } });
    expect(() => controller.update(original.id, { execution: undefined })).toThrow('Local explicitly');
  } finally { controller.dispose(); }
});

test("environment format survives offline restore and a project switch clears the selection explicitly", async () => {
  const storage = cache(); const calls: CommandEnvelope[] = [];
  const selected = { projectId: "project-1", configPath: "/project-1/.agent-desktop/environments/dev.toml", revision: "a".repeat(64) };
  const first = new DraftController(saver(calls), "host", storage);
  first.ingest(draft({ environment: selected }));
  first.update("new-conversation", { text: "offline edit" });
  first.dispose();

  const restored = new DraftController(saver(calls), "host", storage);
  expect(restored.get("new-conversation")).toMatchObject({ status: "offline", draft: { text: "offline edit", environment: selected } });
  expect(() => restored.update("new-conversation", { environment: undefined })).toThrow("No environment explicitly");
  restored.update("new-conversation", { projectId: "project-2" });
  expect(restored.get("new-conversation").draft).toMatchObject({ projectId: "project-2", environment: null, text: "offline edit" });
  restored.setConnected(true);
  await restored.flush("new-conversation");
  expect(calls[0]).toMatchObject({ commandVersion: 5, command: { type: "draft.put", draft: { projectId: "project-2", environment: null } } });
  restored.dispose();
});

test("an older client dropping environment metadata conflicts and remote resolution retains the marker", () => {
  const selected = { projectId: "project-1", configPath: "/project-1/.agent-desktop/environments/dev.toml", revision: "b".repeat(64) };
  const controller = new DraftController(saver([]), "host");
  controller.ingest(draft({ environment: selected }));
  controller.ingest(draft({ revision: 2, text: "older client edit" }));
  expect(controller.get("new-conversation")).toMatchObject({
    status: "conflict",
    draft: { environment: selected },
    conflict: { revision: 2 },
  });
  expect(controller.get("new-conversation").conflict?.environment).toBeUndefined();
  controller.resolve("new-conversation", "remote");
  expect(controller.get("new-conversation")).toMatchObject({ status: "offline", draft: { text: "older client edit", environment: null } });
  controller.dispose();
});

test("consumption of the submitted environment revision preserves a newer selection", async () => {
  const calls: CommandEnvelope[] = [];
  const originalEnvironment = { projectId: "project-1", configPath: "/project-1/.agent-desktop/environments/a.toml", revision: "c".repeat(64) };
  const newerEnvironment = { projectId: "project-1", configPath: "/project-1/.agent-desktop/environments/b.toml", revision: "d".repeat(64) };
  const controller = new DraftController(saver(calls), "host");
  const original = draft({ environment: originalEnvironment });
  controller.ingest(original); controller.setConnected(true);
  const submitted = await controller.prepareSubmission(original.id);
  controller.beginPendingSubmission(submitted, "environment-send");
  controller.update(original.id, { environment: newerEnvironment, text: "next prompt" });
  controller.ingest({ ...original, revision: 2, text: "", lastConsumption: { commandId: "environment-send", submittedRevision: 1 } });
  controller.finishSubmission(original.id, submitted, true, false, "environment-send");
  expect(controller.get(original.id).draft).toMatchObject({ text: "next prompt", environment: newerEnvironment });
  await controller.flush(original.id);
  expect(calls[0]).toMatchObject({ commandVersion: 5, command: { type: "draft.put", expectedRevision: 2, draft: { environment: newerEnvironment, text: "next prompt" } } });
  expect(controller.get(original.id).draft).toMatchObject({ revision: 3, environment: newerEnvironment, text: "next prompt" });
  controller.dispose();
});

describe("revisioned draft persistence", () => {
  test("own save echo does not conflict with newer local typing", async () => {
    let acknowledge!: (result: CommandResult) => void;
    let envelope!: CommandEnvelope;
    const controller = new DraftController(command => { envelope = command; return new Promise(resolve => { acknowledge = resolve; }); }, "host");
    controller.setConnected(true); controller.update("new-conversation", { text: "first" });
    const saving = controller.flush("new-conversation");
    controller.update("new-conversation", { text: "newer text" });
    const saved = draft({ text: "first", projectId: null });
    controller.ingest(saved);
    expect(controller.get(saved.id).status).not.toBe("conflict");
    acknowledge({ ok: true, commandId: envelope.id, value: saved });
    await saving;
    expect(controller.get(saved.id).draft.text).toBe("newer text");
    expect(controller.get(saved.id).status).toBe("unsaved");
    controller.dispose();
  });
  test("submission captures the Enter keypress before a slow draft save", async () => {
    let acknowledge!: (result: CommandResult) => void;
    let commandId = "";
    const controller = new DraftController(envelope => { commandId = envelope.id; return new Promise(resolve => { acknowledge = resolve; }); }, "host");
    controller.setConnected(true); controller.update("new-conversation", { text: "send this" });
    const preparing = controller.prepareSubmission("new-conversation");
    controller.update("new-conversation", { text: "keep this for later" });
    acknowledge({ ok: true, commandId, value: draft({ text: "send this", projectId: null }) });
    const submitted = await preparing;
    expect(submitted.text).toBe("send this");
    expect(controller.get(submitted.id).draft.text).toBe("keep this for later");
    controller.ingest(draft({ revision: 2, text: "", projectId: null }));
    controller.finishSubmission(submitted.id, submitted, true);
    expect(controller.get(submitted.id).draft.text).toBe("keep this for later");
    controller.dispose();
  });
  test("accepted submission consumes only its revision and saves later edits against the new revision", async () => {
    const calls: CommandEnvelope[] = []; const controller = new DraftController(saver(calls), "host");
    controller.ingest(draft()); controller.setConnected(true);
    const submitted = await controller.prepareSubmission("new-conversation");
    controller.update(submitted.id, { text: "next instruction" });
    controller.ingest(draft({ text: "", revision: 2 }));
    controller.finishSubmission(submitted.id, submitted, true);
    expect(controller.get(submitted.id).draft.text).toBe("next instruction");
    await controller.flush(submitted.id);
    expect(calls[0]?.command).toMatchObject({ type: "draft.put", expectedRevision: 2, draft: { text: "next instruction" } });
    controller.dispose();
  });
  test("late consume event does not resurrect a sent prompt", async () => {
    const calls: CommandEnvelope[] = []; const controller = new DraftController(saver(calls), "host");
    controller.ingest(draft()); controller.setConnected(true);
    const submitted = await controller.prepareSubmission("new-conversation");
    controller.finishSubmission(submitted.id, submitted, true);
    expect(controller.get(submitted.id).draft.text).toBe("");
    controller.ingest(draft({ text: "", revision: 2 }));
    controller.update(submitted.id, { text: "another prompt" }); await controller.flush(submitted.id);
    expect(calls[0]?.command).toMatchObject({ expectedRevision: 2 }); controller.dispose();
  });
  test("offline edits survive a fresh controller and require explicit conflict resolution", async () => {
    const storage = cache(); const calls: CommandEnvelope[] = [];
    const first = new DraftController(saver(calls), "host", storage);
    first.ingest(draft()); first.update("new-conversation", { text: "my offline change" }); first.dispose();
    const restored = new DraftController(saver(calls), "host", storage);
    restored.ingest(draft({ revision: 2, text: "other device" }));
    expect(restored.get("new-conversation")).toMatchObject({ status: "conflict", draft: { text: "my offline change" }, conflict: { text: "other device" } });
    restored.resolve("new-conversation", "local"); restored.setConnected(true); await restored.flush("new-conversation");
    expect(calls[0]?.command).toMatchObject({ expectedRevision: 2, draft: { text: "my offline change" } }); restored.dispose();
  });
  test("a rejected save preserves text and the host conflict version", async () => {
    const controller = new DraftController(async envelope => ({ ok: false, commandId: envelope.id, error: { code: "DRAFT_CONFLICT", message: "Draft changed" }, currentDraft: draft({ revision: 3, text: "remote" }) }), "host");
    controller.ingest(draft()); controller.setConnected(true); controller.update("new-conversation", { text: "mine" });
    await expect(controller.flush("new-conversation")).rejects.toThrow("Draft changed");
    expect(controller.get("new-conversation")).toMatchObject({ status: "conflict", draft: { text: "mine" }, conflict: { revision: 3 } }); controller.dispose();
  });
});

describe("submission delivery identities", () => {
  test("uncertain send retries the original envelope after a renderer restart", async () => {
    const storage = cache(); const calls: CommandEnvelope[] = []; let disconnect = true;
    const send = async (envelope: CommandEnvelope): Promise<CommandResult> => {
      calls.push(envelope);
      if (envelope.command.type === "session.create") return { ok: true, commandId: envelope.id, value: session };
      if (disconnect) { disconnect = false; throw new Error("connection closed"); }
      return { ok: true, commandId: envelope.id, value: session };
    };
    const first = new SubmissionController(send, "host", storage);
    await expect(first.submit(draft(), undefined, "prompt")).rejects.toThrow("Delivery is uncertain");
    const restored = new SubmissionController(send, "host", storage);
    expect(restored.get("new-conversation")?.uncertain).toBe(true);
    const result = await restored.submit(draft({ text: "newer edit", revision: 2 }), undefined, "prompt");
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual(calls[1]);
    expect(result.submitted.text).toBe("first prompt");
    expect(restored.get("new-conversation")).toBeUndefined();
  });
  test("uncertain create reuses its identity before sending once", async () => {
    const calls: CommandEnvelope[] = []; let first = true;
    const controller = new SubmissionController(async envelope => {
      calls.push(envelope); if (first) { first = false; throw new Error("lost create response"); }
      return { ok: true, commandId: envelope.id, value: session };
    }, "host", cache());
    await expect(controller.submit(draft(), undefined, "prompt")).rejects.toThrow("uncertain");
    await controller.submit(draft(), undefined, "prompt");
    expect(calls[0]?.id).toBe(calls[1]?.id);
    expect(calls.filter(call => call.command.type === "session.prompt")).toHaveLength(1);
  });
  test("known prompt rejection keeps its created session but accepts edited retry text", async () => {
    const calls: CommandEnvelope[] = []; let rejectPrompt = true;
    const controller = new SubmissionController(async envelope => {
      calls.push(envelope);
      if (envelope.command.type === "session.prompt" && rejectPrompt) { rejectPrompt = false; return { ok: false, commandId: envelope.id, error: { code: "BUSY", message: "Session is busy" } }; }
      return { ok: true, commandId: envelope.id, value: session };
    }, "host", cache());
    await expect(controller.submit(draft(), undefined, "prompt")).rejects.toThrow("busy");
    await controller.submit(draft({ text: "edited retry", revision: 2 }), undefined, "prompt");
    expect(calls.filter(call => call.command.type === "session.create")).toHaveLength(1);
    expect(calls[2]?.command).toMatchObject({ sessionId: "session-1", text: "edited retry" });
    expect(calls[2]?.id).not.toBe(calls[1]?.id);
  });
  test("failure to persist an envelope prevents first delivery", async () => {
    let deliveries = 0;
    const controller = new SubmissionController(async envelope => { deliveries++; return { ok: true, commandId: envelope.id, value: session }; }, "host", { read: () => null, write: () => { throw new Error("Storage full"); } });
    await expect(controller.submit(draft(), undefined, "prompt")).rejects.toThrow("Storage full"); expect(deliveries).toBe(0);
  });
});
