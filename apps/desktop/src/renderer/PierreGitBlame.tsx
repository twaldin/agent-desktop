import { useEffect, useState, type RefObject } from "react";
import type { PierreGitBlame as PierreGitBlameData } from "./git-file-history-state";

/** Observes Pierre's native selection. Never remaps changed lines to a guessed author. */
export function PierreGitBlame({ blame, container, active, value, selection }: {
  blame: PierreGitBlameData;
  container: RefObject<HTMLDivElement | null>;
  active: boolean;
  value: string;
  selection(): { line: number; text: string } | undefined;
}) {
  const [line, setLine] = useState<number>();
  useEffect(() => {
    if (!active) { setLine(undefined); return; }
    let frame = 0;
    const update = () => {
      const shadow = container.current?.querySelector("diffs-container")?.shadowRoot;
      const input = shadow?.querySelector('[contenteditable="true"]');
      const native = (shadow as (ShadowRoot & { getSelection?: () => Selection }) | null)?.getSelection?.() ?? window.getSelection();
      const current = selection();
      setLine(input && native?.anchorNode && input.contains(native.anchorNode) && current?.text === blame.snapshotText ? current.line : undefined);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    document.addEventListener("selectionchange", schedule);
    container.current?.addEventListener("keyup", schedule);
    container.current?.addEventListener("pointerup", schedule);
    schedule();
    const element = container.current;
    return () => { cancelAnimationFrame(frame); document.removeEventListener("selectionchange", schedule); element?.removeEventListener("keyup", schedule); element?.removeEventListener("pointerup", schedule); };
  }, [active, value, blame.snapshotText, container, selection]);
  if (!active) return null;
  const unavailable = blame.unavailable ?? (value !== blame.snapshotText ? "This editor text differs from the committed snapshot. Line authorship is unavailable for changed text." : undefined);
  const row = line === undefined ? undefined : blame.lines[line - 1];
  return <div className="pierre-git-active-blame" aria-label="Active line Git blame" role="status">
    {unavailable ? <span>{unavailable}</span> : row ? <button type="button" onClick={() => blame.open(row)} title={`${row.path}:${row.originalLine}\n${row.email}`}>Line {row.line} · {row.author} · {row.summary} · {row.commit.slice(0, 8)}</button> : <span>{blame.lines.length ? "Place the caret on a line to inspect its commit." : "Empty committed file · no line blame."}</span>}
  </div>;
}
