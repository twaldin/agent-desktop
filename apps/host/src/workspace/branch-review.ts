import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { canonicalReadPath } from "./literal-read-path";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseBranchReviewRequest, type BranchReview, type BranchReviewFile, type BranchReviewRequest } from "../../../../packages/shared/src/branch-review";

export interface BranchReviewPorts {
  git(args: string[], options?: { validExitCodes?: number[]; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; exitCode: number }>;
  requireGitRoot(): Promise<void>;
  baseBranch(): Promise<{ local: string; remote: string } | null>;
  /** Canonical owning WorkspaceService directory; requireGitRoot/readFence verify its identity. */
  cwd: string;
  /** Repository identity plus HEAD/index revision, from the owning WorkspaceService. */
  readFence(): Promise<string>;
}
export class BranchReviewError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "BranchReviewError"; }
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const changed = () => new BranchReviewError("GIT_CHANGED", "The repository, base reference or working files changed during branch review. Refresh the comparison.");
const invalid = () => new BranchReviewError("GIT_FAILED", "Git returned invalid branch review data.");

/** Branch inspection preserves POSIX filename bytes, including literal backslashes.
 * It has no write authority and does not relax generic WorkspaceService paths. */
function branchPath(root: string, path: string): string {
  if (!path || path.includes("\0") || isAbsolute(path) || path.split("/").includes("..") || (sep === "\\" && path.includes("\\")))
    throw new BranchReviewError("OUTSIDE_WORKSPACE", "A relative branch review path within its owning workspace is required.");
  return relative(root, resolve(root, path)) || ".";
}
async function branchParentOwned(root: string, path: string): Promise<string> {
  const lexical = resolve(root, branchPath(root, path));
  if (lexical === root) return root;
  let ancestor = dirname(lexical), canonical: string;
  const missing: string[] = [];
  for (;;) {
    try { canonical = await canonicalReadPath(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || ancestor === root) throw error;
      // A dangling symlink is not a missing directory. Retaining it as a
      // lexical parent could escape if its target appears during the read.
      const entry = await lstat(ancestor).catch(failure => {
        if ((failure as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw failure;
      });
      if (entry?.isSymbolicLink()) throw new BranchReviewError("OUTSIDE_WORKSPACE", "A branch review parent symlink could not be resolved within its owning workspace.");
      missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
  if (canonical !== root && !canonical.startsWith(root.endsWith(sep) ? root : root + sep))
    throw new BranchReviewError("OUTSIDE_WORKSPACE", "The branch review path resolves outside its owning workspace.");
  // Resolve only parents. The final component can be a symlink, whose link text
  // is read and diffed without following it, or an absent deletion.
  return join(canonical, ...missing, basename(lexical));
}
function paths(output: string): string[] {
  if (output && !output.endsWith("\0")) throw invalid();
  return output ? output.slice(0, -1).split("\0") : [];
}
function inventory(raw: string, numstat: string): BranchReviewFile[] {
  const records = paths(raw), files: BranchReviewFile[] = [];
  for (let i = 0; i < records.length;) {
    const record = /^:\d{6} \d{6} [a-f0-9]+ [a-f0-9]+ ([A-Z])\d*$/.exec(records[i++]!);
    if (!record) throw invalid();
    const first = records[i++], renamed = record[1] === "R" || record[1] === "C", path = renamed ? records[i++] : first;
    if (!first || !path) throw invalid();
    files.push({ path, previousPath: renamed ? first : null, status: record[1]!, additions: null, deletions: null, untracked: false });
  }
  const stats = paths(numstat), byPath = new Map(files.map(file => [file.path, file]));
  for (let i = 0; i < stats.length;) {
    const row = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(stats[i++]!);
    if (!row || (row[1] === "-") !== (row[2] === "-")) throw invalid();
    if (!row[3]) i++; // Original rename path is already recorded by --raw.
    const path = row[3] || stats[i++], file = byPath.get(path!);
    if (!file) throw invalid();
    file.additions = row[1] === "-" ? null : Number(row[1]);
    file.deletions = row[2] === "-" ? null : Number(row[2]);
    if (![file.additions ?? 0, file.deletions ?? 0].every(Number.isSafeInteger)) throw invalid();
  }
  return files;
}

/** One bounded read observation; never writes an index, runs external diff/textconv drivers, or fetches objects. */
export async function readBranchReview(ports: BranchReviewPorts, input: BranchReviewRequest = {}): Promise<BranchReview> {
  const request = parseBranchReviewRequest(input), deadline = Date.now() + 30_000;
  const checkTime = () => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new BranchReviewError("GIT_TIMEOUT", "Branch review exceeded its read time limit.");
    return timeoutMs;
  };
  const git = (args: string[], validExitCodes?: number[]) => ports.git(["--no-lazy-fetch", "--no-replace-objects", "--literal-pathspecs", ...args], {
    timeoutMs: checkTime(), validExitCodes, env: { GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
  });
  await ports.requireGitRoot();
  const selectedPath = request.path === undefined ? undefined : branchPath(ports.cwd, request.path);
  if (selectedPath !== undefined) await branchParentOwned(ports.cwd, selectedPath);
  const requestedBase = request.baseBranch ?? null;
  const fence = await ports.readFence();
  const resolveCommit = async (ref: string) => {
    const result = await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], [1]);
    const commit = result.stdout.trim();
    if (result.exitCode !== 0) return null;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw invalid();
    return commit;
  };
  const branch = async () => {
    const result = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], [1]);
    return result.exitCode === 0 ? result.stdout.trim() : null;
  };
  const currentBranch = await branch(), head = await resolveCommit("HEAD");
  let baseBranch: string | null = requestedBase, baseRef: string | null = requestedBase;
  if (baseRef === null) {
    const base = await ports.baseBranch();
    if (base) { baseBranch = `${base.remote}/${base.local}`; baseRef = `refs/remotes/${base.remote}/${base.local}`; }
  }
  const context = { requestedBase, baseBranch, currentBranch, ...(request.path === undefined ? {} : { path: request.path }) };
  const assertSource = async () => {
    if (await ports.readFence() !== fence || await branch() !== currentBranch || await resolveCommit("HEAD") !== head) throw changed();
  };
  const resolveBase = async (): Promise<{ ref: string; branch: string; commit: string } | null> => {
    if (!baseRef) return null;
    const direct = await resolveCommit(requestedBase ?? baseRef);
    if (direct) return { ref: requestedBase ?? baseRef, branch: requestedBase ?? baseBranch!, commit: direct };
    // Pinned kfe/L2 use configured remotes (origin first), not every cached
    // refs/remotes suffix. Short candidates intentionally keep native DWIM
    // precedence, including a local branch with a remote-qualified spelling.
    if (requestedBase) {
      const listed = (await git(["remote"])).stdout.split("\n").map(name => name.trim()).filter(Boolean);
      const remotes = listed.includes("origin") ? ["origin", ...listed.filter(name => name !== "origin")] : listed;
      const slash = requestedBase.indexOf("/"), prefix = slash > 0 ? requestedBase.slice(0, slash) : null;
      const knownPrefix = prefix !== null && remotes.includes(prefix);
      const suffix = knownPrefix && slash + 1 < requestedBase.length ? requestedBase.slice(slash + 1) : null;
      const candidates = new Set<string>();
      for (const remote of remotes) {
        if (knownPrefix && remote === prefix) {
          if (suffix) candidates.add(`refs/remotes/${remote}/${suffix}`);
        } else {
          candidates.add(`${remote}/${requestedBase}`);
          candidates.add(`refs/remotes/${remote}/${requestedBase}`);
        }
      }
      const upstream = (await git(["for-each-ref", "--format=%(upstream:short)", `refs/heads/${requestedBase}`])).stdout.trim();
      if (upstream) candidates.add(upstream);
      for (const ref of candidates) {
        const commit = await resolveCommit(ref);
        if (commit) return { ref, branch: ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : ref, commit };
      }
    }
    return null;
  };
  let resolved: Awaited<ReturnType<typeof resolveBase>> = null;
  const assertBase = async () => {
    if (JSON.stringify(await resolveBase()) !== JSON.stringify(resolved)) throw changed();
    if (requestedBase === null) {
      const latest = await ports.baseBranch();
      if ((latest ? `${latest.remote}/${latest.local}` : null) !== baseBranch) throw changed();
    }
  };
  const unavailable = async (reason: Extract<BranchReview, { state: "unavailable" }>["reason"]): Promise<BranchReview> => {
    await assertSource();
    if (reason !== "head_unavailable") await assertBase();
    return { state: "unavailable", reason, ...context };
  };
  if (!head) return unavailable("head_unavailable");
  if (!baseRef) return unavailable("default_branch_unavailable");
  resolved = await resolveBase();
  if (!resolved) return unavailable("base_ref_unavailable");
  const baseCommit = resolved.commit;
  baseBranch = resolved.branch; context.baseBranch = baseBranch;
  const merge = await git(["merge-base", head, baseCommit], [1]);
  if (merge.exitCode === 1) return unavailable("merge_base_unavailable");
  const mergeBase = merge.stdout.trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(mergeBase)) throw invalid();
  const diff = ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--ignore-submodules=none", "--src-prefix=a/", "--dst-prefix=b/"];
  const readInventory = async () => {
    const raw = (await git([...diff, "--raw", "-z", mergeBase, "--"])).stdout;
    const numstat = (await git([...diff, "--numstat", "-z", mergeBase, "--"])).stdout;
    const untracked = paths((await git(["ls-files", "--others", "--exclude-standard", "-z", "--"])).stdout);
    return { raw, numstat, untracked, files: inventory(raw, numstat) };
  };
  const before = await readInventory();
  const allPaths = [...new Set([...before.files.flatMap(file => [file.path, ...(file.previousPath ? [file.previousPath] : [])]), ...before.untracked])].sort();
  const workingFingerprint = async () => {
    const hash = createHash("sha256"); let total = 0;
    for (const path of allPaths) {
      checkTime();
      try {
        const target = await branchParentOwned(ports.cwd, path), metadata = await lstat(target);
        hash.update(JSON.stringify([path, metadata.mode]));
        if (metadata.isSymbolicLink()) {
          const link = await readlink(target), after = await lstat(await branchParentOwned(ports.cwd, path));
          if (after.ino !== metadata.ino || after.dev !== metadata.dev || after.mtimeMs !== metadata.mtimeMs || !after.isSymbolicLink()) throw changed();
          hash.update(JSON.stringify(["symlink", link]));
        } else if (metadata.isFile()) {
          total += metadata.size;
          if (total > 64 * 1024 * 1024) throw new BranchReviewError("REVIEW_TOO_LARGE", "Changed working files exceed the 64 MiB branch review read limit.");
          const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const opened = await file.stat();
            if (!opened.isFile() || opened.ino !== metadata.ino || opened.dev !== metadata.dev) throw changed();
            const bytes = Buffer.alloc(64 * 1024), content = createHash("sha256"); let count = 0;
            while (count < metadata.size) {
              checkTime();
              const result = await file.read(bytes, 0, Math.min(bytes.length, metadata.size - count), count);
              if (!result.bytesRead) throw changed();
              content.update(bytes.subarray(0, result.bytesRead)); count += result.bytesRead;
            }
            const after = await file.stat(), current = await lstat(await branchParentOwned(ports.cwd, path));
            if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs || current.ino !== metadata.ino || current.dev !== metadata.dev) throw changed();
            hash.update(JSON.stringify(["file", content.digest("hex")]));
          } finally { await file.close(); }
        } else if (metadata.isDirectory() && !before.untracked.includes(path)) {
          // Git records gitlink/submodule state in its native raw and patch output.
          hash.update("gitlink");
        } else throw new BranchReviewError("REVIEW_FILE_UNSUPPORTED", "Branch review supports regular files, symlinks, deletions and tracked submodules.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") hash.update(JSON.stringify([path, "missing"]));
        else throw error;
      }
    }
    return hash.digest("hex");
  };
  const working = await workingFingerprint();
  const selected = selectedPath === undefined || selectedPath === "." ? [] : [selectedPath];
  // Either rename alias must select both names to retain Git's rename patch.
  const selectedFile = before.files.find(file => file.path === selectedPath || file.previousPath === selectedPath);
  if (selectedFile?.previousPath) {
    if (!selected.includes(selectedFile.path)) selected.push(selectedFile.path);
    if (!selected.includes(selectedFile.previousPath)) selected.push(selectedFile.previousPath);
  }
  let patch = (await git([...diff, `--unified=${request.context ?? 3}`, mergeBase, "--", ...selected])).stdout;
  const files = before.files;
  const selectedUntracked = (path: string) => selectedPath === undefined || selectedPath === "." || path === selectedPath || path.startsWith(`${selectedPath}/`);
  for (const path of before.untracked) {
    const noIndex = ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];
    // Validate every untracked path even when its patch is not selected.
    await branchParentOwned(ports.cwd, path);
    const stats = (await git([...noIndex, "--numstat", "-z", "--", "/dev/null", path], [1])).stdout;
    const rows = paths(stats), row = rows.length ? /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(rows[0]!) : null;
    if (rows.length && (!row || (row[1] === "-") !== (row[2] === "-") || (row[3] ? rows.length !== 1 : rows.length !== 3))) throw invalid();
    const additions = row ? row[1] === "-" ? null : Number(row[1]) : 0;
    const deletions = row ? row[2] === "-" ? null : Number(row[2]) : 0;
    const tracked = files.find(file => file.path === path);
    if (tracked) {
      // A removed index path can be recreated as untracked. Native Git emits
      // deletion and addition sections; keep one navigable inventory row.
      tracked.additions = tracked.additions === null || additions === null ? null : tracked.additions + additions;
      tracked.deletions = tracked.deletions === null || deletions === null ? null : tracked.deletions + deletions;
      tracked.status = "M"; tracked.untracked = true;
    } else files.push({ path, previousPath: null, status: "A", additions, deletions, untracked: true });
    if (selectedUntracked(path)) patch += (await git([...noIndex, `--unified=${request.context ?? 3}`, "--", "/dev/null", path], [1])).stdout;
    if (Buffer.byteLength(patch) > 8 * 1024 * 1024) throw new BranchReviewError("GIT_OUTPUT_TOO_LARGE", "Branch review output exceeds 8 MiB. Select a narrower path.");
  }
  const after = await readInventory();
  if (before.raw !== after.raw || before.numstat !== after.numstat || JSON.stringify(before.untracked) !== JSON.stringify(after.untracked) || await workingFingerprint() !== working) throw changed();
  await assertSource();
  await assertBase();
  const revision = digest(JSON.stringify([fence, requestedBase, baseBranch, currentBranch, head, baseCommit, mergeBase, before.raw, before.numstat, working, files]));
  const visible = selectedPath === undefined || selectedPath === "." ? files : files.filter(file => file.path === selectedPath || file.path.startsWith(`${selectedPath}/`) || file.previousPath === selectedPath);
  return { state: "available", ...context, revision, head, baseCommit, mergeBase, files, patch, binary: visible.some(file => file.additions === null || file.deletions === null) };
}
