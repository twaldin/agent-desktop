import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_IMAGE_ATTACHMENT_BYTES, type ImageAttachmentMimeType } from "../../../../packages/shared/src/attachments";
import { AttachmentImageError, ImageAttachmentStore, MAX_IMAGE_ATTACHMENT_PIXELS, type AttachmentImageErrorCode } from "./image-store";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iSgAAAABJRU5ErkJggg==", "base64");
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let root: string;
let store: ImageAttachmentStore;
const pathFor = (hash: string) => join(root, "attachments", "images", hash.slice(0, 2), hash);

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agent-attachment-images-")); store = new ImageAttachmentStore(root); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function rejected(operation: Promise<unknown>, code: AttachmentImageErrorCode, status?: number): Promise<void> {
  try { await operation; throw new Error("Expected operation to reject"); }
  catch (error) {
    expect(error).toBeInstanceOf(AttachmentImageError);
    expect((error as AttachmentImageError).code).toBe(code);
    if (status !== undefined) expect((error as AttachmentImageError).status).toBe(status);
  }
}

test("native PNG/JPEG/GIF/WebP validation retains exact original bytes and dimensions after restart", async () => {
  const fixtures: { bytes: Uint8Array; mimeType: ImageAttachmentMimeType; width: number; height: number }[] = [
    { bytes: png, mimeType: "image/png", width: 1, height: 1 },
    { bytes: await new Bun.Image(png).resize(3, 2).jpeg().bytes(), mimeType: "image/jpeg", width: 3, height: 2 },
    { bytes: gif, mimeType: "image/gif", width: 1, height: 1 },
    { bytes: await new Bun.Image(png).resize(2, 3).webp().bytes(), mimeType: "image/webp", width: 2, height: 3 },
  ];
  for (const fixture of fixtures) {
    const sha256 = digest(fixture.bytes);
    const metadata = await store.putImage(sha256, fixture.bytes);
    expect(metadata).toEqual({ sha256, bytes: fixture.bytes.length, mimeType: fixture.mimeType, width: fixture.width, height: fixture.height });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect((await new ImageAttachmentStore(root).readValidatedImage(sha256)).metadata).toEqual(metadata);
    expect(await new ImageAttachmentStore(root).readImage(sha256)).toEqual(Uint8Array.from(fixture.bytes));
    expect(await readFile(pathFor(sha256))).toEqual(Buffer.from(fixture.bytes));
    expect((await lstat(pathFor(sha256))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, "attachments", "images", sha256.slice(0, 2)))).mode & 0o777).toBe(0o700);
  }
});

test("input and returned byte ownership cannot modify an upload or later reads", async () => {
  const input = Buffer.from(png);
  const hash = digest(input);
  const pending = store.putImage(hash, input);
  input.fill(0);
  await pending;
  const read = await store.readImage(hash);
  read.fill(1);
  expect(await store.readImage(hash)).toEqual(Uint8Array.from(png));
});

test("invalid digest, encoded size, unsupported MIME and incomplete compressed data fail before publication", async () => {
  await rejected(store.putImage("../not-a-digest", png), "INVALID_IMAGE_HASH", 400);
  await rejected(store.readImage("A".repeat(64)), "INVALID_IMAGE_HASH", 400);
  await rejected(store.putImage("0".repeat(64), png), "IMAGE_HASH_MISMATCH", 400);
  await rejected(store.putImage(digest(new Uint8Array()), new Uint8Array()), "INVALID_IMAGE_DATA", 422);
  await rejected(store.putImage("0".repeat(64), new Uint8Array(MAX_IMAGE_ATTACHMENT_BYTES + 1)), "IMAGE_TOO_LARGE", 413);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
  await rejected(store.putImage(digest(svg), svg), "UNSUPPORTED_IMAGE_TYPE", 415);
  // Valid PNG dimensions and trailer are insufficient: remove its compressed stream.
  const missingPixels = Buffer.concat([png.subarray(0, 33), png.subarray(png.length - 12)]);
  expect(await new Bun.Image(missingPixels).metadata()).toMatchObject({ width: 1, height: 1, format: "png" });
  await rejected(store.putImage(digest(missingPixels), missingPixels), "INVALID_IMAGE_DATA", 422);
  expect(await readdir(root)).toEqual([]);
});

