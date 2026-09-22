import { parseDaemonSnapshot } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { parseSessionProcessRow, parseSessionProcessTarget, parseSessionProcessesOwner, parseSessionProcessesRequest,
  parseSessionProcessesSnapshot, sameSessionProcessesOwner, sameSessionProcessTarget, SESSION_PROCESSES_MAX_LOG_CHARS,
  type SessionProcessesOwner, type SessionProcessesRequest, type SessionProcessesResult, type SessionProcessRow,
  type SessionProcessTarget } from "../../../../packages/shared/src/session-processes";

type Request = Exclude<SessionProcessesRequest, { action: "receipt" }>;
type NamedOperation = { op: "stop"; name: string; timeoutMs: number } | { op: "restart"; name: string }
  | { op: "send"; name: string; data: string }
  | { op: "logs"; name: string; lines: number; head: false; follow: false; timeoutMs: number };
export type ProcessBrokerOperation = { op: "observe" } | { op: "guarded"; target: SessionProcessTarget; operation: NamedOperation };
/** The broker's existing request/close surface. The production factory must
 * create an independent client; never pass the agent's shared completion client. */
export interface ProcessBrokerClient {
  readonly projectDir: string;
  request(operation: ProcessBrokerOperation): Promise<unknown>;
  close(): void;
}
export type NativeProcessesReply = Extract<SessionProcessesResult, { action: "read" | "logs" }>
  | { action: "mutation"; row: SessionProcessRow };

/** This error is created only before a native operation is dispatched. It may
 * be recorded as a durable rejection; errors after dispatch remain unknown. */
export class NativeProcessesAdmissionError extends Error {
  readonly code = "PROCESSES_REJECTED";
  constructor(message: string) { super(message); this.name = "NativeProcessesAdmissionError"; }
}
type Pending = { promise: Promise<NativeProcessesReply>; failure?: unknown; failed: boolean };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native process response.");
  return value as Record<string, unknown>;
}
function projectRow(target: SessionProcessTarget, raw: unknown): SessionProcessRow {
  const d = parseDaemonSnapshot(raw);
  if (d.name !== target.name || d.id !== target.id) throw new Error("Native process result identifies a different record.");
  return parseSessionProcessRow({ target, state: d.state, pid: d.pid, createdAt: d.createdAt, startedAt: d.startedAt,
    readyAt: d.readyAt, exitedAt: d.exitedAt, exitCode: d.exitCode, restartCount: d.restartCount, outputBytes: d.outputBytes,
    nativeOwner: d.owner, readyPending: d.readyPending ?? [], persist: d.persist, detached: d.detached });
}

/** One loaded session's access to the project broker, not ownership of its
 * processes. Closing this adapter joins admitted requests then closes only its
 * socket; it never sends shutdown, unsubscribes, consumes completion events or
 * kills project processes. Mutations require the host's durable admission. */
