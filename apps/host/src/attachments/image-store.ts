import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseImageMetadata } from "@oh-my-pi/pi-utils";
import { IMAGE_ATTACHMENT_MIME_TYPES, MAX_IMAGE_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENT_PIXELS, type ImageAttachmentMimeType } from "../../../../packages/shared/src/attachments";

/** Application ingress bound, separate from provider limits and native resizing. */
export { MAX_IMAGE_ATTACHMENT_PIXELS };

export interface ImageAttachmentMetadata {
  sha256: string;
  bytes: number;
  mimeType: ImageAttachmentMimeType;
  width: number;
  height: number;
}

export interface ValidatedImageAttachment {
  metadata: Readonly<ImageAttachmentMetadata>;
  bytes: Uint8Array;
}

export type AttachmentImageErrorCode = "INVALID_IMAGE_HASH" | "IMAGE_HASH_MISMATCH" | "IMAGE_TOO_LARGE"
  | "IMAGE_TOO_MANY_PIXELS" | "UNSUPPORTED_IMAGE_TYPE" | "INVALID_IMAGE_DATA" | "IMAGE_NOT_FOUND"
  | "UNSAFE_IMAGE_STORAGE" | "CORRUPT_IMAGE_STORAGE" | "IMAGE_STORAGE_FAILED" | "IMAGE_DURABILITY_UNCERTAIN";

export class AttachmentImageError extends Error {
  constructor(readonly code: AttachmentImageErrorCode, message: string, readonly status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "AttachmentImageError";
  }
}

interface Directory { path: string; handle: FileHandle; identity: Stats }
const hashBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
// Publishing/removing the temporary hard link can change ctime during a parallel
// read; inode, length, mtime and the full digest establish the byte revision.
const sameRevision = (a: Stats, b: Stats) => sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs;
function fail(code: AttachmentImageErrorCode, message: string, status: number): never { throw new AttachmentImageError(code, message, status); }

function validateHash(value: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("INVALID_IMAGE_HASH", "An image requires a lowercase SHA-256 digest.", 400);
}

function validatePrivate(info: Stats, directory: boolean): void {
  if ((directory ? !info.isDirectory() : !info.isFile()) || (info.mode & 0o077) !== 0
    || (process.getuid && info.uid !== process.getuid())) {
    fail("UNSAFE_IMAGE_STORAGE", "Image storage must use private, owned regular files and directories.", 409);
  }
}

function storageError(error: unknown): AttachmentImageError {
  if (error instanceof AttachmentImageError) return error;
  if (errno(error) === "ELOOP" || errno(error) === "ENOTDIR") return new AttachmentImageError("UNSAFE_IMAGE_STORAGE", "An image storage path is not a regular file or directory.", 409, { cause: error });
  if (errno(error) === "ENOENT") return new AttachmentImageError("IMAGE_NOT_FOUND", "The owning host does not have this image.", 404, { cause: error });
  return new AttachmentImageError("IMAGE_STORAGE_FAILED", `Image storage failed${errno(error) ? ` (${errno(error)})` : ""}.`, 500, { cause: error });
}

async function validateImage(sha256: string, bytes: Uint8Array): Promise<Readonly<ImageAttachmentMetadata>> {
  const detected = parseImageMetadata(bytes);
  if (!detected || !IMAGE_ATTACHMENT_MIME_TYPES.includes(detected.mimeType)) {
    fail("UNSUPPORTED_IMAGE_TYPE", "Attach a PNG, JPEG, GIF or WebP image.", 415);
  }
  try {
    // Bun checks maxPixels after reading the header and before allocating pixels.
    // Keep the explicit metadata check too: dimensions are part of our stored contract.
    const image = new Bun.Image(bytes, { maxPixels: MAX_IMAGE_ATTACHMENT_PIXELS });
    const metadata = await image.metadata();
    const mimeType = `image/${metadata.format}`;
    if (mimeType !== detected.mimeType) fail("INVALID_IMAGE_DATA", "Image signature and decoded format disagree.", 422);
    const { width, height } = metadata;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) fail("INVALID_IMAGE_DATA", "Image dimensions are invalid.", 422);
    if (width > MAX_IMAGE_ATTACHMENT_PIXELS / height) fail("IMAGE_TOO_MANY_PIXELS", `Images may contain at most ${MAX_IMAGE_ATTACHMENT_PIXELS.toLocaleString("en-US")} pixels.`, 413);
    // This matches OMP's full decode probe. GIF uses Bun's first-frame contract.
    // The small output does not bypass input allocation limits or replace the original.
    await image.resize(1, 1).png().bytes();
    return Object.freeze({ sha256, bytes: bytes.byteLength, mimeType: detected.mimeType, width, height });
  } catch (error) {
    if (error instanceof AttachmentImageError) throw error;
    if (errno(error) === "ERR_IMAGE_TOO_MANY_PIXELS") fail("IMAGE_TOO_MANY_PIXELS", `Images may contain at most ${MAX_IMAGE_ATTACHMENT_PIXELS.toLocaleString("en-US")} pixels.`, 413);
    throw new AttachmentImageError("INVALID_IMAGE_DATA", "The image cannot be decoded by the owning host.", 422, { cause: error });
  }
}

