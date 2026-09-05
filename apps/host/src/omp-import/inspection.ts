import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { listSessionsReadOnly, type SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { parseSessionContent } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

export interface ImportCandidate {
  candidateId: string;
  sourcePath: string;
  nativeId?: string;
  title?: string;
  recordedCwd?: string;
  /** Native listing counts only the prefix; never label this a full count. */
  messageCountEstimate?: number;
  persistedStatus?: SessionInfo["status"];
  issue?: string;
}
export interface OriginalSessionInspection {
  candidateId: string;
  revision: string;
  originalFile: string;
  nativeId?: string;
  recordedCwd?: string;
  canonicalCwd?: string;
  nativeVersion?: number;
  entries: number;
  messages: number;
  malformedRecords: number;
  issues: string[];
  writeAdmission: { allowed: false; reason: "source-invalid" | "ownership-unverified" };
}
interface CandidateState { sourcePath: string; canonicalFile: string; fingerprint?: string; revision?: string }
const sameIdentity = (a: Awaited<ReturnType<typeof stat>>, b: Awaited<ReturnType<typeof stat>>) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Read-only opt-in inspection, deliberately not a writable import service.
 * Directories are selected by the owning host, never accepted from a renderer.
 * No SessionManager.open, auth discovery, cache repair, or OMP config executes. */
export class NativeSessionImports {
  #candidates = new Map<string, CandidateState>();
  #byFile = new Map<string, string>();
  #directories?: string[];
  constructor(readonly options: { sessionDirectories: string[]; maxCandidates?: number; maxBytes?: number }) {
    if (!options.sessionDirectories.length || options.sessionDirectories.length > 128 || options.sessionDirectories.some(value => !path.isAbsolute(value))) throw new Error("Select absolute owning-host native session directories");
    if (options.maxCandidates !== undefined && (!Number.isInteger(options.maxCandidates) || options.maxCandidates < 1 || options.maxCandidates > 10_000)) throw new Error("Native import candidate limit must be between 1 and 10000");
    if (options.maxBytes !== undefined && (!Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 256 * 1024 * 1024)) throw new Error("Native import inspection limit must be between 1 byte and 256 MiB");
  }
  async #roots(): Promise<string[]> {
    return this.#directories ??= await Promise.all(this.options.sessionDirectories.map(async directory => {
      const resolved = await realpath(directory); if (!(await stat(resolved)).isDirectory()) throw new Error("A selected session directory is unavailable"); return resolved;
    }));
  }
  async #canonical(file: string): Promise<string> {
    const canonical = await realpath(file);
    if (!(await this.#roots()).includes(path.dirname(canonical))) throw new Error("Session symlink leaves the selected native directories");
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error("Native session source is not a regular file");
    if (info.nlink !== 1) throw new Error("Hard-linked native sessions need an explicit alias ownership contract");
    return canonical;
  }
  async scan(): Promise<ImportCandidate[]> {
    const roots = await this.#roots();
    const paths = (await Promise.all(roots.map(async root => (await readdir(root)).filter(name => name.endsWith(".jsonl")).map(name => path.join(root, name))))).flat();
    if (paths.length > (this.options.maxCandidates ?? 4096)) throw new Error("Native session listing exceeds its candidate limit; select fewer directories");
    const candidates: ImportCandidate[] = [], approved: string[] = [];
    for (const sourcePath of paths) {
      try {
        const canonicalFile = await this.#canonical(sourcePath);
        let candidateId = this.#byFile.get(canonicalFile);
        if (!candidateId) { candidateId = randomUUID(); this.#byFile.set(canonicalFile, candidateId); this.#candidates.set(candidateId, { sourcePath, canonicalFile }); }
        if (!approved.includes(canonicalFile)) { approved.push(canonicalFile); candidates.push({ candidateId, sourcePath }); }
      } catch (error) { candidates.push({ candidateId: randomUUID(), sourcePath, issue: error instanceof Error ? error.message : "Unreadable native session source" }); }
    }
    // Use the native readonly listing parser over only pre-approved paths. Its
    // normal list() counterpart may recover orphaned backups on disk.
    const storage = new class extends FileSessionStorage { override listFilesSync() { return approved; } }();
    const summaries = new Map((await listSessionsReadOnly(roots[0]!, storage)).map(summary => [summary.path, summary]));
    for (const candidate of candidates) {
      const state = this.#candidates.get(candidate.candidateId); if (!state) continue;
      const summary = summaries.get(state.canonicalFile);
      if (!summary) { candidate.issue = "Native listing could not parse this file; inspect before considering import"; continue; }
      Object.assign(candidate, { nativeId: summary.id, title: summary.title, recordedCwd: summary.cwd, messageCountEstimate: summary.messageCount, persistedStatus: summary.status });
    }
    for (const [candidateId, state] of this.#candidates) if (!approved.includes(state.canonicalFile)) { this.#candidates.delete(candidateId); this.#byFile.delete(state.canonicalFile); }
    return candidates;
  }
  async inspect(candidateId: string): Promise<OriginalSessionInspection> {
    const candidate = this.#candidates.get(candidateId); if (!candidate) throw new Error("Select a current native import candidate");
    const canonical = await this.#canonical(candidate.sourcePath);
    if (canonical !== candidate.canonicalFile) throw new Error("Native session alias changed; scan again");
    const file = await open(canonical, "r");
    try {
      const before = await file.stat();
      const maxBytes = this.options.maxBytes ?? 64 * 1024 * 1024;
      if (before.size > maxBytes) throw new Error("Native session exceeds the full-inspection limit; no partial history was admitted");
      const buffer = Buffer.alloc(before.size + 1);
      let bytes = 0;
      while (bytes < buffer.length) { const result = await file.read(buffer, bytes, buffer.length - bytes, bytes); if (!result.bytesRead) break; bytes += result.bytesRead; }
      const after = await file.stat(), visible = await stat(canonical);
      if (bytes !== before.size || !sameIdentity(before, after) || !sameIdentity(after, visible)) throw new Error("Native session changed while being read; inspect again");
      const loaded = parseSessionContent(new TextDecoder("utf8", { fatal: true }).decode(buffer.subarray(0, bytes)));
      const header = loaded.entries[0];
      const issues: string[] = [];
      if (loaded.invalidHeader || header?.type !== "session") issues.push("A valid original native session header is required");
      if (loaded.malformedRecords) issues.push("Malformed native records require explicit recovery before writable import");
      const nativeId = header?.type === "session" && typeof header.id === "string" ? header.id : undefined;
      const recordedCwd = header?.type === "session" && typeof header.cwd === "string" ? header.cwd : undefined;
      if (!nativeId) issues.push("Original native session identity is missing");
      const nativeVersion = header?.type === "session" && typeof header.version === "number" && Number.isInteger(header.version) ? header.version : undefined;
      if (header?.type === "session" && header.version !== undefined && nativeVersion === undefined) issues.push("Native session version is malformed");
      if (nativeVersion !== undefined && nativeVersion > CURRENT_SESSION_VERSION) issues.push("Native session version is newer than the pinned runtime");
      let canonicalCwd: string | undefined;
      try {
        if (!recordedCwd || !path.isAbsolute(recordedCwd)) throw new Error();
        canonicalCwd = await realpath(recordedCwd);
        if (!(await stat(canonicalCwd)).isDirectory()) throw new Error();
        await access(canonicalCwd, constants.R_OK | constants.X_OK);
      } catch { issues.push("Original working directory is unavailable; import must not fall back to another directory"); }
      const fingerprint = createHash("sha256").update(buffer.subarray(0, bytes)).update(JSON.stringify([canonical, after.dev, after.ino, canonicalCwd])).digest("hex");
      if (fingerprint !== candidate.fingerprint) { candidate.fingerprint = fingerprint; candidate.revision = randomUUID(); }
      return { candidateId, revision: candidate.revision!, originalFile: canonical, nativeId, recordedCwd, canonicalCwd, nativeVersion,
        entries: loaded.entries.length, messages: loaded.entries.filter(entry => entry?.type === "message").length,
        malformedRecords: loaded.malformedRecords, issues,
        writeAdmission: { allowed: false, reason: issues.length ? "source-invalid" : "ownership-unverified" } };
    } finally { await file.close(); }
  }
  async checkAdmission(candidateId: string, expectedRevision: string): Promise<OriginalSessionInspection["writeAdmission"]> {
    const inspection = await this.inspect(candidateId);
    if (inspection.revision !== expectedRevision) throw new Error("Original session changed since inspection");
    // Stock OMP does not participate in an external ownership protocol. An
    // unlocked advisory sidecar or absent PID cannot turn this into approval.
    return inspection.writeAdmission;
  }
}
