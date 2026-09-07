import { EditorView, WidgetType } from "@codemirror/view";
import type { MarkdownImageSource } from "./markdown-images";

const disposal = new WeakMap<HTMLElement, () => void>();
/** Browser image decoding and failure rendering, as in the native editor widget. */
export class MarkdownImageWidget extends WidgetType {
  constructor(readonly source: MarkdownImageSource, readonly alt: string, readonly title?: string) { super(); }
  eq(other: MarkdownImageWidget) { return this.source.key === other.source.key && this.alt === other.alt && this.title === other.title; }
  ignoreEvent() { return false; }
  toDOM(view: EditorView) {
    const image = view.dom.ownerDocument.createElement("img");
    image.alt = this.alt; if (this.title !== undefined) image.title = this.title;
    image.className = "markdown-preview-image"; image.dataset.imageState = "loading";
    let alive = true, release: (() => void | Promise<void>) | undefined;
    const dispose = () => { const current = release; release = undefined; if (current) void Promise.resolve().then(current).catch(() => {}); };
    const measure = () => { if (alive) view.requestMeasure(); };
    image.onload = () => { image.dataset.imageState = "loaded"; measure(); };
    image.onerror = () => { image.dataset.imageState = "error"; measure(); };
    disposal.set(image, () => { alive = false; image.onload = image.onerror = null; image.removeAttribute("src"); dispose(); });
    void Promise.resolve().then(() => this.source.load()).then(lease => {
      release = () => lease.release();
      if (!alive) { dispose(); return; }
      image.src = lease.url;
    }, () => {
      if (!alive) return;
      // A failed acquire has the same browser-owned broken-image/alt presentation.
      image.src = "data:image/png;base64,";
    });
    return image;
  }
  destroy(dom: HTMLElement) { disposal.get(dom)?.(); disposal.delete(dom); }
}
