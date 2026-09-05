import { MAX_IMAGE_ATTACHMENT_BYTES, MAX_IMAGE_ATTACHMENT_BATCH_BYTES, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_ATTACHMENT_PIXELS, parseImageAttachments, type CommandEnvelope, type CommandResult, type DesktopBridge, type Draft, type ImageAttachmentCapabilities, type ImageAttachmentRef, type OmpComposerCatalog, type OmpSessionControls, type SessionSummary, type UploadedImageMetadata } from "@agent-desktop/shared";
import type { AttachmentCache } from "./attachment-cache";
import { type DraftController } from "./drafts";
import { loadAttachmentMedia, type AttachmentMediaContext } from "./attachment-media";
import { composerModelKey, composerSelection } from "./composer-catalog";

export interface StagedImage { id: string; name: string; status: "checking" | "caching" | "error"; error?: string }
type Capabilities = ImageAttachmentCapabilities | undefined;
export function imageCapabilityIssue(capabilities: Capabilities) {
  return capabilities?.protocolVersion === 1 && capabilities.commandVersion === 3
    && [capabilities.maxImages, capabilities.maxImageBytes, capabilities.maxBatchBytes, capabilities.maxImagePixels].every(value => Number.isSafeInteger(value) && value > 0)
    && Array.isArray(capabilities.mimeTypes) && capabilities.mimeTypes.length > 0 ? undefined : "Images are unavailable on this host. Update the owning host to enable attachments.";
}
function limits(capabilities: ImageAttachmentCapabilities) {
  return { count: Math.min(MAX_IMAGE_ATTACHMENTS, capabilities.maxImages), bytes: Math.min(MAX_IMAGE_ATTACHMENT_BYTES, capabilities.maxImageBytes), batch: Math.min(MAX_IMAGE_ATTACHMENT_BATCH_BYTES, capabilities.maxBatchBytes), pixels: Math.min(MAX_IMAGE_ATTACHMENT_PIXELS, capabilities.maxImagePixels) };
}
export function imageSendIssue(draft: Draft, running: boolean, capabilities: Capabilities, catalog?: OmpComposerCatalog, session?: SessionSummary | null, controls?: OmpSessionControls) {
  if (!draft.attachments?.length) return undefined;
  if (imageCapabilityIssue(capabilities)) return imageCapabilityIssue(capabilities);
  if (running) return "Images cannot steer a running response. Your draft is retained; wait for it to finish.";
  if (draft.text.trimStart().startsWith("/")) return "Slash commands cannot include images. Your draft is retained; remove the images or use an ordinary prompt.";
  if (controls?.settings.find(setting => setting.path === "images.blockImages")?.effective === true) return "Images are blocked by this session’s native settings. Your draft is retained.";
  const selected = composerSelection(draft, catalog, session, controls);
  const native = controls?.capabilities && composerModelKey(controls.model) === composerModelKey(selected.model) ? controls.capabilities : undefined;
  const input = native?.input ?? selected.entry?.input;
  if (input && !input.includes("image")) return "The selected native model does not accept images. Choose an image-capable model; your draft is retained.";
  return undefined;
}

/** Bounded header inspection precedes browser decode. EXIF can swap display axes. */
export async function decodeComposerImage(bytes: Uint8Array, metadata: UploadedImageMetadata, maximumPixels: number) {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: metadata.mimeType }));
  try { if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > maximumPixels) throw new Error("Decoded image exceeds the pixel limit."); }
  finally { bitmap.close(); }
}

