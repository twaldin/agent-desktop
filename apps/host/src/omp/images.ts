import { createHash } from "node:crypto";
import type { AgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { MAX_IMAGE_ATTACHMENT_BYTES, parseImageAttachments, type ImageAdmission, type ImageAttachmentRef } from "@agent-desktop/shared";

/** Private daemon-to-worker payload, never a command/event/cache representation. */
export interface PreparedPromptImage { attachment: ImageAttachmentRef; data: Uint8Array }
export interface OmpRecordedImage { data: Uint8Array; mimeType: string; bytes: number; sha256: string }
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** The owning store validates container, MIME, dimensions and decode before this boundary. */
export function copyPreparedImages(images: PreparedPromptImage[] | undefined): PreparedPromptImage[] | undefined {
  if (images === undefined) return undefined;
  if (!Array.isArray(images)) throw new Error("Invalid prepared image attachments");
  const attachments = parseImageAttachments(images.map(image => image?.attachment));
  return images.map((image, index) => {
    const attachment = attachments[index]!;
    if (!(image.data instanceof Uint8Array) || image.data.byteLength !== attachment.bytes) throw new Error("Prepared image byte count does not match its attachment");
    const data = new Uint8Array(image.data);
    if (sha256(data) !== attachment.sha256) throw new Error("Prepared image hash does not match its attachment");
    return { attachment, data };
  });
}

export function readNativeImage(value: unknown): OmpRecordedImage {
  const image = value as Partial<ImageContent> | undefined;
  if (!image || image.type !== "image" || typeof image.data !== "string" || typeof image.mimeType !== "string"
    || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.mimeType)) throw new Error("Native image bytes are unavailable or have an unsupported format");
  // A missing native blob remains a native reference, never a path this API opens.
  if (image.data.length > Math.ceil(MAX_IMAGE_ATTACHMENT_BYTES / 3) * 4) throw new Error("Recorded image exceeds the 20 MiB retrieval limit");
  const data = Buffer.from(image.data, "base64");
  if (!data.length || data.byteLength > MAX_IMAGE_ATTACHMENT_BYTES || data.toString("base64") !== image.data) throw new Error("Native image bytes are unavailable or invalid");
  return { data: new Uint8Array(data), mimeType: image.mimeType, bytes: data.byteLength, sha256: sha256(data) };
}

export function assertNativeImageModel(session: AgentSession): void {
  if (!session.model?.input.includes("image")) throw new Error("The selected native model does not accept images");
  if (session.settings.get("images.blockImages")) throw new Error("Images are blocked by this session's native settings");
}

type NativeMessage = Parameters<SessionManager["appendMessage"]>[0];
/** One submission's actual normalized message, observed before the native agent runs. */
export class NativeImagePrompt {
  readonly images: ImageContent[];
  #expected?: Array<Omit<OmpRecordedImage, "data">>;
  #message?: NativeMessage;
  #model?: string;
  #receipt?: ImageAdmission[];
  #restore?: () => void;
  get dispatched(): boolean { return this.#message !== undefined; }

  constructor(private prepared: PreparedPromptImage[], private text: string) {
    this.images = prepared.map(image => ({ type: "image", data: Buffer.from(image.data).toString("base64"), mimeType: image.attachment.mimeType }));
  }

  async prepareQueue(session: AgentSession): Promise<void> {
    if (this.text.trimStart().startsWith("/")) throw new Error("Image attachments are not supported on slash commands yet; no command was executed");
    if (this.text.length > 500_000) throw new Error("Image prompt text exceeds the native durable-history limit");
    assertNativeImageModel(session);
    this.#model = JSON.stringify([session.model!.provider, session.model!.id]);
    const { normalizeModelContextImages } = await import("@oh-my-pi/pi-coding-agent/utils/image-loading");
    // Independent expected slots use the exact pinned native normalizer. Supply
    // original bytes to prompt(), avoiding a second normalization of lossy output.
    const expected = await normalizeModelContextImages(this.images, { model: session.model });
    if (expected?.length !== this.prepared.length) throw new Error("Native image normalization did not preserve every image");
    this.#expected = expected.map(value => { const { data: _data, ...metadata } = readNativeImage(value); return metadata; });
  }

  /** Attribute the exact user object emitted by native steer/followUp. */
  acceptQueued(session: AgentSession, message: NativeMessage): void {
    assertNativeImageModel(session);
    if (JSON.stringify([session.model!.provider, session.model!.id]) !== this.#model)
      throw new Error("Native preflight changed the image model; this message was not queued");
    this.#receipt = this.#verify(message);
    this.#message = message;
  }

  async prepare(session: AgentSession, manager: SessionManager): Promise<void> {
    await this.prepareQueue(session);
    const { sessionMessagePersistenceKey, sameMessageContent } = await import("@oh-my-pi/pi-coding-agent/session/turn-persistence");
    const agent = session.agent, original = agent.prompt;
    const wrapper = (async (...args: Parameters<typeof original>) => {
      if (!this.#message) {
        assertNativeImageModel(session);
        if (JSON.stringify([session.model!.provider, session.model!.id]) !== this.#model) throw new Error("Native preflight changed the image model; this prompt was not dispatched");
        const payload = args[0];
        const messages = (Array.isArray(payload) ? payload : [payload]) as NativeMessage[];
        const candidates = messages.filter(message => message?.role === "user");
        if (candidates.length !== 1) throw new Error("Native image prompt did not produce one attributable user message");
        const message = candidates[0]!;
        this.#receipt = this.#verify(message);
        const key = sessionMessagePersistenceKey(message);
        if (key && [...agent.state.messages, ...manager.getBranch().flatMap(entry => entry.type === "message" ? [entry.message] : [])]
          .some(item => sessionMessagePersistenceKey(item) === key && sameMessageContent(item, message))) throw new Error("Native image prompt identity collides with existing history; this prompt was not dispatched");
        this.#message = message;
      }
      return original.apply(agent, args);
    }) as typeof original;
    agent.prompt = wrapper;
    this.#restore = () => { if (agent.prompt === wrapper) agent.prompt = original; };
  }

  matches(message: unknown): boolean { return this.#message !== undefined && message === this.#message; }
  receipt(): ImageAdmission[] {
    if (!this.#message || !this.#receipt) throw new Error("Native image submission identity was not observed");
    // Extensions/persistence must not mutate the already attributed image content.
    return this.#verify(this.#message);
  }
  close(): void { this.#restore?.(); this.#restore = undefined; }

  #verify(message: NativeMessage): ImageAdmission[] {
    if (message.role !== "user" || !Array.isArray(message.content) || message.content.length !== this.prepared.length + 1
      || message.content[0]?.type !== "text" || message.content[0].text !== this.text) throw new Error("Native preprocessing changed the image prompt content");
    return this.prepared.map((prepared, index) => {
      const blockIndex = index + 1, image = readNativeImage(message.content[blockIndex]), expected = this.#expected?.[index];
      if (!expected || image.sha256 !== expected.sha256 || image.mimeType !== expected.mimeType) throw new Error("Native preprocessing changed image order or content");
      return { attachmentId: prepared.attachment.id, blockIndex, sourceSha256: prepared.attachment.sha256,
        nativeSha256: image.sha256, mimeType: image.mimeType, bytes: image.bytes };
    });
  }
}
