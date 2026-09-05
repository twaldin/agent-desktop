import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeTerminalHistory, NativeTerminalInfo } from "../../../../packages/shared/src/terminals";
import { TerminalError } from "./error";

export interface NativeTerminalRecord { info: NativeTerminalInfo; sessionName: string; paneId?: string; prepared: boolean }
export interface NativeTerminalCatalog {
  schema: 1;
  hostId: string;
  bundleDigest: string;
  bundleDirectory: string;
  serverGeneration: string;
  serverPid?: number;
  socket: string;
  terminals: NativeTerminalRecord[];
}
export function privateDirectory(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new TerminalError("UNSAFE_TERMINAL_DIRECTORY", "The terminal ownership directory must be a private directory owned by this user.");
  return realpathSync(path);
}
export function privateFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new TerminalError("UNSAFE_TERMINAL_FILE", "Terminal ownership metadata must be a private regular file owned by this user.");
}
/** Atomic replacement plus file/directory fsync makes ownership precede native side effects. */
export function atomicPrivateText(path: string, value: string): void {
  const temporary = `${path}.${crypto.randomUUID()}.new`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const parent = openSync(join(path, ".."), "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
}
export function atomicPrivateJson(path: string, value: unknown): void { atomicPrivateText(path, JSON.stringify(value)); }
export class NativeTerminalStore {
  readonly directory: string;
  readonly catalogPath: string;
  constructor(directory: string) { this.directory = privateDirectory(directory); this.catalogPath = join(this.directory, "catalog.json"); }
  read(): NativeTerminalCatalog | undefined {
    if (!existsSync(this.catalogPath)) return;
    privateFile(this.catalogPath); const bytes = readFileSync(this.catalogPath);
    if (bytes.length > 4 * 1024 * 1024) throw new TerminalError("INVALID_TERMINAL_CATALOG", "The terminal catalog exceeds its bound.");
    const value = JSON.parse(bytes.toString("utf8")) as NativeTerminalCatalog;
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if (value.schema !== 1 || !uuid.test(value.hostId) || !uuid.test(value.serverGeneration) || !/^[a-f0-9]{64}$/.test(value.bundleDigest) || typeof value.socket !== "string" || typeof value.bundleDirectory !== "string" || !Array.isArray(value.terminals) || value.terminals.length > 1000) throw new TerminalError("INVALID_TERMINAL_CATALOG", "The durable native terminal catalog is invalid.");
    for (const terminal of value.terminals) {
      if (!uuid.test(terminal.info?.id) || terminal.sessionName !== `agent_${terminal.info.id.replaceAll("-", "")}` || (terminal.paneId !== undefined && !/^%[0-9]+$/.test(terminal.paneId)) || typeof terminal.info.cwd !== "string" || !uuid.test(terminal.info.serverGeneration)) throw new TerminalError("INVALID_TERMINAL_CATALOG", "A native terminal catalog entry is invalid.");
    }
    return value;
  }
  put(catalog: NativeTerminalCatalog): void { atomicPrivateJson(this.catalogPath, catalog); }
  putHistory(history: NativeTerminalHistory): void { atomicPrivateJson(join(this.directory, `${history.terminalId}.history.json`), history); }
  history(id: string): NativeTerminalHistory | undefined {
    const path = join(this.directory, `${id}.history.json`);
    if (!existsSync(path)) return;
    privateFile(path);
    // JSON escaping can expand the manager's bounded 8 MiB text snapshot by up to six times.
    if (lstatSync(path).size > 64 * 1024 * 1024) throw new TerminalError("INVALID_TERMINAL_HISTORY", "The saved terminal history exceeds its bound.");
    const bytes = readFileSync(path);
    const value = JSON.parse(bytes.toString("utf8")) as NativeTerminalHistory;
    if (value.terminalId !== id || typeof value.history !== "string" || typeof value.revision !== "string") throw new TerminalError("INVALID_TERMINAL_HISTORY", "The saved terminal history is invalid.");
    return { ...value, live: false };
  }
  forgetHistory(id: string): void { const path = join(this.directory, `${id}.history.json`); if (existsSync(path)) { privateFile(path); unlinkSync(path); } }
}
