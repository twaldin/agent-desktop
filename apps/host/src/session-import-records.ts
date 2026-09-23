import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { SessionSummary } from "@agent-desktop/shared";
import type { HostStore } from "./store";

/** Durable host schema for one explicitly imported original. These fields are
 * copied from native admission, never reconstructed from a file listing. */
export interface OriginalImportIdentity {
  originalFile: string; nativeId: string; recordedCwd: string; canonicalCwd: string;
}
export interface OriginalImportBinding extends OriginalImportIdentity {
  protocol: 1; enrollmentId: string; registryId: string;
}
export interface OriginalImportRecord {
  version: 1; commandId: string; source: OriginalImportIdentity;
  state: "reserved" | "admitted" | "refused" | "unknown";
  binding?: OriginalImportBinding; error?: string;
}
const prefix = "original-import.v1:";
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid original import identity.");
  return value;
}
function source(value: OriginalImportIdentity): OriginalImportIdentity {
  const result = { nativeId: id(value.nativeId), originalFile: value.originalFile, recordedCwd: value.recordedCwd, canonicalCwd: value.canonicalCwd };
  for (const path of [result.originalFile, result.recordedCwd, result.canonicalCwd]) {
    if (typeof path !== "string" || path.length > 4096 || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Invalid original import path.");
  }
  return result;
}
function binding(value: OriginalImportBinding): OriginalImportBinding {
  if (value.protocol !== 1) throw new Error("Unsupported original ownership protocol.");
  return { ...source(value), protocol: 1, enrollmentId: id(value.enrollmentId), registryId: id(value.registryId) };
}
function same(left: OriginalImportIdentity, right: OriginalImportIdentity): boolean {
  return left.nativeId === right.nativeId && left.originalFile === right.originalFile
    && left.recordedCwd === right.recordedCwd && left.canonicalCwd === right.canonicalCwd;
}
function sameBinding(left: OriginalImportBinding, right: OriginalImportBinding): boolean {
  return same(left,right) && left.protocol === right.protocol && left.enrollmentId === right.enrollmentId && left.registryId === right.registryId;
}
const fileKey = (path: string) => prefix + "file:" + createHash("sha256").update(path).digest("hex");

/** Catalog reservation precedes native startup. Publication and its ownership
 * binding commit together; an interrupted reservation blocks ordinary reopen. */
export class OriginalImportRecords {
  constructor(private readonly store: HostStore) {}
  read(commandId: string): OriginalImportRecord | undefined {
    const value = this.store.readMetadata<OriginalImportRecord>(prefix + "command:" + id(commandId), 32768);
    if (value === undefined) return;
    if (!value || value.version !== 1 || value.commandId !== commandId || !["reserved","admitted","refused","unknown"].includes(value.state)) throw new Error("Original import record is invalid; its bytes were preserved.");
    const checked = source(value.source), bound = value.binding === undefined ? undefined : binding(value.binding);
    if ((bound && !same(checked,bound)) || (value.state === "admitted" && !bound) || (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 4096))) throw new Error("Original import record lost its original binding.");
    return { version: 1, commandId, source: checked, state: value.state, ...(bound ? {binding:bound} : {}), ...(value.error !== undefined ? {error:value.error} : {}) };
  }
  private write(record: OriginalImportRecord) { this.store.writeMetadata(prefix + "command:" + record.commandId, record); }
  private indexed(key: string): OriginalImportRecord | undefined {
    const commandId = this.store.readMetadata<unknown>(key,1024);
    if (commandId === undefined) return;
    const record = this.read(id(commandId));
    if (!record) throw new Error("Original import identity has no retained admission record.");
    return record;
  }
  reserve(commandId: string, original: OriginalImportIdentity): void {
    commandId = id(commandId); const copied = source(original);
    this.store.transactionMetadata(() => {
      const prior = this.read(commandId);
      if (prior) { if (!same(prior.source,copied)) throw new Error("The import command already names another original."); return; }
      for (const key of [prefix + "native:" + copied.nativeId, fileKey(copied.originalFile)]) {
        const owner = this.indexed(key);
        if (owner && owner.state !== "refused") throw new Error("This original already has a retained import. Inspect that outcome before retrying.");
      }
      if (this.store.listSessions().some(session => session.id === copied.nativeId || session.sessionFile === copied.originalFile)) throw new Error("This original is already in the host catalog.");
      this.write({version:1,commandId,source:copied,state:"reserved"});
      this.store.writeMetadata(prefix + "native:" + copied.nativeId,commandId);
      this.store.writeMetadata(fileKey(copied.originalFile),commandId);
    });
  }
  publish(commandId: string, originalBinding: OriginalImportBinding, session: SessionSummary): SessionSummary {
    const bound = binding(originalBinding), copied = structuredClone(session);
    return this.store.transactionMetadata(() => {
      const record = this.read(commandId);
      if (!record || !same(record.source,bound) || copied.id !== bound.nativeId || copied.sessionFile !== bound.originalFile || copied.cwd !== bound.recordedCwd || copied.hostId !== this.store.host.id) throw new Error("Native import publication does not match its original reservation.");
      const existing = this.store.getSession(copied.id);
      if (record.state === "admitted") {
        if (!record.binding || !sameBinding(record.binding,bound) || !existing || existing.sessionFile !== bound.originalFile || existing.cwd !== bound.recordedCwd) throw new Error("The published original import changed.");
        return existing;
      }
      if (record.state !== "reserved" || existing || this.store.listSessions().some(value => value.sessionFile === copied.sessionFile)) throw new Error("The original import cannot replace a catalogued session or uncertain outcome.");
      this.store.upsertSession(copied);
      this.write({...record,state:"admitted",binding:bound});
      return copied;
    });
  }
  settleFailure(commandId: string, state: "refused" | "unknown", error: string): void {
    this.store.transactionMetadata(() => {
      const record = this.read(commandId); if (!record) return;
      if (record.state === "admitted") throw new Error("A published original cannot be changed to a pre-admission failure.");
      if (record.state === "unknown" && state === "refused") throw new Error("An uncertain original cannot be declared unsubmitted.");
      this.write({...record,state,error:error.slice(0,4096)});
    });
  }
  commandForSession(sessionId: string): string | undefined {
    const bound=this.bindingForSession(sessionId);
    return bound ? this.indexed(prefix + "native:" + id(sessionId))!.commandId : undefined;
  }
  bindingForSession(sessionId: string): OriginalImportBinding | undefined {
    const record = this.indexed(prefix + "native:" + id(sessionId));
    if (!record || record.state === "refused") return;
    const session = this.store.getSession(sessionId);
    if (record.state !== "admitted" || !record.binding || !session || session.id !== record.source.nativeId || session.sessionFile !== record.source.originalFile || session.cwd !== record.source.recordedCwd || session.hostId !== this.store.host.id) throw new Error("This original import needs admission recovery before native work can continue.");
    return structuredClone(record.binding);
  }
}
