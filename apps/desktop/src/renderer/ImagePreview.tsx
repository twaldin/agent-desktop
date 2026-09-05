import { useEffect, useRef, useState } from "react";
import { attachmentSourceKey, loadAttachmentMedia, type AttachmentMediaContext, type AttachmentMediaSource } from "./attachment-media";
import "./attachments.css";

export interface ImagePreviewProps {
  media: AttachmentMediaContext;
  source: AttachmentMediaSource;
  hostId: string;
  connected: boolean;
  label: string;
  className?: string;
  dialogOnly?: boolean;
  onClose?(): void;
}

export function ImagePreview({ media, source, hostId, connected, label, className = "", dialogOnly = false, onClose }: ImagePreviewProps) {
  const key = `${hostId}:${attachmentSourceKey(source)}`;
  const [state, setState] = useState<{ key: string; url?: string; error?: string }>({ key });
  const [retry, setRetry] = useState(0), [expanded, setExpanded] = useState(dialogOnly);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let active = true, url: string | undefined;
    setState({ key }); setExpanded(dialogOnly);
    void loadAttachmentMedia(media, source, hostId, connected).then(result => {
      if (!active) return;
      url = URL.createObjectURL(result.blob); setState({ key, url });
    }, cause => { if (active) setState({ key, error: cause instanceof Error ? cause.message : "Image could not be loaded." }); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [media, key, connected, retry]);
  useEffect(() => { if (expanded && !dialog.current?.open) dialog.current?.showModal(); else if (!expanded) dialog.current?.close(); }, [expanded]);
  const current = state.key === key ? state : undefined;
  const failure = () => { setState({ key, error: "This device could not display the image." }); if (!dialogOnly) setExpanded(false); };
  return <div className={`image-preview ${className}`}>
    {!dialogOnly && (current?.url ? <button type="button" className="image-preview-thumbnail" aria-label={`Preview ${label}`} onClick={() => setExpanded(true)}><img src={current.url} alt={label} onError={failure}/></button>
      : current?.error ? <div className="image-preview-error"><span>{current.error}</span><button type="button" onClick={() => setRetry(value => value + 1)}>Retry image</button></div>
        : <span className="image-preview-loading" role="status">Loading image…</span>)}
    <dialog ref={dialog} className="image-preview-dialog" aria-label={`Image preview: ${label}`} onCancel={() => {setExpanded(false);onClose?.();}} onClick={event => { if (event.target === event.currentTarget) {setExpanded(false);onClose?.();} }}>
      <div className="image-preview-heading"><span>{label}</span><button type="button" aria-label="Close image preview" onClick={() => {setExpanded(false);onClose?.();}}>Close</button></div>
      {dialogOnly && !current?.url && <p role="status">{current?.error ?? "Loading image…"}{current?.error && <button onClick={() => setRetry(value => value + 1)}>Retry image</button>}</p>}
      {expanded && current?.url && <img src={current.url} alt={label} onError={failure}/>}
    </dialog>
  </div>;
}
