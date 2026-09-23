import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { inspectOriginalParticipation, observeEnrolledOriginal,
  type NativeOriginalBinding, type NativeOriginalSource } from "@oh-my-pi/pi-coding-agent/session/original-session-ownership";
import type { ReviewedNativeSessionSource } from "./inspection";
import type { WorkerRuntime, WorkerSession } from "../omp-workers/runtime";
import type { WorkerEvent } from "../omp-workers/events";

export type { NativeOriginalBinding } from "@oh-my-pi/pi-coding-agent/session/original-session-ownership";
export interface OriginalAdmissionRefusal {
  code: "ORIGINAL_SESSION_NOT_SUBMITTED";
  reason: string;
  message: string;
}
export type OriginalAdmissionPreparation =
  | { ok: true; preparationId: string; binding: NativeOriginalBinding; source: NativeOriginalSource }
  | ({ ok: false } & OriginalAdmissionRefusal);
export type OriginalAdmissionStatus =
  | { commandId: string; state: "absent" }
  | { commandId: string; state: "pending"; binding: NativeOriginalBinding }
  | { commandId: string; state: "admitted"; binding: NativeOriginalBinding }
  | ({ commandId: string; state: "refused"; binding?: NativeOriginalBinding } & OriginalAdmissionRefusal)
  | { commandId: string; state: "unknown"; code: "OUTCOME_UNKNOWN"; message: string; binding?: NativeOriginalBinding };
export interface OriginalAdmissionResult { status: OriginalAdmissionStatus; handle?: WorkerSession }
export class OriginalAdmissionInputMismatch extends Error {
  readonly code = "ORIGINAL_SESSION_INPUT_MISMATCH";
  constructor() { super("This original command already has different admission input; its retained outcome was not changed."); }
}
export interface NativeOriginalAdmissionOptions {
  dataDirectory: string;
  ownershipDirectory: string;
  runtime: Pick<WorkerRuntime, "openOriginal" | "isOriginalHandleCurrent">;
  resolveReviewedSource(candidateId: string, expectedRevision: string): Promise<ReviewedNativeSessionSource>;
  /** Root reserves this exact native-ID/file pair for its durable command before
   * native startup. Reservation is not proof that an external writer released. */
  reserveCatalogIdentity(source: NativeOriginalSource, commandId: string): Promise<void> | void;
  onEvent?(nativeId: string, event: WorkerEvent): void;
}
interface PreparedOriginal {
  binding: NativeOriginalBinding;
  source: NativeOriginalSource;
  review?: { candidateId: string; expectedRevision: string };
}
interface AdmissionRecord {
  version: 1; dispatcherId: string; requestHash: string; status: Exclude<OriginalAdmissionStatus, { state: "absent" }>;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 4096);
