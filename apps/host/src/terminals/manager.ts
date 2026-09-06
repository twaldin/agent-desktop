import { Process } from "@oh-my-pi/pi-natives";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import {
  TERMINAL_DIMENSIONS, type TerminalChunk, type TerminalCreateOptions, type TerminalEvent, type TerminalInfo, type TerminalReplay,
} from "../../../../packages/shared/src/terminals";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace";
import { defaultTerminalShell } from "./default-shell";
import { localEnvironmentForWorker, type LocalEnvironmentWorkerEnvironment } from "../local-environments/environment";
export type * from "../../../../packages/shared/src/terminals";

import { TerminalError } from "./error";
export { TerminalError } from "./error";
export interface TerminalManagerOptions {
  maximumOutputBytes?: number;
  maximumRunning?: number;
  maximumRetained?: number;
  startupTimeoutMs?: number;
  closeTimeoutMs?: number;
  /** Host-owned shell configuration, never accepted from a renderer request. */
  shell?: { application: string; args: string[]; environment?: Record<string, string> };
  onListenerError?: (error: Error) => void;
}
interface Entry {
  info: TerminalInfo;
  pty?: Bun.Terminal;
  child?: Bun.Subprocess;
  decoder: TextDecoder;
  process: Process | null;
  chunks: (TerminalChunk & { bytes: number })[];
  bytes: number;
  lastSequence: number;
  settled: boolean;
  closing: boolean;
  completion: Promise<void>;
  closePromise?: Promise<TerminalInfo>;
  inputAllowance: number;
  inputClock: number;
  resizeTimer?: ReturnType<typeof setTimeout>;
  pendingResize?: { cols: number; rows: number };
  ready: { resolve: (info: TerminalInfo) => void; reject: (error: Error) => void };
}
const copy = <T>(value: T): T => structuredClone(value);
const boundedInteger = (value: number, minimum: number, maximum: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TerminalError("INVALID_TERMINAL_OPTION", `${label} must be an integer between ${minimum} and ${maximum}.`);
  return value;
};
function dimensions(cols: number, rows: number): { cols: number; rows: number } {
  boundedInteger(cols, 1, 65_535, "Columns"); boundedInteger(rows, 1, 65_535, "Rows");
  return { cols: Math.min(TERMINAL_DIMENSIONS.maximumCols, Math.max(TERMINAL_DIMENSIONS.minimumCols, cols)), rows: Math.min(TERMINAL_DIMENSIONS.maximumRows, Math.max(TERMINAL_DIMENSIONS.minimumRows, rows)) };
}
function owner(target: WorkspaceTarget): WorkspaceTarget {
  if (!target || typeof target !== "object" || Object.keys(target).length !== 1) throw new TerminalError("INVALID_TERMINAL_TARGET", "One catalog project or session identity is required.");
  const key = "projectId" in target ? "projectId" : "sessionId";
  const id = target[key as keyof WorkspaceTarget] as unknown;
  if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new TerminalError("INVALID_TERMINAL_TARGET", "A catalog UUID is required.");
  return { [key]: id } as WorkspaceTarget;
}
function ownerKey(target: WorkspaceTarget): string { return "projectId" in target ? `project:${target.projectId}` : `session:${target.sessionId}`; }
async function deadline<T>(promise: Promise<T>, milliseconds: number, error: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(error()), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** In-memory host ownership keeps shells alive independently of any desktop connection. */
export class TerminalManager {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(event: TerminalEvent) => void>();
  private readonly maximumOutputBytes: number;
  private readonly maximumRunning: number;
  private readonly maximumRetained: number;
  private readonly startupTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly shell: NonNullable<TerminalManagerOptions["shell"]>;
  private stopping = false;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly options: TerminalManagerOptions = {}) {
    this.maximumOutputBytes = boundedInteger(options.maximumOutputBytes ?? 1024 * 1024, 4096, 16 * 1024 * 1024, "Output buffer bytes");
    this.maximumRunning = boundedInteger(options.maximumRunning ?? 32, 1, 128, "Running terminal limit");
    this.maximumRetained = boundedInteger(options.maximumRetained ?? 128, this.maximumRunning, 1000, "Retained terminal limit");
    this.startupTimeoutMs = boundedInteger(options.startupTimeoutMs ?? 10_000, 100, 60_000, "Startup timeout");
    this.closeTimeoutMs = boundedInteger(options.closeTimeoutMs ?? 6000, 1000, 30_000, "Close timeout");
    this.shell = copy(options.shell ?? defaultTerminalShell());
    if (!isAbsolute(this.shell.application) || this.shell.application.includes("\0") || this.shell.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new TerminalError("INVALID_SHELL", "The host shell must be an absolute executable with separate arguments.");
  }

  subscribe(listener: (event: TerminalEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: TerminalEvent): void {
    for (const listener of this.listeners) {
      try { listener(copy(event)); }
      catch (error) {
        this.listeners.delete(listener);
        try {
          if (this.options.onListenerError) this.options.onListenerError(error instanceof Error ? error : new Error("A terminal subscriber failed."));
          else console.error("A terminal event subscriber failed and was detached.");
        } catch { console.error("A terminal subscriber and its error handler failed; the subscriber was detached."); }
      }
    }
  }
  private state(entry: Entry): void { this.emit({ type: "state", terminal: entry.info }); }
  private find(id: string): Entry { const entry = this.entries.get(id); if (!entry) throw new TerminalError("TERMINAL_NOT_FOUND", "This terminal does not exist on the owning host."); return entry; }
  get(id: string): TerminalInfo { return copy(this.find(id).info); }
  list(target?: WorkspaceTarget): TerminalInfo[] {
    const key = target ? ownerKey(owner(target)) : undefined;
    return [...this.entries.values()].filter(entry => key === undefined || ownerKey(entry.info.target) === key).map(entry => copy(entry.info));
  }

  async create(input: TerminalCreateOptions & { cwd: string }, localEnvironment?: LocalEnvironmentWorkerEnvironment): Promise<TerminalInfo> {
    if (this.stopping) throw new TerminalError("TERMINALS_STOPPING", "The owning host is stopping its terminals.");
    if ([...this.entries.values()].filter(entry => !entry.settled).length >= this.maximumRunning) throw new TerminalError("TERMINAL_LIMIT", "Close a running terminal before creating another.");
    if (this.entries.size >= this.maximumRetained) throw new TerminalError("TERMINAL_HISTORY_LIMIT", "Forget an exited terminal before creating another.");
    const target = owner(input.target);
    const cwd = realpathSync(input.cwd);
    if (!statSync(cwd).isDirectory()) throw new TerminalError("NOT_DIRECTORY", "The owning terminal directory must exist.");
    if (localEnvironment && realpathSync(localEnvironment.worktreeRoot) !== cwd) throw new TerminalError("TERMINAL_ENVIRONMENT_OWNER_MISMATCH", "The setup environment belongs to a different worktree.");
    const baseEnvironment: Record<string, string | undefined> = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...this.shell.environment };
    const environment: Record<string, string | undefined> = localEnvironment ? localEnvironmentForWorker(baseEnvironment, localEnvironment) : baseEnvironment;
    // These describe the actual terminal transport rather than project setup.
    for (const key of ["TERM", "COLORTERM", "TERMINFO", "TMUX"] as const) {
      if (baseEnvironment[key] === undefined) delete environment[key];
      else environment[key] = baseEnvironment[key];
    }
    const size = dimensions(input.cols ?? 120, input.rows ?? 40);
    let ready!: Entry["ready"];
    const started = new Promise<TerminalInfo>((resolve, reject) => { ready = { resolve, reject }; });
    const entry: Entry = {
      info: { id: crypto.randomUUID(), target, cwd, shell: basename(this.shell.application), pid: null, ...size, status: "starting", createdAt: Date.now() },
      decoder: new TextDecoder(), process: null, chunks: [], bytes: 0, lastSequence: 0, settled: false, closing: false,
      completion: Promise.resolve(), inputAllowance: 65_536, inputClock: performance.now(), ready,
    };
    this.entries.set(entry.info.id, entry); this.state(entry);
    try {
      const child = Bun.spawn([this.shell.application, ...this.shell.args], {
        cwd, env: environment,
        terminal: { ...size, data: (_terminal, bytes) => this.output(entry, entry.decoder.decode(bytes, { stream: true })) },
      });
      entry.child = child; entry.pty = child.terminal!;
      entry.info.pid = child.pid; entry.process = Process.fromPid(child.pid);
      entry.info.status = "running"; this.state(entry); ready.resolve(copy(entry.info));
      entry.completion = child.exited.then(exitCode => {
        if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
        entry.pendingResize = undefined;
        entry.pty?.close();
        this.output(entry, entry.decoder.decode());
        entry.settled = true;
        entry.info = { ...entry.info, status: entry.info.error ? "error" : "exited", exitCode, cancelled: entry.closing, exitedAt: Date.now() };
        this.state(entry);
      }).catch(error => {
        if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
        entry.pendingResize = undefined; entry.pty?.close();
        entry.settled = true;
        entry.info = { ...entry.info, status: "error", error: error instanceof Error ? error.message : "The native PTY failed.", exitedAt: Date.now(), cancelled: entry.closing };
        this.state(entry);
      });
    } catch (error) {
      entry.settled = true; entry.info.status = "error"; entry.info.error = error instanceof Error ? error.message : "The native PTY failed to start."; entry.info.exitedAt = Date.now(); this.state(entry);
      ready.reject(new TerminalError("TERMINAL_START_FAILED", entry.info.error));
    }
    try { return await deadline(started, this.startupTimeoutMs, () => new TerminalError("TERMINAL_START_TIMEOUT", "The terminal did not start in time.")); }
    catch (error) { if (!entry.settled) { entry.info.error = error instanceof Error ? error.message : "Terminal startup failed."; entry.child?.kill(); entry.pty?.close(); } throw error; }
  }

  private output(entry: Entry, text: string): void {
    const bytes = Buffer.from(text, "utf8");
    const maximumChunk = Math.min(16_384, this.maximumOutputBytes);
    for (let offset = 0; offset < bytes.length;) {
      let end = Math.min(bytes.length, offset + maximumChunk);
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      const chunk = { sequence: ++entry.lastSequence, data: bytes.subarray(offset, end).toString("utf8"), bytes: end - offset };
      entry.chunks.push(chunk); entry.bytes += chunk.bytes;
      while (entry.bytes > this.maximumOutputBytes) entry.bytes -= entry.chunks.shift()!.bytes;
      this.emit({ type: "output", terminalId: entry.info.id, chunk: { sequence: chunk.sequence, data: chunk.data } });
      offset = end;
    }
  }

  replay(id: string, afterSequence = 0): TerminalReplay {
    const entry = this.find(id);
    boundedInteger(afterSequence, 0, entry.lastSequence, "Terminal replay cursor");
    const firstSequence = entry.chunks[0]?.sequence ?? entry.lastSequence + 1;
    return { terminal: copy(entry.info), chunks: entry.chunks.filter(chunk => chunk.sequence > afterSequence).map(({ sequence, data }) => ({ sequence, data })), firstSequence, lastSequence: entry.lastSequence, truncated: afterSequence < firstSequence - 1 };
  }

  /** Acceptance means queued native input, not command completion. Never automatically replay uncertain input. */
  write(id: string, data: string | Uint8Array): void {
    const entry = this.find(id);
    if (entry.info.status !== "running") throw new TerminalError("TERMINAL_NOT_RUNNING", "This terminal is not running.");
    if (typeof data !== "string" && !(data instanceof Uint8Array)) throw new TerminalError("INVALID_TERMINAL_INPUT", "Terminal input must be text or bytes.");
    const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
    if (bytes > 65_536) throw new TerminalError("TERMINAL_INPUT_TOO_LARGE", "Send no more than 64 KiB of terminal input at once.");
    const now = performance.now();
    entry.inputAllowance = Math.min(65_536, entry.inputAllowance + (now - entry.inputClock) * 128); entry.inputClock = now;
    const cost = bytes ? Math.max(bytes, 256) : 0;
    if (cost > entry.inputAllowance) throw new TerminalError("TERMINAL_INPUT_BUSY", "Terminal input is arriving too quickly; wait before sending more.");
    if (bytes) { this.flushResize(entry); entry.pty!.write(typeof data === "string" ? data : new Uint8Array(data)); entry.inputAllowance -= cost; }
  }

  private flushResize(entry: Entry): void {
    if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
    entry.resizeTimer = undefined;
    if (entry.pendingResize) { const size = entry.pendingResize; entry.pendingResize = undefined; entry.pty!.resize(size.cols, size.rows); }
  }

  resize(id: string, cols: number, rows: number): TerminalInfo {
    const entry = this.find(id);
    if (entry.info.status !== "running") throw new TerminalError("TERMINAL_NOT_RUNNING", "This terminal is not running.");
    const size = dimensions(cols, rows);
    entry.pendingResize = size;
    if (!entry.resizeTimer) entry.resizeTimer = setTimeout(() => {
      try { this.flushResize(entry); }
      catch (error) { entry.info.error = error instanceof Error ? error.message : "Terminal resizing failed."; this.state(entry); }
    }, 16);
    entry.info = { ...entry.info, ...size }; this.state(entry);
    return copy(entry.info);
  }

  close(id: string): Promise<TerminalInfo> {
    const entry = this.find(id);
    if (entry.closePromise) return entry.closePromise;
    if (entry.settled) return Promise.resolve(copy(entry.info));
    entry.closing = true; entry.info.status = "closing"; this.state(entry);
    if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
    entry.pendingResize = undefined;
    entry.closePromise = (async () => {
      try {
        // Stable process handles avoid reopening an old PID; native PTY completion reaps its child.
        if (entry.process?.status() === "running") await entry.process.terminate({ gracefulMs: 200, timeoutMs: Math.min(2000, this.closeTimeoutMs) });
        else if (!entry.process) { entry.child?.kill(); entry.pty?.close(); }
        await deadline(entry.completion, this.closeTimeoutMs, () => new TerminalError("TERMINAL_CLOSE_TIMEOUT", "Terminal cleanup did not finish; its process outcome is uncertain."));
        if (entry.process?.status() === "running") throw new TerminalError("TERMINAL_CLOSE_FAILED", "The terminal child remains running after cleanup.");
        return copy(entry.info);
      } catch (error) {
        entry.info.status = "error"; entry.info.error = error instanceof Error ? error.message : "Terminal cleanup failed."; this.state(entry); throw error;
      }
    })();
    return entry.closePromise;
  }

  forget(id: string): void {
    const entry = this.find(id);
    if (!entry.settled) throw new TerminalError("TERMINAL_NOT_EXITED", "Close this terminal before forgetting its history.");
    this.entries.delete(id);
    this.emit({ type: "removed", terminalId: id });
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    this.shutdownPromise = (async () => {
      const outcomes = await Promise.allSettled([...this.entries.values()].map(entry => this.close(entry.info.id)));
      const errors = outcomes.filter(outcome => outcome.status === "rejected").map(outcome => (outcome as PromiseRejectedResult).reason);
      this.listeners.clear();
      if (errors.length) throw new AggregateError(errors, "Some terminal processes did not finish cleanup.");
    })();
    return this.shutdownPromise;
  }
}