/** One mounted owning host/draft. Async completion can append only to this captured target. */
export class AttachmentComposer {
  readonly staging: StagedImage[] = [];
  error?: string;
  #active = true;
  #queue: Promise<void> = Promise.resolve();
  #files = new Map<string, { file: File; capabilities: ImageAttachmentCapabilities }>();
  #listeners = new Set<() => void>();
  constructor(readonly hostId: string, readonly draftId: string, private drafts: Pick<DraftController, "get" | "update">, private cache: AttachmentCache,
    private inspect: (bytes: Uint8Array) => Promise<UploadedImageMetadata>, private decode = decodeComposerImage) {}
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #notify() { for (const listener of this.#listeners) listener(); }
  #current(id: string) { return this.#active && this.#files.has(id); }
  add(files: readonly File[], capabilities: Capabilities): Promise<void> {
    if (!this.#active) return Promise.resolve();
    this.error = undefined;
    const unavailable = imageCapabilityIssue(capabilities);
    if (unavailable) { this.error = unavailable; this.#notify(); return Promise.resolve(); }
    const bounded = limits(capabilities!);
    const existing = this.drafts.get(this.draftId).draft.attachments ?? [];
    const pending = this.staging; // Failed files remain in memory until Retry/Remove, so they still reserve limits.
    if (!files.length) return Promise.resolve();
    if (files.length + existing.length + pending.length > bounded.count) { this.error = `Attach up to ${bounded.count} images per prompt.`; this.#notify(); return Promise.resolve(); }
    if (files.some(file => !file.size || file.size > bounded.bytes)) { this.error = `Each image must contain bytes and fit within ${Math.floor(bounded.bytes / 1024 / 1024)} MiB.`; this.#notify(); return Promise.resolve(); }
    const pendingBytes = pending.reduce((sum, item) => sum + (this.#files.get(item.id)?.file.size ?? 0), 0);
    if (files.reduce((sum, file) => sum + file.size, pendingBytes + existing.reduce((sum, item) => sum + item.bytes, 0)) > bounded.batch) { this.error = `Images must fit within ${Math.floor(bounded.batch / 1024 / 1024)} MiB total.`; this.#notify(); return Promise.resolve(); }
    for (const file of [...files]) {
      const item: StagedImage = { id: crypto.randomUUID(), name: file.name || "Pasted image", status: "checking" };
      this.staging.push(item); this.#files.set(item.id, { file, capabilities: structuredClone(capabilities!) });
      this.#queue = this.#queue.then(() => this.#stage(item));
    }
    this.#notify(); return this.#queue;
  }
  async #stage(item: StagedImage) {
    if (!this.#current(item.id)) return;
    const { file, capabilities } = this.#files.get(item.id)!;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!this.#current(item.id)) return;
      const metadata = { ...await this.inspect(bytes) }, bounded = limits(capabilities);
      if (metadata.bytes !== bytes.byteLength || metadata.bytes > bounded.bytes || !metadata.width || !metadata.height || metadata.width * metadata.height > bounded.pixels || !capabilities.mimeTypes.includes(metadata.mimeType)) throw new Error("This image exceeds the host’s supported size, dimensions, or image types.");
      const attachment = parseImageAttachments([{ id: item.id, hostId: this.hostId, kind: "image", sha256: metadata.sha256, name: item.name, bytes: metadata.bytes, mimeType: metadata.mimeType }], this.hostId)[0]!;
      if (!this.#current(item.id)) return;
      await this.decode(bytes, metadata, bounded.pixels);
      if (!this.#current(item.id)) return;
      item.status = "caching"; this.#notify();
      await this.cache.put({ hostId: this.hostId, sha256: attachment.sha256 }, bytes);
      if (!this.#current(item.id)) return;
      const current = this.drafts.get(this.draftId).draft.attachments ?? [];
      if (current.length >= bounded.count || current.reduce((sum, value) => sum + value.bytes, attachment.bytes) > bounded.batch) throw new Error("The draft changed while this image was being added. Remove an image before retrying.");
      this.drafts.update(this.draftId, { attachments: [...current, attachment] });
      this.#forgetStaged(item.id);
    } catch (cause) {
      if (this.#current(item.id)) { item.status = "error"; item.error = cause instanceof Error ? cause.message : "Image could not be attached."; this.#notify(); }
    }
  }
  #forgetStaged(id: string) { this.#files.delete(id); const index = this.staging.findIndex(item => item.id === id); if (index >= 0) this.staging.splice(index, 1); this.#notify(); }
  removeStaged(id: string) { this.#forgetStaged(id); if (this.drafts.get(this.draftId).draft.attachments?.some(item => item.id === id)) this.remove(id); }
  start() { this.#active = true; }
  retry(id: string): Promise<void> { const item = this.staging.find(value => value.id === id); if (!item || item.status !== "error" || !this.#active) return Promise.resolve(); item.status = "checking"; item.error = undefined; this.#notify(); this.#queue = this.#queue.then(() => this.#stage(item)); return this.#queue; }
  remove(id: string) { const draft = this.drafts.get(this.draftId).draft; this.drafts.update(this.draftId, { attachments: (draft.attachments ?? []).filter(item => item.id !== id) }); }
  move(id: string, offset: -1 | 1) { const refs = [...(this.drafts.get(this.draftId).draft.attachments ?? [])], index = refs.findIndex(item => item.id === id), next = index + offset; if (index < 0 || next < 0 || next >= refs.length) return; [refs[index], refs[next]] = [refs[next]!, refs[index]!]; this.drafts.update(this.draftId, { attachments: refs }); }
  dispose() { this.#active = false; this.#files.clear(); this.#listeners.clear(); }
}

/** Capture first: a delayed upload must never read a subsequently edited manifest. */
export function attachmentDraftSender(hostId: string, media: AttachmentMediaContext, bridge: Pick<DesktopBridge, "uploadImageAttachment" | "command">) {
  // An advisory, bounded upload receipt cache avoids resending bytes on every
  // text edit. Every draft.put still reaches authoritative host validation.
  const confirmed = new Set<string>();
  return async (input: CommandEnvelope): Promise<CommandResult> => {
    const envelope = structuredClone(input);
    if (envelope.command.type === "draft.put" && envelope.command.draft.attachments !== undefined) {
      const refs = parseImageAttachments(envelope.command.draft.attachments, hostId);
      if (refs.length && !bridge.uploadImageAttachment) throw new Error("Update this desktop to upload images. Your draft is retained.");
      for (const attachment of refs) {
        const key = `${attachment.sha256}:${attachment.bytes}:${attachment.mimeType}`;
        if (confirmed.has(key)) continue;
        const image = await loadAttachmentMedia(media, { kind: "attachment", attachment }, hostId, true);
        const result = await bridge.uploadImageAttachment!(attachment.sha256, new Uint8Array(await image.blob.arrayBuffer()), hostId);
        if (result.sha256 !== attachment.sha256 || result.bytes !== attachment.bytes || result.mimeType !== attachment.mimeType) throw new Error("The uploaded image did not match the captured draft.");
        confirmed.add(key); if (confirmed.size > 64) confirmed.delete(confirmed.values().next().value!);
      }
    }
    try { const result = await bridge.command(envelope, hostId); if (!result.ok) confirmed.clear(); return result; }
    catch (cause) { confirmed.clear(); throw cause; }
  };
}
