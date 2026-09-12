import { useImperativeHandle, useRef, type Ref } from "react";
import type { ImageAttachmentCapabilities, ImageAttachmentRef } from "@agent-desktop/shared";
import { AttachmentComposer, imageCapabilityIssue } from "./attachment-composer";
import { ImagePreview } from "./ImagePreview";
import { Icon } from "./Icons";
import { formatImageBytes, type AttachmentMediaContext } from "./attachment-media";
import "./attachments.css";

export interface ComposerImagesHandle { addPhotos(): void }

export function ComposerImages({ controller, attachments, media, hostId, connected, capabilities, disabled = false, commandRef }: {
  controller: AttachmentComposer; attachments?: ImageAttachmentRef[]; media: AttachmentMediaContext; hostId: string;
  connected: boolean; capabilities?: ImageAttachmentCapabilities; disabled?: boolean;
  commandRef?: Ref<ComposerImagesHandle>;
}) {
  const picker = useRef<HTMLInputElement>(null), add = useRef<HTMLButtonElement>(null);
  const unavailable = imageCapabilityIssue(capabilities);
  useImperativeHandle(commandRef, () => ({ addPhotos() {
    if (!disabled && !unavailable && picker.current?.isConnected) picker.current.click();
  } }), [disabled, unavailable, controller]);
  function focusAfterRemove(index: number) { requestAnimationFrame(() => { const chips = add.current?.parentElement?.querySelectorAll<HTMLElement>(".composer-image-chip"); (chips?.[Math.min(index, chips.length - 1)] ?? add.current)?.focus(); }); }
  return <div className="composer-images">
    <button ref={add} type="button" className="attach-image-button" aria-label="Add images" disabled={disabled || Boolean(unavailable)} title={unavailable ?? "Attach PNG, JPEG, GIF, or WebP images"} onClick={() => picker.current?.click()}><Icon name="plus"/></button>
    <input ref={picker} type="file" accept={capabilities?.mimeTypes.join(",") ?? "image/png,image/jpeg,image/gif,image/webp"} multiple hidden aria-label="Choose images" onChange={event => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; if (!disabled) void controller.add(files, capabilities); }}/>
    {(attachments?.length || controller.staging.length) ? <ol className="composer-image-list" aria-label="Attached images">
      {(attachments ?? []).map((attachment, index) => <li className="composer-image-chip" key={attachment.id} tabIndex={0} title={`${attachment.name} · ${formatImageBytes(attachment.bytes)} · Alt Left/Right to reorder`} aria-label={`${attachment.name}, image ${index + 1} of ${attachments!.length}`} onKeyDown={event => {
        if (event.target !== event.currentTarget || event.nativeEvent.isComposing || event.defaultPrevented || disabled) return;
        if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); event.stopPropagation(); controller.move(attachment.id, event.key === "ArrowLeft" ? -1 : 1); }
        if (!event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "Delete" || event.key === "Backspace")) { event.preventDefault(); event.stopPropagation(); controller.remove(attachment.id); focusAfterRemove(index); }
      }}>
        <ImagePreview media={media} source={{ kind: "attachment", attachment }} hostId={hostId} connected={connected} label={attachment.name}/>
        <div className="composer-image-info sr-only"><span className="composer-image-name" title={attachment.name}>{attachment.name}</span><span>{formatImageBytes(attachment.bytes)}</span></div>
        <div className="composer-image-actions"><button className="image-reorder image-earlier" type="button" disabled={disabled || index === 0} onClick={() => controller.move(attachment.id, -1)} aria-label={`Move ${attachment.name} earlier`} title="Move earlier (Alt Left)"><Icon name="arrow" className="image-move-earlier"/></button><button className="image-reorder image-later" type="button" disabled={disabled || index === attachments!.length - 1} onClick={() => controller.move(attachment.id, 1)} aria-label={`Move ${attachment.name} later`} title="Move later (Alt Right)"><Icon name="arrow" className="image-move-later"/></button><button className="image-remove" type="button" disabled={disabled} onClick={() => { controller.remove(attachment.id); focusAfterRemove(index); }} aria-label={`Remove ${attachment.name}`} title="Remove image"><Icon name="close"/></button></div>
      </li>)}
      {controller.staging.map(item => <li className="composer-image-staging" key={item.id}>
        <span className="composer-image-name">{item.name}</span><span role={item.status === "error" ? "alert" : "status"}>{item.error ?? (item.status === "caching" ? "Saving on this device…" : "Checking image…")}</span>
        <div>{item.status === "error" && <button type="button" disabled={disabled} onClick={() => void controller.retry(item.id)}>Retry</button>}<button type="button" onClick={() => controller.removeStaged(item.id)} aria-label={`Cancel adding ${item.name}`}>Remove</button></div>
      </li>)}
    </ol> : null}
    {controller.error && <p className="attachment-notice" role="alert">{controller.error}</p>}
    {unavailable && <p className="attachment-notice">{unavailable}</p>}
    {!unavailable && !connected && <p className="attachment-notice">Images can be added using this host’s saved limits. They stay on this device until the host reconnects; sending remains manual.</p>}
  </div>;
}