/** Original image bytes only. Draft names, selections and native transcripts live elsewhere. */
export class ImageAttachmentStore {
  private readonly dataDirectory: string;
  private rootIdentity?: Stats;
  private rootPath?: string;

  constructor(dataDirectory: string) { this.dataDirectory = resolve(dataDirectory); }

  async putImage(expectedSha256: string, input: Uint8Array): Promise<Readonly<ImageAttachmentMetadata>> {
    validateHash(expectedSha256);
    if (!(input instanceof Uint8Array) || input.byteLength === 0) fail("INVALID_IMAGE_DATA", "The attached image is empty or is not binary data.", 422);
    if (input.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) fail("IMAGE_TOO_LARGE", "An image may contain at most 20 MiB of encoded data.", 413);
    // Bun.Image borrows its TypedArray. Copy before the first await, including Buffers.
    const bytes = Uint8Array.from(input);
    if (hashBytes(bytes) !== expectedSha256) fail("IMAGE_HASH_MISMATCH", "The uploaded image does not match its SHA-256 digest.", 400);
    const metadata = await validateImage(expectedSha256, bytes);
    const directories: Directory[] = [];
    let temporary: string | undefined;
    try {
      const directory = await this.openShard(expectedSha256, true, directories);
      const destination = join(directory.path, expectedSha256);
      await this.verifyDirectories(directories);
      // Never repair or replace a corrupt existing digest, even with correct input.
      try {
        await this.readStored(expectedSha256, destination);
        await this.verifyDirectories(directories);
        await this.syncPublished(directory);
        return metadata;
      } catch (error) { if (errno(error) !== "ENOENT") throw error; }

      temporary = join(directory.path, `.upload-${randomUUID()}`);
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      await this.verifyDirectories(directories);
      try { await link(temporary, destination); }
      catch (error) { if (errno(error) !== "EEXIST") throw error; }
      // Remove only this operation's private temporary link, never a competing file.
      await unlink(temporary);
      temporary = undefined;
      await this.syncPublished(directory);
      await this.readStored(expectedSha256, destination);
      await this.verifyDirectories(directories);
      return metadata;
    } catch (error) { throw storageError(error); }
    finally {
      if (temporary) await unlink(temporary).catch(() => undefined);
      await Promise.all(directories.map(directory => directory.handle.close()));
    }
  }

  async readImage(sha256: string): Promise<Uint8Array> {
    return (await this.readValidatedImage(sha256)).bytes;
  }

  async readValidatedImage(sha256: string): Promise<ValidatedImageAttachment> {
    validateHash(sha256);
    const directories: Directory[] = [];
    try {
      const directory = await this.openShard(sha256, false, directories);
      await this.verifyDirectories(directories);
      const bytes = await this.readStored(sha256, join(directory.path, sha256));
      // Verify native decodability after restart too; a digest is not a MIME assertion.
      let metadata: Readonly<ImageAttachmentMetadata>;
      try { metadata = await validateImage(sha256, bytes); }
      catch (error) { throw new AttachmentImageError("CORRUPT_IMAGE_STORAGE", "Stored image bytes are not an accepted, decodable image.", 409, { cause: error }); }
      await this.verifyDirectories(directories);
      // A read can reconcile a prior uncertain publication before admission.
      // Sync ancestors too; no caller needs a successful upload receipt in memory.
      for (const directory of [...directories].reverse()) await this.syncPublished(directory);
      return { metadata, bytes };
    } catch (error) { throw storageError(error); }
    finally { await Promise.all(directories.map(directory => directory.handle.close())); }
  }

  private async syncPublished(directory: Directory): Promise<void> {
    await this.syncExisting(directory.handle);
  }

