import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync, statSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export { parseLocalEnvironment, serializeLocalEnvironment, scriptForPlatform } from "@agent-desktop/shared";
export type { LocalEnvironmentPlatform, LocalEnvironmentIcon, LocalEnvironmentScript, LocalEnvironmentAction, LocalEnvironmentConfig, LocalEnvironmentRecord, LocalEnvironmentParseError, LocalEnvironmentCatalogItem, LocalEnvironmentSaveResult } from "@agent-desktop/shared";
import { parseLocalEnvironment, type LocalEnvironmentCatalogItem, type LocalEnvironmentSaveResult } from "@agent-desktop/shared";
const maximumConfigBytes = 1024 * 1024;
const maximumDiscoveryDepth = 50;
const saveTails = new Map<string, Promise<void>>();
const revision = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");

function safeName(name: string) {
  const value = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (value || "environment").slice(0, 100);
}

type LocalEnvironmentReadResult =
  | { type: "missing" }
  | { type: "item"; item: LocalEnvironmentCatalogItem; identity?: string; mode?: number; raw?: string };

const fileIdentity = (info: Stats) =>
  `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}`;

type EnvironmentDirectory = {
  path: string;
  canonicalPath: string;
  distance: number;
};

export class LocalEnvironmentStore {
  readonly projectRoot: string;
  readonly directory: string;
  private readonly canonicalProjectRoot: string;
  private readonly canonicalDirectory: string;

  constructor(projectRoot: string) {
    if (!isAbsolute(projectRoot)) throw new Error("Project root must be absolute.");
    this.projectRoot = resolve(projectRoot);
    this.canonicalProjectRoot = realpathSync(this.projectRoot);
    if (!statSync(this.canonicalProjectRoot).isDirectory()) throw new Error("Project root must be a directory.");
    this.directory = join(this.projectRoot, ".agent-desktop", "environments");
    this.canonicalDirectory = join(this.canonicalProjectRoot, ".agent-desktop", "environments");
  }

  private async ownedRoot(create: boolean, directory = this.directory, canonicalDirectory = this.canonicalDirectory): Promise<string | null> {
    const root = await realpath(this.projectRoot);
    if (root !== this.canonicalProjectRoot || !(await stat(root)).isDirectory()) throw new Error("Project root identity changed.");
    const parent = dirname(directory);
    for (const path of [parent, directory]) {
      try {
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Environment storage path is not an owned directory.");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
        if (!create) return null;
        await mkdir(path, { mode: 0o700 });
      }
    }
    if (await realpath(directory) !== canonicalDirectory) throw new Error("Environment storage escaped its discovered project directory.");
    return directory;
  }

