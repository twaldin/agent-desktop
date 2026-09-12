import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileDiff, Virtualizer, WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import type { FileDiffOptions, VirtualFileMetrics, SelectedLineRange } from "@pierre/diffs";
import { REVIEW_SHADOW_CSS, REVIEW_THEMES } from "./review-theme";
import type { ReviewFile, ReviewOptions } from "./review-model";
import { useCodeTheme } from "./use-code-theme";
import PierreWorker from "./review-worker";

const poolOptions = { poolSize: 4, totalASTLRUCacheSize: 100, workerFactory: () => new PierreWorker() };
const highlighterOptions = { theme: REVIEW_THEMES, preferredHighlighter: "shiki-js" as const, langs: ["typescript", "javascript", "css", "html", "python"] as const, lineDiffType: "none" as const, tokenizeMaxLineLength: 1000, maxLineDiffLength: 1000 };

function PoolOptions({ wordDiffs, onError }: { wordDiffs: boolean; onError(message: string | undefined): void }) {
  const pool = useWorkerPool();
  const { themes } = useCodeTheme();
  useEffect(() => {
    let cancelled = false;
    void pool?.setRenderOptions({ theme: themes, lineDiffType: wordDiffs ? "word-alt" : "none" }).then(() => { if (!cancelled) onError(undefined); }, error => { if (!cancelled) onError(`Syntax highlighting failed: ${error instanceof Error ? error.message : String(error)}`); });
    return () => { cancelled = true; };
  }, [pool, wordDiffs, onError, themes]);
  return null;
}
export function ReviewDiffs({ children, options }: { children: ReactNode; options: ReviewOptions }) {
  const [error, setError] = useState<string>();
  return <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={{ ...highlighterOptions, langs: [...highlighterOptions.langs] }}>
    <PoolOptions wordDiffs={options.wordDiffs} onError={setError}/>
    {error && <p className="review-message" role="alert">{error}</p>}
    <Virtualizer className="review-scroll" contentClassName="review-files" config={{ overscrollSize: 600, intersectionObserverMargin: 300 }}>{children}</Virtualizer>
  </WorkerPoolContextProvider>;
}

function useReviewMetrics(): VirtualFileMetrics {
  const read = () => {
    const size = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--code-font-size"));
    return { hunkLineCount: 32, lineHeight: (Number.isFinite(size) && size > 0 ? size : 12) * 1.8, diffHeaderHeight: 0, spacing: 0 };
  };
  const [metrics, setMetrics] = useState(read);
  useEffect(() => {
    const update = () => setMetrics(read());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    return () => observer.disconnect();
  }, []);
  return metrics;
}
export function ReviewDiff({ file, options, onLineSelected }: { file: ReviewFile; options: ReviewOptions; onLineSelected?(range: SelectedLineRange | null): void }) {
  const { themeType, themes } = useCodeTheme();
  const metrics = useReviewMetrics();
  const rendererOptions = useMemo((): FileDiffOptions<undefined> => ({
    theme: themes, themeType, preferredHighlighter: "shiki-js",
    diffStyle: options.split ? "split" : "unified", overflow: options.wrap ? "wrap" : "scroll",
    diffIndicators: options.indicators, disableLineNumbers: !options.lineNumbers,
    disableFileHeader: true, hunkSeparators: "line-info", collapsedContextThreshold: 3,
    expansionLineCount: 20, lineDiffType: options.wordDiffs ? "word-alt" : "none",
    tokenizeMaxLineLength: 1000, maxLineDiffLength: 1000, unsafeCSS: REVIEW_SHADOW_CSS,
    enableLineSelection: true, ...(onLineSelected ? { onLineSelected } : {}),
  }), [themes, themeType, options, onLineSelected]);
  if (file.binary) return <p className="review-file-note">Binary file changed.</p>;
  if (!file.metadata.hunks.length) return <p className="review-file-note">{file.metadata.type === "rename-pure" ? "Renamed without content changes." : file.metadata.mode !== file.metadata.prevMode && file.metadata.prevMode ? `Mode changed: ${file.metadata.prevMode} → ${file.metadata.mode}` : file.metadata.type === "new" ? "Empty file added." : file.metadata.type === "deleted" ? "Empty file deleted." : "No text changes in this patch."}</p>;
  return <FileDiff fileDiff={file.metadata} options={rendererOptions} metrics={metrics}/>
}
