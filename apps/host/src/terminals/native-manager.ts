import { Process } from "@oh-my-pi/pi-natives";
import { existsSync, lstatSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, isAbsolute, join, sep } from "node:path";
import {
  NATIVE_TERMINAL_PROTOCOL, TERMINAL_DIMENSIONS, type NativeTerminalAttachment, type NativeTerminalCapabilities,
  type NativeTerminalHistory, type NativeTerminalInfo, type NativeTerminalInputReceipt, type NativeTerminalInputRequest,
  type NativeTerminalInvalidation, type NativeTerminalReplay, type TerminalChunk, type TerminalCreateOptions,
} from "../../../../packages/shared/src/terminals";
import type { WorkspaceTarget } from "../../../../packages/shared/src/workspace";
import { sha256, verifyTmuxBundle, type TmuxBundle } from "./bundle";
import { NativeControlError, TmuxControl } from "./control";
import { TerminalError } from "./error";
import { defaultTerminalShell } from "./default-shell";
import { nativeActionText, nativeInputCommand, nativeInputIdentity, validateNativeInput } from "./native-input";
import { NativeTerminalStore, privateDirectory, privateFile, atomicPrivateText, type NativeTerminalCatalog, type NativeTerminalRecord } from "./native-store";
import { isProtectedLocalEnvironmentKey, localEnvironmentForWorker, type LocalEnvironmentWorkerEnvironment } from "../local-environments/environment";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ACTION_KEY = /^[a-f0-9]{64}$/;
const copy = <T>(value: T): T => structuredClone(value);
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
const active = (info: NativeTerminalInfo) => info.status === "running" || info.status === "starting" || info.status === "closing";
function integer(value: number, minimum: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TerminalError("INVALID_TERMINAL_NUMBER", `Expected an integer between ${minimum} and ${maximum}.`); return value; }
function targetKey(target: WorkspaceTarget): string {
  if (!target || typeof target !== "object" || Object.keys(target).length !== 1) throw new TerminalError("INVALID_TERMINAL_TARGET", "One catalog target is required.");
  if ("filePath" in target) throw new TerminalError("INVALID_TERMINAL_TARGET", "A standalone file cannot own a native terminal.");
  const key = "projectId" in target ? "projectId" : "sessionId"; const value = target[key as keyof WorkspaceTarget] as string;
  if (!UUID.test(value)) throw new TerminalError("INVALID_TERMINAL_TARGET", "A catalog UUID is required."); return `${key}:${value}`;
}
function dimensions(cols: number, rows: number) { return { cols: Math.max(TERMINAL_DIMENSIONS.minimumCols, Math.min(TERMINAL_DIMENSIONS.maximumCols, integer(cols, 1, 65535))), rows: Math.max(TERMINAL_DIMENSIONS.minimumRows, Math.min(TERMINAL_DIMENSIONS.maximumRows, integer(rows, 1, 65535))) }; }
interface Attachment {
  info: NativeTerminalAttachment;
  child: Bun.Subprocess;
  pty: Bun.Terminal;
  decoder: TextDecoder;
  chunks: (TerminalChunk & { bytes: number })[];
  bytes: number;
  lastSequence: number;
  completedSequence: number;
  acknowledgedGeometry: number;
  replies: Map<string, string>;
  closing: boolean;
}
interface Entry { record: NativeTerminalRecord; process?: Process; control?: TmuxControl; closing?: Promise<NativeTerminalInfo>; finalizing?: Promise<void>; mutating: boolean }
interface InputStream { lastSequence: number; receipts: Map<number, { hash: string; result: Promise<NativeTerminalInputReceipt> }> }
export interface TmuxTerminalManagerOptions {
  dataDirectory: string;
  hostId: string;
  bundleDirectory: string;
  shell?: { application: string; args: string[]; environment?: Record<string, string> };
  maximumOutputBytes?: number;
  maximumHistoryBytes?: number;
  historyRows?: number;
  maximumRunning?: number;
  viewerLifetimeMs?: number;
  /** Tests can use a shorter cycle; native state is always read from the private server. */
  pollIntervalMs?: number;
  onListenerError?: (error: Error) => void;
}

/** Private tmux owns the actual screen and program. Each viewer has its own bounded attach PTY. */
export class TmuxTerminalManager {
  private readonly store: NativeTerminalStore;
  private readonly bundle: TmuxBundle;
  private catalog: NativeTerminalCatalog;
  private readonly entries = new Map<string, Entry>();
  private readonly attachments = new Map<string, Attachment>();
  private readonly streams = new Map<string, InputStream>();
  private readonly listeners = new Set<(event: NativeTerminalInvalidation) => void>();
  private readonly shell: NonNullable<TmuxTerminalManagerOptions["shell"]>;
  private readonly socketDirectory: string;
  private readonly maximumOutputBytes: number;
  private readonly maximumHistoryBytes: number;
  private readonly historyRows: number;
  private readonly maximumRunning: number;
  private readonly lifetime: number;
  private server?: Process;
  private inputEpoch = crypto.randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private stopping = false;
  private recoveringInput = false;
  private shutdownPromise?: Promise<void>;
  private historyClock = Date.now();
  private pendingInputBytes = 0;
  private pendingInputs = 0;
  private createTail: Promise<void> = Promise.resolve();

