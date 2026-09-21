import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { TurnReviewAvailability, TurnReviewFile, TurnReviewOutcome } from "../../../../packages/shared/src/turn-review";

export const TURN_REVIEW_ENTRY = "agent-desktop.turn-review.v1";
export interface CapturedFile {
  path: string;
  mode: "100644" | "100755" | "120000";
  blob: string;
  bytes: number;
  binary: boolean;
}
export interface CapturedSnapshot { cwd: string; files: CapturedFile[]; issues: string[] }
export interface TurnRecord {
  version: 1;
  originSessionId: string;
  turnId: string;
  inputEntryIds: string[];
  branchEntryIdAtInput: string | null;
  cwd: string;
  before: string | null;
  after: string | null;
  recorded: string | null;
  derived: string | null;
  state: TurnReviewAvailability;
  outcome: TurnReviewOutcome;
  reason: string | null;
  backgroundJobs: number | null;
  unjoinedServices: string[];
  backgroundOwnerUncertain: boolean;
  producers: Array<{ callId: string; name: string; isError: boolean }>;
}
export interface RecordedPatch { files: TurnReviewFile[]; patch: string }
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function inside(root: string, path: string): boolean { const part = relative(root, path); return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part)); }
function hashName(value: string): string { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid recorded artifact identity."); return value; }

/** All evidence uses this actual SessionManager's configured artifact root; no home/default-path fallback. */
export class TurnLedger {
  constructor(readonly manager: SessionManager) {}
  root(): string {
    const root = this.manager.getArtifactsDir();
    if (!root || !this.manager.getSessionFile()) throw new Error("This native session has no durable artifact backing.");
    return join(root, "turn-review-v1");
  }
  async put(bytes: Uint8Array | string): Promise<string> {
    const hash = digest(bytes), root = this.root();
    await mkdir(root, { recursive: true });
    const temporary = join(root, `.pending-${crypto.randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, join(root, hash)); await this.syncDirectory(root); }
    finally { await rm(temporary, { force: true }); }
    return hash;
  }
  private async syncDirectory(path: string): Promise<void> { const directory = await open(path, "r"); try { await directory.sync(); } finally { await directory.close(); } }
  async get(hash: string): Promise<Buffer> {
    const bytes = await readFile(join(this.root(), hashName(hash)));
    if (digest(bytes) !== hash) throw new Error("Recorded artifact bytes do not match their saved identity.");
    return bytes;
  }
  async object<T>(hash: string): Promise<T> { return JSON.parse((await this.get(hash)).toString("utf8")) as T; }
  async saveObject(value: unknown): Promise<string> { return this.put(JSON.stringify(value)); }
  async append(record: TurnRecord): Promise<void> {
    if (this.manager.getSessionId() !== record.originSessionId) throw new Error("The native capture owner changed.");
    this.manager.appendCustomEntry(TURN_REVIEW_ENTRY, structuredClone(record));
    await this.manager.ensureOnDisk();
    await this.manager.flush();
  }
  records(): TurnRecord[] {
    const latest = new Map<string, TurnRecord>();
    for (const entry of this.manager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== TURN_REVIEW_ENTRY) continue;
      const record = entry.data as TurnRecord | undefined;
      if (!record || record.version !== 1 || typeof record.turnId !== "string" || typeof record.originSessionId !== "string" || !Array.isArray(record.inputEntryIds)) throw new Error("Saved turn evidence is invalid.");
      latest.set(`${record.originSessionId}:${record.turnId}`, record);
    }
    return [...latest.values()];
  }
  async snapshot(cwd: string): Promise<CapturedSnapshot> {
    // Compare backing paths in the same namespace as the canonical traversal.
    // The session may have been created through /tmp, /var or another symlink.
    await mkdir(this.root(), { recursive: true });
    const [root, artifacts, sessionFile] = await Promise.all([
      realpath(cwd), realpath(this.manager.getArtifactsDir()!), realpath(this.manager.getSessionFile()!),
    ]);
    const files: CapturedFile[] = [], issues: string[] = [];
    const excluded = (path: string) => path === sessionFile || inside(artifacts, path);
    const visit = async (directory: string, prefix: string): Promise<void> => {
      const names = (await readdir(directory)).sort();
      for (const name of names) {
        const path = join(directory, name), key = `${prefix}${name}`;
        if (name === ".git" || excluded(path)) continue;
        try {
          const metadata = await lstat(path);
          if (metadata.isSymbolicLink()) {
            const target = await readlink(path), bytes = Buffer.from(target);
            files.push({ path: key, mode: "120000", blob: await this.put(bytes), bytes: bytes.length, binary: false });
          } else if (metadata.isDirectory()) {
            if (!inside(root, await realpath(path))) throw new Error("A directory escaped the captured working directory.");
            await visit(path, `${key}/`);
          } else if (metadata.isFile()) {
            files.push(await this.captureFile(path, key, root));
          } else issues.push(`Unsupported filesystem entry: ${JSON.stringify(key)}.`);
        } catch (error) { issues.push(`${JSON.stringify(key)}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    };
    await visit(root, "");
    return { cwd: root, files, issues };
  }
  private async captureFile(path: string, key: string, cwd: string): Promise<CapturedFile> {
    const root = this.root(); await mkdir(root, { recursive: true });
    if (!inside(cwd, await realpath(dirname(path)))) throw new Error("A file parent escaped the captured working directory.");
    const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const temporary = join(root, `.pending-${crypto.randomUUID()}`);
    let target: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const before = await source.stat({ bigint: true });
      if (!before.isFile()) throw new Error("The captured entry is no longer a regular file.");
      target = await open(temporary, "wx", 0o600);
      const hash = createHash("sha256"), decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0, binary = false;
      for await (const raw of source.createReadStream({ autoClose: false })) {
        const chunk = raw as Buffer; hash.update(chunk); bytes += chunk.length;
        if (!binary) { try { binary = chunk.includes(0); if (!binary) decoder.decode(chunk, { stream: true }); } catch { binary = true; } }
        await target.writeFile(chunk);
      }
      if (!binary) { try { decoder.decode(); } catch { binary = true; } }
      const after = await source.stat({ bigint: true }), current = await lstat(path, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.ino !== current.ino || after.dev !== current.dev || !inside(cwd, await realpath(dirname(path)))) throw new Error("File changed while its capture was being read.");
      await target.sync(); await target.close(); target = undefined;
      const blob = hash.digest("hex"); await rename(temporary, join(root, blob)); await this.syncDirectory(root);
      return { path: key, mode: Number(after.mode) & 0o111 ? "100755" : "100644", blob, bytes, binary };
    } finally { await target?.close(); await source.close(); await rm(temporary, { force: true }); }
  }
}