  private async discoveryDirectories(): Promise<EnvironmentDirectory[]> {
    const current = await realpath(this.projectRoot);
    if (current !== this.canonicalProjectRoot || !(await stat(current)).isDirectory()) throw new Error("Project root identity changed.");
    const directories: EnvironmentDirectory[] = [];
    let root = this.canonicalProjectRoot;
    for (let distance = 0; distance < maximumDiscoveryDepth; distance++) {
      const displayRoot = distance === 0 ? this.projectRoot : root;
      for (const namespace of [".agent-desktop", ".codex"]) directories.push({
        path: join(displayRoot, namespace, "environments"),
        canonicalPath: join(root, namespace, "environments"),
        distance,
      });
      let gitBoundary = false;
      try {
        const info = await stat(join(root, ".git"));
        gitBoundary = info.isDirectory() || info.isFile();
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      const parent = dirname(root);
      if (gitBoundary || parent === root) break;
      root = parent;
    }
    return directories;
  }

  private async configTarget(configPath: string): Promise<EnvironmentDirectory & { configPath: string }> {
    if (!isAbsolute(configPath) || configPath.includes("\0")) throw new Error("Environment config path must be absolute.");
    const path = resolve(configPath), parent = dirname(path), namespace = dirname(parent);
    if (basename(parent) !== "environments" || ![".agent-desktop", ".codex"].includes(basename(namespace)))
      throw new Error("Environment config path is outside this project's discovered environment directories.");
    let configRoot: string;
    try { configRoot = await realpath(dirname(namespace)); }
    catch { throw new Error("Environment config path is outside this project's environment directories."); }
    const directory = (await this.discoveryDirectories()).find(candidate =>
      dirname(dirname(candidate.canonicalPath)) === configRoot && basename(dirname(candidate.canonicalPath)) === basename(namespace));
    if (!directory) throw new Error("Environment config path is outside this project's discovered environment directories.");
    // Normalize only the discovered project alias. Storage directories and files must not follow symlinks.
    return { ...directory, configPath: this.ownedPath(directory.path, join(directory.path, basename(path))) };
  }

  async resolveConfigPath(configPath: string): Promise<string> {
    const target = await this.configTarget(configPath);
    if (!await this.ownedRoot(false, target.path, target.canonicalPath)) throw new Error("Environment configuration no longer exists.");
    return target.configPath;
  }

  private ownedPath(directory: string, configPath: string): string {
    if (!isAbsolute(configPath)) throw new Error("Environment config path must be absolute.");
    const path = resolve(configPath), child = relative(directory, path);
    if (!child || child.startsWith(`..${sep}`) || child === ".." || isAbsolute(child) || child.includes(sep) || !child.endsWith(".toml"))
      throw new Error("Environment config path is outside this project's environment directory.");
    return path;
  }

  private async readEntry(path: string): Promise<LocalEnvironmentReadResult> {
    let raw: Buffer, identity: string, mode: number;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (typeof constants.O_NOFOLLOW !== "number") throw new Error("This platform cannot safely open environment configs without following symlinks.");
      file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const before = await file.stat();
      if (!before.isFile()) throw new Error("Environment config must be a regular file, not a symlink.");
      if (before.size > maximumConfigBytes) throw new Error("Environment config exceeds 1 MiB.");
      const bounded = Buffer.allocUnsafe(maximumConfigBytes + 1);
      let length = 0;
      while (length < bounded.length) {
        const { bytesRead } = await file.read(bounded, length, bounded.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > maximumConfigBytes) throw new Error("Environment config exceeds 1 MiB.");
      const after = await file.stat();
      if (fileIdentity(before) !== fileIdentity(after) || length !== after.size) throw new Error("Environment config changed while it was being read.");
      raw = bounded.subarray(0, length);
      identity = fileIdentity(after);
      mode = after.mode & 0o777;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { type: "missing" };
      const error = (cause as NodeJS.ErrnoException).code === "ELOOP" ? "Environment config must be a regular file, not a symlink."
        : cause instanceof Error ? cause.message : String(cause);
      return { type: "item", item: { type: "error", configPath: path, error } };
    } finally { await file?.close().catch(() => {}); }
    const currentRevision = revision(raw);
    try { return { type: "item", identity, mode, raw: raw.toString("utf8"), item: { type: "environment", configPath: path, revision: currentRevision, environment: parseLocalEnvironment(raw.toString("utf8")) } }; }
    catch (cause) { return { type: "item", identity, mode, raw: raw.toString("utf8"), item: { type: "error", configPath: path, revision: currentRevision, error: cause instanceof Error ? cause.message : String(cause) } }; }
  }

  async read(configPath: string): Promise<{ configPath: string; revision: string; raw: string }> {
    const path = await this.resolveConfigPath(configPath);
    const entry = await this.readEntry(path);
    if (entry.type === "missing") throw new Error("Environment configuration no longer exists.");
    if (entry.raw === undefined || !entry.item.revision) throw new Error(entry.item.type === "error" ? entry.item.error : "Environment configuration cannot be read safely.");
    return { configPath: path, revision: entry.item.revision, raw: entry.raw };
  }

  async catalog(): Promise<LocalEnvironmentCatalogItem[]> {
    const items: Array<{ item: LocalEnvironmentCatalogItem; distance: number }> = [];
    for (const candidate of await this.discoveryDirectories()) {
      const directory = await this.ownedRoot(false, candidate.path, candidate.canonicalPath); if (!directory) continue;
      const names = (await readdir(directory)).filter(name => name.endsWith(".toml"));
      for (const name of names) {
        const entry = await this.readEntry(join(directory, name));
        if (entry.type === "item") items.push({ item: entry.item, distance: candidate.distance });
      }
    }
    return items.sort((a, b) =>
      Number(basename(b.item.configPath) === "environment.toml") - Number(basename(a.item.configPath) === "environment.toml") ||
      a.distance - b.distance || a.item.configPath.localeCompare(b.item.configPath)).map(({ item }) => item);
  }

  async save(input: { configPath?: string | null; expectedRevision: string | null; raw: string }): Promise<LocalEnvironmentSaveResult> {
    const target = input.configPath ? await this.configTarget(input.configPath) : null;
    const lockKey = target?.canonicalPath ?? this.canonicalDirectory;
    const previous = saveTails.get(lockKey) ?? Promise.resolve();
    const operation = previous.then(() => this.saveOwned(input, lockKey));
    const settled = operation.then(() => undefined, () => undefined);
    saveTails.set(lockKey, settled);
    void settled.finally(() => { if (saveTails.get(lockKey) === settled) saveTails.delete(lockKey); });
    return operation;
  }

  private async saveOwned(input: { configPath?: string | null; expectedRevision: string | null; raw: string }, lockKey: string): Promise<LocalEnvironmentSaveResult> {
    if (input.expectedRevision !== null && !/^[a-f0-9]{64}$/.test(input.expectedRevision)) throw new Error("Invalid environment revision.");
    const environment = parseLocalEnvironment(input.raw);
    const target = input.configPath ? await this.configTarget(input.configPath) : null;
    const canonicalDirectory = target?.canonicalPath ?? this.canonicalDirectory;
    if (canonicalDirectory !== lockKey) throw new Error("Environment storage identity changed before save.");
    if (target && target.distance > 0 && input.expectedRevision === null)
      throw new Error("New environments must be authored in the selected project.");
    const directoryPath = target?.path ?? this.directory;
    const directory = (await this.ownedRoot(true, directoryPath, canonicalDirectory))!;
    let path: string;
    if (target) path = target.configPath;
    else {
      if (input.expectedRevision !== null) throw new Error("A new environment cannot have an existing revision.");
      const stem = safeName(environment.name); path = join(directory, `${stem}.toml`);
      for (let suffix = 2; ; suffix++) {
        try { await lstat(path); path = join(directory, `${stem}-${suffix}.toml`); }
        catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") break; throw cause; }
      }
    }
    const original = await this.readEntry(path);
    const current = original.type === "item" ? original.item : null;
    const actualRevision = current?.revision ?? null;
    const conflict = (latest: LocalEnvironmentCatalogItem | null): LocalEnvironmentSaveResult => ({
      type: "conflict", configPath: path, expectedRevision: input.expectedRevision, current: latest,
      attempted: { raw: input.raw, environment },
    });
    if (actualRevision !== input.expectedRevision || (current?.type === "error" && !current.revision)) return conflict(current);
    const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", original.type === "item" ? original.mode : 0o600);
    try {
      await file.chmod(original.type === "item" ? original.mode! : 0o600);
      await file.writeFile(input.raw, "utf8"); await file.sync();
    }
    catch (cause) { await file.close(); await unlink(temporary).catch(() => {}); throw cause; }
    await file.close();
    try {
      await this.ownedRoot(false, directory, canonicalDirectory);
      const latest = await this.readEntry(path);
      const changed = original.type !== latest.type || (original.type === "item" && latest.type === "item" &&
        (original.identity !== latest.identity || original.item.revision !== latest.item.revision));
      if (changed) return conflict(latest.type === "item" ? latest.item : null);
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
    return { type: "saved", configPath: path, revision: revision(input.raw), environment };
  }
}