  private constructor(private readonly options: TmuxTerminalManagerOptions) {
    if (!UUID.test(options.hostId)) throw new TerminalError("INVALID_HOST_ID", "Native terminal ownership needs the stable host UUID.");
    this.bundle = verifyTmuxBundle(options.bundleDirectory);
    this.store = new NativeTerminalStore(join(options.dataDirectory, "native-terminals-v1"));
    const socketKey = sha256(`${options.hostId}:${this.store.directory}`).slice(0, 20);
    // macOS sockaddr_un is short; this private directory is deterministic from durable ownership.
    this.socketDirectory = privateDirectory(`/tmp/agent-tmux-${process.getuid?.()}-${socketKey}`);
    this.catalog = this.store.read() ?? { schema: 1, hostId: options.hostId, bundleDigest: this.bundle.digest, bundleDirectory: this.bundle.directory, serverGeneration: crypto.randomUUID(), socket: "", terminals: [] };
    if (this.catalog.hostId !== options.hostId) throw new TerminalError("TERMINAL_OWNER_MISMATCH", "The terminal catalog belongs to another host.");
    if (this.catalog.bundleDigest !== this.bundle.digest && (this.catalog.terminals.some(item => active(item.info)) || this.catalog.serverPid)) throw new TerminalError("TERMINAL_BUNDLE_IN_USE", "Native terminal ownership belongs to a different immutable bundle. Close it with that version before replacing it.");
    this.catalog.bundleDigest = this.bundle.digest; this.catalog.bundleDirectory = this.bundle.directory;
    this.catalog.socket ||= this.socketPath(this.catalog.serverGeneration);
    if (this.catalog.socket !== this.socketPath(this.catalog.serverGeneration)) throw new TerminalError("TERMINAL_OWNER_MISMATCH", "The private socket path differs from durable ownership.");
    this.maximumOutputBytes = integer(options.maximumOutputBytes ?? 1024 * 1024, 4096, 16 * 1024 * 1024);
    this.maximumHistoryBytes = integer(options.maximumHistoryBytes ?? 2 * 1024 * 1024, 4096, 8 * 1024 * 1024);
    this.historyRows = integer(options.historyRows ?? 2000, 100, 10_000);
    this.maximumRunning = integer(options.maximumRunning ?? 32, 1, 128);
    this.lifetime = integer(options.viewerLifetimeMs ?? 30_000, 1000, 120_000);
    this.shell = copy(options.shell ?? defaultTerminalShell());
    if (!isAbsolute(this.shell.application) || this.shell.application.includes("\0") || this.shell.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new TerminalError("INVALID_TERMINAL_SHELL", "The host shell requires an absolute executable and separate arguments.");
    for (const record of this.catalog.terminals) { targetKey(record.info.target); record.info.inputEpoch = this.inputEpoch; this.entries.set(record.info.id, { record, mutating: false }); }
  }
  static async open(options: TmuxTerminalManagerOptions): Promise<TmuxTerminalManager> {
    const manager = new TmuxTerminalManager(options);
    try { await manager.recover(); manager.save(); }
    catch (error) {
      // Recovery may already have attached controllers before finding a later ownership mismatch.
      // Detach only clients created here; never kill an unverified server while reporting corruption.
      await Promise.allSettled([...manager.entries.values()].map(entry => entry.control?.close()));
      manager.listeners.clear(); throw error;
    }
    manager.timer = setInterval(() => { void manager.poll(); }, integer(options.pollIntervalMs ?? 1000, 100, 10_000)); manager.timer.unref();
    return manager;
  }
  capabilities(): NativeTerminalCapabilities { return { protocol: NATIVE_TERMINAL_PROTOCOL, tmuxVersion: "3.7c", inputEpoch: this.inputEpoch, dimensions: TERMINAL_DIMENSIONS }; }
  private socketPath(generation: string): string { return join(this.socketDirectory, `${generation.slice(0, 16)}.sock`); }
  private get configPath(): string { return join(this.store.directory, "tmux.conf"); }
  private environment(): Record<string, string | undefined> { return { ...process.env, ...this.shell.environment, TMUX: undefined, TERM: "xterm-256color", TERMINFO: this.bundle.terminfo, COLORTERM: "truecolor" }; }
  private cleanupEnvironmentLaunch(id: string): void {
    const path = join(this.store.directory, `environment-launch-${id}.sh`);
    if (existsSync(path)) { privateFile(path); unlinkSync(path); }
  }
  private actionCwd(cwd: string, root?: string): string {
    if (!root || !isAbsolute(cwd) || !isAbsolute(root)) throw new TerminalError("INVALID_TERMINAL_ENVIRONMENT", "A trusted action directory is required.");
    const actionRoot = realpathSync(root), actionCwd = realpathSync(cwd);
    if (actionRoot !== root || actionCwd !== cwd || !statSync(actionRoot).isDirectory() || !statSync(actionCwd).isDirectory()
      || (actionCwd !== actionRoot && !actionCwd.startsWith(`${actionRoot}${sep}`)))
      throw new TerminalError("INVALID_TERMINAL_ENVIRONMENT", "The action directory is outside its owning Git root.");
    return actionCwd;
  }
  private environmentLaunch(id: string, cwd: string, input?: LocalEnvironmentWorkerEnvironment, trustedActionRoot?: string): { application: string; args: string[]; payload?: string } {
    const actionRoot = trustedActionRoot ? this.actionCwd(trustedActionRoot, trustedActionRoot) : undefined;
    if (actionRoot && cwd !== actionRoot && !cwd.startsWith(`${actionRoot}${sep}`))
      throw new TerminalError("INVALID_TERMINAL_ENVIRONMENT", "The action directory is outside its owning Git root.");
    if (!input) return { application: this.shell.application, args: this.shell.args };
    let worktree: string;
    try { worktree = realpathSync(input.worktreeRoot); }
    catch { throw new TerminalError("INVALID_TERMINAL_ENVIRONMENT", "The local environment worktree no longer exists."); }
    if (actionRoot) {
      if ((cwd !== actionRoot && !cwd.startsWith(`${actionRoot}${sep}`))
        || (worktree !== actionRoot && !worktree.startsWith(`${actionRoot}${sep}`)))
        throw new TerminalError("INVALID_TERMINAL_ENVIRONMENT", "The action and environment directories are outside their owning Git root.");
    } else if (worktree !== cwd) throw new TerminalError("INVALID_TERMINAL_ENVIRONMENT", "The local environment worktree does not own this terminal directory.");
    let desired: Record<string, string>;
    try { desired = localEnvironmentForWorker(this.environment(), input); }
    catch (cause) { throw new TerminalError("INVALID_TERMINAL_ENVIRONMENT", cause instanceof Error ? cause.message : "The local environment is invalid."); }
    // The PTY transport owns these values even when a setup script exported different ones.
    delete desired.TMUX; Object.assign(desired, { TERM: "xterm-256color", TERMINFO: this.bundle.terminfo, COLORTERM: "truecolor" });
    const terminalOwned = new Set(["TERM", "TERMINFO", "TMUX", "COLORTERM"]);
    const payload = join(this.store.directory, `environment-launch-${id}.sh`);
    const removePayload = `/bin/rm -f -- ${shellQuote(payload)}`;
    const lines = ["#!/bin/sh", "set -eu", `trap ${shellQuote(removePayload)} EXIT HUP INT TERM`];
    for (const key of input.environmentDelta?.unset ?? []) if (!isProtectedLocalEnvironmentKey(key) && !terminalOwned.has(key)) lines.push(`unset ${key}`);
    for (const key of Object.keys(input.environmentDelta?.set ?? {})) if (!isProtectedLocalEnvironmentKey(key) && !terminalOwned.has(key)) lines.push(`export ${key}=${shellQuote(desired[key]!)}`);
    for (const key of ["CODEX_SOURCE_TREE_PATH", "CODEX_WORKTREE_PATH", "AGENT_SOURCE_TREE_PATH", "AGENT_WORKTREE_PATH"]) lines.push(`export ${key}=${shellQuote(desired[key]!)}`);
    for (const key of ["TERM", "TERMINFO", "COLORTERM"]) lines.push(`export ${key}=${shellQuote(desired[key]!)}`);
    lines.push(removePayload, "trap - EXIT HUP INT TERM", `exec ${shellQuote(this.shell.application)}${this.shell.args.map(arg => ` ${shellQuote(arg)}`).join("")}`, "");
    atomicPrivateText(payload, lines.join("\n")); privateFile(payload);
    return { application: "/bin/sh", args: [payload], payload };
  }
  private args(...command: string[]): string[] { return [this.bundle.binary, "-S", this.catalog.socket, "-f", this.configPath, ...command]; }
  private async cli(command: string[], maximumBytes = 256 * 1024): Promise<string> {
    const child = Bun.spawn(this.args(...command), { env: this.environment(), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill(), 10_000);
    const read = async (stream: ReadableStream<Uint8Array>) => { const chunks: Uint8Array[] = []; let bytes = 0; for await (const chunk of stream) { bytes += chunk.byteLength; if (bytes > maximumBytes) { child.kill(); throw new TerminalError("TERMINAL_NATIVE_OUTPUT_LIMIT", "The native terminal command exceeded its output bound."); } chunks.push(chunk); } return Buffer.concat(chunks).toString("utf8"); };
    try { const [out, err, code] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]); if (code) throw new TerminalError("TERMINAL_NATIVE_COMMAND_FAILED", err.trim().slice(0, 1024) || "The private native terminal command failed."); return out.replace(/\n$/, ""); }
    finally { clearTimeout(timer); }
  }
  private save(): void { this.catalog.terminals = [...this.entries.values()].map(entry => entry.record); this.store.put(this.catalog); }
  subscribe(listener: (event: NativeTerminalInvalidation) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private emit(event: NativeTerminalInvalidation): void { for (const listener of this.listeners) try { listener(copy(event)); } catch (error) { this.listeners.delete(listener); this.options.onListenerError?.(error instanceof Error ? error : new Error("Native terminal subscriber failed.")); } }
  private publicInfo(entry: Entry): NativeTerminalInfo {
    return { ...copy(entry.record.info), attachable: !this.recoveringInput && !!entry.record.paneId && entry.record.info.serverGeneration === this.catalog.serverGeneration && this.server?.status() === "running" && (entry.record.info.status === "running" || entry.record.info.status === "exited") };
  }
  private state(entry: Entry): void { this.emit({ type: "state", terminal: this.publicInfo(entry) }); }
  private find(id: string): Entry { const entry = this.entries.get(id); if (!entry) throw new TerminalError("TERMINAL_NOT_FOUND", "The native terminal does not exist on its owning host."); return entry; }
  private attachment(id: string): Attachment { const attachment = this.attachments.get(id); if (!attachment || attachment.closing || attachment.info.expiresAt <= Date.now()) throw new TerminalError("TERMINAL_ATTACHMENT_EXPIRED", "This native viewer attachment expired. Create a new attachment to the same terminal."); return attachment; }
  get(id: string): NativeTerminalInfo { return this.publicInfo(this.find(id)); }
  getAction(actionKey: string): NativeTerminalInfo | undefined {
    if (!ACTION_KEY.test(actionKey)) throw new TerminalError("INVALID_TERMINAL_ACTION", "A terminal action key must be a SHA-256 digest.");
    const entry = [...this.entries.values()].find(value => value.record.actionKey === actionKey);
    return entry ? this.publicInfo(entry) : undefined;
  }
  list(target?: WorkspaceTarget): NativeTerminalInfo[] { const key = target && targetKey(target); return [...this.entries.values()].filter(entry => !key || targetKey(entry.record.info.target) === key).map(entry => this.publicInfo(entry)); }

  private async verifyServer(): Promise<void> {
    if (!existsSync(this.catalog.socket)) throw new TerminalError("TERMINAL_SERVER_MISSING", "The native server socket is missing.");
    const socket = lstatSync(this.catalog.socket);
    if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== process.getuid?.()) throw new TerminalError("TERMINAL_OWNER_MISMATCH", "The private terminal socket has unexpected ownership or type.");
    const metadata = (await this.cli(["display-message", "-p", "#{@agent-host}|#{@agent-generation}|#{pid}|#{version}"])).split("|");
    if (metadata[0] !== this.options.hostId || metadata[1] !== this.catalog.serverGeneration || metadata[3] !== "3.7c" || !/^\d+$/.test(metadata[2]!)) throw new TerminalError("TERMINAL_OWNER_MISMATCH", "The native server does not match its durable host/generation/version.");
    const pid = Number(metadata[2]);
    if (this.catalog.serverPid !== undefined && pid !== this.catalog.serverPid) throw new TerminalError("TERMINAL_OWNER_MISMATCH", "The private terminal server PID changed without a new generation.");
    this.server = Process.fromPid(pid) ?? undefined; this.catalog.serverPid = pid;
    if (!this.server || this.server.status() !== "running") throw new TerminalError("TERMINAL_SERVER_MISSING", "The native terminal server exited during recovery.");
  }
  private async recover(): Promise<void> {
    if (!this.entries.size && !this.catalog.serverPid) return;
    try {
      await this.verifyServer();
      const rows = await this.panes();
      for (const entry of this.entries.values()) {
        if (entry.record.info.serverGeneration !== this.catalog.serverGeneration) continue;
        if (entry.record.restartPending) {
          entry.record.info = { ...entry.record.info, status: "error", error: entry.record.info.error ?? "The action restart outcome is unknown; it was not replayed." };
          continue;
        }
        const row = rows.find(row => row.session === entry.record.sessionName);
        if (!row) { if (active(entry.record.info)) this.interrupted(entry, "The owning native pane is missing; no shell or input was replayed."); continue; }
        if ((entry.record.paneId && entry.record.paneId !== row.pane) || (row.id && row.id !== entry.record.info.id)) throw new TerminalError("TERMINAL_OWNER_MISMATCH", "A native pane differs from its durable terminal identity.");
        if (entry.record.prepared && !row.id) await this.cli(["set-option", "-p", "-t", row.pane, "@agent-terminal", entry.record.info.id]);
        else if (row.id !== entry.record.info.id) throw new TerminalError("TERMINAL_OWNER_MISMATCH", "A native pane has no matching terminal identity.");
        entry.record.paneId = row.pane; entry.record.prepared = false; entry.record.info.pid = row.pid;
        entry.record.info.cols = row.cols; entry.record.info.rows = row.rows;
        if (row.dead) { entry.record.info.status = "exited"; entry.record.info.exitedAt ??= Date.now(); entry.record.info.exitCode = row.code; }
        else { entry.process = Process.fromPid(row.pid) ?? undefined; entry.record.info.status = "running"; delete entry.record.info.error; delete entry.record.info.exitedAt; this.controller(entry); }
      }
    } catch (error) {
      if (error instanceof TerminalError && error.code === "TERMINAL_OWNER_MISMATCH") throw error;
      if (this.catalog.serverPid && Process.fromPid(this.catalog.serverPid)?.status() === "running") throw new TerminalError("TERMINAL_SERVER_UNRESPONSIVE", "The recorded native server process is still present but its identity could not be verified. Its programs were preserved; a second server was not started.");
      for (const entry of this.entries.values()) if (active(entry.record.info)) this.interrupted(entry, "The private native server is unavailable. The terminal was interrupted; no shell or input was replayed.");
      this.server = undefined; delete this.catalog.serverPid;
    }
  }
  private interrupted(entry: Entry, message: string): void { entry.record.info = { ...entry.record.info, status: "interrupted", error: message, exitedAt: Date.now() }; this.state(entry); }
  private async panes(): Promise<{ session: string; pane: string; id: string; pid: number; dead: boolean; code: number; cols: number; rows: number }[]> {
    const text = await this.cli(["list-panes", "-a", "-F", "#{session_name}|#{pane_id}|#{@agent-terminal}|#{pane_pid}|#{pane_dead}|#{pane_dead_status}|#{pane_width}|#{pane_height}"]);
    return text ? text.split("\n").map(line => { const [session, pane, id, pid, dead, code, cols, rows] = line.split("|"); return { session: session!, pane: pane!, id: id!, pid: Number(pid), dead: dead === "1", code: Number(code), cols: Number(cols), rows: Number(rows) }; }) : [];
  }
  private controller(entry: Entry): TmuxControl {
    if (entry.control) {
      if (entry.control.isClosed) throw new NativeControlError("TERMINAL_INPUT_NOT_SUBMITTED", "The native input connection was lost. Wait for the new input epoch before typing again.", "not-submitted");
      return entry.control;
    }
    // A control client is always focused in tmux. Keep it off user panes so real viewer focus wins.
    entry.control = new TmuxControl(this.args("-C", "attach-session", "-f", "no-output,ignore-size", "-t", "agent_control"), this.environment());
    return entry.control;
  }
  private async prepareServer(): Promise<void> {
    if (this.server?.status() === "running") return;
    this.catalog.serverGeneration = crypto.randomUUID(); this.catalog.socket = this.socketPath(this.catalog.serverGeneration); delete this.catalog.serverPid;
    const config = ["set -g status off", "set -g prefix None", "unbind-key -a", "set -g update-environment ''", `set -g history-limit ${this.historyRows}`, "set -g destroy-unattached off", "set -g exit-empty on", "set -g default-terminal tmux-256color", "set -g focus-events on", "set -s escape-time 0", "set -g set-clipboard off", "set -g allow-passthrough off", "set -g remain-on-exit on", "set -g remain-on-exit-format ''", `set -g @agent-host '${this.options.hostId}'`, `set -g @agent-generation '${this.catalog.serverGeneration}'`, ""].join("\n");
    atomicPrivateText(this.configPath, config); this.save();
    // A retained, already-exited infrastructure pane owns no shell but keeps control clients separate.
    await this.cli(["new-session", "-d", "-s", "agent_control", "-x", "20", "-y", "5", "/usr/bin/true", "agent-desktop-control"]);
    await this.verifyServer(); this.save();
  }
  create(
    input: TerminalCreateOptions & { cwd: string },
    localEnvironment?: LocalEnvironmentWorkerEnvironment,
    action?: { actionKey: string; actionRoot?: string },
    /** Host-private UUID reserved by the durable creation journal. */
    reservation?: { terminalId: string; validateOwner(): void },
  ): Promise<NativeTerminalInfo> {
    const operation = this.createTail.then(async () => {
      if (this.stopping) throw new TerminalError("TERMINALS_STOPPING", "The native terminal host is stopping.");
      targetKey(input.target); const cwd = realpathSync(input.cwd); if (!statSync(cwd).isDirectory()) throw new TerminalError("NOT_DIRECTORY", "The owning terminal directory must exist.");
      if ([...this.entries.values()].filter(entry => active(entry.record.info)).length >= this.maximumRunning) throw new TerminalError("TERMINAL_LIMIT", "Close a native terminal before creating another.");
      if (this.entries.size >= 128) throw new TerminalError("TERMINAL_HISTORY_LIMIT", "Forget an exited terminal before creating another.");
      if (action && !ACTION_KEY.test(action.actionKey)) throw new TerminalError("INVALID_TERMINAL_ACTION", "A terminal action key must be a SHA-256 digest.");
      if (action && [...this.entries.values()].some(entry => entry.record.actionKey === action.actionKey)) throw new TerminalError("TERMINAL_ACTION_EXISTS", "This configured action already owns a native terminal.");
      const id = reservation === undefined ? crypto.randomUUID() : reservation?.terminalId;
      if (typeof id !== "string" || !UUID.test(id)) throw new TerminalError("INVALID_TERMINAL_ID", "A reserved native terminal UUID is required.");
      if (reservation && typeof reservation.validateOwner !== "function") throw new TerminalError("INVALID_TERMINAL_OWNER_CHECK", "Reserved creation requires its current host owner check.");
      if (this.entries.has(id)) throw new TerminalError("TERMINAL_ID_EXISTS", "This native terminal identity is already owned; creation was not repeated.");
      const size = dimensions(input.cols ?? 120, input.rows ?? 40);
      const launch = this.environmentLaunch(id, cwd, localEnvironment, action?.actionRoot);
      try { await this.prepareServer(); reservation?.validateOwner(); }
      catch (error) {
        // No pane launch was dispatched, so this payload cannot still be opening.
        if (launch.payload) this.cleanupEnvironmentLaunch(id);
        throw error;
      }
      const entry: Entry = { record: { info: { id, target: copy(input.target), cwd, shell: basename(this.shell.application), pid: null, ...size, status: "starting", createdAt: Date.now(), protocol: NATIVE_TERMINAL_PROTOCOL, serverGeneration: this.catalog.serverGeneration, geometryRevision: 1, inputEpoch: this.inputEpoch }, sessionName: `agent_${id.replaceAll("-", "")}`, prepared: true, ...(action ? { actionKey: action.actionKey } : {}) }, mutating: true };
      this.entries.set(id, entry); this.save(); this.state(entry);
      try {
        await this.cli(["new-session", "-d", "-s", entry.record.sessionName, "-x", String(size.cols), "-y", String(size.rows), "-c", cwd, launch.application, ...launch.args]);
        await this.verifyServer();
        const row = (await this.panes()).find(row => row.session === entry.record.sessionName);
        if (!row) throw new TerminalError("TERMINAL_START_UNCERTAIN", "The native pane was created but could not be reconciled.");
        entry.record.paneId = row.pane; entry.record.info.pid = row.pid; entry.process = Process.fromPid(row.pid) ?? undefined;
        await this.cli(["set-option", "-p", "-t", row.pane, "@agent-terminal", id]);
        await this.cli(["set-window-option", "-t", entry.record.sessionName, "window-size", "manual"]);
        entry.record.prepared = false; entry.record.info.status = row.dead ? "exited" : "running";
        if (row.dead) { entry.record.info.exitedAt = Date.now(); entry.record.info.exitCode = row.code; } else this.controller(entry);
        this.save(); this.state(entry); return this.publicInfo(entry);
      } catch (error) { entry.record.info.error = error instanceof Error ? error.message : "Native terminal creation outcome is uncertain."; this.save(); this.state(entry); throw error; }
      finally { entry.mutating = false; }
    });
    this.createTail = operation.then(() => {}, () => {}); return operation;
  }

