import { closeSync, constants, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { parseProcessJournalRecords, parseProcessJournalScope, parseProcessOperationEntries, type ProcessJournalRecord } from "../session-process-journal";

const maximumBytes = 512 * 1024;
/** Window-local receipt identities have their own file: layout recovery must not
 * discard them, and an unreadable journal must not disable ordinary navigation. */
export class SessionProcessJournalStore {
  readonly file: string;
  private records: ProcessJournalRecord[] = [];
  private readError?: string;
  constructor(profile: string, slot: string) {
    if (!/^[a-z0-9-]{1,80}$/.test(slot)) throw new Error("Invalid local window slot.");
    this.file = join(profile, `window-${slot}-process-operations-v1.json`);
    try {
      if (!existsSync(this.file)) return;
      const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > maximumBytes) throw new Error("Invalid journal size.");
        const document = JSON.parse(readFileSync(fd, "utf8"));
        if (!document || document.version !== 1 || Object.keys(document).some(key => key !== "version" && key !== "records"))
          throw new Error("Invalid journal version.");
        this.records = parseProcessJournalRecords(document.records);
      } finally { closeSync(fd); }
    } catch { this.readError = "Saved process operations could not be read. Process changes are disabled to avoid repeating an unknown operation."; }
  }
  readProcessOperations(scope: unknown): { entries?: ProcessJournalRecord["entries"]; error?: string } {
    try {
      if (this.readError) throw new Error(this.readError);
      const parsed = parseProcessJournalScope(scope);
      const record = this.records.find(item => item.hostId === parsed.hostId && item.sessionId === parsed.sessionId);
      return { entries: structuredClone(record?.entries ?? []) };
    } catch (cause) { return { error: cause instanceof Error ? cause.message : "Process operations could not be read." }; }
  }
  saveProcessOperations(scope: unknown, entries: unknown): { error?: string } {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      if (this.readError) throw new Error(this.readError);
      const parsed = parseProcessJournalScope(scope), projected = parseProcessOperationEntries(entries);
      const records = this.records.filter(item => item.hostId !== parsed.hostId || item.sessionId !== parsed.sessionId);
      if (projected.length) records.push({ ...parsed, entries: projected });
      const next = parseProcessJournalRecords(records), serialized = JSON.stringify({ version: 1, records: next }) + "\n";
      if (Buffer.byteLength(serialized, "utf8") > maximumBytes) throw new Error("Process operation records exceed the readable limit.");
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { writeFileSync(fd, serialized, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.file);
      const directory = openSync(dirname(this.file), constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
      this.records = next;
      return {};
    } catch (cause) { return { error: cause instanceof Error ? cause.message : "Process operation records could not be saved." }; }
    finally { try { unlinkSync(temporary); } catch { /* No staging file remains after successful rename. */ } }
  }
}
