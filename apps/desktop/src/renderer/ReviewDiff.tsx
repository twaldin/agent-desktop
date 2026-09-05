import { useEffect, useMemo, useState, type ReactNode } from "react";
import { FileDiff, Virtualizer, WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import type { FileDiffOptions, VirtualFileMetrics } from "@pierre/diffs";
import { REVIEW_SHADOW_CSS, REVIEW_THEMES } from "./review-theme";
import type { ReviewFile, ReviewOptions } from "./review-model";
import PierreWorker from "./review-worker";

const poolOptions = { poolSize: 4, totalASTLRUCacheSize: 100, workerFactory: () => new PierreWorker() };
const highlighterOptions = { theme: REVIEW_THEMES, preferredHighlighter: "shiki-js" as const, langs: ["typescript", "javascript", "css", "html", "python"] as const, lineDiffType: "none" as const, tokenizeMaxLineLength: 1000, maxLineDiffLength: 1000 };

function PoolOptions({ wordDiffs, onError }: { wordDiffs: boolean; onError(message: string | undefined): void }) {
  const pool = useWorkerPool();
  useEffect(() => {
    let cancelled = false;
    void pool?.setRenderOptions({ lineDiffType: wordDiffs ? "word-alt" : "none" }).then(() => { if (!cancelled) onError(undefined); }, error => { if (!cancelled) onError(`Syntax highlighting failed: ${error instanceof Error ? error.message : String(error)}`); });
    return () => { cancelled = true; };
  }, [pool, wordDiffs, onError]);
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

function useReviewTheme(): "dark" | "light" {
  const read = () => document.documentElement.dataset.theme === "light" ? "light" as const : document.documentElement.dataset.theme === "dark" ? "dark" as const : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" as const : "light" as const;
  const [theme, setTheme] = useState(read);
  useEffect(() => { const change = () => setTheme(read()); const observer = new MutationObserver(change); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme"] }); const media = matchMedia("(prefers-color-scheme: dark)"); media.addEventListener("change", change); return () => { observer.disconnect(); media.removeEventListener("change", change); }; }, []);
  return theme;
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
export function ReviewDiff({ file, options }: { file: ReviewFile; options: ReviewOptions }) {
  const theme = useReviewTheme();
  const metrics = useReviewMetrics();
  const rendererOptions = useMemo((): FileDiffOptions<undefined> => ({
    theme: REVIEW_THEMES, themeType: theme, preferredHighlighter: "shiki-js",
    diffStyle: options.split ? "split" : "unified", overflow: options.wrap ? "wrap" : "scroll",
    diffIndicators: options.indicators, disableLineNumbers: !options.lineNumbers,
    disableFileHeader: true, hunkSeparators: "line-info", collapsedContextThreshold: 3,
    expansionLineCount: 20, lineDiffType: options.wordDiffs ? "word-alt" : "none",
    tokenizeMaxLineLength: 1000, maxLineDiffLength: 1000, unsafeCSS: REVIEW_SHADOW_CSS,
    enableLineSelection: true,
  }), [theme, options]);
  if (file.binary) return <p className="review-file-note">Binary file changed.</p>;
  if (!file.metadata.hunks.length) return <p className="review-file-note">{file.metadata.type === "rename-pure" ? "Renamed without content changes." : file.metadata.mode !== file.metadata.prevMode && file.metadata.prevMode ? `Mode changed: ${file.metadata.prevMode} → ${file.metadata.mode}` : file.metadata.type === "new" ? "Empty file added." : file.metadata.type === "deleted" ? "Empty file deleted." : "No text changes in this patch."}</p>;
  return <FileDiff fileDiff={file.metadata} options={rendererOptions} metrics={metrics}/>
}