test("pinned native maxPixels checks input even when the requested output is only one pixel", async () => {
  const twoByTwo = await new Bun.Image(png).resize(2, 2).png().bytes();
  let code: string | undefined;
  try { await new Bun.Image(twoByTwo, { maxPixels: 1 }).resize(1, 1).png().bytes(); }
  catch (error) { code = (error as { code?: string }).code; }
  expect(code).toBe("ERR_IMAGE_TOO_MANY_PIXELS");

  // A real PNG header with a valid IHDR CRC advertises pixels over the ingress cap.
  // It must be rejected before attempting to decode its deliberately small stream.
  const oversized = Buffer.from(png);
  oversized.writeUInt32BE(4097, 16);
  oversized.writeUInt32BE(4096, 20);
  oversized.writeUInt32BE(crc32(oversized.subarray(12, 29)), 29);
  expect((await new Bun.Image(oversized).metadata()).width * 4096).toBeGreaterThan(MAX_IMAGE_ATTACHMENT_PIXELS);
  await rejected(store.putImage(digest(oversized), oversized), "IMAGE_TOO_MANY_PIXELS", 413);
  expect(await readdir(root)).toEqual([]);
});

test("two independent stores publish one immutable digest concurrently and retry idempotently", async () => {
  const hash = digest(png);
  const second = new ImageAttachmentStore(root);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? store : second).putImage(hash, png)));
  expect(results.every(result => result.sha256 === hash)).toBe(true);
  const before = await lstat(pathFor(hash));
  await new ImageAttachmentStore(root).putImage(hash, png);
  const after = await lstat(pathFor(hash));
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(after.nlink).toBe(1);
  expect(await readdir(join(root, "attachments", "images", hash.slice(0, 2)))).toEqual([hash]);
  expect(await second.readImage(hash)).toEqual(Uint8Array.from(png));
});

test("corrupt existing content is refused on read, retry and restart without overwriting either version", async () => {
  const hash = digest(png);
  await store.putImage(hash, png);
  const corrupt = Buffer.from(png); corrupt[44] ^= 1;
  await writeFile(pathFor(hash), corrupt);
  await rejected(store.readImage(hash), "CORRUPT_IMAGE_STORAGE", 409);
  await rejected(new ImageAttachmentStore(root).putImage(hash, png), "CORRUPT_IMAGE_STORAGE", 409);
  expect(await readFile(pathFor(hash))).toEqual(corrupt);
  expect(await readdir(join(root, "attachments", "images", hash.slice(0, 2)))).toEqual([hash]);
});

test("matching hashes do not bless unsupported or undecodable files planted in storage", async () => {
  for (const bytes of [Buffer.from("not an image"), Buffer.concat([png.subarray(0, 33), png.subarray(png.length - 12)])]) {
    const hash = digest(bytes);
    await mkdir(join(root, "attachments", "images", hash.slice(0, 2)), { recursive: true, mode: 0o700 });
    await writeFile(pathFor(hash), bytes, { mode: 0o600 });
    await rejected(new ImageAttachmentStore(root).readImage(hash), "CORRUPT_IMAGE_STORAGE", 409);
  }
});

test("missing reads are explicit and do not create directories", async () => {
  await rejected(store.readImage("0".repeat(64)), "IMAGE_NOT_FOUND", 404);
  expect(await readdir(root)).toEqual([]);
});

test("file symlinks, directories and non-private blobs are refused without following them", async () => {
  const hash = digest(png);
  await store.putImage(hash, png);
  await unlink(pathFor(hash));
  const outside = join(root, "outside-image"); await writeFile(outside, png, { mode: 0o600 });
  await symlink(outside, pathFor(hash));
  await rejected(store.readImage(hash), "UNSAFE_IMAGE_STORAGE", 409);
  await rejected(store.putImage(hash, png), "UNSAFE_IMAGE_STORAGE", 409);
  expect(await readFile(outside)).toEqual(png);
  await unlink(pathFor(hash)); await mkdir(pathFor(hash), { mode: 0o700 });
  await rejected(store.readImage(hash), "UNSAFE_IMAGE_STORAGE", 409);
  await rm(pathFor(hash), { recursive: true }); await writeFile(pathFor(hash), png, { mode: 0o644 });
  await rejected(store.readImage(hash), "UNSAFE_IMAGE_STORAGE", 409);
});