  restartAction(terminalId: string, command: string, localEnvironment?: LocalEnvironmentWorkerEnvironment, action?: { actionRoot?: string }): Promise<NativeTerminalInfo> {
    if (typeof command !== "string" || !command.trim() || command.includes("\0") || Buffer.byteLength(command) > 64 * 1024)
      return Promise.reject(new TerminalError("INVALID_TERMINAL_ACTION", "A terminal action command must contain between 1 and 65536 bytes."));
    const operation = this.createTail.then(async () => {
      if (this.stopping) throw new TerminalError("TERMINALS_STOPPING", "The native terminal host is stopping.");
      const entry = this.find(terminalId), info = entry.record.info;
      if (!entry.record.actionKey) throw new TerminalError("INVALID_TERMINAL_ACTION", "This native terminal is not associated with a configured action.");
      if (entry.record.restartPending) throw new TerminalError("OUTCOME_UNKNOWN", "The previous action restart has an unknown outcome. Inspect its terminal, then close and forget it before starting a new action.");
      if (entry.closing && info.status === "exited" && !entry.record.paneId) entry.closing = undefined;
      if (entry.mutating || entry.closing) throw new TerminalError("TERMINAL_BUSY", "This native terminal is already being changed.");
      const knownExited = info.status === "exited";
      if (!knownExited && (!entry.record.paneId || info.serverGeneration !== this.catalog.serverGeneration || !this.server || this.server.status() !== "running"))
        throw new TerminalError("TERMINAL_NOT_RUNNING", "This action terminal has no verified native pane to restart.");
      if (knownExited && [...this.entries.values()].filter(value => active(value.record.info)).length >= this.maximumRunning)
        throw new TerminalError("TERMINAL_LIMIT", "Close a native terminal before running this action.");
      const initial = nativeActionText(info.cwd, command);
      const launch = this.environmentLaunch(terminalId, info.cwd, localEnvironment, action?.actionRoot);
      entry.mutating = true;
      let restartDispatched = false;
      try {
        // An explicit new Run can reopen a definitely closed action, retaining its tab identity.
        // Unknown outcomes remain blocked above; recovery itself never starts a program.
        if (knownExited) await this.prepareServer();
        const oldRow = (await this.panes()).find(row => row.session === entry.record.sessionName);
        if (oldRow && (oldRow.id !== terminalId || oldRow.pane !== entry.record.paneId || info.serverGeneration !== this.catalog.serverGeneration))
          throw new TerminalError("TERMINAL_OWNER_MISMATCH", "The action pane differs from its durable owner.");
        if (!oldRow && !knownExited) throw new TerminalError("TERMINAL_NOT_RUNNING", "The action pane disappeared; it was not replaced.");
        // Join accepted input before invalidating this pane's viewers.
        if (oldRow) await this.controller(entry).execute(`display-message -p -t ${oldRow.pane} AGENT_ACTION_READY`);
        await this.detachEntry(terminalId);
        await entry.control?.close(); entry.control = undefined;
        entry.record.restartPending = true;
        entry.record.info = { ...info, pid: null, status: "starting", serverGeneration: this.catalog.serverGeneration, geometryRevision: info.geometryRevision + 1,
          error: "The action restart is awaiting its native acknowledgement." };
        delete entry.record.info.exitedAt; delete entry.record.info.exitCode; delete entry.record.info.cancelled;
        this.save(); this.state(entry);
        restartDispatched = true;
        if (oldRow) await this.cli(["respawn-pane", "-k", "-t", oldRow.pane, "-c", info.cwd, launch.application, ...launch.args]);
        else {
          const pane = await this.cli(["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", entry.record.sessionName, "-x", String(info.cols), "-y", String(info.rows), "-c", info.cwd, launch.application, ...launch.args]);
          if (!/^%[0-9]+$/.test(pane)) throw new TerminalError("TERMINAL_RESTART_UNCERTAIN", "The action pane identity was not returned.");
          await this.verifyServer();
          await this.cli(["set-option", "-p", "-t", pane, "@agent-terminal", terminalId]);
          await this.cli(["set-window-option", "-t", entry.record.sessionName, "window-size", "manual"]);
        }
        const row = (await this.panes()).find(row => row.id === terminalId && row.session === entry.record.sessionName && (!oldRow || row.pane === oldRow.pane));
        if (!row || row.dead) throw new TerminalError("TERMINAL_RESTART_UNCERTAIN", "The action pane restart could not be reconciled.");
        entry.record.paneId = row.pane; entry.record.info.pid = row.pid; entry.process = Process.fromPid(row.pid) ?? undefined;
        const receipt = await this.controller(entry).execute(nativeInputCommand(row.pane, info.cols, info.rows, { kind: "text", data: initial }));
        if (receipt.includes("AGENT_STALE_GEOMETRY")) throw new TerminalError("STALE_TERMINAL_GEOMETRY", "The action pane changed size before its command arrived.");
        entry.record.restartPending = undefined;
        entry.record.prepared = false;
        entry.record.info = { ...entry.record.info, pid: row.pid, status: "running" };
        delete entry.record.info.error;
        this.store.forgetHistory(terminalId);
        this.save(); this.state(entry);
        return this.publicInfo(entry);
      } catch (error) {
        if (!restartDispatched) {
          if (launch.payload) this.cleanupEnvironmentLaunch(terminalId);
          entry.record.info = info;
        } else {
          entry.record.restartPending = true;
          entry.record.info = { ...entry.record.info, status: "error", error: `The action restart outcome is unknown. ${error instanceof Error ? error.message : "The native receipt was lost."}` };
        }
        this.save(); this.state(entry);
        if (restartDispatched) throw new TerminalError("OUTCOME_UNKNOWN", entry.record.info.error!);
        throw error;
      } finally { entry.mutating = false; }
    });
    this.createTail = operation.then(() => {}, () => {});
    return operation;
  }

