import { createHash, randomUUID } from "node:crypto";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { AgentRegistry, buildSessionContext, migrateToCurrentVersion, visitEntriesFromFileStream,
  type AgentRef, type AgentSession, type FileEntry, type SessionEntry, type SessionHeader } from "@oh-my-pi/pi-coding-agent";
import { BLOB_HASH_RE, isBlobRef } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { getBlobsDir } from "@oh-my-pi/pi-utils";
import type { ActivityCapability, ImageAttachmentMimeType, NativeAgentActivity } from "@agent-desktop/shared";
import { parseSessionSubagentsRequest, sameSessionSubagentsOwner, SESSION_SUBAGENTS_MAX_FILE_BYTES, SESSION_SUBAGENTS_MAX_IMAGE_BYTES, SESSION_SUBAGENTS_MAX_JOURNAL_BYTES,
  SESSION_SUBAGENTS_MAX_RESPONSE_BYTES, SESSION_SUBAGENTS_MAX_ROWS, SESSION_SUBAGENTS_RESPONSE_RESERVE_BYTES, type SessionSubagentRow, type SessionSubagentsOwner,
  type SessionSubagentsRequest, type SessionSubagentsResult, type SessionSubagentTarget } from "../../../../packages/shared/src/session-subagents";
import { lookupFileMentionImage } from "./file-mentions";
import { readNativeImage, type OmpRecordedImage } from "./images";
import { recordedGeneratedImage } from "./session-outputs";
import { TranscriptMirror, type NativeTranscriptEntry } from "./transcript";

export type NativeSubagentsErrorCode = "STALE_OWNER" | "STALE_CHILD" | "SUBAGENTS_REJECTED";
/** Every code means nothing native was read for another owner or child. The
 * worker RPC preserves only the error name, so the code is carried there as well. */
export class NativeSubagentsError extends Error {
  constructor(readonly code: NativeSubagentsErrorCode, message: string) { super(message); this.name = `NativeSubagentsError.${code}`; }
}
export function nativeSubagentsErrorCode(error: unknown): NativeSubagentsErrorCode | undefined {
  if (error instanceof NativeSubagentsError) return error.code;
  const match = error instanceof Error ? /^NativeSubagentsError\.(STALE_OWNER|STALE_CHILD|SUBAGENTS_REJECTED)$/.exec(error.name) : null;
  return match ? match[1] as NativeSubagentsErrorCode : undefined;
}

/** The exact native surface the adapter reads; production passes the real AgentSession. */
export type NativeSubagentsSession = Pick<AgentSession, "sessionFile" | "isDisposed" | "getAgentId" | "sessionManager">;
/** Header prefix a journal must present before any row or read is bound to it. */
const HEADER_READ_BYTES = 64 * 1024;
const TRANSCRIPT_BUDGET_BYTES = SESSION_SUBAGENTS_MAX_RESPONSE_BYTES - SESSION_SUBAGENTS_RESPONSE_RESERVE_BYTES;
const BLOB_PREFIX = "blob:sha256:";
const NO_JOURNAL = "This native session has no journal on disk, so child ownership cannot be established.";
const STALE_CHILD = "This child is no longer the one you listed. Refresh the roster before reading.";

/** The exact file a path named when a ticket was minted: real path plus device/inode. */
interface FileIdentity { real: string; dev: number; ino: number }
/** Identity a held target was minted against: the exact registry ref object, the
 * session generation attached to it, the journal path it named and that journal's file identity. */
interface Generation { session: AgentSession | null; sessionFile: string; guard: string; journal: FileIdentity }
interface Bound { ref: AgentRef; generation: Generation }
interface Journal { header: SessionHeader; entries: SessionEntry[]; truncated: boolean }

