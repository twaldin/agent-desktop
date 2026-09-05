import { createHash } from "node:crypto";
import { IMAGE_ATTACHMENT_MIME_TYPES, IMAGE_ATTACHMENT_OWNER_HEADER, MAX_IMAGE_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENT_BATCH_BYTES, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_PIXELS,
  type ImageAttachmentCapabilities, type ImageAttachmentMimeType, type UploadedImageMetadata, type RecordedImageBytes } from "@agent-desktop/shared";
import { HostRequestError, requestHost, type HostEndpoint } from "./host-transport";
import { parseImageMetadata } from "@oh-my-pi/pi-utils/mime";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const headersFor = (endpoint: HostEndpoint): Record<string, string> => ({ ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}), [IMAGE_ATTACHMENT_OWNER_HEADER]: endpoint.hostId });
function digest(value: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid image digest.");
  return value;
}
function id(value: string): string {
  if (typeof value !== "string" || !value.length || value.length > 200 || value.includes("\0")) throw new Error("Invalid image owner or native identity.");
  return encodeURIComponent(value);
}
function imageMime(value: unknown): value is ImageAttachmentMimeType { return IMAGE_ATTACHMENT_MIME_TYPES.includes(value as ImageAttachmentMimeType); }
const positive = (value: unknown, maximum: number): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;

const IMAGE_DOWNLOAD_DEADLINE_MS = 60_000;
const MAX_WAITING_IMAGE_DOWNLOADS = 32;
interface ImageDownloadQueue { active: number; waiting: Array<() => void> }
const imageDownloadQueues = new Map<string, ImageDownloadQueue>();

/** Queue only immutable identities, before fetching or allocating an image body.
 * Different desktops still contend for the owning host's two operation slots. */
function scheduleImageDownload(endpoint: HostEndpoint, operation: (signal: AbortSignal) => Promise<RecordedImageBytes>): Promise<RecordedImageBytes> {
  const key = JSON.stringify([endpoint.hostId, endpoint.origin]);
  const queue = imageDownloadQueues.get(key) ?? { active: 0, waiting: [] };
  if (queue.active >= 2 && queue.waiting.length >= MAX_WAITING_IMAGE_DOWNLOADS) return Promise.reject(new Error("Too many image previews are waiting on this host. Retry this image after other previews load."));
  imageDownloadQueues.set(key, queue);
  // This same deadline includes queueing, contention retries, and reading bytes.
  const signal = AbortSignal.timeout(IMAGE_DOWNLOAD_DEADLINE_MS);
  return new Promise((resolve, reject) => {
    const forgetEmptyQueue = () => { if (!queue.active && !queue.waiting.length && imageDownloadQueues.get(key) === queue) imageDownloadQueues.delete(key); };
    const expired = () => {
      const index = queue.waiting.indexOf(start);
      if (index >= 0) queue.waiting.splice(index, 1);
      reject(signal.reason); forgetEmptyQueue();
    };
    const start = () => {
      signal.removeEventListener("abort", expired);
      if (signal.aborted) { reject(signal.reason); forgetEmptyQueue(); return; }
      queue.active++;
      void operation(signal).then(resolve, reject).finally(() => {
        queue.active--;
        while (queue.active < 2 && queue.waiting.length) queue.waiting.shift()!();
        forgetEmptyQueue();
      });
    };
    if (queue.active < 2) start();
    else { queue.waiting.push(start); signal.addEventListener("abort", expired, { once: true }); }
  });
}

function waitForImageSlot(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delayMs);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Stateless local header inspection permits bounded decoding before offline caching.
 * This is not a host upload receipt or a proof that compressed pixels decode. */
export function inspectImageAttachment(input: Uint8Array): UploadedImageMetadata {
  if (!(input instanceof Uint8Array) || !positive(input.byteLength, MAX_IMAGE_ATTACHMENT_BYTES)) throw new Error("An image must contain between 1 byte and 20 MiB.");
  const bytes = Uint8Array.from(input), metadata = parseImageMetadata(bytes);
  if (!metadata || !imageMime(metadata.mimeType) || !positive(metadata.width, MAX_IMAGE_ATTACHMENT_PIXELS)
    || !positive(metadata.height, MAX_IMAGE_ATTACHMENT_PIXELS) || metadata.width > MAX_IMAGE_ATTACHMENT_PIXELS / metadata.height) throw new Error("Attach a PNG, JPEG, GIF or WebP image with at most 16,777,216 pixels.");
  return { sha256: hash(bytes), bytes: bytes.length, mimeType: metadata.mimeType, width: metadata.width, height: metadata.height };
}

export async function requestImageAttachmentCapabilities(endpoint: HostEndpoint): Promise<ImageAttachmentCapabilities | null> {
  let value: ImageAttachmentCapabilities;
  try { value = await requestHost(endpoint, "/v1/attachments/capabilities") as ImageAttachmentCapabilities; }
  catch (error) {
    if (error instanceof HostRequestError && error.status === 404 && !error.code) return null;
    throw error;
  }
  if (!value || value.protocolVersion !== 1 || value.commandVersion !== 3 || !positive(value.maxImages, MAX_IMAGE_ATTACHMENTS)
    || !positive(value.maxImageBytes, MAX_IMAGE_ATTACHMENT_BYTES) || !positive(value.maxBatchBytes, MAX_IMAGE_ATTACHMENT_BATCH_BYTES)
    || !positive(value.maxImagePixels, MAX_IMAGE_ATTACHMENT_PIXELS) || !Array.isArray(value.mimeTypes) || !value.mimeTypes.length || !value.mimeTypes.every(imageMime)) throw new Error("The host returned unsupported image capabilities.");
  return { protocolVersion: 1, commandVersion: 3, maxImages: value.maxImages, maxImageBytes: value.maxImageBytes,
    maxBatchBytes: value.maxBatchBytes, maxImagePixels: value.maxImagePixels, mimeTypes: [...value.mimeTypes] };
}