  async attach(terminalId: string, viewerId: string): Promise<NativeTerminalAttachment> {
    if (!UUID.test(viewerId)) throw new TerminalError("INVALID_TERMINAL_VIEWER", "A viewer UUID is required.");
    for (const value of this.attachments.values()) if (value.info.terminalId === terminalId && value.info.viewerId === viewerId) await this.detach(value.info.id);
    const entry = this.find(terminalId), info = entry.record.info;
    if (this.stopping || this.recoveringInput || entry.mutating || !entry.record.paneId || (info.status !== "running" && info.status !== "exited") || info.serverGeneration !== this.catalog.serverGeneration || !this.server || this.server.status() !== "running") throw new TerminalError("TERMINAL_NOT_ATTACHABLE", "This native terminal cannot be attached in its current state.");
    if (this.attachments.size >= 64 || [...this.attachments.values()].filter(value => value.info.terminalId === terminalId).length >= 16) throw new TerminalError("TERMINAL_VIEWER_LIMIT", "Native terminals allow at most 16 viewers per pane and 64 viewers on one host.");
    const attachmentInfo: NativeTerminalAttachment = { id: crypto.randomUUID(), terminalId, viewerId, inputEpoch: this.inputEpoch, geometryRevision: info.geometryRevision, cols: info.cols, rows: info.rows, expiresAt: Date.now() + this.lifetime };
    let attachment!: Attachment;
    const initial: Uint8Array[] = [];
    const child = Bun.spawn(this.args("attach-session", "-t", entry.record.sessionName), { env: this.environment(), terminal: { cols: info.cols, rows: info.rows, data: (_terminal, data) => { if (attachment) this.output(attachment, data); else initial.push(new Uint8Array(data)); } } });
    attachment = { info: attachmentInfo, child, pty: child.terminal!, decoder: new TextDecoder(), chunks: [], bytes: 0, lastSequence: 0, completedSequence: 0, acknowledgedGeometry: 0, replies: new Map(), closing: false };
    this.attachments.set(attachmentInfo.id, attachment); for (const bytes of initial) this.output(attachment, bytes);
    void child.exited.then(() => { attachment.pty.close(); if (!attachment.closing) { attachment.closing = true; this.attachments.delete(attachmentInfo.id); this.emit({ type: "detached", terminalId, attachmentId: attachmentInfo.id }); } });
    return copy(attachmentInfo);
  }
  private output(attachment: Attachment, data: Uint8Array): void {
    if (attachment.closing) return;
    const text = attachment.decoder.decode(data, { stream: true }); const bytes = Buffer.from(text);
    for (let offset = 0; offset < bytes.length;) {
      let end = Math.min(bytes.length, offset + Math.min(16_384, this.maximumOutputBytes)); while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      const chunk = { sequence: ++attachment.lastSequence, data: bytes.subarray(offset, end).toString("utf8"), bytes: end - offset };
      attachment.chunks.push(chunk); attachment.bytes += chunk.bytes; while (attachment.bytes > this.maximumOutputBytes) attachment.bytes -= attachment.chunks.shift()!.bytes;
      offset = end;
    }
    this.emit({ type: "output", terminalId: attachment.info.terminalId, attachmentId: attachment.info.id, lastSequence: attachment.lastSequence });
  }
  replay(attachmentId: string, afterSequence: number): NativeTerminalReplay {
    const attachment = this.attachment(attachmentId); integer(afterSequence, 0, attachment.lastSequence);
    const firstSequence = attachment.chunks[0]?.sequence ?? attachment.lastSequence + 1, resetRequired = afterSequence < firstSequence - 1;
    return { attachment: copy(attachment.info), terminal: this.get(attachment.info.terminalId), chunks: resetRequired ? [] : attachment.chunks.filter(chunk => chunk.sequence > afterSequence).map(({ sequence, data }) => ({ sequence, data })), firstSequence, lastSequence: attachment.lastSequence, resetRequired };
  }
  heartbeat(attachmentId: string, afterSequence: number, geometryRevision: number): NativeTerminalAttachment {
    const attachment = this.attachment(attachmentId); integer(afterSequence, 0, attachment.lastSequence);
    if (geometryRevision !== attachment.info.geometryRevision) throw new TerminalError("STALE_TERMINAL_GEOMETRY", "Acknowledge the accepted grid before sending input.");
    attachment.acknowledgedGeometry = geometryRevision; attachment.completedSequence = Math.max(afterSequence, attachment.completedSequence); attachment.info.expiresAt = Date.now() + this.lifetime;
    for (const key of attachment.replies.keys()) if (Number(key.split(":")[0]) <= attachment.completedSequence) attachment.replies.delete(key);
    return copy(attachment.info);
  }
  reply(attachmentId: string, outputSequence: number, ordinal: number, data: string): boolean {
    const attachment = this.attachment(attachmentId); integer(ordinal, 1, 2048); integer(outputSequence, 1, attachment.lastSequence);
    if (typeof data !== "string" || Buffer.byteLength(data) > 4096) throw new TerminalError("INVALID_TERMINAL_REPLY", "A native terminal reply exceeds its bound.");
    const first = attachment.chunks[0]?.sequence ?? attachment.lastSequence + 1;
    if (outputSequence < first) throw new TerminalError("TERMINAL_REPLY_CURSOR_LOST", "The query cursor was evicted; replace this native attachment.");
    if (outputSequence <= attachment.completedSequence) return false;
    const key = `${outputSequence}:${ordinal}`, hash = sha256(data), previous = attachment.replies.get(key);
    if (previous) { if (previous !== hash) throw new TerminalError("TERMINAL_REPLY_REUSED", "A native query reply was reused with different content."); return true; }
    if (attachment.replies.size >= 2048) throw new TerminalError("TERMINAL_REPLY_LIMIT", "Too many native replies await a viewer acknowledgement.");
    attachment.pty.write(data); attachment.replies.set(key, hash); return true;
  }
  focus(attachmentId: string, focused: boolean): void {
    if (typeof focused !== "boolean") throw new TerminalError("INVALID_TERMINAL_FOCUS", "Native attachment focus must be a boolean.");
    this.attachment(attachmentId).pty.write(focused ? "\x1b[I" : "\x1b[O");
  }
  async detach(attachmentId: string): Promise<void> {
    const attachment = this.attachments.get(attachmentId); if (!attachment) return;
    attachment.closing = true; this.attachments.delete(attachmentId); attachment.child.kill(); await attachment.child.exited; attachment.pty.close();
    this.emit({ type: "detached", terminalId: attachment.info.terminalId, attachmentId });
  }
  private async detachEntry(id: string): Promise<void> { await Promise.all([...this.attachments.values()].filter(value => value.info.terminalId === id).map(value => this.detach(value.info.id))); }
  async resize(terminalId: string, attachmentId: string, geometryRevision: number, cols: number, rows: number): Promise<NativeTerminalInfo> {
    const entry = this.find(terminalId), attachment = this.attachment(attachmentId), size = dimensions(cols, rows);
    if (attachment.info.terminalId !== terminalId || geometryRevision !== entry.record.info.geometryRevision || entry.mutating) throw new TerminalError("STALE_TERMINAL_GEOMETRY", "The terminal grid changed before this resize was accepted.");
    if (entry.record.info.status !== "running") throw new TerminalError("TERMINAL_NOT_RUNNING", "This native terminal is not running.");
    if (size.cols === entry.record.info.cols && size.rows === entry.record.info.rows) return this.publicInfo(entry);
    entry.mutating = true;
    try {
      await this.detachEntry(terminalId);
      await this.controller(entry).execute(`resize-window -t ${entry.record.sessionName} -x ${size.cols} -y ${size.rows}`);
      entry.record.info = { ...entry.record.info, ...size, geometryRevision: entry.record.info.geometryRevision + 1 }; this.save(); this.state(entry); return this.publicInfo(entry);
    } finally { entry.mutating = false; }
  }
  input(request: NativeTerminalInputRequest): Promise<NativeTerminalInputReceipt> {
    validateNativeInput(request.input);
    if (!UUID.test(request.clientId) || !UUID.test(request.inputEpoch)) throw new TerminalError("INVALID_TERMINAL_INPUT", "Terminal input needs its client UUID and current input epoch.");
    integer(request.sequence, 1, Number.MAX_SAFE_INTEGER);
    const key = `${request.terminalId}:${request.clientId}`, hash = sha256(JSON.stringify([request.terminalId, request.attachmentId, request.inputEpoch, request.geometryRevision, request.clientId, request.sequence, nativeInputIdentity(request.input)]));
    let stream = this.streams.get(key);
    if (!stream) { if (this.streams.size >= 1024) throw new TerminalError("TERMINAL_INPUT_STREAM_LIMIT", "Too many native input streams are retained."); stream = { lastSequence: 0, receipts: new Map() }; this.streams.set(key, stream); }
    if (request.sequence <= stream.lastSequence) {
      const old = stream.receipts.get(request.sequence); if (!old || old.hash !== hash) throw new TerminalError(old ? "TERMINAL_INPUT_REUSED" : "TERMINAL_INPUT_RECEIPT_EXPIRED", "This native input sequence was already used and will not be sent again.");
      return old.result.then(result => ({ ...result, duplicate: true }));
    }
    if (request.sequence !== stream.lastSequence + 1) throw new TerminalError("TERMINAL_INPUT_OUT_OF_ORDER", "Native terminal input arrived out of order and was not submitted.");
    const result = this.submitInput(request).then(outcome => ({ sequence: request.sequence, duplicate: false, ...outcome }));
    stream.lastSequence = request.sequence; stream.receipts.set(request.sequence, { hash, result });
    // Pending receipts are kept until settled so a delayed duplicate can never resubmit.
    void result.finally(() => { while (stream!.receipts.size > 128) stream!.receipts.delete(stream!.receipts.keys().next().value!); });
    return result;
  }
  private async submitInput(request: NativeTerminalInputRequest): Promise<Omit<NativeTerminalInputReceipt, "sequence" | "duplicate">> {
    let reservedBytes = 0;
    try {
      const entry = this.find(request.terminalId), attachment = this.attachment(request.attachmentId), info = entry.record.info;
      if (this.stopping || this.recoveringInput || entry.mutating || info.status !== "running") throw new TerminalError("TERMINAL_NOT_RUNNING", "This native terminal is not accepting input.");
      if (request.inputEpoch !== this.inputEpoch || request.inputEpoch !== attachment.info.inputEpoch) throw new TerminalError("TERMINAL_INPUT_EPOCH_EXPIRED", "The host input epoch changed; this input was not submitted.");
      if (attachment.info.terminalId !== info.id || request.geometryRevision !== info.geometryRevision || attachment.acknowledgedGeometry !== info.geometryRevision) throw new TerminalError("STALE_TERMINAL_GEOMETRY", "The native terminal grid has not been acknowledged; input was not submitted.");
      const bytes = Buffer.byteLength(JSON.stringify(request.input));
      if (this.pendingInputs >= 256 || this.pendingInputBytes + bytes > 2 * 1024 * 1024) throw new TerminalError("TERMINAL_INPUT_BUSY", "The native input queue is full; this input was not submitted.");
      reservedBytes = bytes; this.pendingInputBytes += bytes; this.pendingInputs++;
      const control = this.controller(entry);
      const lines = await control.execute(nativeInputCommand(entry.record.paneId!, info.cols, info.rows, request.input));
      if (lines.includes("AGENT_STALE_GEOMETRY")) return { outcome: "not-submitted", code: "STALE_TERMINAL_GEOMETRY", message: "The native pane changed size before input arrived." };
      return { outcome: "accepted" };
    } catch (error) {
      return { outcome: error instanceof NativeControlError ? error.outcome : "not-submitted", code: error instanceof TerminalError ? error.code : "TERMINAL_INPUT_FAILED", message: error instanceof Error ? error.message : "Native input failed before submission." };
    } finally { if (reservedBytes) { this.pendingInputBytes -= reservedBytes; this.pendingInputs--; } }
  }