export class NativeSessionProcesses {
  readonly #owner: SessionProcessesOwner;
  readonly #pending = new Set<Pending>();
  #client: ProcessBrokerClient | undefined;
  #opening: Promise<ProcessBrokerClient> | undefined;
  #retired = false;
  #disposal: Promise<void> | undefined;
  constructor(owner: SessionProcessesOwner, private readonly assertCurrent: () => void,
    private readonly createClient: () => Promise<ProcessBrokerClient>) {
    this.#owner = parseSessionProcessesOwner(owner);
  }
  get owner(): SessionProcessesOwner { return { ...this.#owner }; }

  request(raw: Request): Promise<NativeProcessesReply> {
    let request: Request;
    try {
      const parsed = parseSessionProcessesRequest(raw);
      if (parsed.action === "receipt") throw new Error("Receipts belong to the durable host store.");
      request = parsed;
      this.#assert();
      if (request.owner && !sameSessionProcessesOwner(request.owner, this.#owner)) throw new Error("The original process view has retired. Refresh before acting.");
      if (this.#pending.size >= 16) throw new Error("Too many process operations are still pending.");
    } catch (error) { return Promise.reject(new NativeProcessesAdmissionError(error instanceof Error ? error.message : String(error))); }
    // Reserve before invoking any client/factory callback, including reentrant disposal.
    const pending: Pending = { promise: undefined!, failed: false };
    this.#pending.add(pending);
    pending.promise = Promise.resolve().then(() => this.#run(request, pending)).finally(() => this.#pending.delete(pending));
    return pending.promise;
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#retired = true;
    const admitted = [...this.#pending];
    this.#disposal = Promise.resolve().then(async () => {
      await Promise.allSettled(admitted.map(entry => entry.promise));
      const errors = admitted.filter(entry => entry.failed).map(entry => entry.failure);
      try { this.#client?.close(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Native process requests failed during session disposal.");
    });
    return this.#disposal;
  }
  #assert(): void {
    if (this.#retired) throw new Error("The original process view has retired.");
    this.assertCurrent();
  }
  async #getClient(): Promise<ProcessBrokerClient> {
    this.#opening ??= Promise.resolve().then(this.createClient).then(client => {
      if (client.projectDir !== this.#owner.projectDir) {
        const mismatch = new Error("The native process broker belongs to a different project.");
        try { client.close(); } catch (error) { throw new AggregateError([mismatch, error], "Incorrect process client cleanup failed."); }
        throw mismatch;
      }
      this.#client = client;
      return client;
    }).catch(error => {
      // Only failed client creation is retryable. A dispatched mutation never
      // reaches this branch and is never automatically reissued.
      this.#opening = undefined;
      throw error;
    });
    return this.#opening;
  }
  async #run(request: Request, pending: Pending): Promise<NativeProcessesReply> {
    try { this.#assert(); } catch (error) { throw new NativeProcessesAdmissionError(error instanceof Error ? error.message : String(error)); }
    let client: ProcessBrokerClient;
    try { client = await this.#getClient(); }
    catch (error) { pending.failure = error; pending.failed = true; throw new NativeProcessesAdmissionError("The native process broker is unavailable."); }
    // The factory can await I/O or reenter disposal. Nothing was dispatched yet.
    try { this.#assert(); } catch (error) { throw new NativeProcessesAdmissionError(error instanceof Error ? error.message : String(error)); }
    const operation: ProcessBrokerOperation = request.action === "read" ? { op: "observe" } : {
      op: "guarded", target: { ...request.target }, operation: request.action === "logs"
        ? { op: "logs", name: request.target.name, lines: 500, head: false, follow: false, timeoutMs: 1000 }
        : request.action === "input" ? { op: "send", name: request.target.name, data: request.text }
        : request.action === "stop" ? { op: "stop", name: request.target.name, timeoutMs: 2000 }
        : { op: "restart", name: request.target.name },
    };
    let result: NativeProcessesReply;
    try {
      const value = object(await client.request(operation));
      // Parse inside operational capture before the post-read retirement check:
      // a malformed dispatched reply must remain visible to the joining drain.
      if (request.action === "read") {
        if (value.op !== "observe" || !Array.isArray(value.daemons)) throw new Error("The broker does not support process observations.");
        result = { action: "read", snapshot: parseSessionProcessesSnapshot({ owner: this.#owner, brokerId: value.brokerId,
          rows: Array.from(value.daemons, item => { const row = object(item); return projectRow(parseSessionProcessTarget(row.target), row.daemon); }) }) };
      } else {
        if (value.op !== "guarded") throw new Error("The broker did not confirm a guarded process operation.");
        const target = parseSessionProcessTarget(value.target), payload = object(value.result);
        const expected = { ...request.target, generation: request.target.generation + (request.action === "restart" ? 1 : 0) };
        if (!sameSessionProcessTarget(target, expected) || payload.op !== (request.action === "input" ? "send" : request.action)) throw new Error("The process result does not answer the original operation.");
        if (request.action === "logs") {
          if (payload.name !== request.target.name || typeof payload.text !== "string") throw new Error("Invalid native process log result.");
          result = { action: "logs", owner: this.owner, target, text: payload.text.slice(-SESSION_PROCESSES_MAX_LOG_CHARS), truncated: payload.text.length > SESSION_PROCESSES_MAX_LOG_CHARS };
        } else result = { action: "mutation", row: projectRow(target, payload.daemon) };
      }
    } catch (error) { pending.failure = error; pending.failed = true; throw error; }
    // Any mutation whose original owner is lost here is unknown, not rejected.
    this.#assert();
    return result;
  }
}

/** Keeps a process view tied to one project epoch. Explicit task moves retire
 * and join the original socket before changing the native session directory.
 * A move never transfers a saved process target to the destination project. */
export class NativeSessionProcessScope {
  #view: NativeSessionProcesses | undefined;
  #moving = false;
  #retired = false;
  #disposal: Promise<void> | undefined;
  #move: Promise<unknown> | undefined;
  #failure: unknown;
  #failed = false;
  constructor(private readonly sessionId: string, private readonly cwd: () => string,
    private readonly assertCurrent: () => void, private readonly createClient: (cwd: string) => Promise<ProcessBrokerClient>) {}
  request(request: Request): Promise<NativeProcessesReply> {
    try {
      if (this.#retired || this.#moving || this.#failed) throw new Error("The native process view is unavailable during task relocation or cleanup.");
      this.assertCurrent();
      if (!this.#view) {
        const projectDir = this.cwd();
        this.#view = new NativeSessionProcesses({ nativeSessionId: this.sessionId, projectDir, epoch: crypto.randomUUID() }, () => {
          this.assertCurrent();
          if (this.cwd() !== projectDir) throw new Error("The original process project changed.");
        }, () => this.createClient(projectDir));
      }
      return this.#view.request(request);
    } catch (error) { return Promise.reject(new NativeProcessesAdmissionError(error instanceof Error ? error.message : String(error))); }
  }
  move<T>(work: () => Promise<T>): Promise<T> {
    if (this.#moving || this.#retired || this.#failed) return Promise.reject(new Error("The process owner cannot be relocated during cleanup."));
    this.#moving = true;
    const old = this.#view;
    const drain = old?.dispose();
    const move = Promise.resolve().then(async () => {
      try { await drain; } catch (error) { this.#failure = error; this.#failed = true; throw error; }
      if (this.#retired) throw new Error("The session retired before task relocation.");
      this.assertCurrent();
      try { return await work(); }
      catch (error) {
        // An unverified native rollback must not admit a new project view.
        if (error instanceof Error && "code" in error && error.code === "OUTCOME_UNKNOWN") { this.#failure = error; this.#failed = true; }
        throw error;
      }
    }).finally(() => { this.#view = undefined; this.#moving = false; this.#move = undefined; });
    this.#move = move;
    return move;
  }
  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#retired = true;
    const drain = this.#view?.dispose();
    this.#disposal = Promise.resolve().then(async () => {
      const outcomes = await Promise.allSettled([drain, this.#move]);
      const errors = outcomes.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (this.#failed && !errors.includes(this.#failure)) errors.push(this.#failure);
      if (errors.length) throw new AggregateError(errors, "Native process scope cleanup failed.");
    });
    return this.#disposal;
  }
}