  private async syncExisting(handle: FileHandle): Promise<void> {
    try { await handle.sync(); }
    catch (error) {
      // The complete bytes may already be visible. Do not delete them, claim a
      // durable receipt, or let the caller reference them until a retry succeeds.
      throw new AttachmentImageError("IMAGE_DURABILITY_UNCERTAIN", "The image exists, but durable publication could not be confirmed. Retry the same digest before using this attachment.", 503, { cause: error });
    }
  }

  private async openShard(sha256: string, create: boolean, directories: Directory[]): Promise<Directory> {
    const root = await lstat(this.dataDirectory);
    if (!root.isDirectory() || root.isSymbolicLink()) fail("UNSAFE_IMAGE_STORAGE", "The host data directory must be an actual directory.", 409);
    const canonical = await realpath(this.dataDirectory);
    if (this.rootIdentity && (!sameFile(root, this.rootIdentity) || canonical !== this.rootPath)) fail("UNSAFE_IMAGE_STORAGE", "The host data directory changed while image storage was open.", 409);
    this.rootIdentity ??= root;
    this.rootPath ??= canonical;
    let directory = await this.openDirectory(canonical, false);
    directories.push(directory);
    for (const name of ["attachments", "images", sha256.slice(0, 2)]) {
      await this.verifyDirectories(directories);
      const path = join(directory.path, name);
      if (create) {
        try { await mkdir(path, { mode: 0o700 }); }
        catch (error) { if (errno(error) !== "EEXIST") throw error; }
        // Also sync after EEXIST: another writer may just have created the directory.
        await directory.handle.sync();
      }
      directory = await this.openDirectory(path, true);
      directories.push(directory);
    }
    return directory;
  }

  private async openDirectory(path: string, privateDirectory: boolean): Promise<Directory> {
    const before = await lstat(path);
    if (!before.isDirectory() || before.isSymbolicLink()) fail("UNSAFE_IMAGE_STORAGE", "An image storage directory is a symlink or is not a directory.", 409);
    if (privateDirectory) validatePrivate(before, true);
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const identity = await handle.stat();
      if (!sameFile(before, identity)) fail("UNSAFE_IMAGE_STORAGE", "An image storage directory changed while opening it.", 409);
      return { path, handle, identity };
    } catch (error) { await handle.close(); throw error; }
  }

  private async verifyDirectories(directories: Directory[]): Promise<void> {
    const root = await lstat(this.dataDirectory);
    if (!root.isDirectory() || !this.rootIdentity || !sameFile(root, this.rootIdentity) || await realpath(this.dataDirectory) !== this.rootPath) fail("UNSAFE_IMAGE_STORAGE", "The host data directory changed during image storage.", 409);
    for (let index = 0; index < directories.length; index++) {
      const directory = directories[index]!;
      const now = await lstat(directory.path);
      if (!now.isDirectory() || !sameFile(now, directory.identity)) fail("UNSAFE_IMAGE_STORAGE", "An image storage directory changed during the operation.", 409);
      if (index > 0) validatePrivate(now, true);
    }
  }

  private async readStored(sha256: string, path: string): Promise<Uint8Array> {
    const before = await lstat(path);
    validatePrivate(before, false);
    if (before.size < 1 || before.size > MAX_IMAGE_ATTACHMENT_BYTES) fail("CORRUPT_IMAGE_STORAGE", "The stored image has an invalid encoded size.", 409);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      validatePrivate(opened, false);
      if (!sameRevision(before, opened)) fail("CORRUPT_IMAGE_STORAGE", "The stored image changed while opening it.", 409);
      // Fixed allocation and an extra-byte probe bound reads even if a file grows.
      const bytes = new Uint8Array(opened.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (result.bytesRead === 0) fail("CORRUPT_IMAGE_STORAGE", "The stored image was truncated while reading it.", 409);
        offset += result.bytesRead;
      }
      const extra = await handle.read(new Uint8Array(1), 0, 1, offset);
      const after = await handle.stat();
      const current = await lstat(path);
      validatePrivate(current, false);
      if (extra.bytesRead !== 0 || !sameRevision(opened, after) || !sameRevision(after, current) || !current.isFile()
        || hashBytes(bytes) !== sha256) fail("CORRUPT_IMAGE_STORAGE", "The stored image failed its integrity check.", 409);
      await this.syncExisting(handle);
      return bytes;
    } finally { await handle.close(); }
  }
}