  async history(terminalId: string): Promise<NativeTerminalHistory> {
    const entry = this.find(terminalId), info = entry.record.info;
    if (!entry.record.paneId || info.serverGeneration !== this.catalog.serverGeneration || !this.server || this.server.status() !== "running") return this.store.history(terminalId) ?? { terminalId, serverGeneration: info.serverGeneration, revision: sha256(""), capturedAt: info.exitedAt ?? info.createdAt, cols: info.cols, rows: info.rows, live: false, history: "", truncated: false };
    const [historySize, alternate] = (await this.cli(["display-message", "-p", "-t", entry.record.paneId, "#{history_size}|#{alternate_on}"])).split("|").map(Number);
    let text = historySize ? await this.cli(["capture-pane", "-p", "-t", entry.record.paneId, "-S", "-", "-E", "-1"], 16 * 1024 * 1024) : "";
    let screen = await this.cli(["capture-pane", "-p", "-t", entry.record.paneId], 8 * 1024 * 1024);
    let savedNormalScreen = alternate ? await this.cli(["capture-pane", "-a", "-p", "-t", entry.record.paneId], 8 * 1024 * 1024) : undefined;
    let truncated = false, remaining = this.maximumHistoryBytes;
    const bound = (value: string): string => { const data = Buffer.from(value); if (data.length <= remaining) { remaining -= data.length; return value; } truncated = true; let offset = data.length - remaining; remaining = 0; while ((data[offset]! & 0xc0) === 0x80) offset++; return data.subarray(offset).toString("utf8"); };
    // Keep current/final visible rows before spending the remaining snapshot budget on older history.
    screen = bound(screen); if (savedNormalScreen !== undefined) savedNormalScreen = bound(savedNormalScreen); text = bound(text);
    const history: NativeTerminalHistory = { terminalId, serverGeneration: info.serverGeneration, revision: sha256(JSON.stringify([info.serverGeneration, info.cols, info.rows, text, screen, savedNormalScreen])), capturedAt: Date.now(), cols: info.cols, rows: info.rows, live: true, history: text, screen, ...(savedNormalScreen === undefined ? {} : { savedNormalScreen }), truncated };
    this.store.putHistory(history); return history;
  }
  close(id: string): Promise<NativeTerminalInfo> {
    const entry = this.find(id); if (entry.closing) return entry.closing;
    entry.closing = (async () => {
      if (entry.record.info.status === "interrupted" || !entry.record.paneId) { this.cleanupEnvironmentLaunch(id); return this.publicInfo(entry); }
      entry.mutating = true;
      let finalOutcome = entry.record.info.status === "exited";
      try {
        // A poll may already be saving the natural final screen. Reserve this
        // entry before waiting so no new reconciliation can race pane removal.
        await entry.finalizing;
        finalOutcome = entry.record.info.status === "exited";
        if (!finalOutcome) { entry.record.info.status = "closing"; this.save(); this.state(entry); }
        await this.history(id); await this.detachEntry(id); await entry.control?.close(); entry.control = undefined;
        if (!finalOutcome) {
          // Native completion can precede the next poll or happen while viewer
          // cleanup awaits. Observe it before requesting process termination.
          const row = (await this.panes()).find(row => row.pane === entry.record.paneId && row.id === id && row.session === entry.record.sessionName);
          if (!row) throw new TerminalError("TERMINAL_PANE_MISSING", "The owning native pane is missing; its completion could not be verified.");
          if (row.dead) {
            entry.record.info = { ...entry.record.info, status: "exited", exitedAt: Date.now(), exitCode: row.code };
            finalOutcome = true; this.save(); this.state(entry);
            await this.history(id);
          } else if (entry.process?.status() === "running") await entry.process.terminate({ gracefulMs: 200, timeoutMs: 3000 });
        }
        if (this.server?.status() === "running") await this.cli(["kill-session", "-t", entry.record.sessionName]);
        if (!finalOutcome) entry.record.info = { ...entry.record.info, status: "exited", exitedAt: Date.now(), cancelled: true };
        entry.record.paneId = undefined; this.cleanupEnvironmentLaunch(id); this.save(); this.state(entry); return this.publicInfo(entry);
      } catch (error) { entry.record.info.error = error instanceof Error ? error.message : "Native terminal cleanup failed."; if (!finalOutcome) entry.record.info.status = "error"; this.save(); this.state(entry); throw error; }
      finally { entry.mutating = false; }
    })(); return entry.closing;
  }
  async forget(id: string): Promise<void> {
    const entry = this.find(id); if (active(entry.record.info)) throw new TerminalError("TERMINAL_NOT_EXITED", "Close this native terminal before forgetting its history.");
    if (entry.record.paneId && entry.record.info.status !== "interrupted") await this.close(id);
    this.cleanupEnvironmentLaunch(id); this.entries.delete(id); this.store.forgetHistory(id); for (const key of this.streams.keys()) if (key.startsWith(`${id}:`)) this.streams.delete(key); this.save(); this.emit({ type: "removed", terminalId: id });
  }
  private async poll(): Promise<void> {
    if (this.polling || this.stopping) return; this.polling = true;
    try {
      for (const value of this.attachments.values()) if (value.info.expiresAt <= Date.now()) await this.detach(value.info.id);
      if (!this.server) return;
      if (this.server.status() !== "running") {
        for (const entry of this.entries.values()) if (active(entry.record.info) && !entry.mutating) { this.interrupted(entry, "The private native server exited; this terminal will not be restarted automatically."); await this.detachEntry(entry.record.info.id); await entry.control?.close(); entry.control = undefined; }
        this.server = undefined; delete this.catalog.serverPid; this.save(); return;
      }
      const rows = await this.panes(); let changed = false;
      for (const entry of this.entries.values()) {
        if (!active(entry.record.info) || entry.mutating) continue;
        const row = rows.find(row => row.pane === entry.record.paneId && row.id === entry.record.info.id);
        if (!row) { this.interrupted(entry, "The owning native pane is missing; no program was restarted."); changed = true; }
        else if (row.dead) {
          entry.record.info = { ...entry.record.info, status: "exited", exitCode: row.code, exitedAt: Date.now() };
          this.save();
          entry.finalizing = (async () => { await this.history(entry.record.info.id); await entry.control?.close(); entry.control = undefined; this.state(entry); })();
          try { await entry.finalizing; } finally { entry.finalizing = undefined; }
          changed = true;
        }
      }
      if (changed) this.save();
      if ([...this.entries.values()].some(entry => entry.record.info.status === "running" && entry.control?.isClosed && !entry.mutating)) {
        // A lost acknowledgement never causes replay. New input must name a fresh epoch and attachment.
        this.recoveringInput = true;
        this.inputEpoch = crypto.randomUUID();
        try {
          for (const entry of this.entries.values()) { entry.record.info.inputEpoch = this.inputEpoch; this.state(entry); }
          await Promise.all([...this.attachments.keys()].map(id => this.detach(id)));
          for (const entry of this.entries.values()) { await entry.control?.close(); entry.control = undefined; if (entry.record.info.status === "running" && !entry.mutating) this.controller(entry); }
          this.save();
        } finally { this.recoveringInput = false; for (const entry of this.entries.values()) this.state(entry); }
      }
      if (Date.now() - this.historyClock >= 30_000) { this.historyClock = Date.now(); for (const entry of this.entries.values()) if (entry.record.info.status === "running" && !entry.mutating) await this.history(entry.record.info.id); }
    } catch (error) { this.options.onListenerError?.(error instanceof Error ? error : new Error("Native terminal reconciliation failed.")); }
    finally { this.polling = false; }
  }
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise; this.stopping = true; clearInterval(this.timer);
    this.shutdownPromise = (async () => {
      await this.createTail;
      const results = await Promise.allSettled([...this.entries.keys()].map(id => this.close(id)));
      await Promise.all([...this.attachments.keys()].map(id => this.detach(id)));
      if (this.server?.status() === "running") await this.server.terminate({ gracefulMs: 200, timeoutMs: 3000 });
      this.server = undefined; delete this.catalog.serverPid; this.save(); this.listeners.clear();
      const failures = results.filter(result => result.status === "rejected"); if (failures.length) throw new AggregateError(failures.map(result => (result as PromiseRejectedResult).reason), "Some native terminals failed to close.");
    })(); return this.shutdownPromise;
  }
}
