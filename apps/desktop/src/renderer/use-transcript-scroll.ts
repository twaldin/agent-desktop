import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TranscriptReadingPositions, TranscriptViewport } from "./transcript-scroll";

export function useTranscriptScroll(contextKey: string | undefined) {
  const positions = useMemo(() => { try { return new TranscriptReadingPositions(sessionStorage); } catch { return new TranscriptReadingPositions(); } }, []);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);
  const controller = useRef<TranscriptViewport | null>(null);
  useLayoutEffect(() => {
    if (!element || !contextKey) return;
    const content = element.querySelector<HTMLElement>(".transcript");
    if (!content) return;
    setFollowing(positions.get(contextKey)?.following ?? true);
    const current = new TranscriptViewport(element, content, positions.get(contextKey), position => {
      positions.set(contextKey, position); setFollowing(position.following);
    });
    controller.current = current;
    return () => { current.dispose(); controller.current = null; positions.flush(); };
  }, [contextKey, element, positions]);
  useEffect(() => { window.addEventListener("pagehide", positions.flush); return () => { window.removeEventListener("pagehide", positions.flush); positions.flush(); }; }, [positions]);
  const latest = useCallback(() => { controller.current?.latest(); element?.focus({ preventScroll: true }); }, [element]);
  return { viewportRef: setElement, following, latest };
}
