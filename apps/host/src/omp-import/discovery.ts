import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { NativeSessionImports, type ImportCandidate, type OriginalSessionInspection, type ReviewedNativeSessionSource } from "./inspection";

/** Resolve an owning profile without creating its missing directories. */
export async function canonicalNativeImportProfile(profile: string): Promise<string> {
  const absolute=path.resolve(profile);
  try { return await realpath(absolute); }
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=="ENOENT"||path.dirname(absolute)===absolute)throw error;
    return path.join(await canonicalNativeImportProfile(path.dirname(absolute)),path.basename(absolute));
  }
}

/** An explicit read of the owning profile, without native directory migration,
 * backup recovery, SessionManager.open, or writable ownership acquisition. */
export class NativeSessionImportDiscovery {
  private readers = new Map<string, NativeSessionImports>();
  private candidates = new Map<string, NativeSessionImports>();
  private reading = false;
  private readonly options: { sessionsRoot: string; maxDirectories?: number; maxCandidates?: number };
  constructor(options: { sessionsRoot: string; maxDirectories?: number; maxCandidates?: number }) {
    this.options = { ...options };
    if (!path.isAbsolute(options.sessionsRoot)) throw new Error("Select an absolute owning-host sessions directory.");
    for (const value of [options.maxDirectories, options.maxCandidates]) {
      if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 10_000)) throw new Error("Native import discovery limits must be between 1 and 10000.");
    }
  }
  async scan(signal?: AbortSignal): Promise<ImportCandidate[]> {
    if (this.reading) throw new Error("Native session discovery is already running.");
    this.reading = true;
    try {
      signal?.throwIfAborted();
      let root: string;
      try { root = await realpath(this.options.sessionsRoot); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        signal?.throwIfAborted();
        this.readers.clear(); this.candidates.clear(); return [];
      }
      if (!(await stat(root)).isDirectory()) throw new Error("The owning profile sessions path is not a directory.");
      const entries = await readdir(root, { withFileTypes: true });
      const directories = new Set<string>();
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const directory = await realpath(path.join(root, entry.name));
        if (path.dirname(directory) !== root) throw new Error("A native session directory alias leaves the owning profile.");
        if (!(await stat(directory)).isDirectory()) continue;
        directories.add(directory);
        if (directories.size > (this.options.maxDirectories ?? 4096)) throw new Error("Native session discovery exceeds its directory limit; no partial list was returned.");
      }
      const rows: ImportCandidate[] = [], next = new Map<string, NativeSessionImports>();
      for (const directory of [...directories].sort()) {
        signal?.throwIfAborted();
        const reader = this.readers.get(directory) ?? new NativeSessionImports({ sessionDirectories: [directory], maxCandidates: this.options.maxCandidates ?? 4096 });
        this.readers.set(directory, reader);
        const found = await reader.scan();
        signal?.throwIfAborted();
        if (rows.length + found.length > (this.options.maxCandidates ?? 4096)) throw new Error("Native session discovery exceeds its candidate limit; no partial list was returned.");
        rows.push(...found);
        for (const row of found) next.set(row.candidateId, reader);
      }
      signal?.throwIfAborted();
      for (const directory of this.readers.keys()) if (!directories.has(directory)) this.readers.delete(directory);
      this.candidates = next;
      return rows;
    } catch (error) {
      // An incomplete refresh must not leave selectable partial or stale rows.
      this.readers.clear(); this.candidates.clear(); throw error;
    } finally { this.reading = false; }
  }
  private reader(candidateId: string): NativeSessionImports {
    const reader = this.candidates.get(candidateId);
    if (!reader) throw new Error("Select a current native import candidate.");
    return reader;
  }
  inspect(candidateId: string): Promise<OriginalSessionInspection> { return this.reader(candidateId).inspect(candidateId); }
  resolveReviewedSource(candidateId: string, revision: string): Promise<ReviewedNativeSessionSource> {
    return this.reader(candidateId).resolveReviewedSource(candidateId, revision);
  }
  checkAdmission(candidateId: string, revision: string): Promise<OriginalSessionInspection["writeAdmission"]> {
    return this.reader(candidateId).checkAdmission(candidateId, revision);
  }
}
