import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal, flushSync } from "react-dom";
import { Icon } from "./Icons";
import type { RenderedDiagram } from "./transcript-diagram";

interface Point { clientX: number; clientY: number }

/** Pinned 7982 diagram viewer zoom ramp; the measured fit percentage joins it in sorted order. */
const zoomRamp = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
const wheelZoomDivisor = 200;
const downloadFileName = "mermaid-diagram.svg";

/** Normalized wheel travel: line and page deltas become pixels before the exponential zoom curve. */
function wheelDelta(event: WheelEvent) { return event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 800 : event.deltaY; }
function rampWithFit(fit: number | undefined) {
  const ramp = [...zoomRamp];
  if (fit != null && !ramp.includes(fit)) { ramp.push(fit); ramp.sort((left, right) => left - right); }
  return ramp;
}
/** Strict next/previous ramp entry: a step never lands back on the current percentage. */
function steppedZoom(current: number, direction: "in" | "out", ramp: number[]) {
  if (direction === "in") { for (const value of ramp) if (value > current) return value; return ramp.at(-1) ?? current; }
  for (let index = ramp.length - 1; index >= 0; index--) { const value = ramp[index]!; if (value < current) return value; }
  return ramp[0] ?? current;
}
/** Prefers the pointer that produced the zoom, then the last pointer seen, then the viewport centre. */
function anchorPoint(event: WheelEvent, fallback: Point | undefined, viewport: HTMLElement | null) {
  if (!viewport) return { clientX: event.clientX, clientY: event.clientY };
  const { left, right, top, bottom, width, height } = viewport.getBoundingClientRect();
  const candidates = [(event.clientX !== 0 || event.clientY !== 0) && { clientX: event.clientX, clientY: event.clientY }, fallback];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.clientX >= left && candidate.clientX <= right && candidate.clientY >= top && candidate.clientY <= bottom) return candidate;
  }
  return { clientX: left + width / 2, clientY: top + height / 2 };
}
function pinchGeometry(pointers: Map<number, Point>) {
  const remaining = pointers.values();
  const first: Point | undefined = remaining.next().value, second: Point | undefined = remaining.next().value;
  if (!first || !second) return undefined;
  const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
  return distance <= 0 ? undefined : { clientX: (first.clientX + second.clientX) / 2, clientY: (first.clientY + second.clientY) / 2, distance };
}

/**
 * Fullscreen preview for a diagram already rendered by the isolated Mermaid sandbox.
 * The SVG is only ever handed to an `img` through a blob URL, never to markup in this document.
 * The parent owns mounting, unmounting and the final focus restoration.
 */
