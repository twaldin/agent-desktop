import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { MAX_SESSION_EXPORT_BYTES, parseSessionExportReceipt, type CommandResult, type SessionExportReceipt, type SessionExportStatus, type SessionExportTheme, type SessionSummary } from "@agent-desktop/shared";
import type { HostStore } from "./store";
import type { WorkerSession } from "./omp-workers/runtime";
import { readSessionHeader } from "./omp/session-files";
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
interface ExportRecord { source: SessionSummary; artifactId: string; commandId: string; directoryIdentity: string; rootIdentity: string; failure?: string; receipt?: SessionExportReceipt }
const key = (id: string) => `session-export.v1:${id}`;
const latestKey = (id: string) => `session-export.latest.v1:${id}`;
const identity = (s: {dev: number; ino: number}) => `${s.dev}:${s.ino}`;
const unknown = () => Object.assign(new Error("The native export outcome is unknown. Inspect this original request; it will not be exported again."), { code: "OUTCOME_UNKNOWN" });
/** Called only inside the existing host command claim/tail. This service never retries a worker side effect. */
export class SessionExportService {
  private active = new Set<string>();
  constructor(private options: { store: HostStore; dataDirectory: string; current(id: string, handle: WorkerSession): Promise<boolean>; busy(id: string): boolean }) {}
  private source(id: string) {
    const source = this.options.store.getSession(id);
    if (!source || source.hostId !== this.options.store.host.id) throw new Error("The original export session is unavailable.");
    return source;
  }
  private same(source: SessionSummary) {
    const now = this.source(source.id);
    if (now.sessionFile !== source.sessionFile || now.cwd !== source.cwd || now.projectId !== source.projectId) throw new Error("The original export session changed ownership.");
  }
  status(sessionId: string, commandId: string): SessionExportStatus {
    this.source(sessionId);
    if (commandId === "latest") commandId = this.options.store.readMetadata<string>(latestKey(sessionId)) ?? "latest";
    const entry = this.options.store.getCommand(commandId), record = this.options.store.readMetadata<ExportRecord>(key(commandId));
    const base = { hostId: this.options.store.host.id, sessionId, commandId };
    if (!entry || !entry.command || !("sessionId" in entry.command) || entry.command.sessionId !== sessionId
      || entry.command.type !== "session.export" && (entry.command.type !== "session.prompt" || !record)) return { ...base, state: "absent" };
    if (entry.state === "pending") return { ...base, state: this.active.has(commandId) ? "pending" : "unknown" };
    if (entry.result?.ok) {
      try { return { ...base, state: "complete", receipt: parseSessionExportReceipt(entry.result.value, base.hostId, sessionId, commandId) }; }
      catch { return { ...base, state: "unknown" }; }
    }
    return { ...base, state: entry.result?.error.code === "OUTCOME_UNKNOWN" ? "unknown" : "failed", message: entry.result?.error.message };
  }
  async export(commandId: string, sessionId: string, theme: SessionExportTheme, handle: WorkerSession, text?: string): Promise<CommandResult> {
    const { store } = this.options, source = this.source(sessionId), entry = store.getCommand(commandId);
    if (entry?.state !== "pending" || !entry.command || !("sessionId" in entry.command) || entry.command.sessionId !== sessionId
      || entry.command.type !== "session.export" && entry.command.type !== "session.prompt") throw new Error("Export requires its original durable command claim.");
    if (store.readMetadata(key(commandId))) throw unknown();
    let sourceIdentity: string | undefined;
    const check = async () => {
      this.same(source);
      const latest = this.source(sessionId);
      if (latest.archived || latest.status !== "idle" || this.options.busy(sessionId) || handle.workerFailure || handle.isStreaming || handle.hasPostPromptWork
        || handle.id !== source.id || handle.sessionFile !== source.sessionFile || handle.cwd !== source.cwd || !await this.options.current(sessionId, handle)) throw new Error("Wait for the original native session to be idle before exporting.");
      const file = await lstat(source.sessionFile);
      if (!file.isFile() || file.isSymbolicLink() || sourceIdentity !== undefined && identity(file) !== sourceIdentity) throw new Error("The original native session file was replaced.");
      sourceIdentity ??= identity(file);
      const header = await readSessionHeader(source.sessionFile);
      if (header.id !== source.id || header.cwd !== source.cwd) throw new Error("The native export file has a different owner.");
      this.same(source);
    };
    await check();
    const base = join(await realpath(this.options.dataDirectory), "session-exports");
    await mkdir(base, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(base);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077)) throw new Error("The private export directory is unavailable.");
    const artifactId = randomBytes(32).toString("hex"), directory = join(base, artifactId);
    await mkdir(directory, { mode: 0o700 });
    const record: ExportRecord = { source, artifactId, commandId, directoryIdentity: identity(await lstat(directory)), rootIdentity: identity(rootStat) };
    await check();
    store.writeMetadata(key(commandId), record);
    store.writeMetadata(latestKey(sessionId), commandId);
    this.active.add(commandId);
    let dispatched = false;
    try {
      await this.validateDirectory(record);
      await check();
      dispatched = true;
      await handle.exportSession({ sessionId, sessionFile: source.sessionFile, cwd: source.cwd, outputPath: join(directory, "session.html"), theme, ...(text === undefined ? {} : { text }) });
      await check();
      const bytes = await this.read(record);
      const receipt: SessionExportReceipt = { type: "session.export", hostId: source.hostId, sessionId, commandId, artifactId, sha256: digest(bytes), bytes: bytes.length, theme };
      store.writeMetadata(key(commandId), { ...record, receipt });
      return { ok: true, commandId, value: receipt };
    } catch (error) {
      // Retain private diagnostics without returning host paths to artifact clients.
      try { store.writeMetadata(key(commandId), { ...record, failure: (error instanceof Error ? error.message : String(error)).slice(0, 4096) }); } catch { /* The original command still remains unconfirmed. */ }
      if (dispatched) throw unknown(); throw error;
    }
    finally { this.active.delete(commandId); }
  }
  private async validateDirectory(record: ExportRecord) {
    const base = join(await realpath(this.options.dataDirectory), "session-exports"), directory = join(base, record.artifactId);
    const [rootStat, stat] = await Promise.all([lstat(base), lstat(directory)]);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || identity(rootStat) !== record.rootIdentity || (rootStat.mode & 0o077)
      || !stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== record.directoryIdentity || (stat.mode & 0o077)) throw new Error("The private export directory changed.");
    return join(directory, "session.html");
  }
  private async read(record: ExportRecord): Promise<Buffer> {
    const path = await this.validateDirectory(record), file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_SESSION_EXPORT_BYTES) throw new Error("Native HTML export exceeds the file limit or is not a regular file.");
      const bytes = Buffer.alloc(stat.size), count = await file.read(bytes, 0, bytes.length, 0);
      const after = await file.stat();
      if (count.bytesRead !== bytes.length || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error("The exported HTML changed while reading.");
      await this.validateDirectory(record);
      const current = await lstat(path);
      if (identity(current) !== identity(stat) || current.isSymbolicLink()) throw new Error("The HTML export path changed.");
      return bytes;
    } finally { await file.close(); }
  }
  async artifact(sessionId: string, commandId: string): Promise<{ receipt: SessionExportReceipt; bytes: Buffer }> {
    const status = this.status(sessionId, commandId), record = this.options.store.readMetadata<ExportRecord>(key(commandId));
    if (status.state !== "complete" || !status.receipt || !record || record.source.id !== sessionId || record.artifactId !== status.receipt.artifactId) throw new Error("A completed export receipt is required.");
    this.same(record.source);
    const bytes = await this.read(record);
    this.same(record.source);
    if (bytes.length !== status.receipt.bytes || digest(bytes) !== status.receipt.sha256) throw new Error("The exported HTML no longer matches its original hash.");
    return { receipt: status.receipt, bytes };
  }
}
