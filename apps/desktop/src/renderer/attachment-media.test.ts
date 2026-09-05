import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ImageAttachmentRef, RecordedImageBytes } from "@agent-desktop/shared";
import type { AttachmentCache } from "./attachment-cache";
import { loadAttachmentMedia } from "./attachment-media";

const data = new Uint8Array([1, 2, 3]), sha256 = createHash("sha256").update(data).digest("hex");
const attachment: ImageAttachmentRef = { id: "image", hostId: "owner", kind: "image", name: "image.png", sha256, mimeType: "image/png", bytes: data.length };
const recorded = (): RecordedImageBytes => ({ data: new Uint8Array(data), sha256, mimeType: "image/png", bytes: data.length });
function cache(): AttachmentCache { const values = new Map<string, Blob>(); return { async get(key) { return values.get(JSON.stringify(key)) ?? null; }, async put(key, input) { const blob = input instanceof Blob ? input : new Blob([new Uint8Array(input)]); if (createHash("sha256").update(new Uint8Array(await blob.arrayBuffer())).digest("hex") !== key.sha256) throw new Error("Corrupt bytes"); values.set(JSON.stringify(key), blob); }, close() {} }; }

// Binary cache behavior itself is separately tested against actual Electron IDB.
test("original attachment loading has explicit owner routing and becomes offline-readable only after verified cache commit", async () => {
  const binary = cache(), calls: unknown[] = [];
  const media = { cache: binary, bridge: { async getImageAttachment(hash: string, host: string) { calls.push({ hash, host }); return recorded(); } } };
  const source = { kind: "attachment" as const, attachment };
  await expect(loadAttachmentMedia(media, source, "owner", false)).rejects.toThrow("not cached"); expect(calls).toHaveLength(0);
  expect((await loadAttachmentMedia(media, source, "owner", true)).blob.type).toBe("image/png");
  expect(calls).toEqual([{ hash: sha256, host: "owner" }]);
  expect(new Uint8Array(await (await loadAttachmentMedia(media, source, "owner", false)).blob.arrayBuffer())).toEqual(data);
  await expect(loadAttachmentMedia(media, source, "other", true)).rejects.toThrow("another host"); expect(calls).toHaveLength(1);
});

test("native media fetch uses exact session, native entry and block; original hash cannot substitute", async () => {
  const calls: unknown[] = [], media = { cache: cache(), bridge: { async getTranscriptImage(sessionId: string, entryId: string, index: number, owner: string) { calls.push({ sessionId, entryId, index, owner }); return recorded(); } } };
  const source = { kind: "transcript" as const, sessionId: "session", nativeEntryId: "native-entry", blockIndex: 3, mimeType: "image/png", sha256, bytes: 3 };
  await loadAttachmentMedia(media, source, "owner", true); expect(calls).toEqual([{ sessionId: "session", entryId: "native-entry", index: 3, owner: "owner" }]);
  await loadAttachmentMedia(media, source, "owner", false); expect(calls).toHaveLength(1);
  await expect(loadAttachmentMedia(media, { ...source, sha256: "a".repeat(64) }, "owner", true)).rejects.toThrow("differs");
  await expect(loadAttachmentMedia(media, { ...source, nativeEntryId: "" }, "owner", true)).rejects.toThrow("durable native entry");
});

test("corrupt bytes, quota failure, wrong MIME and mutated later response bytes cannot produce a successful preview", async () => {
  for (const kind of ["corrupt", "quota", "mime"] as const) {
    const binary = cache(); if (kind === "quota") binary.put = async () => { throw new Error("Quota exceeded"); };
    const value = recorded(); if (kind === "corrupt") value.data[0] = 99; if (kind === "mime") value.mimeType = "image/jpeg";
    await expect(loadAttachmentMedia({ cache: binary, bridge: { async getImageAttachment() { return value; } } }, { kind: "attachment", attachment }, "owner", true)).rejects.toThrow();
    expect(await binary.get({ hostId: "owner", sha256 })).toBeNull();
  }
  const binary = cache(), gate = Promise.withResolvers<void>(), response = recorded(), put = binary.put;
  binary.put = async (key, bytes) => { await gate.promise; return put(key, bytes); };
  const loading = loadAttachmentMedia({ cache: binary, bridge: { async getImageAttachment() { return response; } } }, { kind: "attachment", attachment }, "owner", true);
  for (let i = 0; i < 10; i++) await Promise.resolve(); response.data[0] = 99; gate.resolve();
  expect(new Uint8Array(await (await loading).blob.arrayBuffer())).toEqual(data);
});
