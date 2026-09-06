import type { ContentMetadata, WorkspaceEntry, TextDocument, FileContent, FileWriteInput, FileWriteResult, GitStatus, GitStatusEntry, GitBranch, GitDiff, GitDiffOptions, GitCommitResult, GitWorktree, CreateWorktreeOptions, WorktreeStartingState } from "../../../../packages/shared/src/workspace";
export type * from "../../../../packages/shared/src/workspace";

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync, statSync } from "node:fs";
import { access, copyFile, link, lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
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

export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WorkspaceError"; }
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
    const lexical = await this.parentOwned(path);
    let target: string;
    try { target = await this.owned(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { if ((await lstat(lexical).catch(() => null))?.isSymbolicLink()) throw new WorkspaceError("BROKEN_SYMLINK", "Cannot save through a broken symlink."); target = lexical; } else throw error; }
    return serialized(`file:${target}`, async () => {
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

  private async git(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; validExitCodes?: number[] } = {}): Promise<{ stdout: string; exitCode: number }> {
    const command = ["--no-pager", "--literal-pathspecs", "-c", "color.ui=false", "-C", options.cwd ?? this.cwd, ...args];
    try {
      const result = await execute("git", command, { encoding: "buffer", timeout: this.gitTimeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...options.env } });
      return { stdout: decode(result.stdout), exitCode: 0 };
    } catch (error) {
      const failure = error as Error & { code?: number | string; killed?: boolean; stdout?: Buffer; stderr?: Buffer };
      if (typeof failure.code === "number" && options.validExitCodes?.includes(failure.code)) return { stdout: decode(failure.stdout ?? Buffer.alloc(0)), exitCode: failure.code };
      if (failure.killed) throw new WorkspaceError("GIT_TIMEOUT", "Git exceeded its time limit. Inspect repository state before retrying a mutation.");
      if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new WorkspaceError("GIT_OUTPUT_TOO_LARGE", "Git output exceeds 8 MiB. Select a narrower path.");
      const detail = failure.stderr ? new TextDecoder().decode(failure.stderr).trim().slice(0, 32_000) : failure.message;
      throw new WorkspaceError("GIT_FAILED", detail || "Git failed.");
    }
  }

  private async requireGitRoot(): Promise<void> {
    if ((await this.gitWorkspaceContext()).gitRoot !== this.cwd) throw new WorkspaceError("GIT_ROOT_OUTSIDE_WORKSPACE", "Select the repository root before performing Git operations.");
  }

  /** Canonical repository ownership and the selected workspace's path within it. This does not broaden file access. */
  async gitWorkspaceContext(): Promise<GitWorkspaceContext> {
    const assertWorkspaceIdentity = async () => {
      let current, canonical;
      try { current = await lstat(this.cwd); canonical = await realpath(this.cwd); }
      catch { throw new WorkspaceError("PATH_CHANGED", "The selected workspace changed identity. Reopen it before resolving Git context."); }
      if (!current.isDirectory() || current.dev !== this.cwdIdentity.dev || current.ino !== this.cwdIdentity.ino || canonical !== this.cwd) {
        throw new WorkspaceError("PATH_CHANGED", "The selected workspace changed identity. Reopen it before resolving Git context.");
      }
    };
    await assertWorkspaceIdentity();
    const top = (await this.git(["rev-parse", "--show-toplevel"])).stdout.replace(/\r?\n$/, "");
    const gitRoot = await realpath(top);
    await assertWorkspaceIdentity();
    if (!(await stat(gitRoot)).isDirectory() || !within(gitRoot, this.cwd)) {
      throw new WorkspaceError("GIT_ROOT_OUTSIDE_WORKSPACE", "The selected workspace resolves outside its Git repository root.");
    }
    return { gitRoot, workspaceRelativePath: relative(gitRoot, this.cwd) };
  }

  /** Explicitly enter repository-wide Git/worktree authority while retaining this service's host-owned limits. */
  async gitRootService(): Promise<WorkspaceService> {
    const { gitRoot } = await this.gitWorkspaceContext();
    return new WorkspaceService(gitRoot, { worktreeRoot: this.worktreeRoot, maxTextBytes: this.maxTextBytes, gitTimeoutMs: this.gitTimeoutMs });
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
      await this.checkIndexRevision(expectedRevision);
      const result = await this.git(["commit", "--message", message]);
      return { commit: (await this.git(["rev-parse", "HEAD"])).stdout.trim(), summary: result.stdout.trim() };
    });
  }

  async checkout(branch: string, expectedRevision: string, create = false): Promise<GitStatus> {
    if (typeof branch !== "string" || !branch || branch.length > 200 || branch.startsWith("-") || branch.includes("\0")) {
      throw new WorkspaceError("INVALID_BRANCH", "A valid local branch name is required.");
    }
    if (typeof create !== "boolean") throw new WorkspaceError("INVALID_BRANCH", "The branch creation flag must be boolean.");
    return serialized(`git:${this.cwd}`, async () => {
      await this.requireGitRoot();
      const before = await this.checkIndexRevision(expectedRevision);
      await this.requireLiteralBranch(branch);
      const ref = `refs/heads/${branch}`;
      if (create) {
        if (before.head === null) throw new WorkspaceError("UNBORN_BRANCH", "Create the repository's first commit before creating another branch.");
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
        if (current.branch === branch) return current;
      }
      try {
        await this.git(create
          ? ["switch", "--no-guess", "--no-overwrite-ignore", "--create", branch, before.head!]
          : ["switch", "--no-guess", "--no-overwrite-ignore", "--", branch]);
      } catch (error) {
        const observed = await this.readGitStatus().catch(() => undefined);
        if (observed?.branch === branch && (!create || observed.head === before.head)) return observed;
        if (!observed || observed.revision !== before.revision) {
          throw new WorkspaceError("OUTCOME_UNKNOWN", "The branch switch did not return a reliable receipt. Inspect the repository before retrying.");
        }
        throw error;
      }
      try {
        const result = await this.readGitStatus();
        if (result.branch !== branch || (create && result.head !== before.head)) throw new Error("Unexpected checked-out branch state");
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
    return serialized(`git:${this.cwd}`, async () => {
      await this.requireGitRoot();
      relativePath(path);
      if (!startingState || typeof startingState !== "object" || (startingState.type !== "branch" && startingState.type !== "working-tree")) {
        throw new WorkspaceError("INVALID_STARTING_STATE", "Choose a branch or the current working tree as the worktree starting state.");
      }
      const root = await this.managedRoot(true);
      const target = await this.parentOwned(path, root);
      if (target === root || target === this.cwd) throw new WorkspaceError("INVALID_WORKTREE_PATH", "Choose a new directory below the managed worktree root.");
      try { await lstat(target); throw new WorkspaceError("WORKTREE_EXISTS", "The worktree destination already exists."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

      let commit: string, indexTree: string | undefined, workingTree: string | undefined;
      if (startingState.type === "branch") {
        const branch = startingState.branchName;
        if (typeof branch !== "string" || !branch || branch.length > 200 || branch.startsWith("-") || branch.includes("\0")) throw new WorkspaceError("INVALID_BRANCH", "A valid local branch name is required.");
        await this.requireLiteralBranch(branch);
        const ref = `refs/heads/${branch}`;
        if ((await this.git(["show-ref", "--verify", "--quiet", ref], { validExitCodes: [1] })).exitCode !== 0) throw new WorkspaceError("BRANCH_NOT_FOUND", "The selected local branch no longer exists. Refresh the branch list.");
        if ((await this.git(["symbolic-ref", "--quiet", ref], { validExitCodes: [1] })).exitCode === 0) throw new WorkspaceError("SYMBOLIC_BRANCH", "Symbolic branch references cannot start a worktree.");
        commit = (await this.git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).stdout.trim();
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
          const sourceIndex = (await this.git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.trim();
          await copyFile(sourceIndex, indexFile);
          indexTree = (await this.git(["write-tree"], { env })).stdout.trim();
          const capture = async () => {
            await this.git(["read-tree", indexTree!], { env });
            await this.git(["add", "-A", "--", "."], { env });
            return (await this.git(["write-tree"], { env })).stdout.trim();
          };
          workingTree = await capture();
          if ((await this.indexState()).revision !== before.revision) throw new WorkspaceError("GIT_CHANGED", "The Git index or HEAD changed while the working tree was captured. Retry from a fresh review.");
          if (await capture() !== workingTree || (await this.indexState()).revision !== before.revision) throw new WorkspaceError("GIT_CHANGED", "The working tree changed while it was captured. Retry from a stable source state.");
        } finally { await rm(temporary, { recursive: true, force: true }); }
      }

      try {
        // Once dispatched, a timeout or missing directory cannot prove that Git
        // made no changes. Preserve the target and the command identity on error.
        await this.git(["worktree", "add", "--detach", "--", target, commit]);
        if (indexTree && workingTree) {
          await this.git(["read-tree", "--reset", "-u", workingTree], { cwd: target });
          await this.git(["read-tree", "--reset", indexTree], { cwd: target });
        }
        const created = (await this.worktrees()).find(tree => tree.path === target);
        if (!created || !created.managed || !created.detached || created.head !== commit) throw new Error("The created worktree did not match its resolved starting commit.");
        if (indexTree && (await this.git(["write-tree"], { cwd: target })).stdout.trim() !== indexTree) throw new Error("The created worktree did not retain the captured index.");
        if (workingTree) {
          const temporary = await mkdtemp(join(tmpdir(), "agent-desktop-worktree-verify-"));
          const env = { ...process.env, GIT_INDEX_FILE: join(temporary, "index") };
          try {
            await this.git(["read-tree", indexTree!], { cwd: target, env });
            await this.git(["add", "-A", "--", "."], { cwd: target, env });
            if ((await this.git(["write-tree"], { cwd: target, env })).stdout.trim() !== workingTree) throw new Error("The created worktree did not retain the captured files.");
          } finally { await rm(temporary, { recursive: true, force: true }); }
        } else if ((await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: target })).stdout) throw new Error("The branch worktree was not created cleanly.");
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
