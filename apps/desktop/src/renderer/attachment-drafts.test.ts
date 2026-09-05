import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandEnvelope, CommandResult, Draft, ImageAttachmentRef, SessionSummary } from "@agent-desktop/shared";
import { HostStore } from "../../../host/src/store";
import { DraftController, captureDraft, hasDraftContent, sameDraftContent, type DraftCache } from "./drafts";
import { SubmissionController } from "./submissions";
import { DraftSnapshot } from "./DraftSnapshot";

const image = (id = "one", hostId = "host"): ImageAttachmentRef => ({ id, hostId, kind: "image", sha256: (id === "one" ? "a" : "b").repeat(64), name: `${id}.png`, bytes: 12, mimeType: "image/png" });
const draft = (patch: Partial<Draft> = {}): Draft => ({ id: "new-conversation", text: "", model: null, projectId: null, revision: 1, updatedAt: 1, attachments: [image()], ...patch });
const consumed = (submitted: Draft, commandId = "own-command", patch: Partial<Draft> = {}): Draft => ({ ...submitted, text: "", attachments: [], revision: submitted.revision + 1, lastConsumption: { commandId, submittedRevision: submitted.revision }, ...patch });
const session: SessionSummary = { id: "session", hostId: "host", projectId: null, cwd: "/fixture", sessionFile: "/fixture/session.jsonl", title: "Controlled session", status: "idle", model: null, archived: false, createdAt: 1, updatedAt: 1 };
function cache(): DraftCache { const values = new Map<string, string>(); return { read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, value); } }; }
function saver(calls: CommandEnvelope[]) { return async (envelope: CommandEnvelope): Promise<CommandResult> => {
  calls.push(structuredClone(envelope)); if (envelope.command.type !== "draft.put") throw new Error("Unexpected fixture command");
  return { ok: true, commandId: envelope.id, value: { ...envelope.command.draft, revision: envelope.command.expectedRevision + 1, updatedAt: 2 } };
}; }
const ack = (envelope: CommandEnvelope): CommandResult => ({ ok: true, commandId: envelope.id, value: session });