function identifier(value: string): string {
  if (typeof value !== "string" || !value.length || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid original admission identity.");
  return value;
}
const refusal = (reason: string, text: string): OriginalAdmissionRefusal => ({ code: "ORIGINAL_SESSION_NOT_SUBMITTED", reason, message: text });
const unknown = (commandId: string, text: string, binding?: NativeOriginalBinding): Extract<OriginalAdmissionStatus, { state: "unknown" }> =>
  ({ commandId, state: "unknown", code: "OUTCOME_UNKNOWN", message: text, ...(binding ? { binding } : {}) });
function nativeRefusal(error: unknown): OriginalAdmissionRefusal | undefined {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ORIGINAL_SESSION_NOT_SUBMITTED") return;
  return refusal("reason" in error && typeof error.reason === "string" ? error.reason : "native-refusal", message(error));
}
function validBinding(value: unknown): value is NativeOriginalBinding {
  if (!value || typeof value !== "object" || !("protocol" in value) || value.protocol !== 1) return false;
  const fields = value as Record<string, unknown>;
  return ["enrollmentId", "registryId", "originalFile", "nativeId", "recordedCwd", "canonicalCwd"].every(key =>
    typeof fields[key] === "string" && fields[key].length > 0);
}
function sameBinding(actual: NativeOriginalBinding, expected: NativeOriginalBinding): boolean {
  return actual.protocol === expected.protocol && actual.registryId === expected.registryId
    && actual.enrollmentId === expected.enrollmentId && actual.nativeId === expected.nativeId
    && actual.originalFile === expected.originalFile && actual.recordedCwd === expected.recordedCwd
    && actual.canonicalCwd === expected.canonicalCwd;
}

/** The service journals native admission, not the host catalog. Root publishes
 * catalog ownership only after checking the exact returned worker and binding.
 * A receipt lookup never starts a worker, opens a native file or retries work. */
export class NativeOriginalSessionAdmission {
  readonly #dispatcherId = randomUUID();
  readonly #databasePath: string;
  #db?: Database;
  #closing = false;
  #dispose?: Promise<void>;
  #preparations = new Map<string, PreparedOriginal>();
  #pending = new Map<string, { requestHash: string; result: Promise<OriginalAdmissionResult> }>();
  #handles = new Map<string, { handle: WorkerSession; binding: NativeOriginalBinding; admitted: boolean }>();
  #uncertain = new Map<string, OriginalAdmissionStatus>();

  constructor(private readonly options: NativeOriginalAdmissionOptions) {
    if (!path.isAbsolute(options.dataDirectory) || !path.isAbsolute(options.ownershipDirectory)) throw new Error("Original admission requires owning-host absolute directories.");
    mkdirSync(options.dataDirectory, { recursive: true, mode: 0o700 });
    this.#databasePath = path.join(options.dataDirectory, "original-admission.sqlite");
    this.#db = new Database(this.#databasePath, { create: true, strict: true });
    chmodSync(this.#databasePath, 0o600);
    this.#db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
  }

  async prepare(input: { candidateId: string; expectedRevision: string } | { binding: NativeOriginalBinding }): Promise<OriginalAdmissionPreparation> {
    if (this.#closing) return { ok: false, ...refusal("closing", "Original admission is closing.") };
    try {
      let source: NativeOriginalSource, review: PreparedOriginal["review"], expectedBinding: NativeOriginalBinding | undefined;
      if ("binding" in input) {
        expectedBinding = structuredClone(input.binding);
        source = structuredClone(await observeEnrolledOriginal(this.options.ownershipDirectory, expectedBinding));
      } else {
        review = { candidateId: identifier(input.candidateId), expectedRevision: identifier(input.expectedRevision) };
        source = structuredClone(await this.options.resolveReviewedSource(review.candidateId, review.expectedRevision));
      }
      if (this.#closing) return { ok: false, ...refusal("closing", "Original admission closed while the source was inspected.") };
      const participation = await inspectOriginalParticipation(this.options.ownershipDirectory, source);
      if (!participation.ok) return { ok: false, ...refusal(participation.reason, participation.message) };
      if (expectedBinding && !sameBinding(participation.binding, expectedBinding)) {
        return { ok: false, ...refusal("binding-source-mismatch", "The original no longer matches its complete retained binding.") };
      }
      if (this.#closing) return { ok: false, ...refusal("closing", "Original admission closed while participation was inspected.") };
      // Preparations grant no ownership. Bound retained memory and reject an
      // evicted confirmation rather than silently preparing a newer source.
      if (this.#preparations.size >= 64) this.#preparations.delete(this.#preparations.keys().next().value!);
      const preparationId = randomUUID(), prepared: PreparedOriginal = { source, binding: structuredClone(participation.binding), ...(review ? { review } : {}) };
      this.#preparations.set(preparationId, prepared);
      return { ok: true, preparationId, source: structuredClone(source), binding: structuredClone(prepared.binding) };
    } catch (error) {
      return { ok: false, ...(nativeRefusal(error) ?? refusal("source-unavailable", message(error))) };
    }
  }

  #read(commandId: string): AdmissionRecord | undefined {
    const temporary = !this.#db, db = this.#db ?? new Database(this.#databasePath, { readonly: true, strict: true });
    try {
      const row = db.query<{ data: string }, [string]>("SELECT data FROM metadata WHERE key = ?").get("original-admission.v1:" + commandId);
      if (!row) return;
      if (Buffer.byteLength(row.data) > 65536) throw new Error("Original admission receipt exceeds its limit.");
      const record = JSON.parse(row.data) as AdmissionRecord;
      if (!record || record.version !== 1 || typeof record.dispatcherId !== "string" || !record.dispatcherId
        || typeof record.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(record.requestHash)
        || !record.status || record.status.commandId !== commandId
        || !["pending", "admitted", "refused", "unknown"].includes(record.status.state)
        || ((record.status.state === "pending" || record.status.state === "admitted") && !validBinding(record.status.binding))) {
        throw new Error("Original admission receipt is invalid; its bytes were preserved.");
      }
      return record;
    } finally { if (temporary) db.close(); }
  }
  #project(record: AdmissionRecord): OriginalAdmissionStatus {
    if (record.status.state === "pending" && (record.dispatcherId !== this.#dispatcherId || !this.#pending.has(record.status.commandId))) {
      return unknown(record.status.commandId, "The original admission has no proven live dispatcher. Inspect its original receipt and source; do not replay it.", record.status.binding);
    }
    return structuredClone(record.status);
  }
  #write(record: AdmissionRecord): void {
    if (!this.#db) throw new Error("Original admission journal is closed.");
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > 65536) throw new Error("Original admission receipt exceeds its limit.");
    this.#db.query("INSERT INTO metadata(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run("original-admission.v1:" + record.status.commandId, data);
  }
  async status(commandId: string): Promise<OriginalAdmissionStatus> {
    identifier(commandId);
    const uncertain = this.#uncertain.get(commandId); if (uncertain) return structuredClone(uncertain);
    try {
      const record = this.#read(commandId);
      return record ? this.#project(record) : { commandId, state: "absent" };
    } catch (error) { return unknown(commandId, message(error)); }
  }

  /** Lookup only: a durable admitted receipt is not proof of a retained live
   * worker. Never reacquire ownership to answer this question. */
  getRetainedHandle(commandId: string, expectedBinding: NativeOriginalBinding): WorkerSession | undefined {
    identifier(commandId);
    if (this.#closing || !validBinding(expectedBinding)) return;
    const retained = this.#handles.get(commandId);
    if (!retained?.admitted || !this.options.runtime.isOriginalHandleCurrent(retained.handle)) return;
    if (!sameBinding(retained.binding, expectedBinding)) return;
    return retained.handle;
  }

  async admit(input: { commandId: string; preparationId: string }): Promise<OriginalAdmissionResult> {
    const commandId = identifier(input.commandId), preparationId = identifier(input.preparationId);
    const requestHash = createHash("sha256").update(JSON.stringify({ preparationId })).digest("hex");
    const current = this.#pending.get(commandId);
    if (current) {
      if (current.requestHash !== requestHash) throw new OriginalAdmissionInputMismatch();
      return current.result;
    }
    let prior: AdmissionRecord | undefined;
    try { prior = this.#read(commandId); }
    catch (error) { return { status: unknown(commandId, message(error)) }; }
    if (prior) {
      if (prior.requestHash !== requestHash) throw new OriginalAdmissionInputMismatch();
      return { status: this.#project(prior) };
    }
    if (this.#closing) return { status: { commandId, state: "refused", ...refusal("closing", "Original admission is closing.") } };
    const prepared = this.#preparations.get(preparationId);
    if (!prepared) return { status: { commandId, state: "refused", ...refusal("invalid-preparation", "Review this original source again before admitting a new command.") } };
    const record: AdmissionRecord = { version: 1, dispatcherId: this.#dispatcherId, requestHash,
      status: { commandId, state: "pending", binding: structuredClone(prepared.binding) } };
    let claimed: AdmissionRecord | undefined;
    try {
      claimed = this.#db!.transaction(() => {
        const existing = this.#read(commandId);
        if (existing) return existing;
        this.#write(record); return undefined;
      }).immediate();
    } catch (error) { return { status: { commandId, state: "refused", ...refusal("journal-unavailable", message(error)) } }; }
    if (claimed) {
      if (claimed.requestHash !== requestHash) throw new OriginalAdmissionInputMismatch();
      return { status: this.#project(claimed) };
    }
    this.#preparations.delete(preparationId);
    // Defer the first external port until the local pending identity is visible.
    const result = Promise.resolve().then(() => this.#run(record, prepared));
    this.#pending.set(commandId, { requestHash, result });
    try { return await result; } finally { this.#pending.delete(commandId); }
  }

  async #run(record: AdmissionRecord, prepared: PreparedOriginal): Promise<OriginalAdmissionResult> {
    const commandId = record.status.commandId;
    let started = false, handle: WorkerSession | undefined;
    let preOpenReason = "source-unavailable";
    try {
      if (this.#closing) throw Object.assign(new Error("Original admission closed before source revalidation."), refusal("closing", "Original admission closed before source revalidation."));
      if (prepared.review) {
        const current = await this.options.resolveReviewedSource(prepared.review.candidateId, prepared.review.expectedRevision);
        const captured = prepared.source;
        if (current.originalFile !== captured.originalFile || current.nativeId !== captured.nativeId
          || current.recordedCwd !== captured.recordedCwd || current.canonicalCwd !== captured.canonicalCwd
          || current.contentSha256 !== captured.contentSha256
          || (["dev", "ino", "size", "mtimeMs", "ctimeMs", "birthtimeMs"] as const).some(key => current.fileIdentity[key] !== captured.fileIdentity[key])) {
          throw Object.assign(new Error("The reviewed original source changed; prepare it again."), refusal("stale-source", "The reviewed original source changed; prepare it again."));
        }
      }
      if (this.#closing) throw Object.assign(new Error("Original admission closed before catalog reservation."), refusal("closing", "Original admission closed before catalog reservation."));
      preOpenReason = "catalog-reservation-failed";
      await this.options.reserveCatalogIdentity(structuredClone(prepared.source), commandId);
      if (this.#closing) throw Object.assign(new Error("Original admission closed before native startup."), refusal("closing", "Original admission closed before native startup."));
      started = true;
      handle = await this.options.runtime.openOriginal({ ownershipDirectory: this.options.ownershipDirectory,
        source: structuredClone(prepared.source), binding: structuredClone(prepared.binding), commandId,
        onEvent: event => this.options.onEvent?.(prepared.binding.nativeId, event) });
      if (handle.id !== prepared.binding.nativeId || handle.sessionFile !== prepared.binding.originalFile || handle.cwd !== prepared.binding.recordedCwd) {
        throw new Error("The native worker returned a different original session identity.");
      }
      if (this.#closing) throw new Error("Original admission closed during native startup; inspect the original outcome.");
      const status: OriginalAdmissionStatus = { commandId, state: "admitted", binding: structuredClone(prepared.binding) };
      this.#write({ ...record, status });
      this.#handles.set(commandId, { handle, binding: prepared.binding, admitted: true });
      // A new writer now owns this exact original: any prior non-current
      // admitted worker for it has drained or exited. Do not discard failed
      // cleanup handles, or infer release merely from a non-current handle.
      for (const [previousId, previous] of this.#handles) {
        if (previousId !== commandId && previous.admitted && sameBinding(previous.binding, prepared.binding)
          && !this.options.runtime.isOriginalHandleCurrent(previous.handle)) this.#handles.delete(previousId);
      }
      return { status: structuredClone(status), handle };
    } catch (error) {
      let failure = error;
      if (handle) {
        try { await handle.dispose(); }
        catch (cleanup) {
          this.#handles.set(commandId, { handle, binding: prepared.binding, admitted: false });
          failure = new AggregateError([error, cleanup], "Original admission and its native cleanup failed. Ownership release is unproven.");
        }
      }
      const noEffect = !handle && nativeRefusal(failure);
      const status: Exclude<OriginalAdmissionStatus, { state: "absent" }> = noEffect || !started
        ? { commandId, state: "refused", binding: structuredClone(prepared.binding), ...(noEffect || refusal(preOpenReason, message(failure))) }
        : unknown(commandId, message(failure), structuredClone(prepared.binding));
      try { this.#write({ ...record, status }); }
      catch (journalError) {
        const retained = unknown(commandId, `Admission settlement could not be persisted: ${message(journalError)}. Inspect the original source; do not replay.`, structuredClone(prepared.binding));
        this.#uncertain.set(commandId, retained); return { status: retained };
      }
      return { status };
    }
  }

  dispose(): Promise<void> {
    if (this.#dispose) return this.#dispose;
    this.#closing = true; this.#preparations.clear();
    this.#dispose = (async () => {
      await Promise.allSettled([...this.#pending.values()].map(pending => pending.result));
      const failures: unknown[] = [];
      await Promise.all([...this.#handles].map(async ([commandId, { handle, binding }]) => {
        try { await handle.dispose(); this.#handles.delete(commandId); }
        catch (error) {
          failures.push(error);
          const retained = unknown(commandId, `Native cleanup did not prove ownership release: ${message(error)}`, structuredClone(binding));
          this.#uncertain.set(commandId, retained);
          try { const record = this.#read(commandId); if (record) this.#write({ ...record, status: retained as Extract<OriginalAdmissionStatus, { state: "unknown" }> }); }
          catch (journalError) { failures.push(journalError); }
        }
      }));
      this.#db?.close(); this.#db = undefined;
      if (failures.length) throw new AggregateError(failures, "Original admission cleanup is incomplete; no ownership release was assumed.");
    })();
    return this.#dispose;
  }
}
