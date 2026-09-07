import { useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";

interface EditorScrollProps {
  documentKey: string; active?: boolean; initialScrollTop?: number;
  onScrollChange?(top: number): void;
}
/** Numeric window-local fallback. Live editor instances retain their own selection/history. */
export function useEditorScroll(container: RefObject<HTMLDivElement | null>, props: EditorScrollProps) {
  const remembered = useRef({ key: props.documentKey, top: props.initialScrollTop ?? 0 });
  if (remembered.current.key !== props.documentKey)
    remembered.current = { key: props.documentKey, top: props.initialScrollTop ?? 0 };
  useLayoutEffect(() => {
    const element = container.current;
    if (!element || props.active === false || !props.onScrollChange) return;
    const position = remembered.current, publish = props.onScrollChange;
    let timer: ReturnType<typeof setTimeout> | undefined, frame = 0, restoring = true, alive = true;
    let reported = props.initialScrollTop ?? 0;
    const visible = () => element.clientHeight > 0 && Boolean(element.getClientRects().length);
    const flush = () => {
      clearTimeout(timer); timer = undefined;
      if (position.top !== reported) { reported = position.top; publish(position.top); }
    };
    const restore = () => {
      if (!alive || !restoring || !visible()) return;
      element.scrollTop = position.top;
      // Tokenization and image decoding may grow an initially empty document.
      // Keep the saved target until it is reachable or the user takes control.
      if (element.scrollHeight - element.clientHeight >= position.top) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => { restoring = false; });
      }
    };
    const takeControl = () => { cancelAnimationFrame(frame); restoring = false; };
    const scroll = () => {
      if (restoring || !visible()) return;
      position.top = element.scrollTop;
      clearTimeout(timer); timer = setTimeout(flush, 150);
    };
    // Capture precedes the window-view save listener, including a close directly
    // after a wheel event. No raw document or editor object enters window JSON.
    const leaving = () => { flushSync(flush); };
    element.addEventListener("scroll", scroll, { passive: true });
    for (const event of ["wheel", "pointerdown", "keydown"]) element.addEventListener(event, takeControl, true);
    window.addEventListener("beforeunload", leaving, true);
    window.addEventListener("pagehide", leaving, true);
    const observer = new ResizeObserver(restore);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    restore();
    return () => {
      alive = false; cancelAnimationFrame(frame); observer.disconnect(); flush();
      element.removeEventListener("scroll", scroll);
      for (const event of ["wheel", "pointerdown", "keydown"]) element.removeEventListener(event, takeControl, true);
      window.removeEventListener("beforeunload", leaving, true);
      window.removeEventListener("pagehide", leaving, true);
    };
  }, [container, props.documentKey, props.active]);
}