const sameFile = (a: FileIdentity, b: FileIdentity) => a.real === b.real && a.dev === b.dev && a.ino === b.ino;
const enoent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function pathTo(entries: readonly SessionEntry[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  const branch: SessionEntry[] = [];
  const seen = new Set<string>();
  for (let current = entries.at(-1); current && !seen.has(current.id); current = current.parentId === null ? undefined : byId.get(current.parentId)) {
    seen.add(current.id); branch.push(current);
  }
  return branch.reverse();
}
function transcriptEntries(branch: readonly SessionEntry[]): NativeTranscriptEntry[] {
  return branch.flatMap(entry => entry.type === "message" ? [{ id: entry.id, message: entry.message as unknown }]
    : entry.type === "custom_message" ? [{ id: entry.id, message: { role: "custom", customType: entry.customType, content: entry.content, display: entry.display, details: entry.details, attribution: entry.attribution, timestamp: Date.parse(entry.timestamp) } as unknown }] : []);
}
/** The one native image record a request addresses, in the same namespaces the root session serves. */
function imageRecord(entry: SessionEntry | undefined, blockIndex: number, source: "generated" | undefined): Record<string, unknown> | undefined {
  const message = entry?.type === "message" ? record(entry.message) : undefined;
  if (!message) return undefined;
  if (source === "generated") {
    const details = record(message.details), dispatch = record(details?.xdev);
    const generated = message.toolName === "generate_image" ? details : dispatch?.mode === "execute" && dispatch.tool === "generate_image" ? record(dispatch.inner) : undefined;
    return Array.isArray(generated?.images) ? record(generated.images[blockIndex]) : undefined;
  }
  if (message.role === "fileMention") return Array.isArray(message.files) ? record(record(message.files[blockIndex])?.image) : undefined;
  return Array.isArray(message.content) ? record(message.content[blockIndex]) : undefined;
}
function recordedImage(entry: SessionEntry | undefined, blockIndex: number, source: "generated" | undefined): OmpRecordedImage {
  if (source === "generated") return recordedGeneratedImage(entry, blockIndex);
  if (entry?.type === "message" && entry.message.role === "fileMention") {
    const image = lookupFileMentionImage(entry.message, blockIndex);
    if (!image) throw new Error("Native referenced image is unavailable");
    return image;
  }
  if (entry?.type !== "message" || !("content" in entry.message) || !Array.isArray(entry.message.content)) throw new Error("Native image entry is unavailable");
  return readNativeImage(entry.message.content[blockIndex]);
}
/** Read at most `max + 1` bytes from an open regular file; the extra byte reports overflow without loading the rest. */
async function readBounded(handle: FileHandle, max: number): Promise<{ data: Buffer; overflow: boolean }> {
  const info = await handle.stat();
  if (!info.isFile()) throw new NativeSubagentsError("SUBAGENTS_REJECTED", "The requested path is not a regular file.");
  const buffer = Buffer.allocUnsafe(Math.min(info.size, max) + 1);
  let read = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
    if (bytesRead === 0 || (read += bytesRead) === buffer.length) break;
  }
  return { data: buffer.subarray(0, Math.min(read, max)), overflow: read === buffer.length };
}
async function readHeader(real: string): Promise<SessionHeader | undefined> {
  let header: SessionHeader | undefined;
  await visitEntriesFromFileStream(real, entry => { if (entry.type === "session" && typeof entry.id === "string") header = entry; return false; }, { maxRecords: 1, maxBytes: HEADER_READ_BYTES });
  return header;
}

/** One loaded root session's task children, projected from the process-global
 * native registry and filtered to refs whose journal lies below this root's own
 * artifact directory, lexically and by real path. Stores no children: every row
 * is re-derived from the live ref at request time, every disk read is bounded
 * and fenced before and after each await against the owner, the exact ref
 * generation and the exact journal file, and nothing here opens a writer,
 * revives, resumes, sends to or stops a child. */
