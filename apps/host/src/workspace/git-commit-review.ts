import { createHash } from "node:crypto";
import { gitObjectId } from "../../../../packages/shared/src/git-file-history";
import { parseGitCommitTreePath, parseGitCommitReviewPath, parseGitCommitReviewSelection, type GitCommitReviewDiff, type GitCommitReviewFile, type GitCommitReviewList, type GitCommitReviewPath, type GitCommitReviewSelection, type GitCommitReviewSnapshot, type GitReviewCommit } from "../../../../packages/shared/src/git-commit-review";
import type { GitFileReadIO } from "./git-file-history";
import { WorkspaceError } from "./service";

const invalid = () => new WorkspaceError("INVALID_GIT_OUTPUT", "Git returned invalid Commit review metadata.");
const diffOptions = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-relative", "--ignore-submodules=none", "--submodule=short", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/"];
const metadataFormat = "%H%x00%cI%x00%s%x00%B%x00";
function objectId(value: string): string { if (!gitObjectId.test(value)) throw new Error("An exact Git object ID is required."); return value; }
function commitRows(output: string): GitReviewCommit[] {
  const fields = output.split("\0"), commits: GitReviewCommit[] = [];
  for (let index = 0; index < fields.length;) {
    if (fields[index] === "" || fields[index] === "\n") { index++; continue; }
    const commit = fields[index++]!.replace(/^\n/, ""), committedAt = fields[index++], subject = fields[index++], message = fields[index++];
    if (!gitObjectId.test(commit) || !committedAt || !Number.isFinite(Date.parse(committedAt)) || subject === undefined || message === undefined) throw invalid();
    commits.push({ commit, committedAt, subject, message });
  }
  return commits;
}