/** Binary bodies stay outside JSON command/event caches and credentials stay here. */
export async function uploadImageAttachment(endpoint: HostEndpoint, sha256: string, input: Uint8Array): Promise<UploadedImageMetadata> {
  digest(sha256);
  if (!(input instanceof Uint8Array) || !positive(input.byteLength, MAX_IMAGE_ATTACHMENT_BYTES)) throw new Error("An image must contain between 1 byte and 20 MiB.");
  const bytes = Uint8Array.from(input);
  if (hash(bytes) !== sha256) throw new Error("The image bytes do not match their captured digest.");
  const response = await fetch(`${endpoint.origin}/v1/attachments/images/${sha256}`, { method: "PUT", headers: { ...headersFor(endpoint), "Content-Type": "application/octet-stream" },
    body: bytes.buffer, redirect: "error", signal: AbortSignal.timeout(60_000) });
  await requireSuccess(response);
  requireImageOwner(response, endpoint);
  const value = await readJSON(response) as UploadedImageMetadata;
  if (!value || value.sha256 !== sha256 || value.bytes !== bytes.length || !imageMime(value.mimeType) || !positive(value.width, MAX_IMAGE_ATTACHMENT_PIXELS)
    || !positive(value.height, MAX_IMAGE_ATTACHMENT_PIXELS) || value.width > MAX_IMAGE_ATTACHMENT_PIXELS / value.height) throw new Error("The host returned invalid image metadata.");
  return { sha256, bytes: value.bytes, mimeType: value.mimeType, width: value.width, height: value.height };
}

export async function requestImageAttachment(endpoint: HostEndpoint, sha256: string): Promise<RecordedImageBytes> {
  return requestImage(endpoint, `/v1/attachments/images/${digest(sha256)}`, sha256);
}
export async function requestTranscriptImage(endpoint: HostEndpoint, sessionId: string, nativeEntryId: string, blockIndex: number): Promise<RecordedImageBytes> {
  if (!Number.isSafeInteger(blockIndex) || blockIndex < 0) throw new Error("Invalid image block index.");
  return requestImage(endpoint, `/v1/sessions/${id(sessionId)}/images/${id(nativeEntryId)}/${blockIndex}`);
}
async function requestImage(endpoint: HostEndpoint, path: string, expectedHash?: string): Promise<RecordedImageBytes> {
  return scheduleImageDownload(endpoint, async signal => {
    let delayMs = 150;
    while (true) {
      signal.throwIfAborted();
      try { return await requestImageAttempt(endpoint, path, signal, expectedHash); }
      catch (error) {
        // Only the host's explicit contention response is retryable. Commands,
        // authentication, missing images, and uncertain failures are never replayed.
        if (!(error instanceof HostRequestError) || error.status !== 429 || error.code !== "IMAGE_TRANSFER_BUSY") throw error;
        await waitForImageSlot(delayMs, signal);
        delayMs = Math.min(delayMs * 2, 1000);
      }
    }
  });
}
async function requestImageAttempt(endpoint: HostEndpoint, path: string, signal: AbortSignal, expectedHash?: string): Promise<RecordedImageBytes> {
  const response = await fetch(`${endpoint.origin}${path}`, { headers: headersFor(endpoint), redirect: "error", signal });
  await requireSuccess(response);
  requireImageOwner(response, endpoint);
  const mimeType = response.headers.get("content-type"), sha256 = response.headers.get("x-image-sha256"), length = response.headers.get("content-length");
  const bytes = Number(length);
  if (!imageMime(mimeType) || !sha256 || !/^[a-f0-9]{64}$/.test(sha256) || (expectedHash !== undefined && sha256 !== expectedHash)
    || !length || !/^[0-9]+$/.test(length) || !positive(bytes, MAX_IMAGE_ATTACHMENT_BYTES) || response.headers.has("content-encoding")) {
    void response.body?.cancel(); throw new Error("The host returned invalid image headers.");
  }
  const data = await readBounded(response, bytes);
  if (data.length !== bytes || hash(data) !== sha256) throw new Error("The downloaded image does not match its recorded digest.");
  return { data, sha256, bytes, mimeType };
}
async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new Error("The host returned an empty response.");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      if (total > limit) throw new Error("The host response exceeds its byte limit.");
      chunks.push(Uint8Array.from(next.value));
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function readJSON(response: Response): Promise<unknown> { return JSON.parse(new TextDecoder().decode(await readBounded(response, 64 * 1024))); }
function requireImageOwner(response: Response, endpoint: HostEndpoint): void {
  if (response.headers.get(IMAGE_ATTACHMENT_OWNER_HEADER) !== endpoint.hostId) {
    void response.body?.cancel().catch(() => {});
    throw new HostRequestError("The image response belongs to a different host. Reload the host catalog before retrying.", 409, "OWNER_MISMATCH");
  }
}
async function requireSuccess(response: Response): Promise<void> {
  if (response.ok) return;
  const value = await readJSON(response) as { code?: string; error?: string | { code?: string; message?: string } };
  const nested = typeof value?.error === "object" ? value.error : undefined;
  throw new HostRequestError(typeof value?.error === "string" ? value.error : nested?.message ?? `Image request failed (${response.status}).`, response.status, value?.code ?? nested?.code);
}