export function TranscriptDiagramPreview({ diagram, onClose }: { diagram: RenderedDiagram; onClose: () => void }) {
  const anchor = useRef<HTMLSpanElement>(null), dialog = useRef<HTMLDialogElement>(null), image = useRef<HTMLImageElement>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement>();
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>();
  const [zoomPercent, setZoomPercent] = useState<number>();
  const [blob, setBlob] = useState<{ key: string; url: string }>();
  const pointers = useRef(new Map<number, Point>());
  const panning = useRef<{ pointerId: number; clientX: number; clientY: number; scrollLeft: number; scrollTop: number } | undefined>(undefined);
  const pinching = useRef<{ distance: number; zoomPercent: number } | undefined>(undefined);
  const lastPointer = useRef<Point | undefined>(undefined);
  const blankPointerDown = useRef(false), pointerMoved = useRef(false);
  const wheel = useRef<(event: WheelEvent) => void>(() => {});

  const fit = useMemo(() => {
    if (!viewportSize || diagram.width <= 0 || diagram.height <= 0) return undefined;
    const scale = Math.min(1, viewportSize.width / diagram.width, viewportSize.height / diagram.height);
    return Number.isFinite(scale) && scale > 0 ? scale * 100 : undefined;
  }, [viewportSize, diagram.width, diagram.height]);
  const ramp = useMemo(() => rampWithFit(fit), [fit]);
  const effective = zoomPercent ?? fit;
  const minimum = ramp[0]!, maximum = ramp.at(-1)!;
  const source = blob?.key === diagram.svg ? blob : undefined;

  const clearTracking = useCallback(() => { pointers.current.clear(); panning.current = undefined; pinching.current = undefined; lastPointer.current = undefined; blankPointerDown.current = false; pointerMoved.current = false; }, []);
  const measure = useCallback((node: HTMLElement) => {
    const { width, height } = node.getBoundingClientRect();
    setViewportSize(current => current && current.width === width && current.height === height ? current : { width, height });
  }, []);

  useEffect(() => { setPortalTarget(anchor.current?.ownerDocument.body); }, []);
  useEffect(() => () => clearTracking(), [clearTracking]);
  // The preview only ever displays a blob of the diagram this render owns; a replaced source revokes the old URL.
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([diagram.svg], { type: "image/svg+xml" }));
    setBlob({ key: diagram.svg, url });
    return () => URL.revokeObjectURL(url);
  }, [diagram.svg]);
  // A replaced diagram must never keep the previous render's zoom, scroll offset or pointer tracking.
  useEffect(() => {
    clearTracking(); setZoomPercent(undefined);
    if (viewport) { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
  }, [diagram.svg, viewport, clearTracking]);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (!node.open) node.showModal();
    return () => { if (node.open) node.close(); };
  }, [portalTarget]);
  useEffect(() => {
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => wheel.current(event);
    viewport.addEventListener("wheel", onWheel, { passive: false });
    measure(viewport);
    if (typeof ResizeObserver === "undefined") return () => viewport.removeEventListener("wheel", onWheel);
    const observer = new ResizeObserver(() => measure(viewport));
    observer.observe(viewport);
    return () => { observer.disconnect(); viewport.removeEventListener("wheel", onWheel); };
  }, [viewport, measure]);

  /** Keeps the zoomed point under the cursor by correcting the viewport scroll after the layout commits. */
  const zoomAt = (clientX: number, clientY: number, percent: number) => {
    const node = image.current;
    if (!viewport || !node) { setZoomPercent(percent); return; }
    const before = node.getBoundingClientRect();
    const rawX = before.width > 0 ? (clientX - before.left) / before.width : .5, rawY = before.height > 0 ? (clientY - before.top) / before.height : .5;
    const ratioX = Number.isFinite(rawX) ? Math.min(1, Math.max(0, rawX)) : .5, ratioY = Number.isFinite(rawY) ? Math.min(1, Math.max(0, rawY)) : .5;
    flushSync(() => setZoomPercent(percent));
    if (!viewport.isConnected || !node.isConnected) return;
    const after = node.getBoundingClientRect();
    viewport.scrollLeft += after.left + after.width * ratioX - clientX;
    viewport.scrollTop += after.top + after.height * ratioY - clientY;
  };
  const zoomFromCenter = (percent: number) => {
    if (!viewport) { setZoomPercent(percent); return; }
    const rect = viewport.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, percent);
  };
  const step = (direction: "in" | "out") => { if (effective != null) zoomFromCenter(steppedZoom(effective, direction, ramp)); };
  const close = () => { clearTracking(); onClose(); };

  wheel.current = event => {
    if (!event.ctrlKey || effective == null) return;
    event.preventDefault(); event.stopPropagation();
    const target = effective * Math.exp(-wheelDelta(event) / wheelZoomDivisor);
    if (!Number.isFinite(target)) return;
    const next = Math.min(maximum, Math.max(minimum, target));
    if (next === effective) return;
    const point = anchorPoint(event, lastPointer.current, viewport);
    zoomAt(point.clientX, point.clientY, next);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    lastPointer.current = { clientX: event.clientX, clientY: event.clientY };
    blankPointerDown.current = event.target === event.currentTarget; pointerMoved.current = false;
    if (event.pointerType !== "touch") return;
    if (typeof event.currentTarget.setPointerCapture === "function") event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    if (pointers.current.size === 1 && viewport) {
      panning.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
      return;
    }
    panning.current = undefined;
    const geometry = pinchGeometry(pointers.current);
    pinching.current = geometry == null || effective == null ? undefined : { distance: geometry.distance, zoomPercent: effective };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    lastPointer.current = { clientX: event.clientX, clientY: event.clientY };
    if (event.pointerType !== "touch" || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
    if (pointers.current.size > 1) {
      event.preventDefault(); event.stopPropagation();
      panning.current = undefined; pointerMoved.current = true;
      const start = pinching.current, geometry = pinchGeometry(pointers.current);
      if (start == null || geometry == null) return;
      const target = start.zoomPercent * (geometry.distance / start.distance);
      if (!Number.isFinite(target)) return;
      const next = Math.min(maximum, Math.max(minimum, target));
      if (next === effective) return;
      zoomAt(geometry.clientX, geometry.clientY, next);
      return;
    }
    const pan = panning.current;
    if (!viewport || pan == null || pan.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); pointerMoved.current = true;
    viewport.scrollLeft = pan.scrollLeft - (event.clientX - pan.clientX);
    viewport.scrollTop = pan.scrollTop - (event.clientY - pan.clientY);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") return;
    pointers.current.delete(event.pointerId);
    const target = event.currentTarget;
    if (typeof target.hasPointerCapture === "function" && typeof target.releasePointerCapture === "function" && target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    if (pointers.current.size === 0) { panning.current = undefined; pinching.current = undefined; return; }
    const remaining: [number, Point] | undefined = pointers.current.entries().next().value;
    if (pointers.current.size === 1 && remaining) {
      const [pointerId, point] = remaining;
      panning.current = viewport ? { pointerId, clientX: point.clientX, clientY: point.clientY, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop } : undefined;
      pinching.current = undefined;
      return;
    }
    const geometry = pinchGeometry(pointers.current);
    panning.current = undefined;
    pinching.current = geometry == null || effective == null ? undefined : { distance: geometry.distance, zoomPercent: effective };
  };

  const scaled = effective == null ? undefined : { width: `${diagram.width * effective / 100}px`, height: `${diagram.height * effective / 100}px` };
  return <><span ref={anchor} hidden aria-hidden="true"/>
  {portalTarget && createPortal(<dialog ref={dialog} className="transcript-diagram-dialog" aria-label="Mermaid diagram preview"
      onCancel={event => { event.preventDefault(); close(); }}
      onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="transcript-diagram-preview-actions">
      {source && <a className="icon-button transcript-diagram-preview-download" href={source.url} download={downloadFileName} aria-label="Download Mermaid diagram" title="Download Mermaid diagram"><Icon name="arrow" className="transcript-diagram-preview-download-icon"/></a>}
      <button type="button" className="icon-button" aria-label="Close Mermaid diagram preview" title="Close Mermaid diagram preview" onClick={close}><Icon name="close"/></button>
    </div>
    <div ref={setViewport} className="transcript-diagram-preview-viewport"
      onPointerDownCapture={onPointerDown} onPointerMoveCapture={onPointerMove} onPointerUpCapture={onPointerEnd} onPointerCancelCapture={onPointerEnd}
      onClick={event => {
        if (blankPointerDown.current && event.target === event.currentTarget && !pointerMoved.current) close();
        blankPointerDown.current = false; pointerMoved.current = false;
      }}>
      {source && <img ref={image} className={`transcript-diagram-preview-image${scaled ? " scaled" : ""}`} src={source.url} role="img" alt="Mermaid diagram" draggable={false} style={scaled} onPointerDown={event => event.stopPropagation()}/>}
    </div>
    <div className="transcript-diagram-preview-zoom">
      <button type="button" aria-label="Zoom out Mermaid diagram" title="Zoom out Mermaid diagram" disabled={effective == null || effective <= minimum} onClick={() => step("out")}>−</button>
      <span className="transcript-diagram-preview-zoom-value">{effective == null ? "" : `${Math.round(effective)}%`}</span>
      <button type="button" aria-label="Zoom in Mermaid diagram" title="Zoom in Mermaid diagram" disabled={effective == null || effective >= maximum} onClick={() => step("in")}><Icon name="plus"/></button>
    </div>
  </dialog>, portalTarget)}</>;
}
