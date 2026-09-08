import { useEffect, useRef, useState, type RefObject, type WheelEventHandler } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icons";
import type { MarkdownImageLease, MarkdownImageSource } from "./markdown-images";
import "./transcript-markdown-image.css";

export type { MarkdownImageSource } from "./markdown-images";

export interface TranscriptMarkdownImageProps {
  source?: MarkdownImageSource;
  alt: string;
  title?: string;
  rootRef: RefObject<HTMLDivElement | null>;
  download?(): Promise<void>;
  unavailableReason?: string;
}

interface GalleryItem { source: MarkdownImageSource; alt: string; title?: string; download?: () => Promise<void> }
interface GallerySelection { button: HTMLButtonElement; item: GalleryItem }
const galleryItems = new WeakMap<HTMLButtonElement, GalleryItem>();
const galleryAttribute = "data-transcript-markdown-image";

function release(lease: MarkdownImageLease | undefined) { if (lease) void Promise.resolve(lease.release()).catch(() => {}); }

/** A leased Markdown image. This component never accepts or fetches raw URLs. */
export function TranscriptMarkdownImage({ source, alt, title, rootRef, download, unavailableReason }: TranscriptMarkdownImageProps) {
  const trigger = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDialogElement>(null), viewport = useRef<HTMLDivElement>(null);
  const thumbnailLease = useRef<MarkdownImageLease | undefined>(undefined), previewLease = useRef<MarkdownImageLease | undefined>(undefined);
  const [thumbnail, setThumbnail] = useState<{ key: string; url?: string; failed?: boolean }>({ key: source?.key ?? "" });
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<GallerySelection | undefined>(undefined), [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);
  const [zoom, setZoom] = useState(1), [pan, setPan] = useState({ x: 0, y: 0 });
  const [downloadError, setDownloadError] = useState<string | undefined>(undefined);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | undefined>(undefined);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | undefined>(undefined);
  const panned = useRef(false);
  const beganOnBlankViewport = useRef(false);

  useEffect(() => {
    const button = trigger.current;
    if (!button || !source || !thumbnail.url) return;
    galleryItems.set(button, { source, alt, title, download });
    return () => { galleryItems.delete(button); };
  }, [source, alt, title, download, thumbnail.url]);
  useEffect(() => { setPortalTarget(trigger.current?.ownerDocument.body); }, [thumbnail.url]);
  useEffect(() => {
    let alive = true; release(thumbnailLease.current); thumbnailLease.current = undefined;
    const key = source?.key ?? ""; setThumbnail({ key });
    if (!source) return;
    void source.load().then(lease => {
      if (!alive) { release(lease); return; }
      thumbnailLease.current = lease; setThumbnail({ key, url: lease.url });
    }, () => { if (alive) setThumbnail({ key, failed: true }); });
    return () => { alive = false; release(thumbnailLease.current); thumbnailLease.current = undefined; };
  }, [source]);
  // A changed source must never leave an old granted image open in the preview.
  useEffect(() => { setOpen(false); setSelected(undefined); setPreviewUrl(undefined); setZoom(1); setPan({ x: 0, y: 0 }); }, [source]);
  useEffect(() => {
    let alive = true; release(previewLease.current); previewLease.current = undefined; setPreviewUrl(undefined);
    if (!open || !selected) return;
    void selected.item.source.load().then(lease => {
      if (!alive) { release(lease); return; }
      previewLease.current = lease; setPreviewUrl(lease.url);
    }, () => { if (alive) setPreviewUrl(undefined); });
    return () => { alive = false; release(previewLease.current); previewLease.current = undefined; };
  }, [open, selected]);
  useEffect(() => {
    const node = dialog.current;
    if (open && node && !node.open) node.showModal();
    if (!open && node?.open) node.close();
  }, [open, portalTarget]);
  if (!source) return <span className="transcript-markdown-image-unavailable" title={unavailableReason}> <Icon name="fileTree"/> <span>{alt || unavailableReason || "Image unavailable"}</span></span>;
  const current = thumbnail.key === source.key ? thumbnail : { key: source.key };
  if (!current.url) {
    // Native ordinary transcript leaves pending media blank; only a completed failure has a fallback.
    return current.failed ? <span className="transcript-markdown-image-unavailable" title={title ?? unavailableReason}><Icon name="fileTree"/><span>{alt || unavailableReason || "Image unavailable"}</span></span> : null;
  }
  const items = () => Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>(`[${galleryAttribute}]`) ?? []).flatMap(button => {
    const item = galleryItems.get(button); return item ? [{ button, item }] : [];
  });
  const gallery = items();
  const close = () => { setOpen(false); setSelected(undefined); setPreviewUrl(undefined); setZoom(1); setPan({ x: 0, y: 0 }); setDownloadError(undefined); requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true })); };
  const selectAdjacent = (direction: -1 | 1) => {
    const visible = items(), index = visible.findIndex(value => value.button === selected?.button);
    if (index < 0 || visible.length < 2) return;
    setSelected(visible[(index + direction + visible.length) % visible.length]!); setZoom(1); setPan({ x: 0, y: 0 }); setDownloadError(undefined);
  };
  const openPreview = () => { const button = trigger.current, item = button == null ? undefined : galleryItems.get(button); if (!button || !item) return; setSelected({ button, item }); setZoom(1); setPan({ x: 0, y: 0 }); setDownloadError(undefined); setOpen(true); };
  const thumbnailFailure = () => { release(thumbnailLease.current); thumbnailLease.current = undefined; setThumbnail({ key: source.key, failed: true }); setOpen(false); setSelected(undefined); setPreviewUrl(undefined); };
  const previewFailure = () => { release(previewLease.current); previewLease.current = undefined; setPreviewUrl(undefined); };
  const onWheel: WheelEventHandler<HTMLDivElement> = event => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); setZoom(value => Math.min(4, Math.max(.5, value * Math.exp(-event.deltaY / 300)))); };
  const activeAlt = selected?.item.alt ?? alt, activeTitle = selected?.item.title ?? title;
  return <><button ref={trigger} type="button" className="transcript-markdown-image" {...{ [galleryAttribute]: "" }} aria-label={alt || "Open image preview"} title={title} onClick={openPreview}>
    <img src={current.url} alt={alt} title={title} loading="lazy" decoding="async" onError={thumbnailFailure}/>
  </button>
  {portalTarget && createPortal(<dialog ref={dialog} className="transcript-markdown-image-dialog" aria-label="Image preview" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }} onKeyDown={event => { if (event.key === "ArrowLeft") { event.preventDefault(); selectAdjacent(-1); } if (event.key === "ArrowRight") { event.preventDefault(); selectAdjacent(1); } if (event.key === "0") { event.preventDefault(); setZoom(1); setPan({ x: 0, y: 0 }); } }}>
    <div className="transcript-markdown-image-actions">
      {selected?.item.download && <button type="button" className="icon-button" aria-label="Download image" title="Download image" onClick={() => { setDownloadError(undefined); void selected.item.download?.().catch(cause => setDownloadError(cause instanceof Error ? cause.message : "Image download failed.")); }}><Icon name="arrow" className="transcript-markdown-image-download-icon"/></button>}
      <button type="button" className="icon-button" aria-label="Close image preview" title="Close image preview" onClick={close}><Icon name="close"/></button>
    </div>
    {gallery.length > 1 && <><button type="button" className="transcript-markdown-image-nav previous" aria-label="Previous image" onClick={() => selectAdjacent(-1)}><Icon name="chevron"/></button><button type="button" className="transcript-markdown-image-nav next" aria-label="Next image" onClick={() => selectAdjacent(1)}><Icon name="chevron"/></button></>}
    {downloadError && <p className="transcript-markdown-image-download-error" role="alert">{downloadError}</p>}
    <div ref={viewport} className={`transcript-markdown-image-viewport${gallery.length > 1 ? " gallery" : ""}`} onWheel={onWheel} onClick={event => { if (beganOnBlankViewport.current && event.target === event.currentTarget && !panned.current) close(); panned.current = false; beganOnBlankViewport.current = false; }} onPointerDown={event => { if (event.pointerType === "mouse" && event.button !== 0) return; panned.current = false; beganOnBlankViewport.current = event.target === event.currentTarget; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; }} onPointerMove={event => { const value = drag.current; if (value) { if (Math.abs(event.clientX - value.x) > 2 || Math.abs(event.clientY - value.y) > 2) panned.current = true; setPan({ x: value.panX + event.clientX - value.x, y: value.panY + event.clientY - value.y }); } }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; panned.current = false; beganOnBlankViewport.current = false; }}>
      {previewUrl ? <img src={previewUrl} alt={activeAlt} title={activeTitle} draggable={false} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} onError={previewFailure}/> : <span className="transcript-markdown-image-unavailable"><Icon name="fileTree"/><span>{activeAlt || "Image unavailable"}</span></span>}
    </div>
    <div className="transcript-markdown-image-zoom"><button type="button" aria-label="Zoom out" disabled={zoom <= .5} onClick={() => setZoom(value => Math.max(.5, value - .25))}>−</button><button type="button" aria-label="Reset image zoom" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>{Math.round(zoom * 100)}%</button><button type="button" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + .25))}><Icon name="plus"/></button></div>
  </dialog>, portalTarget)}</>;
}
