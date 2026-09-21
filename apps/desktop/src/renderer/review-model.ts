import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { GitStatusEntry } from "../../../../packages/shared/src/workspace";
import type { TurnReviewFile } from "../../../../packages/shared/src/turn-review";

export interface ReviewFile {
  key: string;
  metadata: FileDiffMetadata;
  additions: number;
  deletions: number;
  binary: boolean;
}
export interface ReviewPatch { files: ReviewFile[]; additions: number; deletions: number; binaryFiles: number }
export interface ReviewOptions { split: boolean; wrap: boolean; wordDiffs: boolean; indicators: "bars" | "classic"; lineNumbers: boolean }
export const DEFAULT_REVIEW_OPTIONS: ReviewOptions = { split: false, wrap: false, wordDiffs: false, indicators: "bars", lineNumbers: true };
export function readReviewOptions(value: string | null): ReviewOptions {
  if (value === null) return { ...DEFAULT_REVIEW_OPTIONS };
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Review preferences are invalid.");
  const options = parsed as Record<string, unknown>;
  if (["split", "wrap", "wordDiffs", "lineNumbers"].some(key => typeof options[key] !== "boolean") || !["bars", "classic"].includes(String(options.indicators))) throw new Error("Review preferences are invalid.");
  return { split: options.split as boolean, wrap: options.wrap as boolean, wordDiffs: options.wordDiffs as boolean, lineNumbers: options.lineNumbers as boolean, indicators: options.indicators as "bars" | "classic" };
}

/** Git quotes non-ASCII filename bytes with octal escapes; decode names only, never patch content.
 * The pinned parser strips the outer quotes from `diff --git` headers but keeps them on
 * `rename from`/`rename to` metadata. Only that outer pair is removed: a literal quote character
 * in a filename always arrives escaped inside the quoted form. */
export function reviewPath(name: string): string {
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
  if (!name.includes("\\")) return name;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < name.length;) {
    if (name[i] === "\\") {
      const octal = name.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
      if (octal) { bytes.push(parseInt(octal, 8)); i += octal.length + 1; continue; }
      const escaped = name[i + 1];
      const mapped: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", '"': '"', "\\": "\\" };
      if (escaped && mapped[escaped] !== undefined) { bytes.push(...encoder.encode(mapped[escaped])); i += 2; continue; }
    }
    const point = String.fromCodePoint(name.codePointAt(i)!); bytes.push(...encoder.encode(point)); i += point.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
}

/** Counts come from the pinned parser's changed hunk lines, never header-prefix heuristics. */
export function parseReviewPatch(patch: string, cacheIdentity: string, selectedPath?: string): ReviewPatch {
  if (!patch.trim()) return { files: [], additions: 0, deletions: 0, binaryFiles: 0 };
  const parsed = parsePatchFiles(patch, cacheIdentity, true).flatMap(part => part.files);
  if (!parsed.length) throw new Error("Git returned a patch without readable file metadata.");
  const rawFiles = patch.split(/(?=^diff --git )/m).filter(part => part.startsWith("diff --git "));
  const files = parsed.map((metadata, index): ReviewFile => {
    // --no-index untracked patches use absolute owner paths. The request identity is authoritative.
    metadata.name = selectedPath && parsed.length === 1 ? selectedPath : reviewPath(metadata.name);
    if (metadata.prevName) metadata.prevName = reviewPath(metadata.prevName);
    return {
      key: `${index}:${metadata.name}`, metadata,
      additions: metadata.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0),
      deletions: metadata.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0),
      binary: /^(?:Binary files .+ differ|GIT binary patch)\r?$/m.test(rawFiles[index] ?? ""),
    };
  });
  return { files, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0), binaryFiles: files.filter(file => file.binary).length };
}
export function reviewEntries(entries: GitStatusEntry[], staged: boolean): GitStatusEntry[] {
  return entries.filter(entry => staged ? ![".", " ", "?"].includes(entry.indexStatus) : ![".", " "].includes(entry.worktreeStatus) || entry.kind === "untracked");
}
export function reviewMutationPaths(entry: GitStatusEntry): string[] { return entry.originalPath ? [entry.originalPath, entry.path] : [entry.path]; }

export interface TurnReviewFileSections { sections: ReviewFile[]; error?: string }
/** Recorded sections for one turn-review file, rendered under the recorded identity.
 * A file-type replacement records two sections for the same path; both keep that path. */
export function parseTurnReviewFile(file: TurnReviewFile, identity: string): TurnReviewFileSections {
  if (file.binary && !file.patch.trim()) return { sections: [] };
  try {
    const sections = parseReviewPatch(file.patch, identity).files.map((section, index) => {
      section.metadata.name = file.path;
      if (file.previousPath !== null) section.metadata.prevName = file.previousPath; else delete section.metadata.prevName;
      return { ...section, key: `${identity}:${index}`, binary: section.binary || file.binary };
    });
    return { sections };
  } catch (error) { return { sections: [], error: error instanceof Error ? error.message : String(error) }; }
}
/** Recorded paths are cwd-relative; a Transcript path may be absolute inside the recorded cwd. */
export function turnReviewRelativePath(path: string, cwd: string | undefined): string {
  if (!cwd || !path.startsWith("/")) return path;
  const root = cwd.replace(/\/+$/, "");
  return path === root ? "." : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
export function turnReviewMatches(file: TurnReviewFile, path: string | undefined): boolean {
  return !path || path === "." || file.path === path || file.previousPath === path || file.path.startsWith(`${path}/`);
}
