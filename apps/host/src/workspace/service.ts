import type { ContentMetadata, WorkspaceEntry, WorkspacePathContext, TextDocument, FileContent, FileWriteInput, FileWriteResult, GitStatus, GitStatusEntry, GitBranch, GitDiff, GitDiffOptions, GitReviewSummary, GitCommitResult, GitWorktree, CreateWorktreeOptions, WorktreeStartingState } from "../../../../packages/shared/src/workspace";
export type * from "../../../../packages/shared/src/workspace";

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync, statSync } from "node:fs";
import { access, copyFile, link, lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rm, rmdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { fuzzyFind } from "@oh-my-pi/pi-natives";
import { searchGitBranches } from "./branch-presentation-search";
import type { GitRepositoryWatchContext } from "./repository-watch";
import type { RecentBranchCache } from "./recent-branch-cache";
import type { DefaultBranchCache } from "./default-branch-cache";

export interface BranchReadOptions {
  cache: RecentBranchCache;
  defaults?: DefaultBranchCache;
  isLive?(context: GitRepositoryWatchContext): boolean;
}
import { parseWorktreeStartingState } from "../../../../packages/shared/src/new-chat";
import { readCheckoutConflict } from "./checkout-conflict";
import type { GitPreparedPushInput, GitPreparedPushResult } from "./git-push";
import type { GitSelectionSummary } from "../../../../packages/shared/src/git-submissions";
import { parseGitRecentBranchesLimit, parseGitResolvedRevision, parseGitRevisionExpression, type GitResolvedRevision, type GitCheckoutTarget, parseGitBranchSearch, parseGitBranchSelection, type GitBranchSelection } from "../../../../packages/shared/src/workspace-protocol";

const execute = promisify(execFile);
const FILE_COPY_CHUNK_BYTES = 1024 * 1024;
const FILE_SEARCH_TIMEOUT_MS = 1000;
const editTails = new Map<string, Promise<void>>();
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface GitWorkspaceContext {
  gitRoot: string;
  workspaceRelativePath: string;
}

/** Host-private proof that a managed worktree was durably captured before cleanup. */
export interface ManagedWorktreeSnapshotReceipt {
  version: 1;
  worktreePath: string;
  worktreeGitDir: string;
  commonGitDir: string;
  worktreeIdentity: { dev: number; ino: number };
  worktreeGitDirIdentity: { dev: number; ino: number };
  head: string;
  branch: string | null;
  detached: boolean;
  snapshotRef: string;
  snapshotCommit: string;
}

export type GitCommitSelectionMode = "staged" | "include-unstaged";

/** Host-private immutable input prepared for later message generation and commit submission. */
export interface PreparedGitCommitSelection {
  readonly mode: GitCommitSelectionMode;
  readonly reviewedRevision: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly selectedTree: string;
  readonly selectedPaths: readonly string[];
  readonly diff: string;
  readonly stat: string;
  readonly numstat: string;
  readonly privateIndexPath: string;
  assertCurrent(): Promise<void>;
  dispose(): Promise<void>;
}

export interface PreparedGitCommitResult extends GitCommitResult {
  reviewedTree: string;
  committedTree: string;
  publishedIndexTree: string;
}

type PreparedSelectionState = "active" | "committing" | "consumed" | "unknown" | "disposed";
interface PreparedSelectionRecord {
  owner: WorkspaceService;
  state: PreparedSelectionState;
  temporary: string;
  reviewed: { head: string | null; revision: string };
  branch: string | null;
  indexPath: string;
  liveIndexBytes: Uint8Array | null;
  privateIndexPath: string;
  privateIndexBytes: Uint8Array;
  expectedWorking: string | null;
}
const preparedSelections = new WeakMap<PreparedGitCommitSelection, PreparedSelectionRecord>();

export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WorkspaceError"; }
}

/** A confirmed checkout refusal, distinct from an uncertain dispatched mutation.
 * Consumers must retain the original action and require an explicit commit flow. */
export class GitCheckoutBlockedError extends WorkspaceError {
  constructor(message: string, readonly conflictedPaths: string[]) {
    super("GIT_CHECKOUT_BLOCKED", message);
  }
}

class GitProcessError extends WorkspaceError {
  constructor(message: string, readonly exitCode: number | undefined, readonly output: string) {
    super("GIT_FAILED", message);
  }
}

function throwCheckoutFailure(error: unknown): never {
  if (error instanceof GitProcessError && error.exitCode === 1) {
    const conflict = readCheckoutConflict(error.output);
    if (conflict) throw new GitCheckoutBlockedError(error.message, conflict.conflictedPaths);
  }
  throw error;
}


function within(root: string, path: string): boolean { return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep); }
function relativePath(path: string): string {
  if (typeof path !== "string" || path.includes("\0") || isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes("\\")) {
    throw new WorkspaceError("OUTSIDE_WORKSPACE", "A relative path within the owning workspace is required.");
  }
  return path || ".";
}
async function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const pending = (editTails.get(key) ?? Promise.resolve()).then(operation);
  const settled = pending.then(() => {}, () => {});
  editTails.set(key, settled);
  void settled.then(() => { if (editTails.get(key) === settled) editTails.delete(key); });
  return pending;
}

function decode(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new WorkspaceError("INVALID_GIT_ENCODING", "Git output contains filenames or metadata that are not valid UTF-8."); }
}

function reviewNumstat(output: string): GitReviewSummary["files"] {
  if (!output) return [];
  const invalid = () => new WorkspaceError("GIT_FAILED", "Git returned invalid review statistics.");
  if (!output.endsWith("\0")) throw invalid();
  const records = output.slice(0, -1).split("\0"), files: GitReviewSummary["files"] = [];
  let totalAdditions = 0, totalDeletions = 0;
  for (let index = 0; index < records.length; index++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(records[index]!);
    if (!match || (match[1] === "-") !== (match[2] === "-")) throw invalid();
    const renamed = match[3] === "", previousPath = renamed ? records[++index] : null, path = renamed ? records[++index] : match[3];
    if (!path || renamed && !previousPath) throw invalid();
    const additions = match[1] === "-" ? null : Number(match[1]), deletions = match[2] === "-" ? null : Number(match[2]);
    totalAdditions += additions ?? 0; totalDeletions += deletions ?? 0;
    if (![additions ?? 0, deletions ?? 0, totalAdditions, totalDeletions].every(Number.isSafeInteger)) throw invalid();
    files.push({ path, previousPath: previousPath ?? null, additions, deletions });
  }
  return files;
}

/** One owning directory; every caller-supplied file path is relative to it. */
export class WorkspaceService {
  readonly cwd: string;
  readonly worktreeRoot?: string;
  private readonly maxTextBytes: number;
  private readonly gitTimeoutMs: number;
  private readonly cwdIdentity: { dev: number; ino: number };

