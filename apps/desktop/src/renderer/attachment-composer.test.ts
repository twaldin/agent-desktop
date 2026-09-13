import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { CommandEnvelope, Draft, ImageAttachmentCapabilities, ImageAttachmentRef, OmpComposerCatalog, OmpSessionControls, UploadedImageMetadata } from "@agent-desktop/shared";
import { AttachmentComposer, attachmentDraftSender, imageCapabilityIssue, imageSendIssue } from "./attachment-composer";
import { DraftController } from "./drafts";
import type { AttachmentCache } from "./attachment-cache";

export const capabilities: ImageAttachmentCapabilities = { protocolVersion: 1, commandVersion: 3, maxImages: 4, maxImageBytes: 20 * 1024 * 1024, maxBatchBytes: 20 * 1024 * 1024, maxImagePixels: 16_777_216, mimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"] };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const metadata = (bytes: Uint8Array): UploadedImageMetadata => ({ sha256: hash(bytes), bytes: bytes.byteLength, mimeType: "image/png", width: 1, height: 1 });
const file = (name = "one.png", bytes = [1, 2, 3]) => new File([new Uint8Array(bytes)], name, { type: "image/png" });
const draft = (patch: Partial<Draft> = {}): Draft => ({ id: "new-conversation", projectId: null, model: null, text: "", revision: 0, updatedAt: 0, ...patch });
const ref = (id = "one", bytes = new Uint8Array([1, 2, 3])): ImageAttachmentRef => ({ id, hostId: "owner", name: `${id}.png`, kind: "image", ...Object.fromEntries(Object.entries(metadata(bytes)).filter(([key]) => key !== "width" && key !== "height")) } as ImageAttachmentRef);
function binaryCache(): AttachmentCache { const values = new Map<string, Blob>(); return { async get(key) { return values.get(JSON.stringify(key)) ?? null; }, async put(key, bytes) { values.set(JSON.stringify(key), bytes instanceof Blob ? bytes : new Blob([new Uint8Array(bytes)])); }, close() {} }; }
const noSend = async () => { throw new Error("No host command allowed in this fixture"); };
const ticks = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// Controlled inspect/decode/cache boundaries exercise controller state and calls.
// Actual browser decode + IndexedDB + rendered events have a separate Electron fixture.
test("staging snapshots owner and draft, commits cache before chips, and keeps later edits and ordered files", async () => {
  const drafts = new DraftController(noSend, "owner"), cache = binaryCache();
  const commit = Promise.withResolvers<void>(), put = cache.put; const order: string[] = [];
  cache.put = async (key, bytes) => { order.push("cache-start"); await commit.promise; await put(key, bytes); order.push("cache-done"); };
  const controller = new AttachmentComposer("owner", "new-conversation", drafts, cache, async bytes => { order.push("inspect"); return metadata(bytes); }, async () => { order.push("decode"); });
  try {
    const pending = controller.add([file(), file("two.png", [4, 5])], capabilities);
    await ticks(); expect(controller.staging[0]?.status).toBe("caching"); expect(drafts.get("new-conversation").draft.attachments).toBeUndefined();
    drafts.update("new-conversation", { text: "typed while staging", projectId: "chosen-project" });
    drafts.update("session:another", { text: "another route" });
    commit.resolve(); await pending;
    expect(order).toEqual(["inspect", "decode", "cache-start", "cache-done", "inspect", "decode", "cache-start", "cache-done"]);
    expect(drafts.get("new-conversation").draft).toMatchObject({ text: "typed while staging", projectId: "chosen-project", attachments: [{ name: "one.png", hostId: "owner" }, { name: "two.png", hostId: "owner" }] });
    expect(drafts.get("session:another").draft.attachments).toBeUndefined();
    const [first, second] = drafts.get("new-conversation").draft.attachments!;
    controller.move(second!.id, -1); expect(drafts.get("new-conversation").draft.attachments?.map(item => item.name)).toEqual(["two.png", "one.png"]);
    controller.remove(first!.id); controller.remove(second!.id); expect(drafts.get("new-conversation").draft.attachments).toEqual([]);
    expect(controller.staging).toEqual([]);
  } finally { controller.dispose(); drafts.dispose(); }
});

test("cancel, route disposal, and stale staging Remove cannot publish a late image", async () => {
  for (const action of ["cancel", "dispose", "late-remove"] as const) {
    const drafts = new DraftController(noSend, "owner"), decode = Promise.withResolvers<void>();
    const controller = new AttachmentComposer("owner", "new-conversation", drafts, binaryCache(), async bytes => metadata(bytes), () => decode.promise);
    try {
      const pending = controller.add([file()], capabilities); const id = controller.staging[0]!.id; await ticks();
      if (action === "cancel") controller.removeStaged(id); else if (action === "dispose") controller.dispose();
      decode.resolve(); await pending;
      if (action === "late-remove") { expect(drafts.get("new-conversation").draft.attachments).toHaveLength(1); controller.removeStaged(id); }
      expect(drafts.get("new-conversation").draft.attachments?.length ?? 0).toBe(0);
    } finally { controller.dispose(); drafts.dispose(); }
  }
});

test("decode or cache failures retain a visible failed stage and never report a saved chip", async () => {
  for (const failure of ["decode", "cache"] as const) {
    const drafts = new DraftController(noSend, "owner"), cache = binaryCache(); let fail = true, commits = 0;
    const put = cache.put; cache.put = async (key, bytes) => { commits++; if (failure === "cache" && fail) throw new Error("Quota fixture"); await put(key, bytes); };
    const controller = new AttachmentComposer("owner", "new-conversation", drafts, cache, async bytes => metadata(bytes), async () => { if (failure === "decode" && fail) throw new Error("Decode fixture"); });
    try {
      await controller.add([file()], capabilities); expect(controller.staging[0]).toMatchObject({ status: "error" });
      expect(drafts.get("new-conversation").draft.attachments).toBeUndefined(); expect(commits).toBe(failure === "decode" ? 0 : 1);
      fail = false; await controller.retry(controller.staging[0]!.id);
      expect(drafts.get("new-conversation").draft.attachments).toHaveLength(1); expect(controller.staging).toHaveLength(0);
    } finally { controller.dispose(); drafts.dispose(); }
  }
});

test("cached capabilities permit offline attach but malformed limits, excessive count, bytes and header pixels do not", async () => {
  let inspected = 0, decoded = 0;
  const drafts = new DraftController(noSend, "owner"), controller = new AttachmentComposer("owner", "new-conversation", drafts, binaryCache(), async bytes => { inspected++; return { ...metadata(bytes), width: 4097, height: 4096 }; }, async () => { decoded++; });
  try {
    await controller.add([file()], undefined); expect(controller.error).toContain("unavailable");
    expect(imageCapabilityIssue({ ...capabilities, maxImagePixels: NaN })).toContain("unavailable");
    await controller.add(Array.from({ length: 5 }, () => file()), capabilities); expect(controller.error).toContain("up to 4");
    await controller.add([file()], { ...capabilities, maxImageBytes: 2 }); expect(controller.error).toContain("Each image"); expect(inspected).toBe(0);
    await controller.add([file()], capabilities); expect(inspected).toBe(1); expect(decoded).toBe(0); expect(controller.staging[0]?.error).toContain("dimensions");
    expect(drafts.get("new-conversation").draft.attachments).toBeUndefined();
  } finally { controller.dispose(); drafts.dispose(); }
});

test("staging lifecycle survives StrictMode effect cleanup/setup without reviving cancelled jobs", async () => {
  const drafts = new DraftController(noSend, "owner"), controller = new AttachmentComposer("owner", "new-conversation", drafts, binaryCache(), async bytes => metadata(bytes), async () => {});
  try { controller.dispose(); controller.start(); await controller.add([file()], capabilities); expect(drafts.get("new-conversation").draft.attachments).toHaveLength(1); }
  finally { controller.dispose(); drafts.dispose(); }
});

test("upload captures ordered metadata before await and completes every upload before draft.put", async () => {
  const bytes = new Uint8Array([1, 2, 3]), cache = binaryCache(); await cache.put({ hostId: "owner", sha256: hash(bytes) }, bytes);
  const gate = Promise.withResolvers<void>(), events: string[] = [], calls: CommandEnvelope[] = [];
  const bridge = {
    async uploadImageAttachment(sha256: string, sent: Uint8Array, owner: string) { events.push(`upload:${owner}:${sha256}`); await gate.promise; expect(sent).toEqual(bytes); return metadata(sent); },
    async command(envelope: CommandEnvelope, owner?: string) { events.push(`command:${owner}`); calls.push(envelope); return { ok: true as const, commandId: envelope.id }; },
  };
  const send = attachmentDraftSender("owner", { cache, bridge: {} }, bridge);
  const envelope: CommandEnvelope = { id: "exact-command", command: { type: "draft.put", draft: { id: "new-conversation", text: "captured", projectId: null, model: null, attachments: [ref(), ref("two")] }, expectedRevision: 3 } };
  const expected = structuredClone(envelope), pending = send(envelope); await ticks();
  if (envelope.command.type !== "draft.put") throw new Error("Fixture type"); envelope.command.draft.text = "later"; envelope.command.draft.attachments!.reverse();
  expect(calls).toHaveLength(0); gate.resolve(); await pending;
  expect(events.map(value => value.split(":")[0])).toEqual(["upload", "command"]); expect(calls[0]).toEqual(expected);
});

test("missing bytes, wrong owner, and failed or mismatching upload prevent draft publication", async () => {
  for (const failure of ["missing", "owner", "upload", "receipt"] as const) {
    let writes = 0, uploads = 0; const cache = binaryCache(), bytes = new Uint8Array([1, 2, 3]);
    if (failure !== "missing") await cache.put({ hostId: "owner", sha256: hash(bytes) }, bytes);
    const send = attachmentDraftSender("owner", { cache, bridge: {} }, { async uploadImageAttachment() { uploads++; if (failure === "upload") throw new Error("Upload failed"); return { ...metadata(bytes), sha256: "c".repeat(64) }; }, async command(envelope) { writes++; return { ok: true, commandId: envelope.id }; } });
    await expect(send({ id: "command", command: { type: "draft.put", expectedRevision: 0, draft: { id: "new-conversation", text: "", projectId: null, model: null, attachments: [{ ...ref(), hostId: failure === "owner" ? "foreign" : "owner" }] } } })).rejects.toThrow();
    expect(writes).toBe(0); if (failure === "missing" || failure === "owner") expect(uploads).toBe(0);
  }
});

test("confirmed bytes avoid upload on text edits but a failed authoritative draft check invalidates that advice", async () => {
  const bytes = new Uint8Array([1, 2, 3]), cache = binaryCache(); await cache.put({ hostId: "owner", sha256: hash(bytes) }, bytes);
  let uploads = 0, writes = 0;
  const sender = attachmentDraftSender("owner", { cache, bridge: {} }, { async uploadImageAttachment() { uploads++; return metadata(bytes); }, async command(envelope) {
    writes++; return writes === 2 ? { ok: false, commandId: envelope.id, error: { code: "IMAGE_MISSING", message: "Controlled owner validation rejection" } } : { ok: true, commandId: envelope.id };
  } });
  for (let i = 0; i < 3; i++) await sender({ id: `save-${i}`, command: { type: "draft.put", expectedRevision: i, draft: { id: "new-conversation", text: String(i), model: null, projectId: null, attachments: [ref()] } } });
  expect(uploads).toBe(2); expect(writes).toBe(3);
});

test("image send checks preserve drafts and use actual current native capabilities over refreshed catalog", () => {
  const input = draft({ attachments: [ref()] });
  expect(imageSendIssue(input, true, capabilities)).toContain("cannot steer"); expect(imageSendIssue({ ...input, text: " /help" }, false, capabilities)).toContain("Slash commands");
  const model = { provider: "fixture", id: "model" }, session = { model } as import("@agent-desktop/shared").SessionSummary;
  const catalog = { models: [{ ...model, input: ["text"] }], default: { model } } as OmpComposerCatalog;
  const controls = { model, capabilities: { input: ["text", "image"] }, settings: [] } as unknown as OmpSessionControls;
  expect(imageSendIssue(input, false, capabilities, catalog, session, controls)).toBeUndefined();
  expect(imageSendIssue(input, false, capabilities, catalog)).toContain("does not accept images");
  controls.settings = [{ path: "images.blockImages", effective: true }] as OmpSessionControls["settings"];
  expect(imageSendIssue(input, false, capabilities, catalog, session, controls)).toContain("blocked");
  expect(imageSendIssue({ ...input, attachments: [] }, true, undefined)).toBeUndefined();
});

test("active image composition requires follow-up capability and preserves model, settings and command checks", () => {
  const input = draft({ attachments: [ref()] });
  const model = { provider: "fixture", id: "vision" }, session = { model } as import("@agent-desktop/shared").SessionSummary;
  const controls = { model, capabilities: { input: ["text", "image"] }, settings: [] } as unknown as OmpSessionControls;
  const followUpImages = { commandVersion: 17 as const };
  expect(imageSendIssue(input, true, capabilities, undefined, session, controls, followUpImages)).toBeUndefined();
  expect(imageSendIssue(input, true, capabilities, undefined, session, controls)).toContain("cannot steer");
  expect(imageSendIssue(input, true, undefined, undefined, session, controls, followUpImages)).toContain("unavailable");
  expect(imageSendIssue({ ...input, text: "/help" }, true, capabilities, undefined, session, controls, followUpImages)).toContain("Slash commands");
  controls.settings = [{ path: "images.blockImages", effective: true }] as OmpSessionControls["settings"];
  expect(imageSendIssue(input, true, capabilities, undefined, session, controls, followUpImages)).toContain("blocked");
  controls.settings = []; controls.capabilities!.input = ["text"];
  expect(imageSendIssue(input, true, capabilities, undefined, session, controls, followUpImages)).toContain("does not accept images");
  expect(input.attachments).toEqual([ref()]);
});
