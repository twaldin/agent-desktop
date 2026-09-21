import { structuredPatchHunks } from "@oh-my-pi/pi-natives";

/** Producer-observed bytes decoded as UTF-8, not content reread when Review opens. */
export interface RecordedTextFile {
  readonly path: string;
  readonly text: string;
  readonly mode: "100644" | "100755" | "120000";
}
export interface RecordedTextChange {
  readonly before: RecordedTextFile | null;
  readonly after: RecordedTextFile | null;
}
export interface RecordedTextDiff {
  path: string;
  previousPath: string | null;
  kind: "A" | "D" | "M" | "R";
  additions: number;
  deletions: number;
  patch: string;
}

/** Missing/pruned evidence is not an empty successful turn. The producer must surface it. */
export class RecordedDiffError extends Error {
  readonly name = "RecordedDiffError";
  constructor(readonly code: "INVALID_EVIDENCE" | "DISCONTINUOUS_HISTORY", message: string) { super(message); }
}
function invalid(message: string): never { throw new RecordedDiffError("INVALID_EVIDENCE", message); }
function gap(path: string): never { throw new RecordedDiffError("DISCONTINUOUS_HISTORY", `Recorded file history is discontinuous at ${JSON.stringify(path)}.`); }
function check(file: RecordedTextFile | null): void {
  if (file === null) return;
  if (!file || typeof file.path !== "string" || !file.path || file.path.startsWith("/") || file.path.includes("\0")
    || file.path.split("/").some(part => !part || part === "." || part === "..") || /[\uD800-\uDFFF]/u.test(file.path)) invalid("Recorded file paths must be canonical relative paths.");
  if (typeof file.text !== "string" || /[\uD800-\uDFFF]/u.test(file.text) || file.text.includes("\0")) invalid("Recorded text requires complete UTF-8 text; binary or missing snapshots need a different evidence record.");
  if (!["100644", "100755", "120000"].includes(file.mode)) invalid("A recorded file mode is required.");
}
function same(a: RecordedTextFile | null, b: RecordedTextFile | null): boolean {
  return a === null || b === null ? a === b : a.path === b.path && a.text === b.text && a.mode === b.mode;
}
/** Git's byte-oriented C quoting, not JSON's Unicode escapes. */
export function quoteRecordedPath(path: string): string {
  let result = '"';
  for (const byte of Buffer.from(path)) result += byte === 34 ? '\\"' : byte === 92 ? "\\\\" : byte >= 32 && byte < 127 ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, "0")}`;
  return `${result}"`;
}
function render(before: RecordedTextFile | null, after: RecordedTextFile | null, context: number): RecordedTextDiff {
  const path = after?.path ?? before!.path, previousPath = before && after && before.path !== after.path ? before.path : null;
  // Git represents a regular-file/symlink replacement as deletion plus creation.
  if (before && after && (before.mode === "120000") !== (after.mode === "120000")) {
    const removed = render(before, null, context), added = render(null, after, context);
    return { path, previousPath, kind: previousPath === null ? "M" : "R", additions: added.additions, deletions: removed.deletions, patch: removed.patch + added.patch };
  }
  const oldName = quoteRecordedPath(`a/${before?.path ?? path}`), newName = quoteRecordedPath(`b/${path}`);
  const lines = [`diff --git ${oldName} ${newName}`];
  if (before === null) lines.push(`new file mode ${after!.mode}`);
  else if (after === null) lines.push(`deleted file mode ${before.mode}`);
  else {
    if (before.mode !== after.mode) lines.push(`old mode ${before.mode}`, `new mode ${after.mode}`);
    if (previousPath !== null) lines.push(`rename from ${quoteRecordedPath(previousPath)}`, `rename to ${quoteRecordedPath(path)}`);
  }
  const hunks = structuredPatchHunks(before?.text ?? "", after?.text ?? "", context);
  let additions = 0, deletions = 0;
  if (hunks.length) {
    lines.push(`--- ${before === null ? "/dev/null" : oldName}`, `+++ ${after === null ? "/dev/null" : newName}`);
    for (const hunk of hunks) {
      lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines);
      for (const line of hunk.lines) { if (line.startsWith("+")) additions++; else if (line.startsWith("-")) deletions++; }
    }
  }
  return { path, previousPath, kind: before === null ? "A" : after === null ? "D" : previousPath === null ? "M" : "R", additions, deletions, patch: `${lines.join("\n")}\n` };
}

/**
 * Compose one producer-defined turn's ordered, successful file transitions.
 * A rename's destination must be absent (record an overwritten destination's
 * deletion first). Repeated observations must match exactly, including modes.
 * No turn inference, disk/Git lookup, mutation, or fallback to current content.
 */
export function composeRecordedTextChanges(changes: readonly RecordedTextChange[], context = 3): { files: RecordedTextDiff[]; patch: string } {
  if (!Number.isSafeInteger(context) || context < 0 || context > 1000) invalid("Diff context must be between 0 and 1000 lines.");
  type Chain = { before: RecordedTextFile | null; after: RecordedTextFile | null };
  const paths = new Map<string, Chain | null>(), chains: Chain[] = [];
  for (const change of changes) {
    check(change.before); check(change.after);
    if (!change.before && !change.after) invalid("A recorded transition must contain a before or after file.");
    const key = change.before?.path ?? change.after!.path;
    let chain = paths.get(key);
    if (paths.has(key) && !same(chain?.after ?? null, change.before)) gap(key);
    if (change.before && change.after && change.before.path !== change.after.path) {
      const destination = paths.get(change.after.path);
      if (destination?.after) gap(change.after.path);
    }
    if (!chain) { chain = { before: change.before, after: change.before }; chains.push(chain); }
    chain.after = change.after;
    paths.set(key, chain);
    if (change.after) {
      if (change.before && key !== change.after.path) paths.set(key, null);
      paths.set(change.after.path, chain);
    }
  }
  const files = chains.filter(chain => !same(chain.before, chain.after)).map(chain => render(chain.before, chain.after, context));
  return { files, patch: files.map(file => file.patch).join("") };
}