export class NativeSessionSubagents {
  #owner: SessionSubagentsOwner;
  readonly #agentId: string | undefined;
  readonly #rootFile: string | undefined;
  /** Lexical `<root>.jsonl` minus the suffix: where the native task tool writes this root's children. */
  readonly #rootDir: string | undefined;
  /** Real identity of `#rootDir`, bound on the first disk touch; a later swap or move fails closed. */
  #root: FileIdentity | undefined;
  #rootJournal: FileIdentity | undefined;
  readonly #registry = AgentRegistry.global();
  readonly #manager: NativeSubagentsSession["sessionManager"];
  readonly #generations = new WeakMap<AgentRef, Generation>();
  constructor(private readonly session: NativeSubagentsSession, private readonly assertOwner: () => void, nativeSessionId = session.sessionManager.getSessionId()) {
    this.#owner = { nativeSessionId, epoch: randomUUID() };
    this.#agentId = session.getAgentId() || undefined;
    this.#rootFile = session.sessionFile;
    this.#manager = session.sessionManager;
    this.#rootDir = this.#rootFile?.endsWith(".jsonl") ? path.resolve(this.#rootFile).slice(0, -".jsonl".length) : undefined;
    this.#assert();
  }
  get owner(): SessionSubagentsOwner { return { ...this.#owner }; }

  /** Synchronous, lexical, root-filtered roster for `getSessionActivity`; usable
   * while the worker retires because it touches neither the fence nor the disk. */
  activity(): ActivityCapability<NativeAgentActivity[]> {
    if (!this.#rootDir) return { availability: "unavailable", reason: NO_JOURNAL };
    const registry = this.#registry;
    const value = registry.list().filter(ref => this.#owned(ref)).slice(0, SESSION_SUBAGENTS_MAX_ROWS).map(ref => ({
      id: ref.id.slice(0, 200), displayName: ref.displayName.slice(0, 500), status: ref.status, running: registry.isRunning(ref),
      ...(ref.parentId ? { parentId: ref.parentId.slice(0, 200) } : {}), createdAt: ref.createdAt, lastActivity: ref.lastActivity,
      ...(ref.activity ? { activity: ref.activity.slice(0, 500) } : {}),
    }));
    return { availability: "available", value };
  }

  async request(raw: SessionSubagentsRequest): Promise<SessionSubagentsResult> {
    let request: SessionSubagentsRequest;
    try { request = parseSessionSubagentsRequest(raw); }
    catch (error) { throw new NativeSubagentsError("SUBAGENTS_REJECTED", error instanceof Error ? error.message : String(error)); }
    this.#assert();
    if (request.owner && !sameSessionSubagentsOwner(request.owner, this.#owner))
      throw new NativeSubagentsError("STALE_OWNER", "These subagents belong to another native owner generation. Refresh before reading.");
    if (request.action === "list") return this.#list();
    const target = request.target, bound = this.#resolve(target);
    if (request.action === "validate") {
      if (bound.ref.session) await this.#verify(target, bound); else await this.#journal(target, bound, HEADER_READ_BYTES, 1);
      return { action: "validate", owner: this.owner, target };
    }
    if (request.action === "transcript") return this.#transcript(target, bound);
    if (request.action === "image") {
      let entry: SessionEntry | undefined;
      if (bound.ref.session) {
        await this.#verify(target, bound);
        // Same synchronous tick as the verify above: the live child's own branch, never mutated.
        entry = bound.ref.session.sessionManager.getBranch().find(entry => entry.id === request.nativeEntryId);
      } else entry = await this.#entry(target, bound, request.nativeEntryId, request.blockIndex, request.source);
      const image = recordedImage(entry, request.blockIndex, request.source);
      if (image.bytes > SESSION_SUBAGENTS_MAX_IMAGE_BYTES) throw new Error("The native image exceeds the desktop response budget; no partial image was returned.");
      return { action: "image", owner: this.owner, target, image: { base64: Buffer.from(image.data).toString("base64"), mimeType: image.mimeType as ImageAttachmentMimeType, bytes: image.bytes, sha256: image.sha256 } };
    }
    let cwd: string;
    if (bound.ref.session) { await this.#verify(target, bound); cwd = bound.ref.session.sessionManager.getCwd(); }
    else cwd = (await this.#journal(target, bound, HEADER_READ_BYTES, 1)).header.cwd;
    const file = await this.#confinedFile(target, bound, cwd, request.path);
    return { action: "file", owner: this.owner, target, path: request.path, ...file };
  }

  /** The runtime fence and the bound root identity are both required; either
   * failing means every held row and target is stale. */
  #assert(): void {
    try { this.assertOwner(); }
    catch (error) { throw new NativeSubagentsError("STALE_OWNER", error instanceof Error ? error.message : String(error)); }
    const session = this.session;
    if (session.isDisposed || session.sessionManager !== this.#manager || AgentRegistry.global() !== this.#registry || session.sessionFile !== this.#rootFile || session.sessionManager.getSessionId() !== this.#owner.nativeSessionId
      || (session.getAgentId() || undefined) !== this.#agentId)
      throw new NativeSubagentsError("STALE_OWNER", "The original native subagents owner has retired.");
  }
  /** Lexical ownership: the ref's journal lies below this root's artifact directory. Every status is filtered alike. */
  #owned(ref: AgentRef): boolean {
    return ref.kind !== "main" && typeof ref.sessionFile === "string" && this.#rootDir !== undefined && path.resolve(ref.sessionFile).startsWith(`${this.#rootDir}${path.sep}`);
  }
  /** The real root artifact directory, bound to its first observed identity; the
   * root journal beside it must still carry this owner's session header. */
  async #rootReal(): Promise<string | undefined> {
    const stale = (message: string) => new NativeSubagentsError("STALE_OWNER", message);
    this.#assert();
    const journal = await realpath(this.#rootFile!).catch(error => { throw enoent(error) ? stale("The original root journal is gone.") : error; });
    this.#assert();
    const file = await stat(journal);
    this.#assert();
    const journalIdentity = { real: journal, dev: file.dev, ino: file.ino };
    if (!file.isFile() || this.#rootJournal && !sameFile(this.#rootJournal, journalIdentity)) throw stale("The original root journal was replaced.");
    const header = await readHeader(journal);
    this.#assert();
    if (header?.id !== this.#owner.nativeSessionId) throw stale("The original root journal was replaced.");
    const after = await stat(journal);
    this.#assert();
    if (after.dev !== file.dev || after.ino !== file.ino) throw stale("The original root journal changed during the read.");
    this.#rootJournal ??= journalIdentity;
    const real = await realpath(this.#rootDir!).catch(error => { if (enoent(error)) return undefined; throw error; });
    this.#assert();
    if (real === undefined) return undefined;
    if (`${real}.jsonl` !== journal) throw stale("The original root artifact directory no longer sits beside its journal.");
    const info = await stat(real);
    this.#assert();
    const identity = { real, dev: info.dev, ino: info.ino };
    this.#root ??= identity;
    if (!info.isDirectory() || !sameFile(this.#root, identity)) throw stale("The original root artifact directory was replaced.");
    return real;
  }
  /** Exact identity of a ref's journal, or undefined when its real path escapes the real root.
   * A missing journal surfaces as ENOENT so callers can report it honestly. */
  async #identify(ref: AgentRef, root: string): Promise<FileIdentity | undefined> {
    const real = await realpath(ref.sessionFile!);
    if (!real.startsWith(`${root}${path.sep}`)) return undefined;
    const info = await stat(real);
    return info.isFile() ? { real, dev: info.dev, ino: info.ino } : undefined;
  }
  /** Reuse a ticket only while the ref keeps the same attached session, journal path and journal file. */
  #mint(ref: AgentRef, journal: FileIdentity): Generation {
    let generation = this.#generations.get(ref);
    if (!generation || generation.session !== ref.session || generation.sessionFile !== ref.sessionFile || !sameFile(generation.journal, journal)) {
      generation = { session: ref.session, sessionFile: ref.sessionFile!, guard: randomUUID(), journal };
      this.#generations.set(ref, generation);
    }
    return generation;
  }
  /** Synchronous binding of a target to the exact registry ref and generation it was minted for. */
  #resolve(target: SessionSubagentTarget): Bound {
    const ref = this.#registry.get(target.id), generation = ref && this.#generations.get(ref);
    if (!ref || !generation || !this.#owned(ref) || generation.guard !== target.guard || generation.session !== ref.session || generation.sessionFile !== ref.sessionFile)
      throw new NativeSubagentsError("STALE_CHILD", STALE_CHILD);
    if (ref.session && (ref.session.isDisposed || ref.session.sessionFile !== ref.sessionFile || ref.session.sessionManager.getSessionId() !== target.sessionId))
      throw new NativeSubagentsError("STALE_CHILD", "This child's native session changed since it was listed. Refresh the roster before reading.");
    return { ref, generation };
  }
  /** Full fence around an await: owner, exact ref generation and exact journal file, checked
   * synchronously on both sides of the disk identity read. ENOENT propagates. */
  async #verify(target: SessionSubagentTarget, bound: Bound): Promise<void> {
    this.#assert();
    if (this.#resolve(target).generation !== bound.generation) throw new NativeSubagentsError("STALE_CHILD", STALE_CHILD);
    const root = await this.#rootReal();
    const journal = root === undefined ? undefined : await this.#identify(bound.ref, root);
    this.#assert();
    if (this.#resolve(target).generation !== bound.generation) throw new NativeSubagentsError("STALE_CHILD", STALE_CHILD);
    if (!journal || !sameFile(journal, bound.generation.journal)) throw new NativeSubagentsError("STALE_CHILD", "This child's journal was replaced since it was listed.");
    const header = await readHeader(journal.real);
    this.#assert();
    if (this.#resolve(target).generation !== bound.generation || header?.id !== target.sessionId)
      throw new NativeSubagentsError("STALE_CHILD", "This child's journal identity changed during the read.");
    const after = await this.#identify(bound.ref, root!);
    this.#assert();
    if (this.#resolve(target).generation !== bound.generation || !after || !sameFile(journal, after))
      throw new NativeSubagentsError("STALE_CHILD", "This child's journal changed during the read.");
  }

  async #list(): Promise<SessionSubagentsResult> {
    if (!this.#rootDir) return { action: "list", owner: this.owner, availability: "unavailable", rows: [], omitted: 0, reason: NO_JOURNAL };
    for (let attempt = 0; ; attempt++) {
      const registry = this.#registry;
      const owned = registry.list().filter(ref => this.#owned(ref));
      const snapshot = owned.slice(0, SESSION_SUBAGENTS_MAX_ROWS).map(ref => ({ ref, session: ref.session, sessionFile: ref.sessionFile }));
      const bound: Array<Bound & { sessionId: string }> = [];
      const root = snapshot.length ? await this.#rootReal() : undefined;
      for (const { ref } of snapshot) {
        // Absent, escaping, header-less or replaced-mid-read journals are counted, never guessed.
        const journal = root === undefined ? undefined : await this.#identify(ref, root).catch(error => { if (enoent(error)) return undefined; throw error; });
        this.#assert();
        if (!journal) continue;
        const sessionId = (await readHeader(journal.real).catch(error => { if (enoent(error)) return undefined; throw error; }))?.id;
        this.#assert();
        if (sessionId === undefined || ref.session && ref.session.sessionManager.getSessionId() !== sessionId) continue;
        bound.push({ ref, generation: this.#mint(ref, journal), sessionId });
      }
      this.#assert();
      const stable = snapshot.every(({ ref, session, sessionFile }) => registry.get(ref.id) === ref && ref.session === session && ref.sessionFile === sessionFile)
        && bound.every(({ ref, generation }) => this.#generations.get(ref) === generation);
      if (!stable) { if (attempt >= 2) throw new Error("The native subagent roster changed during the read; no partial roster was returned."); continue; }
      const rows = bound.map(({ ref, generation, sessionId }): SessionSubagentRow => ({
        target: { id: ref.id, sessionId, guard: generation.guard }, displayName: ref.displayName.slice(0, 500), status: ref.status,
        running: registry.isRunning(ref), createdAt: ref.createdAt, lastActivity: ref.lastActivity, ...(ref.activity ? { activity: ref.activity.slice(0, 500) } : {}),
      }));
      return { action: "list", owner: this.owner, availability: "available", rows, omitted: owned.length - rows.length };
    }
  }
  /** Bounded read-only load of a detached child's exact journal file, fenced before and after
   * and bound to the listed session id. `maxRecords: 1` reads only the header. */
  async #journal(target: SessionSubagentTarget, bound: Bound, maxBytes: number, maxRecords?: number): Promise<Journal> {
    await this.#verify(target, bound);
    const real = bound.generation.journal.real;
    const size = (await stat(real)).size;
    const entries: FileEntry[] = [];
    let malformed = false;
    await visitEntriesFromFileStream(real, entry => { entries.push(entry); }, { maxBytes, onMalformedRecord: () => { malformed = true; }, ...(maxRecords === undefined ? {} : { maxRecords }) });
    await this.#verify(target, bound);
    const header = entries[0];
    if (header?.type !== "session" || header.id !== target.sessionId) throw new NativeSubagentsError("STALE_CHILD", "This child's journal was replaced since it was listed.");
    return { header, entries: entries.filter((entry): entry is SessionEntry => entry.type !== "session"), truncated: size > maxBytes || malformed };
  }
  async #transcript(target: SessionSubagentTarget, bound: Bound): Promise<SessionSubagentsResult> {
    let messages: unknown[], entries: NativeTranscriptEntry[], cwd: string, journalTruncated = false;
    let journal: Journal | undefined;
    try {
      if (bound.ref.session) await this.#verify(target, bound);
      else journal = await this.#journal(target, bound, SESSION_SUBAGENTS_MAX_JOURNAL_BYTES);
    }
    catch (error) {
      if (!enoent(error)) throw error;
      this.#assert(); this.#resolve(target);
      return { action: "transcript", owner: this.owner, target, availability: "missing", messages: [], truncated: false, reason: `The child's journal is missing: ${bound.ref.sessionFile}` };
    }
    if (journal) {
      migrateToCurrentVersion([journal.header, ...journal.entries]);
      messages = buildSessionContext(journal.entries, undefined, undefined, { transcript: true, collapseCompactedHistory: false, keepDanglingToolCalls: true }).messages;
      entries = transcriptEntries(pathTo(journal.entries)); cwd = journal.header.cwd; journalTruncated = journal.truncated;
    } else {
      // Same synchronous tick as the verify above: the live child's own context builder and branch.
      const live = this.#resolve(target).ref.session!;
      messages = live.buildTranscriptSessionContext({ collapseCompactedHistory: false, keepDanglingToolCalls: true }).messages;
      entries = transcriptEntries(live.sessionManager.getBranch()); cwd = live.sessionManager.getCwd();
    }
    const projected = new TranscriptMirror().snapshot(messages, entries);
    // Honest response bound: whole leading messages up to the byte budget, never a torn row.
    let bytes = 2; const kept: typeof projected = [];
    for (const message of projected) {
      bytes += Buffer.byteLength(JSON.stringify(message)) + 1;
      if (bytes > TRANSCRIPT_BUDGET_BYTES) break;
      kept.push(message);
    }
    return { action: "transcript", owner: this.owner, target, availability: "available", messages: kept, cwd, truncated: journalTruncated || kept.length < projected.length };
  }
  /** One exact detached journal entry; only the addressed image record's blob is restored, bounded. */
  async #entry(target: SessionSubagentTarget, bound: Bound, nativeEntryId: string, blockIndex: number, source: "generated" | undefined): Promise<SessionEntry | undefined> {
    const journal = await this.#journal(target, bound, SESSION_SUBAGENTS_MAX_JOURNAL_BYTES);
    const entry = journal.entries.find(entry => entry.id === nativeEntryId);
    if (!entry) return undefined;
    migrateToCurrentVersion([journal.header, entry]);
    const image = imageRecord(entry, blockIndex, source);
    if (typeof image?.data === "string" && isBlobRef(image.data)) {
      const hash = image.data.slice(BLOB_PREFIX.length);
      if (!BLOB_HASH_RE.test(hash)) throw new Error("Native image bytes are unavailable or invalid");
      const handle = await open(path.join(getBlobsDir(), hash), constants.O_RDONLY | constants.O_NOFOLLOW);
      let blob: { data: Buffer; overflow: boolean };
      try { blob = await readBounded(handle, SESSION_SUBAGENTS_MAX_IMAGE_BYTES); } finally { await handle.close(); }
      await this.#verify(target, bound);
      if (blob.overflow) throw new Error("The native image exceeds the desktop response budget; no partial image was returned.");
      if (createHash("sha256").update(blob.data).digest("hex") !== hash) throw new Error("Native image blob does not match its recorded hash.");
      image.data = blob.data.toString("base64");
    }
    return entry;
  }
  /** A regular file whose real path lies inside the child's real working directory, read up to the file bound. */
  async #confinedFile(target: SessionSubagentTarget, bound: Bound, cwd: string, relative: string): Promise<{ text: string; truncated: boolean }> {
    const realCwd = await realpath(cwd);
    const real = await realpath(path.resolve(cwd, relative));
    await this.#verify(target, bound);
    if (real !== realCwd && !real.startsWith(`${realCwd}${path.sep}`)) throw new NativeSubagentsError("SUBAGENTS_REJECTED", "The requested file lies outside the child's working directory.");
    const expected = await stat(real);
    const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: { text: string; truncated: boolean };
    try {
      const opened = await handle.stat();
      if (opened.dev !== expected.dev || opened.ino !== expected.ino) throw new NativeSubagentsError("STALE_CHILD", "The child file changed while it was being opened.");
      const { data, overflow } = await readBounded(handle, SESSION_SUBAGENTS_MAX_FILE_BYTES);
      const finalPath = await realpath(path.resolve(cwd, relative)), final = await stat(finalPath);
      if (finalPath !== real || final.dev !== opened.dev || final.ino !== opened.ino) throw new NativeSubagentsError("STALE_CHILD", "The child file changed during the read.");
      value = { text: data.toString("utf8"), truncated: overflow };
    } finally { await handle.close(); }
    await this.#verify(target, bound);
    return value;
  }
}