/** Parse raw identity and numstat together: NULs frame filenames, including tabs/newlines. */
function reviewFiles(output: string, oidLength: number): GitCommitReviewFile[] {
  if (!output) return [];
  if (!output.endsWith("\0")) throw invalid();
  const fields = output.slice(0, -1).split("\0"), files = new Map<string, GitCommitReviewFile>(), stats = new Set<string>();
  const key = (path: string, previousPath: string | null) => `${previousPath ?? ""}\0${path}`;
  let totalAdditions = 0, totalDeletions = 0;
  for (let index = 0; index < fields.length;) {
    const field = fields[index++]!, raw = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([ADMRCT])(?:\d+)?$/.exec(field);
    if (raw) {
      const [, oldMode, newMode, oldOid, newOid, change] = raw;
      if (!gitObjectId.test(oldOid!) || !gitObjectId.test(newOid!) || oldOid!.length !== oidLength || newOid!.length !== oidLength) throw invalid();
      const previousPath = change === "R" || change === "C" ? parseGitCommitTreePath(fields[index++]) : null, path = parseGitCommitTreePath(fields[index++]);
      const identity = key(path, previousPath);
      if (files.has(identity)) throw invalid();
      files.set(identity, { path, previousPath, change: change as GitCommitReviewFile["change"], oldMode: oldMode!, newMode: newMode!, oldOid: oldOid!, newOid: newOid!, additions: null, deletions: null });
      continue;
    }
    const stat = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(field);
    if (!stat || (stat[1] === "-") !== (stat[2] === "-")) throw invalid();
    const previousPath = stat[3] === "" ? parseGitCommitTreePath(fields[index++]) : null;
    const path = parseGitCommitTreePath(stat[3] === "" ? fields[index++] : stat[3]), identity = key(path, previousPath), file = files.get(identity);
    if (!file || stats.has(identity)) throw invalid();
    const additions = stat[1] === "-" ? null : Number(stat[1]), deletions = stat[2] === "-" ? null : Number(stat[2]);
    totalAdditions += additions ?? 0; totalDeletions += deletions ?? 0;
    if (![additions ?? 0, deletions ?? 0, totalAdditions, totalDeletions].every(Number.isSafeInteger)) throw invalid();
    file.additions = additions; file.deletions = deletions; stats.add(identity);
  }
  if (stats.size !== files.size) throw invalid();
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

/** Request-scoped reader. The owning service supplies bounded root-relative IO and fences
 * repository/catalog identity before and after the read. No ref resolution, fetch or disk fallback. */
export class GitCommitReviewReader {
  constructor(private io: Pick<GitFileReadIO, "text">, private repositoryId: string) {
    if (!/^[a-f0-9]{64}$/.test(repositoryId)) throw new Error("The owning repository identity is required.");
  }
  private read(args: string[]): Promise<string> {
    return this.io.text(["--no-lazy-fetch", "--no-replace-objects", "--literal-pathspecs", "-c", "color.ui=false", ...args]);
  }
  /** The shared Branch owner resolves the local base/HEAD and merge-base once.
   * Missing base or unborn HEAD gives the native empty picker, never all history. */
  async commits(mergeBase: string | null, head: string | null): Promise<GitCommitReviewList> {
    if (mergeBase !== null) objectId(mergeBase);
    if (head !== null) objectId(head);
    const commits = mergeBase === null || head === null ? [] : commitRows(await this.read([
      "log", "--no-patch", "--no-renames", "--no-decorate", "--no-show-signature", "--max-count=100", `--format=${metadataFormat}`, "-z", `${mergeBase}..${head}`, "--",
    ]));
    if (commits.length > 100) throw invalid();
    return { repositoryId: this.repositoryId, head, mergeBase, commits };
  }
  private selection(input: GitCommitReviewSelection): GitCommitReviewSelection {
    const selection = parseGitCommitReviewSelection(input);
    if (selection.repositoryId !== this.repositoryId) throw new WorkspaceError("WORKSPACE_CHANGED", "The Commit review repository changed. Select the commit again.");
    return selection;
  }
  private async comparison(selection: GitCommitReviewSelection) {
    const output = await this.read(["log", "--no-walk=unsorted", "--max-count=1", "--no-patch", "--no-renames", "--no-show-signature", "--no-decorate", `--format=%P%x00${metadataFormat}`, selection.commit, "--"]);
    const split = output.indexOf("\0");
    if (split < 0) throw invalid();
    const parentText = output.slice(0, split), parents = parentText ? parentText.split(" ") : [], commits = commitRows(output.slice(split + 1));
    if (!parents.every(parent => gitObjectId.test(parent) && parent.length === selection.commit.length) || commits.length !== 1 || commits[0]!.commit !== selection.commit) throw invalid();
    const parent = parents[0] ?? null;
    // Compute the object-format-specific empty tree without writing an object.
    const base = parent ?? createHash(selection.commit.length === 64 ? "sha256" : "sha1").update("tree 0\0").digest("hex");
    return { parent, base, commit: commits[0]! };
  }
  async inspect(input: GitCommitReviewSelection): Promise<GitCommitReviewSnapshot> {
    const selection = this.selection(input), { parent, base, commit } = await this.comparison(selection);
    const output = await this.read(["diff", ...diffOptions, "--raw", "--no-abbrev", "--numstat", "-z", base, selection.commit, "--"]);
    return { selection, commit, parent, files: reviewFiles(output, selection.commit.length) };
  }
  /** The summary supplies both names for renames. Historical paths never require live files. */
  async file(input: GitCommitReviewSelection, requested: GitCommitReviewPath, context = 3): Promise<GitCommitReviewDiff> {
    const selection = this.selection(input), path = parseGitCommitReviewPath(requested);
    if (!Number.isSafeInteger(context) || context < 0 || context > 1000) throw new Error("Invalid diff context.");
    const { parent, base } = await this.comparison(selection);
    const paths = path.previousPath && path.previousPath !== path.path ? [path.previousPath, path.path] : [path.path];
    const patch = await this.read(["diff", ...diffOptions, "--full-index", `--unified=${context}`, base, selection.commit, "--", ...paths]);
    return { selection, parent, path: path.path, patch };
  }
}