  constructor(cwd: string, options: { worktreeRoot?: string; maxTextBytes?: number; gitTimeoutMs?: number } = {}) {
    this.cwd = realpathSync(cwd);
    const cwdMetadata = statSync(this.cwd);
    if (!cwdMetadata.isDirectory()) throw new WorkspaceError("NOT_DIRECTORY", "The workspace must be an existing directory.");
    this.cwdIdentity = { dev: cwdMetadata.dev, ino: cwdMetadata.ino };
    if (options.worktreeRoot && !isAbsolute(options.worktreeRoot)) throw new WorkspaceError("INVALID_WORKTREE_ROOT", "The host must provide an absolute managed worktree root.");
    this.worktreeRoot = options.worktreeRoot && resolve(options.worktreeRoot);
    this.maxTextBytes = options.maxTextBytes ?? 2 * 1024 * 1024;
    this.gitTimeoutMs = options.gitTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.maxTextBytes) || this.maxTextBytes < 1 || this.maxTextBytes > 64 * 1024 * 1024) throw new WorkspaceError("INVALID_LIMIT", "Text size limit must be between 1 byte and 64 MiB.");
    if (!Number.isSafeInteger(this.gitTimeoutMs) || this.gitTimeoutMs < 1) throw new WorkspaceError("INVALID_LIMIT", "Git timeout must be a positive integer.");
  }

  private async owned(path: string, root = this.cwd): Promise<string> {
    const target = await realpath(resolve(root, relativePath(path)));
    if (!within(root, target)) throw new WorkspaceError("OUTSIDE_WORKSPACE", "The path resolves outside its owning workspace.");
    return target;
  }

  private async parentOwned(path: string, root = this.cwd): Promise<string> {
    const target = resolve(root, relativePath(path));
    if (target === root) return root;
    const parent = await this.owned(relative(root, dirname(target)), root);
    return join(parent, basename(target));
  }

  private async assertWorkspaceIdentity(message: string): Promise<void> {
    let metadata, canonical;
    try { metadata = await lstat(this.cwd); canonical = await realpath(this.cwd); }
    catch { throw new WorkspaceError("PATH_CHANGED", message); }
    if (!metadata.isDirectory() || metadata.dev !== this.cwdIdentity.dev || metadata.ino !== this.cwdIdentity.ino || canonical !== this.cwd) {
      throw new WorkspaceError("PATH_CHANGED", message);
    }
  }

  /** Resolve an existing regular file without granting access beyond this workspace. */
  async externalFilePath(path: string): Promise<string> {
    const changed = "The selected workspace changed identity. Reopen it before opening a file externally.";
    await this.assertWorkspaceIdentity(changed);
    const target = await this.owned(path);
    const initial = await stat(target);
    if (!initial.isFile()) throw new WorkspaceError("NOT_REGULAR_FILE", "Only a regular workspace file can be opened externally.");
    await this.assertWorkspaceIdentity(changed);
    const currentPath = await realpath(target), current = await stat(currentPath);
    if (currentPath !== target || !current.isFile() || current.dev !== initial.dev || current.ino !== initial.ino) {
      throw new WorkspaceError("PATH_CHANGED", "The file changed identity while preparing its external application. Refresh before retrying.");
    }
    return target;
  }

  private copyRevision(metadata: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
    return createHash("sha256").update([metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(":"), "utf8").digest("hex");
  }

  private async verifyCopyPath(path: string, target: string, expected: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): Promise<void> {
    const changed = "The source file changed while it was being copied. Choose Save as again.";
    await this.assertWorkspaceIdentity(changed);
    let currentPath: string, current;
    try { currentPath = await this.owned(path); current = await stat(currentPath, { bigint: true }); }
    catch { throw new WorkspaceError("FILE_COPY_CHANGED", changed); }
    if (currentPath !== target || !current.isFile() || this.copyRevision(current) !== this.copyRevision(expected)) {
      throw new WorkspaceError("FILE_COPY_CHANGED", changed);
    }
  }

  private async copyFile(path: string) {
    const changed = "The source file changed while it was being copied. Choose Save as again.";
    await this.assertWorkspaceIdentity(changed);
    const target = await this.owned(path);
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await file.stat({ bigint: true });
      if (!metadata.isFile()) throw new WorkspaceError("NOT_REGULAR_FILE", "Only a regular workspace file can be copied.");
      if (metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new WorkspaceError("FILE_TOO_LARGE", "This file is too large to copy safely.");
      await this.verifyCopyPath(path, target, metadata);
      return { file, target, metadata, size: Number(metadata.size), revision: this.copyRevision(metadata) };
    } catch (error) { await file.close(); throw error; }
  }

  async copyInfo(path: string): Promise<{ absolutePath: string; size: number; revision: string }> {
    const source = await this.copyFile(path);
    try {
      await this.verifyCopyPath(path, source.target, source.metadata);
      return { absolutePath: source.target, size: source.size, revision: source.revision };
    } finally { await source.file.close(); }
  }

  async copyChunk(path: string, revision: string, offset: number): Promise<{ size: number; revision: string; offset: number; dataBase64: string }> {
    if (!/^[a-f0-9]{64}$/.test(revision) || !Number.isSafeInteger(offset) || offset < 0) throw new WorkspaceError("INVALID_COPY_REQUEST", "An exact file revision and non-negative byte offset are required.");
    const source = await this.copyFile(path);
    try {
      if (source.revision !== revision) throw new WorkspaceError("FILE_COPY_CHANGED", "The source file changed before this copy chunk. Choose Save as again.");
      if (offset > source.size) throw new WorkspaceError("INVALID_COPY_OFFSET", "The file copy offset is beyond the end of the source file.");
      const buffer = Buffer.alloc(Math.min(FILE_COPY_CHUNK_BYTES, source.size - offset));
      let read = 0;
      while (read < buffer.length) {
        const result = await source.file.read(buffer, read, buffer.length - read, offset + read);
        if (!result.bytesRead) break;
        read += result.bytesRead;
      }
      const after = await source.file.stat({ bigint: true });
      if (read !== buffer.length || this.copyRevision(after) !== revision) throw new WorkspaceError("FILE_COPY_CHANGED", "The source file changed while this copy chunk was read. Choose Save as again.");
      await this.verifyCopyPath(path, source.target, source.metadata);
      return { size: source.size, revision, offset, dataBase64: buffer.toString("base64") };
    } finally { await source.file.close(); }
  }

  async stat(path: string): Promise<WorkspaceEntry> {
    const target = await this.parentOwned(path);
    const metadata = await lstat(target);
    const entry: WorkspaceEntry = { path: relative(this.cwd, target) || ".", name: basename(target),
      kind: metadata.isSymbolicLink() ? "symlink" : metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : "other",
      size: metadata.size, modifiedAt: metadata.mtimeMs, mode: metadata.mode & 0o777 };
    if (metadata.isSymbolicLink()) {
      entry.linkTarget = await readlink(target);
      try { entry.linkState = within(this.cwd, await realpath(target)) ? "inside" : "outside"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") entry.linkState = "missing"; else throw error; }
    }
    return entry;
  }

  async list(path = "."): Promise<WorkspaceEntry[]> {
    const directory = await this.owned(path);
    if (!(await stat(directory)).isDirectory()) throw new WorkspaceError("NOT_DIRECTORY", "The selected path is not a directory.");
    const names = await readdir(directory);
    if (names.length > 20_000) throw new WorkspaceError("DIRECTORY_TOO_LARGE", "The directory has more than 20000 entries.");
    const entries = await Promise.all(names.map(name => this.stat(relative(this.cwd, join(directory, name)))));
    return entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
  }

  private async pathRevision(target: string): Promise<string> {
    const metadata = await lstat(target, { bigint: true });
    const linkTarget = metadata.isSymbolicLink() ? await readlink(target) : "";
    return hash(Buffer.from(JSON.stringify({ dev: String(metadata.dev), ino: String(metadata.ino), mode: String(metadata.mode), size: String(metadata.size), mtimeNs: String(metadata.mtimeNs), ctimeNs: String(metadata.ctimeNs), linkTarget })));
  }

  /** Reviewable identity for a later rename/delete. Contents are never supplied by the client. */
  async pathContext(path: string): Promise<WorkspacePathContext> {
    if (relativePath(path) === ".") throw new WorkspaceError("WORKSPACE_ROOT", "The workspace root cannot be renamed or deleted.");
    await this.assertWorkspaceIdentity("The selected workspace changed. Reopen it before changing files.");
    const target = await this.parentOwned(path);
    const entry = await this.stat(path);
    await this.assertWorkspaceIdentity("The selected workspace changed. Reopen it before changing files.");
    return { entry, revision: await this.pathRevision(target) };
  }

  private async assertPathRevision(path: string, expectedRevision: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(expectedRevision)) throw new WorkspaceError("INVALID_REVISION", "An exact path revision is required.");
    const target = await this.parentOwned(path);
    if (await this.pathRevision(target) !== expectedRevision) throw new WorkspaceError("REVISION_CONFLICT", "The selected path changed. Refresh before trying again.");
    return target;
  }

  async createFile(path: string): Promise<WorkspacePathContext> {
    await this.assertWorkspaceIdentity("The selected workspace changed. Reopen it before creating a file.");
    const result = await this.writeText(path, { text: "", expectedRevision: null });
    if (!result.ok) throw new WorkspaceError("ALREADY_EXISTS", "A file or folder already exists at that path.");
    return this.pathContext(path);
  }

  async createDirectory(path: string): Promise<WorkspacePathContext> {
    await this.assertWorkspaceIdentity("The selected workspace changed. Reopen it before creating a folder.");
    const target = await this.parentOwned(path);
    return serialized(`file:${dirname(target)}`, async () => {
      await this.assertWorkspaceIdentity("The selected workspace changed. Reopen it before creating a folder.");
      const parent = await this.owned(relative(this.cwd, dirname(target)));
      if (parent !== dirname(target)) throw new WorkspaceError("PATH_CHANGED", "The destination folder changed. Refresh before trying again.");
      try { await mkdir(target, { mode: 0o755 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkspaceError("ALREADY_EXISTS", "A file or folder already exists at that path."); throw error; }
      return this.pathContext(path);
    });
  }

  async renamePath(path: string, destination: string, expectedRevision: string): Promise<WorkspacePathContext> {
    await this.assertWorkspaceIdentity("The selected workspace changed. Reopen it before renaming a path.");
    if (relativePath(destination) === ".") throw new WorkspaceError("WORKSPACE_ROOT", "Choose a name within the workspace.");
    await this.assertPathRevision(path, expectedRevision);
    const target = await this.parentOwned(destination);
    return serialized(`file:${this.cwd}`, async () => {
      await this.assertWorkspaceIdentity("The selected workspace changed. Reopen it before renaming a path.");
      const source = await this.assertPathRevision(path, expectedRevision);
      if (await lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; })) throw new WorkspaceError("ALREADY_EXISTS", "A file or folder already exists at the destination.");
      const parent = await this.owned(relative(this.cwd, dirname(target)));
      if (parent !== dirname(target)) throw new WorkspaceError("PATH_CHANGED", "The destination folder changed. Refresh before trying again.");
      await this.assertWorkspaceIdentity("The selected workspace changed. Reopen it before renaming a path.");
      await rename(source, target);
      return this.pathContext(destination);
    });
  }

  async deletePath(path: string, expectedRevision: string): Promise<void> {
    await this.assertWorkspaceIdentity("The selected workspace changed. Reopen it before deleting a path.");
    await serialized(`file:${this.cwd}`, async () => {
      await this.assertWorkspaceIdentity("The selected workspace changed. Reopen it before deleting a path.");
      const target = await this.assertPathRevision(path, expectedRevision), metadata = await lstat(target);
      if (metadata.isDirectory()) {
        try { await rmdir(target); }
        catch (error) { if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new WorkspaceError("DIRECTORY_NOT_EMPTY", "This folder is not empty. Remove its contents before deleting it."); throw error; }
      }
      else if (metadata.isFile() || metadata.isSymbolicLink()) await unlink(target);
      else throw new WorkspaceError("UNSUPPORTED_PATH", "Only files, links, and empty folders can be deleted here.");
    });
  }

  /** Bounded, owner-confined filename search for the command-menu Files action. */
  async searchFiles(query: string, limit = 50): Promise<{ entries: Array<WorkspaceEntry & { score: number }>; nativeTotalMatches: number; status: "complete" | "truncated" }> {
    if (typeof query !== "string" || !query.trim() || query.length > 512 || /[\0\r\n]/.test(query)) throw new WorkspaceError("INVALID_SEARCH", "A nonempty file search query of at most 512 characters is required.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WorkspaceError("INVALID_SEARCH", "A file search limit must be between 1 and 100.");
    const text = query.trim();
    await this.assertWorkspaceIdentity("The selected workspace changed before file search. Reopen it before searching.");
    const signal = AbortSignal.timeout(FILE_SEARCH_TIMEOUT_MS);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let result;
    try {
      result = await Promise.race([
        fuzzyFind({ query: text, path: this.cwd, hidden: false, gitignore: true, cache: false, maxResults: limit, signal, timeoutMs: FILE_SEARCH_TIMEOUT_MS }),
        new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new WorkspaceError("SEARCH_TIMED_OUT", "File search exceeded its 1000 ms limit. Refine the query and try again.")), FILE_SEARCH_TIMEOUT_MS); }),
      ]);
    } finally { if (deadline) clearTimeout(deadline); }
    if (signal.aborted) throw new WorkspaceError("SEARCH_TIMED_OUT", "File search exceeded its 1000 ms limit. Refine the query and try again.");
    await this.assertWorkspaceIdentity("The selected workspace changed during file search. Reopen it before using results.");
    const entries: Array<WorkspaceEntry & { score: number }> = [];
    for (const match of result.matches) {
      try {
        const entry = await this.stat(match.path);
        // The command menu opens previews. Keep a symlink only when its resolved
        // target is an inside-root regular file; never follow directory links.
        if (entry.kind === "symlink") {
          if (entry.linkState !== "inside" || !(await stat(await this.owned(entry.path))).isFile()) continue;
        } else if (entry.kind !== "file") continue;
        entries.push({ ...entry, score: match.score });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await this.assertWorkspaceIdentity("The selected workspace changed during file search. Reopen it before using results.");
    return { entries, nativeTotalMatches: result.totalMatches, status: result.totalMatches > result.matches.length ? "truncated" : "complete" };
  }

  async readText(path: string): Promise<FileContent> {
    const target = await this.owned(path);
    if (!(await stat(target)).isFile()) throw new WorkspaceError("NOT_REGULAR_FILE", "Text reading supports regular files only.");
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const initial = await file.stat();
      if (!initial.isFile()) throw new WorkspaceError("NOT_REGULAR_FILE", "Text reading supports regular files only.");
      const resolvedAgain = await realpath(target);
      const current = await stat(resolvedAgain);
      if (!within(this.cwd, resolvedAgain) || current.ino !== initial.ino || current.dev !== initial.dev) throw new WorkspaceError("PATH_CHANGED", "The file changed identity while opening it. Refresh before retrying.");
      const metadata: ContentMetadata = { path: relative(this.cwd, target), size: initial.size, modifiedAt: initial.mtimeMs, mode: initial.mode & 0o777 };
      if (initial.size > this.maxTextBytes) return { ...metadata, kind: "too-large", revision: null, maximumBytes: this.maxTextBytes };
      const buffer = Buffer.alloc(Math.min(initial.size + 1, this.maxTextBytes + 1));
      let count = 0;
      while (count < buffer.length) {
        const result = await file.read(buffer, count, buffer.length - count, count);
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      const after = await file.stat();
      if (after.size > this.maxTextBytes) return { ...metadata, size: after.size, kind: "too-large", revision: null, maximumBytes: this.maxTextBytes };
      if (after.size !== count || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs) throw new WorkspaceError("FILE_CHANGED", "The file changed during reading. Refresh before retrying.");
      const bytes = buffer.subarray(0, count);
      const revision = hash(bytes);
      const encoding = bytes.subarray(0, 4).equals(Buffer.from([0xff, 0xfe, 0, 0])) ? "utf32le"
        : bytes.subarray(0, 4).equals(Buffer.from([0, 0, 0xfe, 0xff])) ? "utf32be"
        : bytes[0] === 0xff && bytes[1] === 0xfe ? "utf16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf16be" : undefined;
      if (encoding) return { ...metadata, kind: "unsupported-encoding", revision, encoding };
      if (bytes.includes(0)) return { ...metadata, kind: "binary", revision };
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { return { ...metadata, kind: "binary", revision }; }
      return { ...metadata, kind: "text", text, revision, encoding: "utf8", bom: bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) };
    } finally { await file.close(); }
  }

  private async currentText(path: string): Promise<FileContent | null> {
    try { return await this.readText(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  async writeText(path: string, input: FileWriteInput): Promise<FileWriteResult> {
    if (typeof input.text !== "string" || (input.expectedRevision !== null && !/^[a-f0-9]{64}$/.test(input.expectedRevision))) throw new WorkspaceError("INVALID_REVISION", "A text value and its exact SHA-256 revision (or null for a new file) are required.");
    await this.assertWorkspaceIdentity("The selected workspace changed. Reopen it before saving a file.");
    const lexical = await this.parentOwned(path);
    let target: string;
    try { target = await this.owned(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { if ((await lstat(lexical).catch(() => null))?.isSymbolicLink()) throw new WorkspaceError("BROKEN_SYMLINK", "Cannot save through a broken symlink."); target = lexical; } else throw error; }
    return serialized(`file:${target}`, async () => {
      await this.assertWorkspaceIdentity("The selected workspace changed. Reopen it before saving a file.");
      const current = await this.currentText(relative(this.cwd, target));
      if ((current?.revision ?? null) !== input.expectedRevision || (current !== null && input.expectedRevision === null)) return { ok: false, code: "REVISION_CONFLICT", current };
      if (current && current.kind !== "text") throw new WorkspaceError("NOT_UTF8_TEXT", "This file is not editable UTF-8 text.");
      const bytes = Buffer.from((input.bom ?? current?.bom ? "\uFEFF" : "") + input.text, "utf8");
      if (bytes.length > this.maxTextBytes) throw new WorkspaceError("FILE_TOO_LARGE", `Text exceeds the ${this.maxTextBytes}-byte editor limit.`);
      if (bytes.includes(0)) throw new WorkspaceError("BINARY_CONTENT", "Text writes cannot contain NUL bytes.");
      const before = current ? await stat(target) : undefined;
      if (current) await access(target, constants.W_OK);
      const parent = await this.owned(relative(this.cwd, dirname(target)));
      if (parent !== dirname(target)) throw new WorkspaceError("PATH_CHANGED", "The destination directory changed. Refresh before saving.");
      const temporary = join(parent, `.agent-desktop-save-${randomUUID()}`);
      const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, before ? before.mode & 0o777 : 0o644);
      try {
        if (before) { await file.chmod(before.mode & 0o777); const tempMetadata = await file.stat(); if (tempMetadata.uid !== before.uid || tempMetadata.gid !== before.gid) await file.chown(before.uid, before.gid); }
        await file.writeFile(bytes);
        await file.sync();
        await file.close();
        const latest = await this.currentText(relative(this.cwd, target));
        if ((latest?.revision ?? null) !== input.expectedRevision || (latest !== null && input.expectedRevision === null)) return { ok: false, code: "REVISION_CONFLICT", current: latest };
        if (await this.owned(relative(this.cwd, parent)) !== parent) throw new WorkspaceError("PATH_CHANGED", "The destination directory changed. Refresh before saving.");
        await this.assertWorkspaceIdentity("The selected workspace changed. Reopen it before saving a file.");
        if (current) await rename(temporary, target);
        else {
          try { await link(temporary, target); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return { ok: false, code: "REVISION_CONFLICT", current: await this.currentText(relative(this.cwd, target)) }; throw error; }
        }
        const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
        try { await directory.sync(); } finally { await directory.close(); }
        const written = await this.readText(relative(this.cwd, target));
        if (written.kind !== "text" || written.revision !== hash(bytes)) throw new WorkspaceError("FILE_CHANGED", "The file changed immediately after saving. Refresh its contents.");
        return { ok: true, document: written };
      } finally { await file.close(); await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
    });
  }

  private async git(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; validExitCodes?: number[]; timeoutMs?: number; signal?: AbortSignal; assertCurrent?: () => void } = {}): Promise<{ stdout: string; exitCode: number }> {
    options.assertCurrent?.();
    const command = ["--no-pager", "--literal-pathspecs", "-c", "color.ui=false", "-C", options.cwd ?? this.cwd, ...args];
    try {
      const result = await execute("git", command, { encoding: "buffer", timeout: Math.min(this.gitTimeoutMs, options.timeoutMs ?? this.gitTimeoutMs), maxBuffer: 8 * 1024 * 1024, signal: options.signal, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...options.env } });
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
      return { stdout: decode(result.stdout), exitCode: 0 };
    } catch (error) {
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
      if (error instanceof WorkspaceError) throw error;
      const failure = error as Error & { code?: number | string; killed?: boolean; stdout?: Buffer; stderr?: Buffer };
      if (typeof failure.code === "number" && options.validExitCodes?.includes(failure.code)) return { stdout: decode(failure.stdout ?? Buffer.alloc(0)), exitCode: failure.code };
      if (failure.killed) throw new WorkspaceError("GIT_TIMEOUT", "Git exceeded its time limit. Inspect repository state before retrying a mutation.");
      if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new WorkspaceError("GIT_OUTPUT_TOO_LARGE", "Git output exceeds 8 MiB. Select a narrower path.");
      const detail = failure.stderr ? new TextDecoder().decode(failure.stderr).trim().slice(0, 32_000) : failure.message;
      throw new GitProcessError(detail || "Git failed.", typeof failure.code === "number" ? failure.code : undefined,
        [failure.stderr, failure.stdout].filter(Boolean).map(bytes => new TextDecoder().decode(bytes)).join("\n"));
    }
  }

  private async requireGitRoot(signal?: AbortSignal): Promise<void> {
    if ((await this.gitWorkspaceContext(signal)).gitRoot !== this.cwd) throw new WorkspaceError("GIT_ROOT_OUTSIDE_WORKSPACE", "Select the repository root before performing Git operations.");
  }

  /** Canonical repository ownership and the selected workspace's path within it. This does not broaden file access. */
  async gitWorkspaceContext(signal?: AbortSignal): Promise<GitWorkspaceContext> {
    const assertWorkspaceIdentity = async () => {
      signal?.throwIfAborted();
      let current, canonical;
      try { current = await lstat(this.cwd); canonical = await realpath(this.cwd); }
      catch { throw new WorkspaceError("PATH_CHANGED", "The selected workspace changed identity. Reopen it before resolving Git context."); }
      if (!current.isDirectory() || current.dev !== this.cwdIdentity.dev || current.ino !== this.cwdIdentity.ino || canonical !== this.cwd) {
        throw new WorkspaceError("PATH_CHANGED", "The selected workspace changed identity. Reopen it before resolving Git context.");
      }
    };
    await assertWorkspaceIdentity();
    const top = (await this.git(["rev-parse", "--show-toplevel"], { signal })).stdout.replace(/\r?\n$/, "");
    const gitRoot = await realpath(top);
    await assertWorkspaceIdentity();
    if (!(await stat(gitRoot)).isDirectory() || !within(gitRoot, this.cwd)) {
      throw new WorkspaceError("GIT_ROOT_OUTSIDE_WORKSPACE", "The selected workspace resolves outside its Git repository root.");
    }
    return { gitRoot, workspaceRelativePath: relative(gitRoot, this.cwd) };
  }

  /** Explicitly enter repository-wide Git/worktree authority while retaining this service's host-owned limits. */
  async gitRootService(signal?: AbortSignal): Promise<WorkspaceService> {
    const { gitRoot } = await this.gitWorkspaceContext(signal);
    return new WorkspaceService(gitRoot, { worktreeRoot: this.worktreeRoot, maxTextBytes: this.maxTextBytes, gitTimeoutMs: this.gitTimeoutMs });
  }

  /** Resolve shared refs and per-worktree metadata using Git, including unborn
   * repositories where the index/current ref need not exist yet. No watch is
   * started here; a subscription must retain and revalidate its catalog owner. */
  async repositoryWatchContext(signal?: AbortSignal): Promise<GitRepositoryWatchContext> {
    return (await this.repositoryReadContext(signal)).context;
  }
  private async repositoryReadContext(signal?: AbortSignal) {
    const changed = "The repository changed while resolving its watch paths. Refresh before subscribing.";
    const readPaths = async () => {
      signal?.throwIfAborted();
      await this.assertWorkspaceIdentity(changed);
      const { gitRoot: root } = await this.gitWorkspaceContext(signal);
      const paths = await Promise.all([
        ["--absolute-git-dir"], ["--git-common-dir"], ["--git-path", "HEAD"], ["--git-path", "index"],
      ].map(async args => {
        const path = (await this.git(["rev-parse", "--path-format=absolute", ...args], { signal })).stdout.replace(/\r?\n$/, "");
        if (!path || !isAbsolute(path) || path.includes("\0")) throw new WorkspaceError("GIT_FAILED", "Git returned an invalid repository watch path.");
        return path;
      }));
      const gitDir = await realpath(paths[0]!), commonDir = await realpath(paths[1]!);
      // Canonicalize existing parents without requiring unborn metadata files.
      const headPath = join(await realpath(dirname(paths[2]!)), basename(paths[2]!));
      const indexPath = join(await realpath(dirname(paths[3]!)), basename(paths[3]!));
      const identity = await Promise.all([...new Set([root, gitDir, commonDir, dirname(headPath), dirname(indexPath)])].map(async path => {
        const metadata = await stat(path);
        if (!metadata.isDirectory()) throw new WorkspaceError("PATH_CHANGED", changed);
        return { path, dev: metadata.dev, ino: metadata.ino };
      }));
      signal?.throwIfAborted();
      return { paths: { root, gitDir, commonDir, headPath, indexPath }, identity };
    };
    const before = await readPaths();
    const symbolic = await this.git(["symbolic-ref", "--quiet", "HEAD"], { validExitCodes: [1], signal });
    const headRef = symbolic.exitCode === 1 ? null : symbolic.stdout.replace(/\r?\n$/, "");
    if (headRef !== null && (!headRef.startsWith("refs/") || headRef.includes("\0") || /[\r\n]/.test(headRef)))
      throw new WorkspaceError("GIT_FAILED", "Git returned an invalid symbolic HEAD.");
    const after = await readPaths();
    await this.assertWorkspaceIdentity(changed);
    signal?.throwIfAborted();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new WorkspaceError("PATH_CHANGED", changed);
    return { context: { ...after.paths, headRef }, identity: JSON.stringify(after) };
  }

  /** Content revision of HEAD and the index, independent of working-file edits. */
  private async indexState(): Promise<{ head: string | null; revision: string }> {
    const resolved = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], { validExitCodes: [1] });
    const head = resolved.exitCode === 0 ? resolved.stdout.trim() : null;
    if (!head) {
      // A missing commit is safe only for a genuinely unborn branch, never a corrupt HEAD.
      const symbolic = (await this.git(["symbolic-ref", "--quiet", "HEAD"])).stdout.trim();
      if (!symbolic.startsWith("refs/heads/") || (await this.git(["show-ref", "--verify", "--quiet", symbolic], { validExitCodes: [1] })).exitCode !== 1) {
        throw new WorkspaceError("INVALID_GIT_HEAD", "Git HEAD cannot be resolved to a commit or an unborn branch.");
      }
    }
    const index = (await this.git(["ls-files", "--stage", "-z"])).stdout;
    return { head, revision: hash(Buffer.from(JSON.stringify([head, index]))) };
  }

  private async checkIndexRevision(expectedRevision?: string): Promise<{ head: string | null; revision: string }> {
    if (expectedRevision !== undefined && (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision))) throw new WorkspaceError("INVALID_REVISION", "An exact SHA-256 Git revision is required.");
    const current = await this.indexState();
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new WorkspaceError("GIT_REVISION_CONFLICT", "The Git index or HEAD changed since this review. Refresh before changing Git state.");
    return current;
  }

  private async gitPaths(paths: string[]): Promise<string[]> {
    if (!paths.length) throw new WorkspaceError("PATHS_REQUIRED", "Select at least one path.");
    return Promise.all(paths.map(async path => {
      const lexical = resolve(this.cwd, relativePath(path));
      if (lexical === this.cwd) return ".";
      let ancestor = dirname(lexical);
      const missing: string[] = [];
      let canonical: string;
      for (;;) {
        try { canonical = await realpath(ancestor); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || ancestor === this.cwd) throw error;
          missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
        }
      }
      if (!within(this.cwd, canonical)) throw new WorkspaceError("OUTSIDE_WORKSPACE", "The Git path resolves outside its owning workspace.");
      const target = join(canonical, ...missing, basename(lexical));
      return relative(this.cwd, target) || ".";
    }));
  }

  async gitStatus(): Promise<GitStatus> {
    return serialized(`git:${this.cwd}`, () => this.readGitStatus());
  }

  /** Proves whether the selected workspace resolves to a repository without classifying Git stderr. */
  async gitRepositoryAvailability(): Promise<"repository" | "not-repository"> {
    try { await this.gitWorkspaceContext(); return "repository"; }
    catch (cause) {
      // `gitWorkspaceContext()` is the ownership proof used by status. Exit 128
      // alone is not absence: a corrupt ancestor repository can report it too.
      if (!(cause instanceof GitProcessError) || cause.exitCode !== 128 || !await this.canProveNoDiscoverableRepository()) throw cause;
      return "not-repository";
    }
  }

  /** Conservative filesystem counterpart to Git's default upward discovery. */
  private async canProveNoDiscoverableRepository(): Promise<boolean> {
    // Git discovery can be redirected or bounded by these process settings.
    // Without reproducing every Git environment rule, retain the original error.
    if (["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"]
      .some(name => process.env[name] !== undefined)) return false;
    let directory = this.cwd, device = (await lstat(directory)).dev;
    for (;;) {
      if (await this.pathExists(join(directory, ".git")) || await this.isBareRepositoryDirectory(directory)) return false;
      const parent = dirname(directory);
      if (parent === directory) return true;
      const metadata = await lstat(parent);
      // Default Git discovery stops before crossing a filesystem boundary.
      if (metadata.dev !== device) return true;
      directory = parent; device = metadata.dev;
    }
  }

  private async isBareRepositoryDirectory(directory: string): Promise<boolean> {
    return await this.pathExists(join(directory, "HEAD")) && await this.pathExists(join(directory, "objects"));
  }

  private async pathExists(path: string): Promise<boolean> {
    try { await lstat(path); return true; }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    }
  }

  private async readGitStatus(): Promise<GitStatus> {
    await this.requireGitRoot();
    let snapshot: { revision: string; output: string } | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.indexState();
      const output = (await this.git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])).stdout;
      if ((await this.indexState()).revision === before.revision) { snapshot = { revision: before.revision, output }; break; }
    }
    if (!snapshot) throw new WorkspaceError("GIT_CHANGED", "The Git index or HEAD kept changing during inspection. Refresh before reviewing.");
    const records = snapshot.output.split("\0");
    const result: GitStatus = { revision: snapshot.revision, branch: null, head: null, upstream: null, ahead: 0, behind: 0, entries: [] };
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      if (!record) continue;
      if (record.startsWith("# branch.head ")) { const value = record.slice(14); result.branch = value === "(detached)" ? null : value; }
      else if (record.startsWith("# branch.oid ")) { const value = record.slice(13); result.head = value === "(initial)" ? null : value; }
      else if (record.startsWith("# branch.upstream ")) result.upstream = record.slice(18);
      else if (record.startsWith("# branch.ab ")) { const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record); if (counts) { result.ahead = Number(counts[1]); result.behind = Number(counts[2]); } }
      else if (record.startsWith("? ")) result.entries.push({ path: record.slice(2), indexStatus: "?", worktreeStatus: "?", kind: "untracked", submodule: false });
      else if (/^[12u] /.test(record)) {
        const fields = record.split(" ");
        const count = fields[0] === "1" ? 8 : fields[0] === "2" ? 9 : 10;
        const path = fields.slice(count).join(" ");
        const xy = fields[1]!;
        result.entries.push({ path, indexStatus: xy[0]!, worktreeStatus: xy[1]!, kind: fields[0] === "u" ? "conflict" : "tracked",
          submodule: fields[2]?.startsWith("S") ?? false, ...(fields[0] === "2" ? { originalPath: records[++index] } : {}) });
      }
    }
    return result;
  }

  async branches(): Promise<GitBranch[]> {
    await this.requireGitRoot();
    const output = (await this.git(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(symref)", "refs/heads", "refs/remotes"])).stdout;
    return output.split("\n").filter(Boolean).map(line => {
      const [ref, commit, head, upstream, symbolicTarget] = line.split("\0");
      return { name: ref!.replace(/^refs\/(heads|remotes)\//, ""), ref: ref!, commit: commit!, current: head === "*", remote: ref!.startsWith("refs/remotes/"), upstream: upstream || null, symbolicTarget: symbolicTarget || null };
    });
  }

  /** Pinned recent-branches means local branch tip committer-date order, not
   * checkout history. The cache stores the full scan before the caller's slice. */
  async recentBranches(limit?: number, signal?: AbortSignal, reads?: BranchReadOptions): Promise<string[]> {
    const bounded = parseGitRecentBranchesLimit(limit);
    await this.requireGitRoot(signal);
    const scan = async (signal?: AbortSignal) => {
      const { stdout } = await this.git(["for-each-ref", "--count=100", "--sort=-committerdate", "refs/heads", "--format=%(refname:short)"], { signal });
      return stdout.split("\n").map(name => name.trim()).filter(Boolean);
    };
    let branches: string[];
    if (reads) {
      const { context, identity } = await this.repositoryReadContext(signal);
      branches = await reads.cache.read(context.root, identity, reads.isLive?.(context) ?? false, scan, signal);
    } else branches = await scan(signal);
    signal?.throwIfAborted();
    return branches.slice(0, bounded);
  }

  /** Pinned base discovery checks each ordered remote. remote show may contact
   * that remote using host-native auth; a base branch always retains its remote. */
  async baseBranch(signal?: AbortSignal, cache?: DefaultBranchCache): Promise<{ local: string; remote: string } | null> {
    await this.requireGitRoot(signal);
    const proof = cache ? await this.repositoryReadContext(signal) : undefined;
    const root = proof?.context.root ?? this.cwd, identity = proof?.identity ?? "";
    const list = async (signal?: AbortSignal) => {
      const remotes = (await this.git(["remote"], { signal })).stdout.split("\n").map(name => name.trim()).filter(Boolean);
      return remotes.includes("origin") ? ["origin", ...remotes.filter(name => name !== "origin")] : remotes;
    };
    const ordered = cache ? await cache.orderedRemotes(root, identity, list, signal) : await list(signal);
    for (const remote of ordered) {
      signal?.throwIfAborted();
      const prefix = `refs/remotes/${remote}/`;
      const symbolic = async (signal?: AbortSignal) => {
        const result = await this.git(["symbolic-ref", "--quiet", `${prefix}HEAD`], { validExitCodes: [1], signal });
        const local = result.stdout.trim();
        return result.exitCode === 0 && local.startsWith(prefix) && local.length > prefix.length ? local.slice(prefix.length) : null;
      };
      const local = cache ? await cache.localDefault(root, identity, remote, symbolic, signal) : await symbolic(signal);
      if (local) return { local, remote };
      const advertisement = async (signal?: AbortSignal) => {
        const advertised = await this.git(["remote", "show", "--", remote], {
          signal, timeoutMs: 10_000, validExitCodes: [1, 128],
          env: { LC_ALL: "C", LC_MESSAGES: "C", LANGUAGE: "C", GIT_TERMINAL_PROMPT: "0" },
        });
        const name = advertised.exitCode === 0 ? /HEAD branch:\s*(.+)/.exec(advertised.stdout)?.[1]?.trim() : null;
        return name && name !== "(unknown)" ? name : null;
      };
      const advertised = cache ? await cache.advertisedDefault(root, identity, remote, advertisement, signal) : await advertisement(signal);
      if (advertised) return { local: advertised, remote };
      for (const name of ["main", "master"]) {
        const exists = async (signal?: AbortSignal) => (await this.git(["show-ref", "--verify", "--quiet", `${prefix}${name}`], { validExitCodes: [1], signal })).exitCode === 0;
        if (cache ? await cache.remoteBranch(root, identity, remote, name, exists, signal) : await exists(signal)) return { local: name, remote };
      }
    }
    return null;
  }

  /** Default naming uses the remote-backed base before its bounded local fallback. */
  async defaultBranch(signal?: AbortSignal, reads?: BranchReadOptions): Promise<string | null> {
    const base = await this.baseBranch(signal, reads?.defaults);
    if (base) return base.local;
    return (await this.recentBranches(10, signal, reads)).find(name => name === "main" || name === "master") ?? null;
  }

  /** Native current-checkout presentation, independent of target resolution. */
  async searchBranches(query: string, limit?: number): Promise<{ branches: GitBranch[]; limitReached: boolean }> {
    const input = parseGitBranchSearch(query, limit);
    await this.requireGitRoot();
    return searchGitBranches(this.cwd, input.query, input.limit, this.gitTimeoutMs);
  }

  /** Starting-state presentation preserves remote identity without resolving or fetching. */
  async searchStartingBranches(query: string, limit?: number): Promise<{ branches: GitBranch[]; limitReached: boolean }> {
    const input = parseGitBranchSearch(query, limit);
    await this.requireGitRoot();
    return searchGitBranches(this.cwd, input.query, input.limit, this.gitTimeoutMs, undefined, true);
  }

  async diff(options: GitDiffOptions = {}): Promise<GitDiff> {
    await this.requireGitRoot();
    const context = options.context ?? 3;
    if (!Number.isSafeInteger(context) || context < 0 || context > 1000) throw new WorkspaceError("INVALID_CONTEXT", "Diff context must be between 0 and 1000 lines.");
    const paths = options.path === undefined ? [] : await this.gitPaths([options.path]);
    const arguments_ = ["diff", "--no-ext-diff", "--no-textconv", `--unified=${context}`, ...(options.staged ? ["--cached"] : []), "--", ...paths];
    let patch: string;
    let binary: boolean;
    if (paths.length && !options.staged && (await this.git(["ls-files", "--error-unmatch", "--", ...paths], { validExitCodes: [1] })).exitCode === 1) {
      const target = await this.parentOwned(options.path!);
      patch = (await this.git(["diff", "--no-index", "--no-ext-diff", "--no-textconv", `--unified=${context}`, "--", "/dev/null", target], { validExitCodes: [1] })).stdout;
      binary = (await this.git(["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", target], { validExitCodes: [1] })).stdout.startsWith("-\t-\t");
    } else {
      patch = (await this.git(arguments_)).stdout;
      const stats = (await this.git(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", ...(options.staged ? ["--cached"] : []), "--", ...paths])).stdout;
      binary = stats.split("\0").some(record => record.startsWith("-\t-\t"));
    }
    return { patch, binary, staged: options.staged ?? false, ...(options.path === undefined ? {} : { path: options.path }) };
  }

  /** Staged and working changes are distinct review sources, even when they
   * cancel in the final commit tree. This never prepares or publishes an index. */
  async reviewSummary(source: GitReviewSummary["source"]): Promise<GitReviewSummary> {
    if (source !== "staged" && source !== "unstaged") throw new WorkspaceError("INVALID_REVIEW_SOURCE", "Choose staged or unstaged review changes.");
    return serialized(`git:${this.cwd}`, async () => {
      const before = await this.readGitStatus();
      const files = reviewNumstat((await this.git(["--no-lazy-fetch", "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--numstat", "-z",
        ...(source === "staged" ? ["--cached"] : []), "--"])).stdout);
      if (source === "unstaged") {
        // Unmerged records have unknown line counts, not a normal diff against
        // one arbitrarily selected index stage.
        for (const entry of before.entries.filter(entry => entry.kind === "conflict")) {
          for (let i = files.length - 1; i >= 0; i--) if (files[i]!.path === entry.path) files.splice(i, 1);
          files.push({ path: entry.path, previousPath: null, additions: null, deletions: null });
        }
        const deadline = Date.now() + this.gitTimeoutMs;
        for (const entry of before.entries.filter(entry => entry.kind === "untracked")) {
          const target = await this.parentOwned(entry.path), metadata = await lstat(target);
          if (!metadata.isFile() && !metadata.isSymbolicLink())
            throw new WorkspaceError("REVIEW_FILE_UNSUPPORTED", "Review statistics require regular files or symlinks. Inspect the untracked directory separately.");
          const timeoutMs = deadline - Date.now();
          if (timeoutMs <= 0) throw new WorkspaceError("GIT_TIMEOUT", "Untracked review statistics exceeded the read time limit.");
          const statOutput = await this.git(["--no-lazy-fetch", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--", "/dev/null", target], { validExitCodes: [1], timeoutMs });
          const rows = reviewNumstat(statOutput.stdout);
          // An empty regular file can have no numstat record. It still appears
          // in the review inventory, with known zero line changes.
          if (rows.length > 1 || rows.length === 0 && (metadata.isSymbolicLink() || metadata.size !== 0))
            throw new WorkspaceError("GIT_FAILED", "Git returned invalid statistics for an untracked review file.");
          const row = rows[0];
          files.push({ path: entry.path, previousPath: null, additions: row ? row.additions : 0, deletions: row ? row.deletions : 0 });
        }
      }
      const after = await this.readGitStatus();
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new WorkspaceError("GIT_CHANGED", "Git state changed while reading review statistics. Refresh the changes.");
      let additions = 0, deletions = 0;
      for (const file of files) { additions += file.additions ?? 0; deletions += file.deletions ?? 0; }
      if (![additions, deletions].every(Number.isSafeInteger)) throw new WorkspaceError("GIT_FAILED", "Review totals exceed the supported range.");
      return { source, revision: before.revision, files,
        stagedCount: before.entries.filter(entry => entry.kind !== "untracked" && entry.indexStatus !== ".").length,
        unstagedCount: before.entries.filter(entry => entry.kind !== "untracked" && entry.worktreeStatus !== ".").length,
        untrackedCount: before.entries.filter(entry => entry.kind === "untracked").length };
    });
  }

  async stage(paths: string[]): Promise<GitStatus> {
    return serialized(`git:${this.cwd}`, async () => { await this.requireGitRoot(); await this.git(["add", "--", ...await this.gitPaths(paths)]); return this.readGitStatus(); });
  }

  async unstage(paths: string[], expectedRevision?: string): Promise<GitStatus> {
    return serialized(`git:${this.cwd}`, async () => {
      await this.requireGitRoot();
      const normalized = await this.gitPaths(paths);
      const state = await this.checkIndexRevision(expectedRevision);
      await this.git(state.head === null ? ["rm", "--cached", "-r", "-f", "--ignore-unmatch", "--", ...normalized] : ["restore", "--staged", `--source=${state.head}`, "--", ...normalized]);
      return this.readGitStatus();
    });
  }

  async commit(message: string, expectedRevision?: string): Promise<GitCommitResult> {
    if (typeof message !== "string" || !message.trim() || message.includes("\0")) throw new WorkspaceError("INVALID_COMMIT_MESSAGE", "A nonempty commit message is required.");
    return serialized(`git:${this.cwd}`, async () => {
      await this.requireGitRoot();
      const before = await this.checkIndexRevision(expectedRevision);
      let result: { stdout: string; exitCode: number };
      try {
        result = await this.git(["commit", "--message", message]);
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === "OUTCOME_UNKNOWN") throw error;
        // A killed command or exhausted output buffer may return before Git and a
        // hook descendant have reached a stable state, even if HEAD is unchanged.
        if (error instanceof WorkspaceError && (error.code === "GIT_TIMEOUT" || error.code === "GIT_OUTPUT_TOO_LARGE")) {
          throw new WorkspaceError("OUTCOME_UNKNOWN", "Git did not return a reliable commit outcome. Inspect the repository before retrying.");
        }
        try {
          const observed = (await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], { validExitCodes: [1] })).stdout.trim() || null;
          if (observed === before.head) throw error;
        } catch (probeError) {
          if (probeError === error) throw error;
        }
        throw new WorkspaceError("OUTCOME_UNKNOWN", "Git did not return a reliable commit outcome. Inspect the repository before retrying.");
      }
      try {
        const receipt = /^\[[^\x00-\x20]+(?: [^\]\r\n]*)? ([0-9a-f]{4,64})\] /m.exec(result.stdout)?.[1];
        if (!receipt) throw new WorkspaceError("OUTCOME_UNKNOWN", "Git did not return a commit receipt that can be verified. Inspect the repository before retrying.");
        const commit = (await this.git(["rev-parse", "--verify", `${receipt}^{commit}`])).stdout.trim();
        const observed = (await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], { validExitCodes: [1] })).stdout.trim() || null;
        if (!commit || commit === before.head || observed !== commit) {
          throw new WorkspaceError("OUTCOME_UNKNOWN", "Git reported a commit, but its resulting HEAD does not verify that receipt. Inspect the repository before retrying.");
        }
        return { commit, summary: result.stdout.trim() };
      } catch { throw new WorkspaceError("OUTCOME_UNKNOWN", "Git reported a commit, but its resulting receipt could not be verified. Inspect the repository before retrying."); }
    });
  }

  /**
   * Capture an explicit commit selection in a private index. This is read-only
   * with respect to the live index, refs, and working tree; callers must dispose
   * the returned selection after generation or submission.
   */
  async prepareCommitSelection(mode: GitCommitSelectionMode, expectedRevision: string): Promise<PreparedGitCommitSelection> {
    return this.captureCommitSelection(mode, expectedRevision, false);
  }
  /** Summarize the same final tree used by commit preparation, including a validated empty selection. */
  async summarizeCommitSelection(mode: GitCommitSelectionMode, expectedRevision: string): Promise<GitSelectionSummary> {
    const selection = await this.captureCommitSelection(mode, expectedRevision, true);
    try {
      let additions = 0, deletions = 0, binaryFiles = 0, files = 0;
      for (const line of selection.numstat.split("\n").filter(Boolean)) {
        const match = /^(\d+|-)\t(\d+|-)\t.+$/.exec(line);
        if (!match || (match[1] === "-") !== (match[2] === "-")) throw new WorkspaceError("GIT_FAILED", "Git returned an invalid selection summary.");
        files++;
        if (match[1] === "-") binaryFiles++;
        else { additions += Number(match[1]); deletions += Number(match[2]); }
      }
      if (![additions, deletions, binaryFiles, files].every(Number.isSafeInteger)) throw new WorkspaceError("GIT_FAILED", "Git selection totals exceed the supported range.");
      return { selectionMode: mode, reviewedRevision: selection.reviewedRevision, selectedTree: selection.selectedTree, additions, deletions, binaryFiles, files };
    } finally { await selection.dispose(); }
  }
  private async captureCommitSelection(mode: GitCommitSelectionMode, expectedRevision: string, allowEmpty: boolean): Promise<PreparedGitCommitSelection> {
    if (mode !== "staged" && mode !== "include-unstaged") throw new WorkspaceError("INVALID_COMMIT_SELECTION", "Choose staged changes or staged and unstaged changes.");
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw new WorkspaceError("INVALID_REVISION", "An exact SHA-256 Git revision is required.");
    return serialized(`git:${this.cwd}`, async () => {
      await this.requireGitRoot();
      const reviewed = await this.checkIndexRevision(expectedRevision);
      const branchResult = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], { validExitCodes: [1] });
      const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
      if ((await this.git(["ls-files", "--unmerged", "-z"])).stdout) {
        throw new WorkspaceError("COMMIT_SELECTION_CONFLICT", "Resolve Git index conflicts before preparing a commit.");
      }
      const indexPath = (await this.git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
      const liveIndexBytes = await readOptionalFileBytes(indexPath);
      const liveIndexMetadata = liveIndexBytes === null ? null : await stat(indexPath);
      if (mode === "include-unstaged") await this.assertIncludeUnstagedSupported();
      const rawBefore = mode === "include-unstaged" ? await this.workingSelectionFingerprint() : null;
      const temporary = await mkdtemp(join(tmpdir(), "agent-desktop-commit-index-"));
      const privateIndexPath = join(temporary, "index");
      const env = { ...process.env, GIT_INDEX_FILE: privateIndexPath };
      let preparing = true;
      try {
        if (liveIndexBytes === null) await this.git(["read-tree", "--empty"], { env });
        else {
          await writeFile(privateIndexPath, liveIndexBytes, { flag: "wx", mode: 0o600 });
          // A newer copied index can hide same-size edits by disabling Git's
          // racy-stat check. Preserve the source timestamp before refreshing it.
          await utimes(privateIndexPath, liveIndexMetadata!.atime, liveIndexMetadata!.mtime);
        }
        if (mode === "include-unstaged") await this.git(["add", "-A", "--", "."], { env });
        const selectedTree = (await this.git(["write-tree"], { env })).stdout.trim();
        const selectedPaths = (await this.git(["diff", "--cached", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--"], { env })).stdout.split("\0").filter(Boolean);
        if (!selectedPaths.length && !allowEmpty) throw new WorkspaceError("NO_CHANGES", "The selected changes do not produce a commit.");
        const [diff, statOutput, numstat] = await Promise.all([
          this.git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--"], { env }),
          this.git(["diff", "--cached", "--stat", "--no-ext-diff", "--no-textconv", "--"], { env }),
          this.git(["diff", "--cached", "--numstat", "--no-ext-diff", "--no-textconv", "--"], { env }),
        ]);
        const privateIndexBytes = await readFileBytes(privateIndexPath);
        const rawAfter = mode === "include-unstaged" ? await this.workingSelectionFingerprint() : null;
        await this.assertCommitSelectionState(reviewed, branch, indexPath, liveIndexBytes, privateIndexPath, privateIndexBytes, rawBefore, rawAfter);
        const record: PreparedSelectionRecord = { owner: this, state: "active", temporary, reviewed, branch, indexPath,
          liveIndexBytes, privateIndexPath, privateIndexBytes, expectedWorking: rawBefore };
        const assertCurrent = () => serialized(`git:${this.cwd}`, async () => {
          if (record.state === "unknown") throw new WorkspaceError("OUTCOME_UNKNOWN", "This prepared selection belongs to an unresolved Git outcome. Inspect it before any cleanup or retry.");
          if (record.state !== "active") throw new WorkspaceError("COMMIT_SELECTION_DISPOSED", "This prepared commit selection is no longer active.");
          await this.requireGitRoot();
          await this.assertCommitSelectionState(reviewed, branch, indexPath, liveIndexBytes, privateIndexPath, privateIndexBytes, rawBefore,
            mode === "include-unstaged" ? await this.workingSelectionFingerprint() : null);
        });
        const dispose = async () => {
          if (record.state === "unknown") throw new WorkspaceError("OUTCOME_UNKNOWN", "This prepared selection belongs to an unresolved Git outcome and is retained for inspection.");
          if (record.state === "committing") throw new WorkspaceError("COMMIT_SELECTION_BUSY", "This prepared selection is being committed.");
          if (record.state === "disposed" || record.state === "consumed") return;
          record.state = "disposed";
          await rm(temporary, { recursive: true, force: true });
        };
        const selection = Object.freeze({ mode, reviewedRevision: reviewed.revision, head: reviewed.head, branch, selectedTree,
          selectedPaths: Object.freeze(selectedPaths), diff: diff.stdout, stat: statOutput.stdout, numstat: numstat.stdout,
          privateIndexPath, assertCurrent, dispose });
        preparedSelections.set(selection, record);
        preparing = false;
        return selection;
      } catch (error) {
        if (preparing) await rm(temporary, { recursive: true, force: true });
        throw error;
      }
    });
  }

  /** Commit an opaque prepared selection once, then atomically publish its post-hook private index. */
  async commitPreparedSelection(prepared: PreparedGitCommitSelection, message: string, beforeDispatch?: () => void): Promise<PreparedGitCommitResult> {
    if (typeof message !== "string" || !message.trim() || message.includes("\0")) throw new WorkspaceError("INVALID_COMMIT_MESSAGE", "A nonempty commit message is required.");
    const record = preparedSelections.get(prepared);
    if (!record || record.owner !== this) throw new WorkspaceError("INVALID_COMMIT_SELECTION", "Use a prepared commit selection from this owning workspace.");
    if (record.state === "unknown") throw new WorkspaceError("OUTCOME_UNKNOWN", "This prepared selection belongs to an unresolved Git outcome and cannot be replayed.");
    if (record.state !== "active") throw new WorkspaceError("COMMIT_SELECTION_DISPOSED", "This prepared commit selection is no longer active.");
    record.state = "committing";
    return serialized(`git:${this.cwd}`, async () => {
      const lockPath = `${record.indexPath}.lock`;
      let lock: Awaited<ReturnType<typeof open>> | null = null;
      let lockIdentity: { dev: number; ino: number } | null = null;
      let published = false;
      let dispatched = false;
      let definiteFailure = false;
      try {
        await this.requireGitRoot();
        const currentIndexPath = (await this.git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
        if (currentIndexPath !== record.indexPath) throw new WorkspaceError("GIT_CHANGED", "The Git index path changed after commit preparation.");
        const indexMetadata = await lstat(record.indexPath).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" && record.liveIndexBytes === null) return null;
          throw error;
        });
        try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, indexMetadata?.mode ?? 0o644); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkspaceError("GIT_BUSY", "Git is already updating this worktree index. Retry from a fresh review when it finishes.");
          throw error;
        }
        const lockMetadata = await lock.stat();
        lockIdentity = { dev: lockMetadata.dev, ino: lockMetadata.ino };
        if (indexMetadata) await lock.chmod(indexMetadata.mode & 0o777);
        await this.assertCommitSelectionState(record.reviewed, record.branch, record.indexPath, record.liveIndexBytes,
          record.privateIndexPath, record.privateIndexBytes, record.expectedWorking,
          prepared.mode === "include-unstaged" ? await this.workingSelectionFingerprint() : null);

        let result: { stdout: string; exitCode: number };
        beforeDispatch?.();
        dispatched = true;
        try { result = await this.git(["commit", "--message", message], { env: { ...process.env, GIT_INDEX_FILE: record.privateIndexPath } }); }
        catch (error) {
          if (error instanceof WorkspaceError && (error.code === "GIT_TIMEOUT" || error.code === "GIT_OUTPUT_TOO_LARGE" || error.code === "OUTCOME_UNKNOWN")) throw error;
          const observed = await this.currentHead();
          if (observed === record.reviewed.head) { definiteFailure = true; throw error; }
          throw new WorkspaceError("OUTCOME_UNKNOWN", "Git may have created the prepared commit. Inspect the repository before retrying.");
        }

        const receipt = /^\[[^\x00-\x20]+(?: [^\]\r\n]*)? ([0-9a-f]{4,64})\] /m.exec(result.stdout)?.[1];
        if (!receipt) throw new WorkspaceError("OUTCOME_UNKNOWN", "Git did not return a commit receipt that can be verified. Inspect the repository before retrying.");
        const commit = (await this.git(["rev-parse", "--verify", `${receipt}^{commit}`])).stdout.trim();
        const observed = await this.currentHead();
        const currentBranch = await this.currentBranch();
        const parents = (await this.git(["rev-list", "--parents", "-n", "1", commit])).stdout.trim().split(" ");
        const parentVerified = record.reviewed.head === null ? parents.length === 1 && parents[0] === commit
          : parents[0] === commit && parents[1] === record.reviewed.head;
        if (!commit || commit === record.reviewed.head || observed !== commit || currentBranch !== record.branch
          || !parentVerified) {
          throw new WorkspaceError("OUTCOME_UNKNOWN", "Git reported a prepared commit, but its HEAD, branch, or parent receipt could not be verified.");
        }
        const reviewedTree = prepared.selectedTree;
        const committedTree = (await this.git(["rev-parse", "--verify", `${commit}^{tree}`])).stdout.trim();
        const publishedIndexTree = (await this.git(["write-tree"], { env: { ...process.env, GIT_INDEX_FILE: record.privateIndexPath } })).stdout.trim();
        const postHookIndexBytes = await readFileBytes(record.privateIndexPath);
        if (!sameOptionalBytes(await readOptionalFileBytes(record.indexPath), record.liveIndexBytes)) {
          throw new WorkspaceError("OUTCOME_UNKNOWN", "The live Git index changed despite its held lock after the prepared commit.");
        }
        await lock.writeFile(postHookIndexBytes);
        await lock.sync();
        await lock.close();
        lock = null;
        // Check the pathname after descriptor writes have settled. This detects
        // replacement by hooks; it cannot fence nonconforming concurrent writers.
        const ownedLock = await lstat(lockPath).catch(() => null);
        if (!ownedLock?.isFile() || !lockIdentity || ownedLock.dev !== lockIdentity.dev || ownedLock.ino !== lockIdentity.ino) {
          throw new WorkspaceError("OUTCOME_UNKNOWN", "The prepared commit completed, but ownership of its live index lock was lost before publication.");
        }
        await rename(lockPath, record.indexPath);
        published = true;
        const directory = await open(dirname(record.indexPath), constants.O_RDONLY | constants.O_DIRECTORY);
        try { await directory.sync(); } finally { await directory.close(); }
        if (await this.currentHead() !== commit || await this.currentBranch() !== record.branch) {
          throw new WorkspaceError("OUTCOME_UNKNOWN", "The prepared commit was published, but its branch or HEAD changed before final verification.");
        }
        record.state = "consumed";
        await rm(record.temporary, { recursive: true, force: true }).catch(() => {});
        return { commit, summary: result.stdout.trim(), reviewedTree, committedTree, publishedIndexTree };
      } catch (error) {
        const unknown = error instanceof WorkspaceError && error.code === "OUTCOME_UNKNOWN"
          || dispatched && !definiteFailure;
        if (unknown) {
          record.state = "unknown";
          if (error instanceof WorkspaceError && error.code === "OUTCOME_UNKNOWN") throw error;
          throw new WorkspaceError("OUTCOME_UNKNOWN", "The prepared commit or index publication could not be verified. Inspect it before retrying.");
        }
        record.state = "consumed";
        await rm(record.temporary, { recursive: true, force: true }).catch(() => {});
        throw error;
      } finally {
        if (lock) await lock.close().catch(() => {});
        if (!published && lockIdentity) {
          const current = await lstat(lockPath).catch(() => null);
          if (current && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) await unlink(lockPath).catch(() => {});
        }
      }
    });
  }

  private async currentHead(): Promise<string | null> {
    const result = await this.git(["rev-parse", "--verify", "--quiet", "HEAD"], { validExitCodes: [1] });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  private async currentBranch(): Promise<string | null> {
    const result = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], { validExitCodes: [1] });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async pushPreparedDestination(input: GitPreparedPushInput, beforeDispatch?: () => void): Promise<GitPreparedPushResult> {
    return serialized(`git:${this.cwd}`, async () => {
      await this.requireGitRoot();
      const { pushPreparedDestination } = await import("./git-push");
      return pushPreparedDestination({ cwd: this.cwd, gitStatus: () => this.readGitStatus() }, input, this.gitTimeoutMs, undefined, beforeDispatch);
    });
  }

  private async assertCommitSelectionState(
    reviewed: { head: string | null; revision: string }, branch: string | null, indexPath: string,
    liveIndexBytes: Uint8Array | null, privateIndexPath: string, privateIndexBytes: Uint8Array,
    expectedWorking: string | null, actualWorking: string | null,
  ): Promise<void> {
    const current = await this.indexState();
    const branchResult = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"], { validExitCodes: [1] });
    const currentBranch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
    const currentIndexPath = (await this.git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
    const currentIndexBytes = await readOptionalFileBytes(currentIndexPath);
    const currentPrivateIndexBytes = await readOptionalFileBytes(privateIndexPath);
    if (current.revision !== reviewed.revision || current.head !== reviewed.head || currentBranch !== branch
      || currentIndexPath !== indexPath || !sameOptionalBytes(currentIndexBytes, liveIndexBytes)
      || !sameOptionalBytes(currentPrivateIndexBytes, privateIndexBytes)
      || expectedWorking !== actualWorking) {
      throw new WorkspaceError("GIT_CHANGED", "Git branch, HEAD, index, or selected working files changed after commit preparation. Refresh before continuing.");
    }
  }

  private async assertIncludeUnstagedSupported(): Promise<void> {
    const sparse = await this.git(["config", "--bool", "--get", "core.sparseCheckout"], { validExitCodes: [1] });
    if (sparse.exitCode === 0 && sparse.stdout.trim() === "true") {
      throw new WorkspaceError("COMMIT_SELECTION_SPARSE_UNSUPPORTED", "Include unstaged is not yet supported for sparse checkouts.");
    }
    const sharedIndex = (await this.git(["rev-parse", "--shared-index-path"])).stdout.trim();
    if (sharedIndex) throw new WorkspaceError("COMMIT_SELECTION_SPLIT_INDEX_UNSUPPORTED", "Include unstaged is not yet supported for split indexes.");
    const flagged = (await this.git(["ls-files", "-v", "-z"])).stdout.split("\0").find(record => /^[a-zS] /.test(record));
    if (flagged) throw new WorkspaceError("COMMIT_SELECTION_HIDDEN_CHANGES_UNSUPPORTED", "Clear Git assume-unchanged and skip-worktree flags before including unstaged changes.");
    const status = await this.readGitStatus();
    if (status.entries.some(entry => entry.submodule && entry.worktreeStatus !== ".")) {
      throw new WorkspaceError("COMMIT_SELECTION_SUBMODULE_UNSUPPORTED", "Commit or clean submodule working changes before including unstaged changes.");
    }
  }

  private async workingSelectionFingerprint(): Promise<string> {
    // Every staged path participates in include-unstaged even when its working
    // bytes are stat-clean. Union those paths with Git's current working
    // candidates so validation does not depend only on the stat cache.
    const staged = (await this.git(["diff", "--cached", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--"])).stdout;
    const working = (await this.git(["ls-files", "-z", "-m", "-d", "-o", "--exclude-standard", "--", "."])).stdout;
    const paths = [...new Set([...staged.split("\0"), ...working.split("\0")].filter(Boolean))].sort();
    const records: Array<[string, string, number?]> = [];
    for (const path of paths) {
      const target = resolve(this.cwd, gitRelativePath(path));
      if (!within(this.cwd, target)) throw new WorkspaceError("OUTSIDE_WORKSPACE", "Git selected a path outside its owning workspace.");
      try {
        const metadata = await lstat(target);
        if (metadata.isSymbolicLink()) records.push([path, `link:${hash(Buffer.from(await readlink(target)))}`, metadata.mode]);
        else if (metadata.isFile()) records.push([path, `file:${hash(await readFileBytes(target))}`, metadata.mode]);
        else throw new WorkspaceError("COMMIT_SELECTION_FILE_UNSUPPORTED", "Include unstaged supports regular files, symlinks, and deletions only.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") records.push([path, "deleted"]);
        else throw error;
      }
    }
    return hash(Buffer.from(JSON.stringify(records)));
  }

  /** Effectful starting-state resolution. Only a durably admitted preparation may
   * consume this method; it is deliberately absent from read-only query routes. */
  async resolveWorktreeStartingRef(input: string, signal?: AbortSignal, assertCurrent?: () => void): Promise<{ ref: string; remoteRef?: string } | null> {
    const expression = parseGitRevisionExpression(input);
    signal?.throwIfAborted();
    assertCurrent?.();
    await this.requireGitRoot();
    const commit = (ref: string) => this.worktreeStartingCommit(ref, signal, assertCurrent);
    if (expression === "HEAD" || expression === "@") return await commit(expression) ? { ref: expression } : null;
    const local = expression.startsWith("refs/heads/") ? expression : expression.startsWith("refs/") ? null : `refs/heads/${expression}`;
    const upstream = await this.git(["--no-lazy-fetch", "rev-parse", "--verify", "--abbrev-ref", "--symbolic-full-name", "--end-of-options", `${expression}@{u}`], { validExitCodes: [1, 128], signal, assertCurrent });
    if (upstream.exitCode === 0 && upstream.stdout.trim()) {
      const name = upstream.stdout.trim(), remote = `refs/remotes/${name}`;
      const right = await commit(remote) ? remote : name.startsWith("refs/") ? name : `refs/heads/${name}`;
      const left = local ?? expression;
      // Resolve exact namespace identities before Git's range grammar can DWIM.
      const leftCommit = await commit(left), rightCommit = await commit(right);
      if (!leftCommit || !rightCommit) throw new WorkspaceError("BRANCH_CHANGED", "The branch or its upstream no longer resolves.");
      const counts = await this.git(["--no-lazy-fetch", "rev-list", "--left-right", "--count", `${leftCommit}...${rightCommit}`, "--"], { signal, assertCurrent });
      const matched = /^(\d+)\s+(\d+)$/.exec(counts.stdout.trim());
      if (!matched) throw new WorkspaceError("GIT_FAILED", "Git returned invalid upstream divergence counts.");
      return { ref: Number(matched[1]) === 0 && Number(matched[2]) > 0 ? right : left };
    }
    if (local && await commit(local)) return { ref: local };
    const remotes = await this.worktreeStartingRemotes(signal, assertCurrent);
    if (expression.startsWith("refs/remotes/") && await commit(expression)) return { ref: expression, remoteRef: expression };
    const prefix = "refs/remotes/", short = expression.startsWith(prefix) ? expression.slice(prefix.length) : expression;
    const named = remotes.find(remote => short.startsWith(`${remote}/`));
    const candidates = expression.startsWith("refs/") && !expression.startsWith(prefix) ? []
      : named ? [{ remote: named, branch: short.slice(named.length + 1), ref: `${prefix}${named}/${short.slice(named.length + 1)}` }]
      : expression.startsWith(prefix) ? [] : remotes.map(remote => ({ remote, branch: expression, ref: `${prefix}${remote}/${expression}` }));
    // Check all cached candidates before any remote operation.
    for (const candidate of candidates) if (await commit(candidate.ref)) return { ref: candidate.ref, remoteRef: candidate.ref };
    let validationFailure: Error | undefined;
    for (const candidate of candidates) {
      signal?.throwIfAborted();
      assertCurrent?.();
      if ((await this.git(["check-ref-format", `refs/heads/${candidate.branch}`], { validExitCodes: [1], signal, assertCurrent })).exitCode !== 0) continue;
      let listed;
      try { listed = await this.git(["ls-remote", "--exit-code", "--", candidate.remote, `refs/heads/${candidate.branch}`], { validExitCodes: [2], signal, assertCurrent }); }
      catch (error) {
        signal?.throwIfAborted();
        assertCurrent?.();
        // Only Git's remote validation failure may try another candidate. Timeout,
        // cancellation, output limits and other operational failures propagate.
        if (!(error instanceof GitProcessError) || ![1, 128].includes(error.exitCode ?? -1)) throw error;
        validationFailure ??= error;
        continue;
      }
      if (listed.exitCode === 2) continue;
      await this.fetchWorktreeStartingRef(candidate.remote, candidate.branch, candidate.ref, signal, assertCurrent);
      return { ref: candidate.ref, remoteRef: candidate.ref };
    }
    const revision = await commit(expression);
    if (revision) return { ref: revision };
    if (validationFailure) throw validationFailure;
    return null;
  }

  /** Creation-stage refresh (pinned Zue). Caller must already retain its admitted
   * operation: a fetch error may have changed refs/objects without a worktree. */
  async resolveWorktreeStartingCommit(input: WorktreeStartingState, signal?: AbortSignal, assertCurrent?: () => void): Promise<string> {
    const state = parseWorktreeStartingState(input);
    signal?.throwIfAborted();
    assertCurrent?.();
    await this.requireGitRoot();
    let ref: string;
    if (state.type === "working-tree") ref = "HEAD";
    else if (state.branchName === "HEAD" || state.branchName === "@") ref = state.branchName;
    else if (state.remoteRef !== undefined) {
      const remote = (await this.worktreeStartingRemotes(signal, assertCurrent)).filter(name => state.remoteRef!.startsWith(`refs/remotes/${name}/`)).sort((a, b) => b.length - a.length)[0];
      if (!remote) throw new WorkspaceError("REMOTE_CHANGED", "The selected starting-state remote is no longer configured.");
      return this.fetchWorktreeStartingRef(remote, state.remoteRef.slice(`refs/remotes/${remote}/`.length), state.remoteRef, signal, assertCurrent);
    } else {
      const resolved = await this.resolveWorktreeStartingRef(state.branchName, signal, assertCurrent);
      if (!resolved) throw new WorkspaceError("BRANCH_NOT_FOUND", "The worktree starting state no longer resolves.");
      ref = resolved.ref;
    }
    const commit = await this.worktreeStartingCommit(ref, signal, assertCurrent);
    if (!commit) throw new WorkspaceError("BRANCH_CHANGED", "The worktree starting commit disappeared during resolution.");
    return commit;
  }

  private async worktreeStartingRemotes(signal?: AbortSignal, assertCurrent?: () => void): Promise<string[]> {
    const names = (await this.git(["remote"], { signal, assertCurrent })).stdout.split("\n").map(name => name.trim()).filter(Boolean);
    return names.includes("origin") ? ["origin", ...names.filter(name => name !== "origin")] : names;
  }

  private async worktreeStartingCommit(ref: string, signal?: AbortSignal, assertCurrent?: () => void): Promise<string | null> {
    signal?.throwIfAborted();
    assertCurrent?.();
    if (ref.startsWith("refs/")) {
      if ((await this.git(["check-ref-format", ref], { validExitCodes: [1], signal, assertCurrent })).exitCode !== 0) return null;
      if ((await this.git(["show-ref", "--verify", "--quiet", ref], { validExitCodes: [1], signal, assertCurrent })).exitCode !== 0) return null;
    }
    const result = await this.git(["--no-lazy-fetch", "rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], { validExitCodes: [1], signal, assertCurrent });
    signal?.throwIfAborted();
    assertCurrent?.();
    if (result.exitCode === 1) return null;
    const value = result.stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new WorkspaceError("GIT_FAILED", "Git returned an invalid starting commit identity.");
    return value;
  }

  private async fetchWorktreeStartingRef(remote: string, branch: string, ref: string, signal?: AbortSignal, assertCurrent?: () => void): Promise<string> {
    signal?.throwIfAborted();
    assertCurrent?.();
    try {
      await this.git(["fetch", "--", remote, `+refs/heads/${branch}:${ref}`], { signal, assertCurrent });
      const commit = await this.worktreeStartingCommit(ref, signal, assertCurrent);
      if (!commit) throw new Error("The fetched starting ref does not resolve to a commit.");
      return commit;
    } catch (error) {
      throw new WorkspaceError("OUTCOME_UNKNOWN", `The starting-state fetch may have changed refs or objects. Inspect the admitted preparation before retrying. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Resolve tags, commit IDs and revision expressions using only local objects.
   * A later checkout must revalidate its own status/owner and target admission. */
  async resolveRevision(input: string): Promise<GitResolvedRevision | null> {
    const expression = parseGitRevisionExpression(input);
    await this.requireGitRoot();
    // The explicit option fails closed on Git versions lacking this capability;
    // never silently fall back to a lookup that may fetch from a promisor remote.
    const result = await this.git(["--no-lazy-fetch", "rev-parse", "--verify", "--quiet", "--end-of-options", `${expression}^{commit}`], { validExitCodes: [1] });
    if (result.exitCode === 1) return null;
    const commit = result.stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
      throw new WorkspaceError("GIT_FAILED", "Git returned an invalid resolved commit identity.");
    return { expression, commit };
  }

  /** Native branch-name precedence, independent of presentation result limits.
   * This reads an exact target; checkout still owns revision/identity admission. */
  async resolveCheckoutTarget(input: string): Promise<GitCheckoutTarget | null> {
    const expression = parseGitRevisionExpression(input);
    await this.requireGitRoot();
    if (!expression.startsWith("-") && (await this.git(["check-ref-format", `refs/heads/${expression}`], { validExitCodes: [1] })).exitCode === 0) {
      const local = `refs/heads/${expression}`;
      let ref: string | undefined;
      if ((await this.git(["show-ref", "--verify", "--quiet", local], { validExitCodes: [1] })).exitCode === 0) ref = local;
      else {
        const result = await this.git(["for-each-ref", "--count=2", "--format=%(refname)", `refs/remotes/*/${expression}`]);
        const refs = result.stdout.split("\n").map(name => name.trim()).filter(Boolean);
        if (refs.length > 1) throw new WorkspaceError("BRANCH_AMBIGUOUS", `Branch '${expression}' exists on multiple remotes.`);
        ref = refs[0];
      }
      if (ref) {
        // rev-parse applies DWIM even to a full ref name. Read the exact ref's
        // object first so a vanished branch cannot become a shadow tag.
        const result = await this.git(["for-each-ref", "--format=%(refname)%00%(objectname)", "--", ref]);
        const records = result.stdout.split("\n").filter(Boolean).map(line => line.split("\0")).filter(fields => fields[0] === ref);
        if (!records.length) throw new WorkspaceError("BRANCH_CHANGED", "The selected branch is no longer locally resolvable. Refresh before continuing.");
        const object = records[0]?.[1];
        if (records.length !== 1 || records[0]?.length !== 2 || !object || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(object))
          throw new WorkspaceError("GIT_FAILED", "Git returned an invalid exact branch object identity.");
        const revision = await this.resolveRevision(object);
        if (!revision) throw new WorkspaceError("BRANCH_CHANGED", "The selected branch is no longer locally resolvable. Refresh before continuing.");
        const selection = parseGitBranchSelection({ ref, commit: revision.commit, ...(ref === local ? {} : { localBranch: expression }) });
        return { kind: "branch", expression, selection };
      }
    }
    const revision = await this.resolveRevision(expression);
    return revision ? { kind: "revision", ...revision } : null;
  }

  /** Explicit detached checkout of a previously resolved commit. Branch selection
   * continues through checkoutRef so branch tracking and identity stay intact. */
  async checkoutRevision(input: GitResolvedRevision, expectedRevision: string, beforeDispatch?: () => void): Promise<GitStatus> {
    const revision = parseGitResolvedRevision(input);
    return serialized(`git:${this.cwd}`, async () => {
      await this.requireGitRoot();
      const before = await this.checkIndexRevision(expectedRevision);
      const current = await this.resolveRevision(revision.expression);
      if (!current) throw new WorkspaceError("REVISION_NOT_FOUND", "The selected revision no longer resolves to a local commit.");
      if (current.commit !== revision.commit) throw new WorkspaceError("REVISION_CHANGED", "The selected revision changed. Resolve it again before switching.");
      const confirms = (status: GitStatus) => status.branch === null && status.head === revision.commit;
      const admitted = await this.readGitStatus();
      if (admitted.revision !== before.revision) throw new WorkspaceError("GIT_REVISION_CONFLICT", "Git HEAD or index changed while resolving the checkout target. Refresh before switching.");
      beforeDispatch?.();
      if (confirms(admitted)) return admitted;
      try {
        // Dispatch the reviewed immutable object ID, not the mutable expression.
        await this.git(["--no-lazy-fetch", "switch", "--detach", "--no-guess", "--no-overwrite-ignore", revision.commit]);
      } catch (cause) {
        const observed = await this.readGitStatus().catch(() => undefined);
        if (observed && confirms(observed)) return observed;
        if (!observed || observed.revision !== before.revision)
          throw new WorkspaceError("OUTCOME_UNKNOWN", "The revision checkout did not return a reliable receipt. Inspect the repository before retrying.");
        throwCheckoutFailure(cause);
      }
      try {
        const result = await this.readGitStatus();
        if (confirms(result)) return result;
      } catch { /* Successful dispatch without verifiable state remains unknown. */ }
      throw new WorkspaceError("OUTCOME_UNKNOWN", "The revision checkout completed, but its resulting state could not be verified. Inspect the repository before retrying.");
    });
  }

  async checkout(branch: string, expectedRevision: string, create = false, beforeDispatch?: () => void): Promise<GitStatus> {
    return this.switchBranch(branch, expectedRevision, create, beforeDispatch);
  }

  async checkoutRef(input: GitBranchSelection, expectedRevision: string, beforeDispatch?: () => void): Promise<GitStatus> {
    const selection = parseGitBranchSelection(input);
    return this.switchBranch(selection.localBranch ?? selection.ref.slice("refs/heads/".length), expectedRevision, selection.localBranch !== undefined, beforeDispatch, selection);
  }

  private async switchBranch(branch: string, expectedRevision: string, create: boolean, beforeDispatch?: () => void, selection?: GitBranchSelection): Promise<GitStatus> {
    if (typeof branch !== "string" || !branch || branch.length > 200 || branch.startsWith("-") || branch.includes("\0")) {
      throw new WorkspaceError("INVALID_BRANCH", "A valid local branch name is required.");
    }
    if (typeof create !== "boolean") throw new WorkspaceError("INVALID_BRANCH", "The branch creation flag must be boolean.");
    return serialized(`git:${this.cwd}`, async () => {
      await this.requireGitRoot();
      const before = await this.checkIndexRevision(expectedRevision);
      await this.requireLiteralBranch(branch);
      // Keep full ref identity until admission. Never let Git guess a remote or
      // reinterpret a same-named local branch as the selected remote branch.
      if (selection) {
        const candidates = await this.branches();
        const candidate = candidates.find(item => item.ref === selection.ref);
        if (!candidate) throw new WorkspaceError("BRANCH_NOT_FOUND", "The selected branch no longer exists. Refresh the branch list.");
        if (candidate.symbolicTarget) throw new WorkspaceError("SYMBOLIC_BRANCH", "Symbolic branch references cannot be checked out.");
        if (candidate.commit !== selection.commit) throw new WorkspaceError("BRANCH_CHANGED", "The selected branch changed. Refresh the branch list before switching.");
      }
      const targetHead = selection?.commit ?? (create ? before.head : undefined);
      const ref = `refs/heads/${branch}`;
      if (create) {
        if (targetHead === null) throw new WorkspaceError("UNBORN_BRANCH", "Create the repository's first commit before creating another branch.");
        if ((await this.git(["show-ref", "--verify", "--quiet", ref], { validExitCodes: [1] })).exitCode === 0) {
          throw new WorkspaceError("BRANCH_EXISTS", "A local branch with this name already exists.");
        }
      } else {
        if ((await this.git(["show-ref", "--verify", "--quiet", ref], { validExitCodes: [1] })).exitCode !== 0) {
          throw new WorkspaceError("BRANCH_NOT_FOUND", "The selected local branch no longer exists. Refresh the branch list.");
        }
        if ((await this.git(["symbolic-ref", "--quiet", ref], { validExitCodes: [1] })).exitCode === 0) {
          throw new WorkspaceError("SYMBOLIC_BRANCH", "Symbolic branch references cannot be checked out.");
        }
        const current = await this.readGitStatus();
        if (current.branch === branch && (!selection || current.head === selection.commit)) { beforeDispatch?.(); return current; }
      }
      const trackingConfig = selection?.localBranch === undefined ? undefined : (await this.git(["config", "--local", "--null", "--list"])).stdout;
      const confirmsSelection = async (status: GitStatus): Promise<boolean> => {
        if (status.branch !== branch || (targetHead !== undefined && status.head !== targetHead)) return false;
        return selection?.localBranch === undefined || (await this.git(["for-each-ref", "--format=%(upstream)", ref])).stdout.trim() === selection.ref;
      };
      beforeDispatch?.();
      try {
        await this.git(selection?.localBranch !== undefined
          ? ["switch", "--no-guess", "--no-overwrite-ignore", "--create", branch, "--track=direct", selection.ref]
          : create ? ["switch", "--no-guess", "--no-overwrite-ignore", "--create", branch, before.head!]
          : ["switch", "--no-guess", "--no-overwrite-ignore", "--", branch]);
      } catch (error) {
        const observed = await this.readGitStatus().catch(() => undefined);
        if (observed && await confirmsSelection(observed).catch(() => false)) return observed;
        if (create) {
          // A failed post-checkout hook can return HEAD to the source while
          // leaving the new branch/tracking config behind. Status alone cannot
          // establish a confirmed refusal in that case.
          const unchanged = await (async () =>
            (await this.git(["show-ref", "--verify", "--quiet", ref], { validExitCodes: [1] })).exitCode === 1
            && (trackingConfig === undefined || (await this.git(["config", "--local", "--null", "--list"])).stdout === trackingConfig))().catch(() => false);
          if (!unchanged) throw new WorkspaceError("OUTCOME_UNKNOWN", "The branch checkout left an unconfirmed branch or tracking configuration. Inspect the repository before retrying.");
        }
        if (!observed || observed.revision !== before.revision) {
          throw new WorkspaceError("OUTCOME_UNKNOWN", "The branch switch did not return a reliable receipt. Inspect the repository before retrying.");
        }
        throwCheckoutFailure(error);
      }
      try {
        const result = await this.readGitStatus();
        if (!await confirmsSelection(result)) throw new Error("Unexpected checked-out branch state");
        return result;
      }
      catch { throw new WorkspaceError("OUTCOME_UNKNOWN", "The branch switched, but its resulting status could not be verified. Inspect the repository before retrying."); }
    });
  }

  async worktrees(): Promise<GitWorktree[]> {
    await this.requireGitRoot();
    const output = (await this.git(["worktree", "list", "--porcelain", "-z"])).stdout;
    const managedRoot = this.worktreeRoot ? await realpath(this.worktreeRoot).catch(() => undefined) : undefined;
    const result: GitWorktree[] = [];
    let item: GitWorktree | undefined;
    for (const field of output.split("\0")) {
      if (field.startsWith("worktree ")) { item = { path: field.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, managed: false }; result.push(item); }
      else if (item && field.startsWith("HEAD ")) item.head = field.slice(5);
      else if (item && field.startsWith("branch ")) item.branch = field.slice(7).replace(/^refs\/heads\//, "");
      else if (item && field === "detached") item.detached = true;
      else if (item && field === "bare") item.bare = true;
      else if (item && (field === "locked" || field.startsWith("locked "))) { item.locked = true; item.lockReason = field.slice(7) || undefined; }
      else if (item && (field === "prunable" || field.startsWith("prunable "))) item.prunable = field.slice(9) || "Prunable";
    }
    if (managedRoot) for (const tree of result) {
      const canonical = await realpath(tree.path).catch(() => undefined);
      tree.managed = !!canonical && canonical !== managedRoot && within(managedRoot, canonical) && canonical !== this.cwd;
      if (tree.managed) tree.managedRelativePath = relative(managedRoot, canonical!);
    }
    return result;
  }

  private async managedRoot(create: boolean): Promise<string> {
    if (!this.worktreeRoot) throw new WorkspaceError("WORKTREE_ROOT_REQUIRED", "The host must configure a managed worktree root before creating or removing worktrees.");
    if (create) await mkdir(this.worktreeRoot, { recursive: true });
    const root = await realpath(this.worktreeRoot);
    if (!(await stat(root)).isDirectory()) throw new WorkspaceError("NOT_DIRECTORY", "The managed worktree root is not a directory.");
    return root;
  }

  private async registeredManagedWorktree(path: string): Promise<{ target: string; tree: GitWorktree; gitDir: string; commonDir: string; targetIdentity: { dev: number; ino: number }; gitDirIdentity: { dev: number; ino: number } }> {
    const root = await this.managedRoot(false);
    const target = await this.owned(path, root);
    const tree = (await this.worktrees()).find(item => item.path === target && item.managed);
    if (!tree || target === root || target === this.cwd) throw new WorkspaceError("UNMANAGED_WORKTREE", "Only a registered linked worktree under the configured managed root may be used.");
    if (tree.locked) throw new WorkspaceError("WORKTREE_LOCKED", "Git has locked this worktree; unlock it explicitly before continuing.");
    if (!tree.head) throw new WorkspaceError("INVALID_GIT_HEAD", "The managed worktree HEAD cannot be resolved.");
    const gitDir = await realpath((await this.git(["rev-parse", "--absolute-git-dir"], { cwd: target })).stdout.trim());
    const commonOutput = (await this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: target })).stdout.trim();
    const commonDir = await realpath(commonOutput);
    const [targetMetadata, gitDirMetadata] = await Promise.all([stat(target), stat(gitDir)]);
    if (!targetMetadata.isDirectory() || !gitDirMetadata.isDirectory()) throw new WorkspaceError("WORKTREE_REGISTRATION_CHANGED", "The managed worktree registration is not an owned directory.");
    return {
      target, tree, gitDir, commonDir,
      targetIdentity: { dev: targetMetadata.dev, ino: targetMetadata.ino },
      gitDirIdentity: { dev: gitDirMetadata.dev, ino: gitDirMetadata.ino },
    };
  }

  private async assertNoDirtySubmodules(cwd: string, filterOverrides: string[]): Promise<void> {
    const status = (await this.git([...filterOverrides, "status", "--porcelain=v2", "-z", "--untracked-files=normal", "--ignore-submodules=none"], { cwd })).stdout;
    for (const record of status.split("\0")) {
      if ((record.startsWith("1 ") || record.startsWith("2 ") || record.startsWith("u ")) && record.split(" ")[2]?.startsWith("S")) {
        throw new WorkspaceError("WORKTREE_SNAPSHOT_SUBMODULE", "Commit or clean submodule changes before snapshotting this worktree.");
      }
    }
  }

  private async snapshotFilterOverrides(cwd: string): Promise<string[]> {
    const configured = await this.git(["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], { cwd, validExitCodes: [1] });
    const names = new Set<string>();
    for (const key of configured.stdout.split(/\r?\n/)) {
      const name = /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(key)?.[1];
      if (name) names.add(name);
    }
    return ["-c", "attr.tree=", "-c", "core.attributesFile=", ...[...names].flatMap(name => [
      "-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`,
    ])];
  }

  private async snapshotRawPaths(cwd: string, filterOverrides: string[]): Promise<string[]> {
    const results = await Promise.all([
      this.git([...filterOverrides, "diff", "--name-only", "--no-renames", "-z"], { cwd }),
      this.git([...filterOverrides, "diff", "--cached", "--name-only", "--no-renames", "-z"], { cwd }),
      this.git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd }),
    ]);
    return [...new Set(results.flatMap(result => result.stdout.split("\0").filter(Boolean)))];
  }

  private async assertNoUnsupportedSnapshotConversions(cwd: string): Promise<void> {
    for (const key of ["core.autocrlf", "core.eol"]) {
      const value = await this.git(["config", "--get", key], { cwd, validExitCodes: [1] });
      if (value.exitCode === 0 && !["", "false", "native"].includes(value.stdout.trim().toLowerCase())) {
        throw new WorkspaceError("WORKTREE_SNAPSHOT_CONVERSION", `Disable ${key} before snapshotting this worktree so raw file bytes can be preserved.`);
      }
    }
    const externalAttributes = await this.git(["config", "--get", "core.attributesFile"], { cwd, validExitCodes: [1] });
    if (externalAttributes.exitCode === 0 && externalAttributes.stdout.trim()) {
      throw new WorkspaceError("WORKTREE_SNAPSHOT_CONVERSION", "A custom Git attributes file can transform working bytes. Disable it before snapshotting this worktree.");
    }
    const attributePaths = (await this.git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd })).stdout
      .split("\0").filter(path => path === ".gitattributes" || path.endsWith("/.gitattributes"));
    const commonDir = (await this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })).stdout.trim();
    const candidates = [...attributePaths.map(path => resolve(cwd, path)), join(commonDir, "info", "attributes")];
    for (const path of candidates) {
      let bytes: Uint8Array;
      try { bytes = await readFileBytes(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (content.split(/\r?\n/).some(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return false;
        return trimmed.split(/\s+/).slice(1).some(attribute => /^(?:[-!]?(?:text|ident|binary)|eol=|working-tree-encoding=)/i.test(attribute));
      })) throw new WorkspaceError("WORKTREE_SNAPSHOT_CONVERSION", "Git text or encoding attributes can transform working bytes. Remove them before snapshotting this worktree.");
    }
  }

  private async preserveRawSnapshotBytes(cwd: string, paths: string[], env: NodeJS.ProcessEnv, filterOverrides: string[]): Promise<void> {
    for (const path of paths) {
      const staged = (await this.git(["ls-files", "--stage", "-z", "--", path], { cwd, env })).stdout.split("\0").filter(Boolean);
      if (staged.length !== 1) continue; // Deleted paths have no entry; unresolved stages are rejected by git add.
      const match = /^(\d+) ([0-9a-f]{40,64}) 0\t/.exec(staged[0]!);
      if (!match) throw new WorkspaceError("WORKTREE_SNAPSHOT_FAILED", "The temporary snapshot index contains an unexpected staged entry.");
      const mode = match[1]!;
      // Git add already records gitlinks and symlink target text exactly. Hashing
      // a mode-120000 path as a regular file would follow its target (and a
      // dangling target would fail), corrupting the snapshot blob.
      if (mode === "160000" || mode === "120000") continue;
      const object = (await this.git(["hash-object", "-w", "--no-filters", "--", path], { cwd })).stdout.trim();
      if (object !== match[2]) await this.git([...filterOverrides, "update-index", "--add", "--cacheinfo", mode, object, path], { cwd, env });
    }
  }

  async createWorktree(options: CreateWorktreeOptions): Promise<GitWorktree> {
    return serialized(`git:${this.cwd}`, async () => {
      await this.requireGitRoot();
      if (options.branch && (options.newBranch || options.startPoint)) throw new WorkspaceError("INVALID_BRANCH_SELECTION", "Choose an existing branch, or a new/detached start point.");
      relativePath(options.path);
      const root = await this.managedRoot(true);
      const target = await this.parentOwned(options.path, root);
      if (target === root || target === this.cwd) throw new WorkspaceError("INVALID_WORKTREE_PATH", "Choose a new directory below the managed worktree root.");
      try { await lstat(target); throw new WorkspaceError("WORKTREE_EXISTS", "The worktree destination already exists."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (options.branch) {
        await this.requireLiteralBranch(options.branch);
        await this.git(["show-ref", "--verify", `refs/heads/${options.branch}`]);
        await this.git(["worktree", "add", "--", target, options.branch]);
      } else {
        if (options.newBranch) await this.requireLiteralBranch(options.newBranch);
        const start = (await this.git(["rev-parse", "--verify", "--end-of-options", `${options.startPoint ?? "HEAD"}^{commit}`])).stdout.trim();
        await this.git(["worktree", "add", ...(options.newBranch ? ["-b", options.newBranch] : ["--detach"]), "--", target, start]);
      }
      const created = (await this.worktrees()).find(tree => tree.path === target);
      if (!created) throw new WorkspaceError("WORKTREE_NOT_REGISTERED", "Git did not register the new worktree. Inspect its outcome before retrying.");
      return created;
    });
  }

  /** Resolve a host-generated destination before dispatch so preparation can record its identity. */
  async sessionWorktreeDestination(path: string): Promise<string> {
    await this.requireGitRoot();
    relativePath(path);
    const root = await this.managedRoot(true);
    const target = await this.parentOwned(path, root);
    if (target === root || target === this.cwd) throw new WorkspaceError("INVALID_WORKTREE_PATH", "Choose a new directory below the managed worktree root.");
    return target;
  }

  /** Creates a detached session worktree from either a clean branch or an explicit snapshot of the source files and index. */
  async createSessionWorktree(path: string, startingState: WorktreeStartingState): Promise<GitWorktree> {
    if (startingState && Object.hasOwn(startingState, "remoteRef")) throw new WorkspaceError("REMOTE_WORKTREE_PROTOCOL_REQUIRED", "Remote starting refs require admitted resolution before worktree creation.");
    return this.createSessionWorktreeOwned(path, startingState);
  }

  /** The owning host binds this operation to a persisted worktree-creating record. */
  async createPreparedSessionWorktree(path: string, startingState: WorktreeStartingState, admission: { destination: string; assertCurrent(): void; signal?: AbortSignal }): Promise<GitWorktree> {
    return this.createSessionWorktreeOwned(path, parseWorktreeStartingState(startingState), admission);
  }

  private async createSessionWorktreeOwned(path: string, startingState: WorktreeStartingState, admission?: { destination: string; assertCurrent(): void; signal?: AbortSignal }): Promise<GitWorktree> {
    let parentIdentity: { path: string; dev: number; ino: number } | undefined;
    const assertCurrent = () => {
      if (!admission) return;
      admission.signal?.throwIfAborted();
      admission.assertCurrent();
      const info = statSync(this.cwd);
      if (!info.isDirectory() || info.dev !== this.cwdIdentity.dev || info.ino !== this.cwdIdentity.ino || realpathSync(this.cwd) !== this.cwd)
        throw new WorkspaceError("WORKSPACE_CHANGED", "The admitted source directory changed identity.");
      if (parentIdentity) {
        const parent = statSync(parentIdentity.path);
        if (!parent.isDirectory() || parent.dev !== parentIdentity.dev || parent.ino !== parentIdentity.ino
          || realpathSync(parentIdentity.path) !== parentIdentity.path || realpathSync(this.worktreeRoot!) !== parentIdentity.path)
          throw new WorkspaceError("PREPARATION_CHANGED", "The admitted destination directory changed identity.");
      }
    };
    const git = (args: string[], options: Parameters<WorkspaceService["git"]>[1] = {}) => this.git(args, { ...options, signal: admission?.signal, assertCurrent });
    return serialized(`git:${this.cwd}`, async () => {
      assertCurrent();
      await this.requireGitRoot();
      relativePath(path);
      if (!startingState || typeof startingState !== "object" || (startingState.type !== "branch" && startingState.type !== "working-tree")) {
        throw new WorkspaceError("INVALID_STARTING_STATE", "Choose a branch or the current working tree as the worktree starting state.");
      }
      assertCurrent();
      const root = await this.managedRoot(true);
      const target = await this.parentOwned(path, root);
      if (admission) {
        if (target !== admission.destination) throw new WorkspaceError("PREPARATION_CHANGED", "Creation must use the recorded destination.");
        const parent = statSync(dirname(target));
        parentIdentity = { path: dirname(target), dev: parent.dev, ino: parent.ino };
      }
      if (target === root || target === this.cwd) throw new WorkspaceError("INVALID_WORKTREE_PATH", "Choose a new directory below the managed worktree root.");
      try { await lstat(target); throw new WorkspaceError("WORKTREE_EXISTS", "The worktree destination already exists."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

      assertCurrent();
      let commit: string, indexTree: string | undefined, workingTree: string | undefined;
      if (startingState.type === "branch" && admission) {
        commit = await this.resolveWorktreeStartingCommit(startingState, admission.signal, assertCurrent);
      } else if (startingState.type === "branch") {
        const branch = startingState.branchName;
        if (typeof branch !== "string" || !branch || branch.length > 200 || branch.startsWith("-") || branch.includes("\0")) throw new WorkspaceError("INVALID_BRANCH", "A valid local branch name is required.");
        await this.requireLiteralBranch(branch);
        const ref = `refs/heads/${branch}`;
        if ((await git(["show-ref", "--verify", "--quiet", ref], { validExitCodes: [1] })).exitCode !== 0) throw new WorkspaceError("BRANCH_NOT_FOUND", "The selected local branch no longer exists. Refresh the branch list.");
        if ((await git(["symbolic-ref", "--quiet", ref], { validExitCodes: [1] })).exitCode === 0) throw new WorkspaceError("SYMBOLIC_BRANCH", "Symbolic branch references cannot start a worktree.");
        commit = (await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).stdout.trim();
      } else {
        const before = await this.indexState();
        if (before.head === null) throw new WorkspaceError("UNBORN_BRANCH", "Create the repository's first commit before starting a worktree.");
        const status = await this.readGitStatus();
        if (status.entries.some(entry => entry.kind === "conflict")) throw new WorkspaceError("WORKTREE_SNAPSHOT_CONFLICT", "Resolve Git index conflicts before copying the current working tree.");
        if (status.entries.some(entry => entry.submodule)) throw new WorkspaceError("WORKTREE_SNAPSHOT_SUBMODULE", "Commit or clean submodule changes before copying the current working tree.");
        commit = before.head;
        const temporary = await mkdtemp(join(tmpdir(), "agent-desktop-worktree-index-"));
        const indexFile = join(temporary, "index");
        const env = { ...process.env, GIT_INDEX_FILE: indexFile };
        try {
          const sourceIndex = (await git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
          await copyFile(sourceIndex, indexFile);
          indexTree = (await git(["write-tree"], { env })).stdout.trim();
          const capture = async () => {
            await git(["read-tree", indexTree!], { env });
            await git(["add", "-A", "--", "."], { env });
            return (await git(["write-tree"], { env })).stdout.trim();
          };
          workingTree = await capture();
          if ((await this.indexState()).revision !== before.revision) throw new WorkspaceError("GIT_CHANGED", "The Git index or HEAD changed while the working tree was captured. Retry from a fresh review.");
          if (await capture() !== workingTree || (await this.indexState()).revision !== before.revision) throw new WorkspaceError("GIT_CHANGED", "The working tree changed while it was captured. Retry from a stable source state.");
        } finally { await rm(temporary, { recursive: true, force: true }); }
      }

      try {
        // Once dispatched, a timeout or missing directory cannot prove that Git
        // made no changes. Preserve the target and the command identity on error.
        await git(["worktree", "add", "--detach", "--", target, commit]);
        if (indexTree && workingTree) {
          await git(["read-tree", "--reset", "-u", workingTree], { cwd: target });
          await git(["read-tree", "--reset", indexTree], { cwd: target });
        }
        const created = (await this.worktrees()).find(tree => tree.path === target);
        if (!created || !created.managed || !created.detached || created.head !== commit) throw new Error("The created worktree did not match its resolved starting commit.");
        if (indexTree && (await git(["write-tree"], { cwd: target })).stdout.trim() !== indexTree) throw new Error("The created worktree did not retain the captured index.");
        if (workingTree) {
          const temporary = await mkdtemp(join(tmpdir(), "agent-desktop-worktree-verify-"));
          const env = { ...process.env, GIT_INDEX_FILE: join(temporary, "index") };
          try {
            await git(["read-tree", indexTree!], { cwd: target, env });
            await git(["add", "-A", "--", "."], { cwd: target, env });
            if ((await git(["write-tree"], { cwd: target, env })).stdout.trim() !== workingTree) throw new Error("The created worktree did not retain the captured files.");
          } finally { await rm(temporary, { recursive: true, force: true }); }
        } else if ((await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: target })).stdout) throw new Error("The branch worktree was not created cleanly.");
        assertCurrent();
        return created;
      } catch (error) {
        throw new WorkspaceError("OUTCOME_UNKNOWN", `The session worktree may have been created at ${target}. Inspect it before retrying. ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private async requireLiteralBranch(branch: string): Promise<void> {
    const checked = await this.git(["check-ref-format", "--branch", branch]);
    if (checked.stdout.trim() !== branch) throw new WorkspaceError("INVALID_BRANCH", "Branch syntax must name the requested local branch exactly.");
  }

  async removeWorktree(path: string): Promise<void> {
    return serialized(`git:${this.cwd}`, async () => {
      await this.requireGitRoot();
      const root = await this.managedRoot(false);
      const target = await this.owned(path, root);
      const registered = (await this.worktrees()).find(tree => tree.path === target && tree.managed);
      if (!registered || target === root || target === this.cwd) throw new WorkspaceError("UNMANAGED_WORKTREE", "Only a registered linked worktree under the configured managed root may be removed.");
      if (registered.locked) throw new WorkspaceError("WORKTREE_LOCKED", "Git has locked this worktree; unlock it explicitly before removal.");
      const changes = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], { cwd: target });
      if (changes.stdout) throw new WorkspaceError("DIRTY_WORKTREE", "The worktree contains changed, untracked or ignored files. Preserve or clean them before removal.");
      if (registered.detached && registered.head && !(await this.git(["for-each-ref", `--contains=${registered.head}`, "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"])).stdout.trim()) {
        throw new WorkspaceError("UNREFERENCED_COMMITS", "The detached worktree contains commits with no branch or tag. Preserve a reference before removal.");
      }
      await this.git(["worktree", "remove", "--", target]);
    });
  }

  /**
   * Durably captures a managed worktree's files in a private Git ref without
   * changing its HEAD, index, or files. Cleanup may run after this receipt is
   * returned; removal separately verifies that the Git registration is the
   * same one that was captured.
   */
  async snapshotWorktreeForRemoval(path: string): Promise<ManagedWorktreeSnapshotReceipt> {
    return serialized(`git:${this.cwd}`, async () => {
      await this.requireGitRoot();
      const before = await this.registeredManagedWorktree(path);
      const hiddenIndexEntries = (await this.git(["ls-files", "-v", "-z"], { cwd: before.target })).stdout
        .split("\0").filter(entry => entry && (/^[a-z]/.test(entry) || entry.startsWith("S ")));
      if (hiddenIndexEntries.length) {
        throw new WorkspaceError("WORKTREE_SNAPSHOT_HIDDEN_CHANGES", "Clear Git assume-unchanged and skip-worktree flags before snapshotting this worktree.");
      }
      const filterOverrides = await this.snapshotFilterOverrides(before.target);
      await this.assertNoDirtySubmodules(before.target, filterOverrides);
      await this.assertNoUnsupportedSnapshotConversions(before.target);
      const indexPath = (await this.git(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: before.target })).stdout.trim();
      const indexBytes = await readFileBytes(indexPath);
      const rawPaths = await this.snapshotRawPaths(before.target, filterOverrides);
      const temporary = await mkdtemp(join(tmpdir(), "agent-desktop-remove-index-"));
      const temporaryIndex = join(temporary, "index");
      const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
      try {
        const capture = async () => {
          await copyFile(indexPath, temporaryIndex);
          await this.git([...filterOverrides, "add", "-A", "--", "."], { cwd: before.target, env });
          await this.preserveRawSnapshotBytes(before.target, rawPaths, env, filterOverrides);
          return (await this.git([...filterOverrides, "write-tree"], { cwd: before.target, env })).stdout.trim();
        };
        const tree = await capture();
        if (await capture() !== tree) throw new WorkspaceError("GIT_CHANGED", "The worktree changed while it was being snapshotted. Retry after it is stable.");
        const current = await this.registeredManagedWorktree(path);
        if (!sameWorktreeRegistration(before, current) || !Buffer.from(await readFileBytes(indexPath)).equals(Buffer.from(indexBytes))) {
          throw new WorkspaceError("GIT_CHANGED", "The worktree registration, HEAD, or index changed while it was being snapshotted.");
        }
        const snapshotRef = `refs/agent-desktop/snapshots/${createHash("sha1").update(before.target).digest("hex")}`;
        const commit = (await this.git(["commit-tree", tree, "-p", before.tree.head!, "-m", `Agent Desktop worktree snapshot: ${before.target}`], {
          cwd: before.target,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Agent Desktop",
            GIT_AUTHOR_EMAIL: "agent-desktop@localhost",
            GIT_COMMITTER_NAME: "Agent Desktop",
            GIT_COMMITTER_EMAIL: "agent-desktop@localhost",
          },
        })).stdout.trim();
        const existing = await this.git(["rev-parse", "--verify", "--quiet", snapshotRef], { cwd: before.target, validExitCodes: [1] });
        await this.git(["update-ref", snapshotRef, commit, ...(existing.exitCode === 0 ? [existing.stdout.trim()] : ["0".repeat(before.tree.head!.length)])], { cwd: before.target });
        if ((await this.git(["rev-parse", "--verify", `${snapshotRef}^{commit}`], { cwd: before.target })).stdout.trim() !== commit) {
          throw new WorkspaceError("SNAPSHOT_NOT_DURABLE", "Git did not retain the worktree snapshot ref.");
        }
        return {
          version: 1,
          worktreePath: before.target,
          worktreeGitDir: before.gitDir,
          commonGitDir: before.commonDir,
          worktreeIdentity: before.targetIdentity,
          worktreeGitDirIdentity: before.gitDirIdentity,
          head: before.tree.head!,
          branch: before.tree.branch,
          detached: before.tree.detached,
          snapshotRef,
          snapshotCommit: commit,
        };
      } finally { await rm(temporary, { recursive: true, force: true }); }
    });
  }

  /** Force-removes only the unchanged managed registration proven by a snapshot receipt. */
  async removeSnapshottedWorktree(path: string, receipt: ManagedWorktreeSnapshotReceipt, beforeDispatch?: () => void | Promise<void>): Promise<void> {
    return serialized(`git:${this.cwd}`, async () => {
      await this.requireGitRoot();
      if (!validSnapshotReceipt(receipt)) throw new WorkspaceError("INVALID_SNAPSHOT_RECEIPT", "A valid managed-worktree snapshot receipt is required.");
      const root = await this.managedRoot(false);
      if (!within(root, receipt.worktreePath) || receipt.worktreePath === root || receipt.worktreePath === this.cwd) {
        throw new WorkspaceError("UNMANAGED_WORKTREE", "The snapshot does not belong to this managed worktree root.");
      }
      const current = await this.registeredManagedWorktree(path);
      if (current.target !== receipt.worktreePath || current.gitDir !== receipt.worktreeGitDir || current.commonDir !== receipt.commonGitDir
        || current.targetIdentity.dev !== receipt.worktreeIdentity.dev || current.targetIdentity.ino !== receipt.worktreeIdentity.ino
        || current.gitDirIdentity.dev !== receipt.worktreeGitDirIdentity.dev || current.gitDirIdentity.ino !== receipt.worktreeGitDirIdentity.ino
        || current.tree.head !== receipt.head || current.tree.branch !== receipt.branch || current.tree.detached !== receipt.detached) {
        throw new WorkspaceError("WORKTREE_REGISTRATION_CHANGED", "The managed worktree registration changed after it was snapshotted.");
      }
      await this.assertNoDirtySubmodules(current.target, await this.snapshotFilterOverrides(current.target));
      const expectedRef = `refs/agent-desktop/snapshots/${createHash("sha1").update(current.target).digest("hex")}`;
      if (receipt.snapshotRef !== expectedRef
        || (await this.git(["rev-parse", "--verify", `${expectedRef}^{commit}`], { cwd: current.target })).stdout.trim() !== receipt.snapshotCommit) {
        throw new WorkspaceError("SNAPSHOT_CHANGED", "The durable worktree snapshot changed before removal.");
      }
      await beforeDispatch?.();
      try { await this.git(["worktree", "remove", "--force", "--", current.target]); }
      catch (error) {
        throw new WorkspaceError("OUTCOME_UNKNOWN", `Git did not return a verified managed-worktree removal receipt. Inspect ${current.target} before retrying. ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        if (!await this.inspectSnapshottedWorktreeRemoval(receipt)) {
          throw new WorkspaceError("OUTCOME_UNKNOWN", "Git reported removal but the managed worktree still exists or remains registered. Inspect it before retrying.");
        }
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === "OUTCOME_UNKNOWN") throw error;
        throw new WorkspaceError("OUTCOME_UNKNOWN", `Git reported removal but its result could not be verified. Inspect ${current.target} before retrying. ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  /** Read-only proof used after a restart; it never invokes Git removal. */
  async inspectSnapshottedWorktreeRemoval(receipt: ManagedWorktreeSnapshotReceipt): Promise<boolean> {
    await this.requireGitRoot();
    if (!validSnapshotReceipt(receipt)) throw new WorkspaceError("INVALID_SNAPSHOT_RECEIPT", "A valid managed-worktree snapshot receipt is required.");
    const root = await this.managedRoot(false);
    if (!within(root, receipt.worktreePath) || receipt.worktreePath === root || receipt.worktreePath === this.cwd) {
      throw new WorkspaceError("UNMANAGED_WORKTREE", "The snapshot does not belong to this managed worktree root.");
    }
    const common = await realpath((await this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim());
    if (common !== receipt.commonGitDir) throw new WorkspaceError("WORKTREE_REGISTRATION_CHANGED", "The snapshot belongs to another Git repository.");
    const expectedRef = `refs/agent-desktop/snapshots/${createHash("sha1").update(receipt.worktreePath).digest("hex")}`;
    if (receipt.snapshotRef !== expectedRef
      || (await this.git(["rev-parse", "--verify", `${expectedRef}^{commit}`])).stdout.trim() !== receipt.snapshotCommit) {
      throw new WorkspaceError("SNAPSHOT_CHANGED", "The durable worktree snapshot is no longer valid.");
    }
    if ((await this.worktrees()).some(tree => tree.path === receipt.worktreePath)) return false;
    return !await lstat(receipt.worktreePath).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
  }
}

async function readFileBytes(path: string): Promise<Uint8Array> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new WorkspaceError("NOT_REGULAR_FILE", "The Git index must be a regular file.");
    return new Uint8Array(await file.readFile());
  } finally { await file.close(); }
}

async function readOptionalFileBytes(path: string): Promise<Uint8Array | null> {
  try { return await readFileBytes(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameOptionalBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  return left === null || right === null ? left === right : Buffer.from(left).equals(Buffer.from(right));
}

function gitRelativePath(path: string): string {
  if (!path || path.includes("\0") || isAbsolute(path) || path.split("/").includes("..")) {
    throw new WorkspaceError("OUTSIDE_WORKSPACE", "Git selected an invalid repository-relative path.");
  }
  return path;
}

function sameWorktreeRegistration(
  left: { target: string; tree: GitWorktree; gitDir: string; commonDir: string; targetIdentity: { dev: number; ino: number }; gitDirIdentity: { dev: number; ino: number } },
  right: { target: string; tree: GitWorktree; gitDir: string; commonDir: string; targetIdentity: { dev: number; ino: number }; gitDirIdentity: { dev: number; ino: number } },
): boolean {
  return left.target === right.target && left.gitDir === right.gitDir && left.commonDir === right.commonDir
    && left.targetIdentity.dev === right.targetIdentity.dev && left.targetIdentity.ino === right.targetIdentity.ino
    && left.gitDirIdentity.dev === right.gitDirIdentity.dev && left.gitDirIdentity.ino === right.gitDirIdentity.ino
    && left.tree.head === right.tree.head && left.tree.branch === right.tree.branch && left.tree.detached === right.tree.detached;
}

function validSnapshotReceipt(value: ManagedWorktreeSnapshotReceipt): boolean {
  return !!value && value.version === 1 && typeof value.worktreePath === "string" && typeof value.worktreeGitDir === "string"
    && typeof value.commonGitDir === "string" && validFileIdentity(value.worktreeIdentity) && validFileIdentity(value.worktreeGitDirIdentity)
    && /^[0-9a-f]{40,64}$/.test(value.head)
    && (value.branch === null || typeof value.branch === "string") && typeof value.detached === "boolean"
    && /^refs\/agent-desktop\/snapshots\/[0-9a-f]{40}$/.test(value.snapshotRef) && /^[0-9a-f]{40,64}$/.test(value.snapshotCommit);
}

function validFileIdentity(value: { dev: number; ino: number }): boolean {
  return !!value && Number.isSafeInteger(value.dev) && value.dev >= 0 && Number.isSafeInteger(value.ino) && value.ino > 0;
}