describe("image-aware draft state", () => {
  test("content includes images and exact ordered metadata, with sticky empty format", () => {
    const original = draft({ attachments: [image(), image("two")] });
    expect(hasDraftContent(original)).toBe(true); expect(hasDraftContent(draft({ text: " \n", attachments: [] }))).toBe(false);
    expect(hasDraftContent(draft({ text: "text", attachments: [] }))).toBe(true);
    expect(sameDraftContent(original, captureDraft(original))).toBe(true);
    expect(sameDraftContent(original, { ...original, attachments: [...original.attachments!].reverse() })).toBe(false);
    for (const patch of [{ id: "another" }, { name: "renamed.png" }, { hostId: "other" }, { sha256: "c".repeat(64) }, { bytes: 13 }, { mimeType: "image/jpeg" as const }]) {
      expect(sameDraftContent(original, { ...original, attachments: [{ ...image(), ...patch }, image("two")] })).toBe(false);
    }
    expect(sameDraftContent(draft({ attachments: [] }), draft({ attachments: undefined }))).toBe(false);
    expect(sameDraftContent(original, { ...original, lastConsumption: { commandId: "host-owned", submittedRevision: 0 } })).toBe(true);
  });

  test("slow save deeply captures the keypress and strips all host-owned fields", async () => {
    const pending = Promise.withResolvers<CommandResult>(); let sent!: CommandEnvelope;
    const controller = new DraftController(async envelope => { sent = envelope; return pending.promise; }, "host");
    try {
      controller.ingest(draft({ lastConsumption: { commandId: "old", submittedRevision: 0 } })); controller.setConnected(true);
      const attachments = [image("two")], model = { provider: "fixture", id: "chosen" };
      controller.update("new-conversation", { attachments, text: "captured", model });
      const preparing = controller.prepareSubmission("new-conversation");
      attachments[0]!.name = "mutated outside"; model.id = "mutated outside";
      controller.update("new-conversation", { text: "", attachments: [image()] });
      expect(sent.command).toMatchObject({ type: "draft.put", expectedRevision: 1, draft: { text: "captured", model: { id: "chosen" }, attachments: [image("two")] } });
      if (sent.command.type !== "draft.put") throw new Error("Unexpected fixture command");
      expect(Object.keys(sent.command.draft)).not.toContain("lastConsumption"); expect(Object.keys(sent.command.draft)).not.toContain("revision"); expect(Object.keys(sent.command.draft)).not.toContain("updatedAt");
      pending.resolve({ ok: true, commandId: sent.id, value: { ...sent.command.draft, revision: 2, updatedAt: 2 } });
      const captured = await preparing;
      expect(captured).toMatchObject({ text: "captured", attachments: [image("two")], model: { id: "chosen" } });
      expect(controller.get(captured.id)).toMatchObject({ status: "unsaved", draft: { text: "", attachments: [image()] } });
      controller.beginPendingSubmission(captured, "own-command"); controller.ingest(consumed(captured)); controller.finishSubmission(captured.id, captured, true, false, "own-command");
      expect(controller.get(captured.id).draft.attachments).toEqual([image()]);
    } finally { controller.dispose(); }
  });

  for (const eventFirst of [false, true]) test(`exact host marker clears image-only input (${eventFirst ? "event" : "receipt"} first)`, async () => {
    const controller = new DraftController(saver([]), "host");
    try {
      const original = draft(); controller.ingest(original); controller.setConnected(true);
      const submitted = await controller.prepareSubmission(original.id); controller.beginPendingSubmission(submitted, "own-command");
      if (eventFirst) controller.ingest(consumed(submitted));
      controller.finishSubmission(submitted.id, submitted, true, false, "own-command");
      if (!eventFirst) {
        expect(controller.get(submitted.id).draft.attachments).toEqual(original.attachments);
        await expect(controller.prepareSubmission(submitted.id)).rejects.toThrow("confirm consumption");
        controller.ingest(consumed(submitted));
      }
      expect(controller.get(submitted.id)).toMatchObject({ status: "saved", draft: { text: "", attachments: [], revision: 2 } });
      expect(hasDraftContent(controller.get(submitted.id).draft)).toBe(false);
      expect((await controller.prepareSubmission(submitted.id)).attachments).toEqual([]);
    } finally { controller.dispose(); }
  });

  test("direct consumption retains newer image-only edits and saves them against its authoritative revision", async () => {
    const calls: CommandEnvelope[] = [], controller = new DraftController(saver(calls), "host");
    try {
      controller.ingest(draft({ text: "sent" })); controller.setConnected(true);
      const submitted = await controller.prepareSubmission("new-conversation"); controller.beginPendingSubmission(submitted, "own-command");
      controller.update(submitted.id, { text: "", attachments: [image("two")] });
      controller.finishSubmission(submitted.id, submitted, true, false, "own-command"); controller.ingest(consumed(submitted));
      expect(controller.get(submitted.id).draft).toMatchObject({ text: "", attachments: [image("two")] });
      await controller.flush(submitted.id);
      expect(calls[0]?.command).toMatchObject({ expectedRevision: 2, draft: { text: "", attachments: [image("two")] } });
    } finally { controller.dispose(); }
  });

  test("a newer acknowledged local revision retires the consume wait without clearing its image content", async () => {
    const controller = new DraftController(saver([]), "host");
    try {
      const original = draft(); controller.ingest(original); controller.setConnected(true);
      controller.beginPendingSubmission(original, "own-command");
      controller.update(original.id, { attachments: [image("two")] });
      controller.finishSubmission(original.id, original, true, false, "own-command");
      // Another client may already have saved this same newer draft. The older
      // admitted command cannot consume it, and therefore produces no marker.
      controller.ingest(draft({ revision: 2, attachments: [image("two")] }));
      expect(controller.get(original.id)).toMatchObject({ status: "saved", draft: { revision: 2, attachments: [image("two")] } });
      expect((await controller.prepareSubmission(original.id)).attachments).toEqual([image("two")]);
    } finally { controller.dispose(); }
  });

  test("restart after preparing an image snapshot without a send envelope does not leave a permanent consume wait", async () => {
    const storage = cache(), first = new DraftController(saver([]), "host", storage);
    first.ingest(draft()); first.setConnected(true);
    const snapshot = await first.prepareSubmission("new-conversation"); first.beginPendingSubmission(snapshot); first.dispose();
    const restored = new DraftController(saver([]), "host", storage);
    try {
      restored.setConnected(true);
      expect(await restored.prepareSubmission(snapshot.id)).toEqual(snapshot);
    } finally { restored.dispose(); }
  });

  test("a surviving exact submission cache can restore its snapshot when the separate draft cache is missing", () => {
    const controller = new DraftController(saver([]), "host");
    try {
      const original = draft(); controller.beginPendingSubmission(original, "own-command"); controller.ingest(original);
      expect(controller.get(original.id)).toMatchObject({ status: "saved", draft: original });
      controller.ingest(consumed(original));
      expect(controller.get(original.id).draft.attachments).toEqual([]);
    } finally { controller.dispose(); }
  });

  test("restart between durable rejection and App completion releases the matching draft wait", async () => {
    const storage = cache(); const first = new DraftController(saver([]), "host", storage);
    first.ingest(draft()); first.setConnected(true); const snapshot = await first.prepareSubmission("new-conversation");
    const submissions = new SubmissionController(async envelope => ({ ok: false, commandId: envelope.id, error: { code: "PROMPT_NOT_RECORDED", message: "Controlled definitive rejection" } }), "host", storage);
    await expect(submissions.submit(snapshot, session.id, "prompt", (value, id) => first.beginPendingSubmission(value, id))).rejects.toThrow("definitive rejection");
    first.dispose(); // App finishSubmission has deliberately not run.
    const restored = new DraftController(saver([]), "host", storage);
    const restoredSubmissions = new SubmissionController(async envelope => ack(envelope), "host", storage);
    try {
      for (const pending of restoredSubmissions.entries()) {
        if (pending.send) restored.beginPendingSubmission(pending.draft, pending.send.id);
        else if (!pending.uncertain) { restored.get(pending.draft.id, pending.draft); restored.finishSubmission(pending.draft.id, pending.draft, false); }
      }
      restored.setConnected(true);
      expect(await restored.prepareSubmission(snapshot.id)).toEqual(snapshot);
      expect((await restoredSubmissions.submit(snapshot, session.id, "prompt")).submitted).toEqual(snapshot);
    } finally { restored.dispose(); }
  });

  for (const receipt of [undefined, { commandId: "other", submittedRevision: 1 }, { commandId: "own-command", submittedRevision: 0 }]) test(`unrelated empty draft cannot consume pending images: ${JSON.stringify(receipt)}`, async () => {
    const controller = new DraftController(saver([]), "host");
    try {
      const original = draft(); controller.ingest(original); controller.beginPendingSubmission(original, "own-command");
      controller.finishSubmission(original.id, original, true, false, "own-command");
      controller.ingest(consumed(original, "own-command", { lastConsumption: receipt }));
      expect(controller.get(original.id)).toMatchObject({ status: "conflict", draft: { attachments: original.attachments }, conflict: { attachments: [], revision: 2 } });
    } finally { controller.dispose(); }
  });

  test("a retained marker on a later remote save does not swallow the conflict, including after restart", () => {
    const storage = cache(), original = draft(), remote = consumed(original, "own-command", { revision: 3, text: "another device", attachments: [image("two")] });
    const controller = new DraftController(saver([]), "host", storage);
    controller.ingest(original); controller.beginPendingSubmission(original, "own-command"); controller.finishSubmission(original.id, original, true, false, "own-command");
    controller.ingest(remote); controller.ingest(consumed(original)); controller.dispose();
    const restored = new DraftController(saver([]), "host", storage);
    try {
      expect(restored.get(original.id)).toMatchObject({ status: "conflict", draft: original, conflict: remote });
      restored.resolve(original.id, "remote"); expect(restored.get(original.id)).toMatchObject({ status: "saved", draft: remote });
    } finally { restored.dispose(); }
  });

  test("offline ordered images and conflicts survive restart; obsolete host format cannot silently strip them", async () => {
    const storage = cache(), calls: CommandEnvelope[] = [], first = new DraftController(saver(calls), "host", storage);
    first.ingest(draft()); first.update("new-conversation", { attachments: [image("two"), image()] }); first.dispose();
    const restored = new DraftController(saver(calls), "host", storage);
    try {
      restored.ingest(draft({ revision: 2, attachments: undefined, text: "old client" }));
      expect(restored.get("new-conversation")).toMatchObject({ status: "conflict", draft: { attachments: [image("two"), image()] } });
      expect(() => restored.update("new-conversation", { attachments: undefined })).toThrow("empty array");
      restored.resolve("new-conversation", "remote"); restored.setConnected(true); await restored.flush("new-conversation");
      expect(calls[0]?.command).toMatchObject({ expectedRevision: 2, draft: { text: "old client", attachments: [] } });
    } finally { restored.dispose(); }
  });

  test("a successful-looking legacy save reply that drops images is rejected and retains local content", async () => {
    const controller = new DraftController(async envelope => ({ ok: true, commandId: envelope.id, value: draft({ revision: 2, attachments: undefined }) }), "host");
    try {
      controller.ingest(draft()); controller.setConnected(true); controller.update("new-conversation", { attachments: [image("two")] });
      await expect(controller.flush("new-conversation")).rejects.toThrow("preserve the saved draft content");
      expect(controller.get("new-conversation")).toMatchObject({ status: "error", draft: { attachments: [image("two")] } });
    } finally { controller.dispose(); }
  });
});

