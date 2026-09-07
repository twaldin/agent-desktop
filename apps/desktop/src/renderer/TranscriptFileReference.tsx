import { useContext, useState } from "react";
import { TranscriptMarkdownContext } from "./MarkdownText";
import type { WorkspaceFileLink } from "./transcript-links";
import "./transcript-file-reference.css";

export interface TranscriptFileReferenceProps {
  /** Literal native file path. It is never parsed as a URL or line location. */
  path: string;
  /** Native display label, when the record supplied one. */
  label?: string;
}

type Resolution = { file: WorkspaceFileLink } | { error: string };

function absolutePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

/**
 * Native file references are paths, not Markdown hrefs. In particular `%`,
 * `#`, `?`, `:` and spaces remain literal filename characters.
 */
export function resolveTranscriptFileReference(path: string, cwd?: string): Resolution {
  if (typeof path !== "string" || !path || path.length > 32_768 || /[\x00-\x1f\x7f\\]/.test(path)) return { error: "This native file reference has an invalid path." };
  if (path.startsWith("//")) return { error: "This native file reference names another host." };
  if (!cwd?.startsWith("/")) return { error: "This file reference has no owning workspace." };
  const root = absolutePath(cwd), resolved = absolutePath(path.startsWith("/") ? path : `${root}/${path}`);
  if (resolved === root || root !== "/" && !resolved.startsWith(`${root}/`)) return { error: "This file reference is outside the owning workspace." };
  return { file: { path: resolved.slice(root === "/" ? 1 : root.length + 1) } };
}

export function TranscriptFileReference({ path, label }: TranscriptFileReferenceProps) {
  const { actions } = useContext(TranscriptMarkdownContext);
  const [error, setError] = useState<string>();
  const target = resolveTranscriptFileReference(path, actions?.cwd);
  const text = label?.trim() || path;
  if ("error" in target) return <span className="transcript-file-reference unavailable" title={target.error}>{text}<span className="sr-only"> ({target.error})</span></span>;
  const open = async () => {
    setError(undefined);
    try {
      if (!actions?.openFile) throw new Error("The owning workspace is unavailable.");
      await actions.openFile(target.file);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return <><button type="button" className="transcript-file-reference" title={path} onClick={() => void open()}>{text}</button>{error && <span className="transcript-file-reference-error" role="alert">{error}</span>}</>;
}
