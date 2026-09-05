import { IMAGE_ATTACHMENT_MIME_TYPES, IMAGE_ATTACHMENT_OWNER_HEADER, MAX_IMAGE_ATTACHMENT_BATCH_BYTES, MAX_IMAGE_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENTS,
  parseImageAttachments, type ImageAttachmentCapabilities } from "@agent-desktop/shared";
import { AttachmentImageError, ImageAttachmentStore, MAX_IMAGE_ATTACHMENT_PIXELS } from "./attachments";
import type { OmpRecordedImage, PreparedPromptImage } from "./omp/images";

export class AttachmentRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
const fail = (code: string, message: string, status = 400): never => { throw new AttachmentRequestError(code, message, status); };
const privateHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/** Auth is the server's existing privileged local / verified tailnet boundary. */
export class ImageAttachmentsHttp {
  readonly store: ImageAttachmentStore;
  readonly capabilities: ImageAttachmentCapabilities = Object.freeze({ protocolVersion: 1, commandVersion: 3,
    maxImages: MAX_IMAGE_ATTACHMENTS, maxImageBytes: MAX_IMAGE_ATTACHMENT_BYTES, maxBatchBytes: MAX_IMAGE_ATTACHMENT_BATCH_BYTES,
    maxImagePixels: MAX_IMAGE_ATTACHMENT_PIXELS, mimeTypes: IMAGE_ATTACHMENT_MIME_TYPES });
  #active = 0;
  constructor(private options: { dataDirectory: string; hostId: string;
    getNativeImage: (sessionId: string, nativeEntryId: string, blockIndex: number) => Promise<OmpRecordedImage>;
    readTimeoutMs?: number }) { this.store = new ImageAttachmentStore(options.dataDirectory); }

  /** Hold the same bound through native preparation/admission, not just disk reads. */
  async withPrepared<T>(input: unknown, operation: (images: PreparedPromptImage[]) => Promise<T>): Promise<T> {
    const references = parseImageAttachments(input, this.options.hostId);
    if (!references.length) return operation([]);
    return this.#bounded(async () => {
      const images: PreparedPromptImage[] = [];
      for (const attachment of references) {
        const stored = await this.store.readValidatedImage(attachment.sha256);
        if (stored.metadata.bytes !== attachment.bytes || stored.metadata.mimeType !== attachment.mimeType) {
          fail("IMAGE_METADATA_MISMATCH", "The image metadata does not match the owning host's bytes.", 409);
        }
        images.push({ attachment, data: stored.bytes });
      }
      return operation(images);
    });
  }

  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/attachments/capabilities") return Response.json(this.capabilities, { headers: privateHeaders });
    const original = /^\/v1\/attachments\/images\/([^/]+)$/.exec(url.pathname);
    const native = /^\/v1\/sessions\/([^/]+)\/images\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!original && !native) return undefined;
    try {
      if (request.headers.get(IMAGE_ATTACHMENT_OWNER_HEADER) !== this.options.hostId) fail("OWNER_MISMATCH", "The image's owning host changed or was not specified. Reload the host catalog before retrying.", 409);
      return await this.#bounded(async () => {
        if (original) {
          const hash = original[1]!;
          if (!/^[a-f0-9]{64}$/.test(hash)) fail("INVALID_IMAGE_HASH", "An image requires a lowercase SHA-256 digest.");
          if (request.method === "PUT") {
            if (request.headers.has("content-encoding")) fail("IMAGE_ENCODING_UNSUPPORTED", "Upload the original unencoded image bytes.", 415);
            const bytes = await readImageBody(request, this.options.readTimeoutMs ?? 30_000);
            return Response.json(await this.store.putImage(hash, bytes), { headers: { ...privateHeaders, [IMAGE_ATTACHMENT_OWNER_HEADER]: this.options.hostId } });
          }
          if (request.method === "GET") {
            const image = await this.store.readValidatedImage(hash);
            return imageResponse({ data: image.bytes, ...image.metadata }, this.options.hostId);
          }
        } else if (native && request.method === "GET") {
          const sessionId = decodeURIComponent(native[1]!), entryId = decodeURIComponent(native[2]!);
          if (!/^[0-9]+$/.test(native[3]!)) fail("INVALID_IMAGE_BLOCK", "Invalid native image block index.");
          const blockIndex = Number(native[3]);
          if (!sessionId || sessionId.length > 200 || !entryId || entryId.length > 200 || !Number.isSafeInteger(blockIndex)) fail("INVALID_IMAGE_BLOCK", "Invalid native image identity.");
          const image = await this.options.getNativeImage(sessionId, entryId, blockIndex);
          return imageResponse(image, this.options.hostId);
        }
        return Response.json({ code: "METHOD_NOT_ALLOWED", error: "This image operation is not supported." }, { status: 405, headers: privateHeaders });
      });
    } catch (error) {
      if (error instanceof AttachmentImageError || error instanceof AttachmentRequestError) return Response.json({ code: error.code, error: error.message }, { status: error.status, headers: privateHeaders });
      throw error;
    }
  }

  async #bounded<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= 2) fail("IMAGE_TRANSFER_BUSY", "Two image operations are already in progress on this host. Retry shortly.", 429);
    this.#active++;
    try { return await operation(); } finally { this.#active--; }
  }
}

function imageResponse(image: OmpRecordedImage, hostId: string): Response {
  if (!(image.data instanceof Uint8Array) || image.data.length !== image.bytes || image.bytes <= 0 || image.bytes > MAX_IMAGE_ATTACHMENT_BYTES
    || !IMAGE_ATTACHMENT_MIME_TYPES.includes(image.mimeType as typeof IMAGE_ATTACHMENT_MIME_TYPES[number]) || !/^[a-f0-9]{64}$/.test(image.sha256)) fail("INVALID_RECORDED_IMAGE", "The recorded native image is unavailable.", 422);
  return new Response(Uint8Array.from(image.data).buffer, { headers: { ...privateHeaders, [IMAGE_ATTACHMENT_OWNER_HEADER]: hostId, "Content-Type": image.mimeType,
    "Content-Length": String(image.bytes), "X-Image-Sha256": image.sha256 } });
}

async function readImageBody(request: Request, timeoutMs: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_IMAGE_ATTACHMENT_BYTES)) fail("IMAGE_TOO_LARGE", "An image may contain at most 20 MiB of encoded data.", 413);
  if (!request.body) fail("INVALID_IMAGE_DATA", "The attached image is empty.", 422);
  const reader = request.body!.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let total = 0;
  const chunks: Uint8Array[] = [];
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new AttachmentRequestError("IMAGE_UPLOAD_TIMEOUT", "The image upload timed out. Retry the same image.", 408)), timeoutMs); });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_IMAGE_ATTACHMENT_BYTES) fail("IMAGE_TOO_LARGE", "An image may contain at most 20 MiB of encoded data.", 413);
      chunks.push(Uint8Array.from(next.value));
    }
    if (length !== null && total !== Number(length)) fail("IMAGE_LENGTH_MISMATCH", "The uploaded image length does not match its declared length.");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    clearTimeout(timer);
    // Cancellation must not hold the decoder slot indefinitely on a broken stream.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