test("a replaced shard, root symlink or non-private directory cannot redirect publication", async () => {
  const hash = digest(png); await store.putImage(hash, png);
  const shard = join(root, "attachments", "images", hash.slice(0, 2));
  const moved = join(root, "moved-shard"); await rename(shard, moved); await symlink(moved, shard);
  await rejected(store.readImage(hash), "UNSAFE_IMAGE_STORAGE", 409);
  await rejected(store.putImage(hash, png), "UNSAFE_IMAGE_STORAGE", 409);
  await unlink(shard); await rename(moved, shard);
  await chmod(shard, 0o755);
  await rejected(store.readImage(hash), "UNSAFE_IMAGE_STORAGE", 409);
  await chmod(shard, 0o700);
  const alias = join(root, "data-alias"); await symlink(root, alias);
  await rejected(new ImageAttachmentStore(alias).putImage(hash, png), "UNSAFE_IMAGE_STORAGE", 409);
});

test.skipIf(process.getuid?.() === 0)("actual filesystem refusal leaves no published file and a later retry can recover", async () => {
  // Filesystem permissions, not a mocked write failure. Test runners must be unprivileged.
  expect(process.getuid?.()).not.toBe(0);
  const hash = digest(png);
  const shard = join(root, "attachments", "images", hash.slice(0, 2));
  await mkdir(shard, { recursive: true, mode: 0o700 });
  await chmod(shard, 0o500);
  try {
    await rejected(store.putImage(hash, png), "IMAGE_STORAGE_FAILED", 500);
    expect(await readdir(shard)).toEqual([]);
  } finally { await chmod(shard, 0o700); }
  await store.putImage(hash, png);
  expect(await store.readImage(hash)).toEqual(Uint8Array.from(png));
});

test("directory fsync failure reports uncertain durability; visible complete bytes require successful reconciliation", async () => {
  const hash = digest(png);
  const shard = join(root, "attachments", "images", hash.slice(0, 2));
  await mkdir(shard, { recursive: true, mode: 0o700 });
  const identity = await lstat(shard);
  const handle = await open(shard, "r");
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  const original = prototype.sync;
  await handle.close();
  // Inject only an fsync errno on the actual private shard. All file writes,
  // hard links, unlinks and integrity reads run against the real filesystem.
  let refused = 0;
  const sync = spyOn(prototype, "sync").mockImplementation(async function(this: FileHandle) {
    const current = await this.stat();
    if (current.ino === identity.ino && current.dev === identity.dev) {
      refused++;
      throw Object.assign(new Error("Injected directory fsync failure"), { code: "EIO" });
    }
    return original.call(this);
  });
  try {
    await rejected(store.putImage(hash, png), "IMAGE_DURABILITY_UNCERTAIN", 503);
    expect(await readFile(pathFor(hash))).toEqual(png);
    expect(await readdir(shard)).toEqual([hash]);
    await rejected(store.readValidatedImage(hash), "IMAGE_DURABILITY_UNCERTAIN", 503);
    expect(refused).toBe(2);
  } finally { sync.mockRestore(); }
  const before = await lstat(pathFor(hash));
  expect((await new ImageAttachmentStore(root).readValidatedImage(hash)).bytes).toEqual(Uint8Array.from(png));
  await store.putImage(hash, png);
  expect((await lstat(pathFor(hash))).ino).toBe(before.ino);
});

test("file fsync failure refuses publication and cleans only its temporary file", async () => {
  const handle = await open(root, "r");
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  const original = prototype.sync;
  await handle.close();
  const sync = spyOn(prototype, "sync").mockImplementation(async function(this: FileHandle) {
    if ((await this.stat()).isFile()) throw Object.assign(new Error("Injected file fsync failure"), { code: "EIO" });
    return original.call(this);
  });
  const hash = digest(png);
  try {
    await rejected(store.putImage(hash, png), "IMAGE_STORAGE_FAILED", 500);
    expect(await readdir(join(root, "attachments", "images", hash.slice(0, 2)))).toEqual([]);
  } finally { sync.mockRestore(); }
  await store.putImage(hash, png);
  expect(await store.readImage(hash)).toEqual(Uint8Array.from(png));
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
