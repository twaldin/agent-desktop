import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { CommandEnvelope, CommandResult, Draft, OmpComposerCatalog, OmpSessionControls, SessionSummary } from "@agent-desktop/shared";
import { DraftController, type DraftCache } from "./drafts";
import { SubmissionController } from "./submissions";
import { composerApproval, ComposerPermissions } from "./ComposerPermissions";
import { DraftSnapshot } from "./DraftSnapshot";

const draft: Draft = { id: "new-conversation", revision: 1, text: "same text", projectId: null, model: null, updatedAt: 1, approvalMode: "write" };
const session: SessionSummary = { id: "s", hostId: "host", cwd: "/private/project", projectId: null, sessionFile: "/private/session", title: "Created", status: "idle", model: null, createdAt: 1, updatedAt: 1, archived: false };
function cache(): DraftCache { const values = new Map<string, string>(); return { read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, value); } }; }
const ack = (envelope: CommandEnvelope): CommandResult => ({ ok: true, commandId: envelope.id, value: session });

test("a permission-only offline edit survives restart and conflicts with a different remote choice", async () => {
  const storage = cache(), calls: CommandEnvelope[] = [];
  const send = async (envelope: CommandEnvelope): Promise<CommandResult> => {
    calls.push(envelope); if (envelope.command.type !== "draft.put") throw new Error("Unexpected operation");
    return { ok: true, commandId: envelope.id, value: { ...envelope.command.draft, revision: 3, updatedAt: 3 } };
  };
  const first = new DraftController(send, "host", storage);
  first.ingest(draft); first.update(draft.id, { approvalMode: "always-ask" }); first.dispose();
  const restored = new DraftController(send, "host", storage);
  try {
    restored.ingest({ ...draft, approvalMode: "yolo", revision: 2 });
    expect(restored.get(draft.id)).toMatchObject({ status: "conflict", draft: { text: draft.text, approvalMode: "always-ask" }, conflict: { text: draft.text, approvalMode: "yolo" } });
    const own = renderToStaticMarkup(createElement(DraftSnapshot, { draft: restored.get(draft.id).draft, hostName: "Home", projects: [] }));
    const remote = renderToStaticMarkup(createElement(DraftSnapshot, { draft: restored.get(draft.id).conflict!, hostName: "Home", projects: [] }));
    expect(own).toContain("Always ask"); expect(remote).toContain("Yolo");
    restored.resolve(draft.id, "local"); restored.setConnected(true); await restored.flush(draft.id);
    expect(calls[0]?.command).toMatchObject({ expectedRevision: 2, draft: { approvalMode: "always-ask" } });
    restored.update(draft.id, { approvalMode: undefined }); await restored.flush(draft.id);
    expect(restored.get(draft.id).draft.approvalMode).toBeUndefined();
  } finally { restored.dispose(); }
});

test("the created session publishes before first prompt acceptance and an uncertain retry keeps its captured policy", async () => {
  const storage = cache(), calls: CommandEnvelope[] = [], observations: unknown[] = [];
  const pending = Promise.withResolvers<CommandResult>();
  const controller = new SubmissionController(async envelope => {
    calls.push(structuredClone(envelope));
    return envelope.command.type === "session.create" ? ack(envelope) : pending.promise;
  }, "host", storage);
  const off = controller.subscribe(() => observations.push(structuredClone(controller.get(draft.id))));
  const sending = controller.submit(draft, undefined, "prompt"); void sending.catch(() => {});
  for (let i = 0; i < 20 && calls.length < 2; i++) await Promise.resolve();
  expect(calls).toHaveLength(2);
  expect(observations.some(value => (value as { sessionId?: string })?.sessionId === session.id)).toBe(true);
  expect(calls[0]?.command).toMatchObject({ type: "session.create", approvalMode: "write" });
  expect(calls[1]?.command).toMatchObject({ type: "session.prompt", approvalMode: "write" });
  pending.reject(new Error("lost after startup question")); await expect(sending).rejects.toThrow("uncertain"); off();
  const restored = new SubmissionController(async envelope => { calls.push(structuredClone(envelope)); return ack(envelope); }, "host", storage);
  const result = await restored.submit({ ...draft, approvalMode: "yolo", text: "edited" }, "different-session", "steer");
  expect(calls[2]).toEqual(calls[1]); expect(result.submitted.approvalMode).toBe("write");
});

test("a later permission edit is preserved when the captured prompt is consumed", async () => {
  const controller = new DraftController(async envelope => ack(envelope), "host");
  try {
    controller.ingest(draft); controller.setConnected(true);
    const captured = await controller.prepareSubmission(draft.id);
    controller.update(draft.id, { approvalMode: "always-ask" });
    controller.ingest({ ...draft, text: "", revision: 2 }); controller.finishSubmission(draft.id, captured, true);
    expect(controller.get(draft.id).draft).toMatchObject({ text: draft.text, approvalMode: "always-ask" });
    expect(controller.get(draft.id).status).toBe("unsaved");
  } finally { controller.dispose(); }
});

test("session Settings refresh changes the follow-current label without replacing a draft override", () => {
  const catalog: OmpComposerCatalog = { cwd: "/private/project", models: [], default: { model: null, source: "unavailable", approvalMode: "yolo" }, resolution: "native-registry-preview" };
  const controls = { settings: [{ path: "tools.approvalMode", effective: "always-ask" }] } as OmpSessionControls;
  expect(composerApproval(draft, catalog, session, controls)).toMatchObject({ current: "always-ask", effective: "write", differs: true, supported: true });
  expect(composerApproval({ ...draft, approvalMode: undefined }, catalog, session, controls)).toMatchObject({ current: "always-ask", effective: "always-ask", differs: false });
  expect(composerApproval(draft, { ...catalog, default: { ...catalog.default, approvalMode: undefined } }, session, controls).supported).toBe(false);
  const markup = renderToStaticMarkup(createElement(ComposerPermissions, { draft, catalog, session, controls, disabled: false, onChange: () => {} }));
  expect(markup).toContain("Session: Always ask"); expect(markup).toContain('value="write" selected');
  expect(markup).not.toContain("Full access"); expect(markup).not.toContain("sandbox");
});
