import { describe, expect, test } from "bun:test";
import { MAX_IMAGE_ATTACHMENT_BYTES, parseImageAttachments, sameImageAttachments, type ImageAttachmentRef } from "./attachments";

const image = (patch: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef => ({
  id: "chip-a", hostId: "owner-a", kind: "image", sha256: "a".repeat(64), name: "雪.png", bytes: 128, mimeType: "image/png", ...patch,
});

describe("image draft metadata", () => {
  test("copies ordered identities while allowing duplicate bytes", () => {
    const source = [image(), image({ id: "chip-b", name: "same bytes.png" })];
    const saved = parseImageAttachments(source, "owner-a");
    expect(saved).toEqual(source);
    source[0]!.name = "changed later"; source.reverse();
    expect(saved.map(item => item.name)).toEqual(["雪.png", "same bytes.png"]);
    expect(sameImageAttachments(saved, saved.toReversed())).toBe(false);
    expect(sameImageAttachments(saved, structuredClone(saved))).toBe(true);
    expect(sameImageAttachments(undefined, [])).toBe(false);
    expect(sameImageAttachments([], [])).toBe(true);
  });

  test("rejects untrusted ownership, binary fields, malformed metadata and reused chip IDs", () => {
    expect(() => parseImageAttachments([image()], "owner-b")).toThrow("another host");
    expect(() => parseImageAttachments([image(), image()])).toThrow("distinct");
    for (const patch of [{ data: "base64" }, { url: "https://example.invalid/image" }, { path: "/tmp/image.png" },
      { kind: "file" }, { mimeType: "image/svg+xml" }, { sha256: "A".repeat(64) }, { bytes: -1 }, { bytes: 0 },
      { bytes: 1.2 }, { bytes: Number.NaN }, { hostId: "" }, { id: "\0" }, { name: "x".repeat(501) }]) {
      expect(() => parseImageAttachments([{ ...image(), ...patch }])).toThrow();
    }
  });

  test("counts ordered duplicate bytes against the bounded native batch", () => {
    expect(parseImageAttachments([image({ bytes: MAX_IMAGE_ATTACHMENT_BYTES })])).toHaveLength(1);
    expect(() => parseImageAttachments([image({ bytes: MAX_IMAGE_ATTACHMENT_BYTES + 1 })])).toThrow();
    expect(() => parseImageAttachments([image({ bytes: MAX_IMAGE_ATTACHMENT_BYTES }), image({ id: "chip-b" })])).toThrow("total");
    expect(parseImageAttachments(Array.from({ length: 4 }, (_, i) => image({ id: String(i) })))).toHaveLength(4);
    expect(() => parseImageAttachments(Array.from({ length: 5 }, (_, i) => image({ id: String(i) })))).toThrow("at most");
  });
});