describe("attachment submission envelopes", () => {
  test("capture precedes async create; exact send is durable before callback/delivery and external mutation cannot change it", async () => {
    const storage = cache(), creation = Promise.withResolvers<CommandResult>(), calls: CommandEnvelope[] = [];
    let callbackId = "";
    const controller = new SubmissionController(async envelope => {
      calls.push(structuredClone(envelope));
      if (envelope.command.type === "session.create") return creation.promise;
      expect(callbackId).toBe(envelope.id); return ack(envelope);
    }, "host", storage);
    const input = draft({ model: { provider: "fixture", id: "captured" }, attachments: [image(), image("two")] });
    const expected = captureDraft(input);
    const sending = controller.submit(input, undefined, "prompt", (captured, id) => {
      const persisted = JSON.parse(storage.read(controller.cacheKey)!)[input.id];
      expect(persisted.send.id).toBe(id); expect(persisted.send.command.attachments).toEqual(expected.attachments);
      callbackId = id; captured.attachments![0]!.name = "callback mutation";
      const read = controller.get(input.id)!; read.send!.id = "public mutation"; read.draft.attachments!.reverse();
    });
    input.attachments![0]!.name = "caller mutation"; input.attachments!.reverse(); input.model!.id = "changed";
    creation.resolve(ack(calls[0]!));
    const result = await sending;
    expect(result).toEqual({ sessionId: session.id, commandId: calls[1]!.id, submitted: expected });
    expect(calls[1]?.command).toMatchObject({ type: "session.prompt", model: expected.model, attachments: expected.attachments });
  });

  test("nonempty image steer is rejected before delivery; an aware empty steer keeps its protocol field", async () => {
    const calls: CommandEnvelope[] = [], controller = new SubmissionController(async envelope => { calls.push(envelope); return ack(envelope); }, "host", cache());
    await expect(controller.submit(draft(), session.id, "steer")).rejects.toThrow("cannot be sent while");
    expect(calls).toHaveLength(0); expect(controller.get("new-conversation")).toBeUndefined();
    await controller.submit(draft({ text: "text only now", attachments: [] }), session.id, "steer");
    expect(calls[0]?.command).toMatchObject({ type: "session.steer", attachments: [] });
  });

  test("wrong result identity remains uncertain and retries the original image snapshot after restart", async () => {
    const storage = cache(), calls: CommandEnvelope[] = [];
    const controller = new SubmissionController(async envelope => { calls.push(envelope); return { ...ack(envelope), commandId: "different" }; }, "host", storage);
    await expect(controller.submit(draft(), session.id, "prompt")).rejects.toThrow("different command identity");
    expect(controller.get("new-conversation")?.uncertain).toBe(true);
    const restored = new SubmissionController(async envelope => { calls.push(envelope); return ack(envelope); }, "host", storage);
    const accepted = await restored.submit(draft({ attachments: [image("two")], text: "newer", revision: 2 }), "different-session", "steer");
    expect(calls[1]).toEqual(calls[0]); expect(accepted.submitted).toEqual(draft());
  });

  test("foreign owner and modified cached command metadata are rejected without delivery", async () => {
    let deliveries = 0; const storage = cache();
    const controller = new SubmissionController(async envelope => { deliveries++; throw new Error(envelope.id); }, "host", storage);
    await expect(controller.submit(draft({ attachments: [image("one", "foreign")] }), session.id, "prompt")).rejects.toThrow("another host");
    expect(deliveries).toBe(0);
    await expect(controller.submit(draft(), session.id, "prompt")).rejects.toThrow("uncertain");
    const saved = JSON.parse(storage.read(controller.cacheKey)!); saved["new-conversation"].send.command.attachments[0].name = "different"; storage.write(controller.cacheKey, JSON.stringify(saved));
    const restored = new SubmissionController(async envelope => { deliveries++; return ack(envelope); }, "host", storage);
    expect(restored.cacheWarning).toContain("could not be read"); expect(restored.get("new-conversation")).toBeUndefined(); expect(deliveries).toBe(1);
  });

  test("real reopened SQLite admission consumes the exact old manifest while restored newer edits survive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-image-draft-state-")); let store = new HostStore(directory);
    const storage = cache(), calls: CommandEnvelope[] = []; let executions = 0;
    const hash = (envelope: CommandEnvelope) => createHash("sha256").update(JSON.stringify(envelope.command)).digest("hex");
    // Real host store and renderer controllers; admission/transport are controlled,
    // with no provider, native image normalization, or binary upload in this fixture.
    const send = async (envelope: CommandEnvelope): Promise<CommandResult> => {
      calls.push(structuredClone(envelope));
      if (envelope.command.type === "draft.put") {
        const saved = store.putDraft(envelope.command.draft, envelope.command.expectedRevision);
        return saved.ok ? { ok: true, commandId: envelope.id, value: saved.draft } : { ok: false, commandId: envelope.id, currentDraft: saved.currentDraft, error: { code: "DRAFT_CONFLICT", message: "Changed" } };
      }
      const claim = store.claimCommand(envelope.id, hash(envelope), envelope.command);
      if (claim.kind === "done") return claim.record.result!;
      if (claim.kind === "claimed") executions++;
      return { ok: false, commandId: envelope.id, error: { code: "OUTCOME_UNKNOWN", message: "Controlled lost admission reply" } };
    };
    let drafts = new DraftController(send, store.host.id, storage), submissions = new SubmissionController(send, store.host.id, storage);
    try {
      const original = draft({ attachments: [image("one", store.host.id)], revision: 0 });
      const { revision: _revision, updatedAt: _updatedAt, ...input } = original;
      const saved = store.putDraft(input, 0); if (!saved.ok) throw new Error("Fixture setup conflict");
      drafts.ingest(saved.draft); drafts.setConnected(true);
      const snapshot = await drafts.prepareSubmission(original.id);
      await expect(submissions.submit(snapshot, session.id, "prompt", (value, id) => drafts.beginPendingSubmission(value, id))).rejects.toThrow("uncertain");
      const pending = submissions.get(original.id)!;
      drafts.finishSubmission(original.id, snapshot, false, true, pending.send!.id);
      drafts.update(original.id, { text: "", attachments: [image("two", store.host.id)] });
      drafts.dispose(); store.close(); store = new HostStore(directory);
      drafts = new DraftController(send, store.host.id, storage); submissions = new SubmissionController(send, store.host.id, storage);
      for (const item of submissions.entries()) if (item.send) drafts.beginPendingSubmission(item.draft, item.send.id);
      const envelope = submissions.get(original.id)!.send!;
      const receipt: CommandResult = { ok: true, commandId: envelope.id, value: session, admission: { kind: "user-message", entryId: "controlled-native-entry" } };
      store.finishCommand(envelope.id, hash(envelope), receipt);
      const cleared = store.getDraft(original.id)!;
      expect(cleared).toMatchObject({ revision: 2, text: "", attachments: [], lastConsumption: { commandId: envelope.id, submittedRevision: 1 } });
      drafts.ingest(cleared);
      const accepted = await submissions.submit(drafts.get(original.id).draft, "different-session", "steer", (value, id) => drafts.beginPendingSubmission(value, id));
      drafts.finishSubmission(original.id, accepted.submitted, true, false, accepted.commandId);
      expect(calls[1]).toEqual(calls[0]); expect(executions).toBe(1);
      expect(drafts.get(original.id).draft.attachments).toEqual([image("two", store.host.id)]);
      drafts.setConnected(true); await drafts.flush(original.id);
      expect(store.getDraft(original.id)).toMatchObject({ revision: 3, attachments: [image("two", store.host.id)], lastConsumption: cleared.lastConsumption });
      expect(calls.at(-1)?.command).toMatchObject({ type: "draft.put", expectedRevision: 2 });
      expect(submissions.get(original.id)).toBeUndefined();
    } finally { drafts.dispose(); store.close(); await rm(directory, { recursive: true, force: true }); }
  });
});

test("conflict snapshots expose ordered image metadata, escape names, and do not invent previews", () => {
  const markup = renderToStaticMarkup(createElement(DraftSnapshot, { draft: draft({ attachments: [{ ...image(), name: "<img src=x>" }, image("two")] }), hostName: "Home", projects: [] }));
  expect(markup).toContain("(No authored text)"); expect(markup).toContain("&lt;img src=x&gt;"); expect(markup).not.toContain("<img");
  expect(markup.indexOf("&lt;img")).toBeLessThan(markup.indexOf("two.png")); expect(markup).toContain("Home"); expect(markup).not.toContain("SHA-256"); expect(markup).not.toContain("a".repeat(64));
  const empty = renderToStaticMarkup(createElement(DraftSnapshot, { draft: draft({ attachments: [] }), hostName: "Home", projects: [] }));
  expect(empty).toContain("No images"); expect(empty).toContain("(Empty draft)");
});
