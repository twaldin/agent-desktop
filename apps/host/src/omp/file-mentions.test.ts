import { expect, test } from "bun:test";
import { lookupFileMentionImage, projectFileMentions } from "./file-mentions";

const image = { type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64"), provider: "opaque" };

test("projects pinned text, directory, skipped, and image files in order", () => {
  const projected = projectFileMentions({ role: "fileMention", timestamp: 1, providerPayload: { secret: true }, files: [
    { path: "src/a.ts", content: "one\ntwo", lineCount: 2, byteSize: 7 },
    { path: "src", content: "a.ts\n", lineCount: 1 },
    { path: "big.bin", content: "(skipped)", byteSize: 99, skippedReason: "tooLarge" },
    { path: "image.png", content: "", image },
  ] });
  expect(projected?.map(file => file.path)).toEqual(["src/a.ts", "src", "big.bin", "image.png"]);
  expect(projected?.[3]).toEqual({ path: "image.png", content: "", image: { blockIndex: 3, mimeType: "image/png", bytes: 3, sha256: expect.any(String) } });
  expect(JSON.stringify(projected)).not.toContain("provider");
  expect(JSON.stringify(projected)).not.toContain("cG5n");
});

test("rejects malformed messages or files as a whole", () => {
  expect(projectFileMentions({ role: "fileMention", timestamp: 1, files: [] })).toEqual([]);
  expect(projectFileMentions({ role: "fileMention", timestamp: 1, files: [{ path: "ok", content: "" }, { path: "bad", content: "", skippedReason: "unknown" }] })).toBeUndefined();
  expect(projectFileMentions({ role: "fileMention", timestamp: 1, files: [{ path: "bad", content: "", image: { type: "image", mimeType: "image/png", data: "bad" } }] })?.[0]?.image).toMatchObject({ blockIndex: 0, error: expect.any(String) });
  expect(projectFileMentions({ role: "user", timestamp: 1, files: [] })).toBeUndefined();
  expect(projectFileMentions({ role: "fileMention", timestamp: 1, files: new Array(1) })).toBeUndefined();
  expect(projectFileMentions({ role: "fileMention", timestamp: 1, files: [{ path: "bad\u0000path", content: "" }] })).toBeUndefined();
});

test("looks up only the requested native image index", () => {
  const message = { role: "fileMention", timestamp: 1, files: [{ path: "a", content: "" }, { path: "b", content: "", image }] };
  expect(lookupFileMentionImage(message, 0)).toBeUndefined();
  expect(lookupFileMentionImage(message, 1)).toMatchObject({ mimeType: "image/png", bytes: 3, data: expect.any(Uint8Array) });
  expect(lookupFileMentionImage(message, 1.5)).toBeUndefined();
  expect(lookupFileMentionImage(message, 2)).toBeUndefined();
});

test("projected pending metadata can be safely recopied", () => {
  const projected = projectFileMentions({ role: "fileMention", timestamp: 1, files: [{ path: "a", content: "text", lineCount: 1 }] })!;
  const pending = structuredClone(projected);
  expect(pending).toEqual(projected);
  expect(() => (projected as unknown as Array<{ path: string }>)[0]!.path = "changed").toThrow();
});
