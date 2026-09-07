import type { NativeMarketplaceCatalog, NativePluginAcquisition } from "../../../../packages/shared/src/plugin-acquisition";
import type { NativeMcpAuthorizationSnapshot, NativeMcpAuthorizationReply, NativeMcpAuthorizationStart } from "@agent-desktop/shared";
import type { NativePluginCatalog, NativePluginMutation, NativeMcpCatalog, NativeMcpDetail, NativeMcpDetailRequest, NativeMcpMutation } from "@agent-desktop/shared";
import type { BrowserControlRequest, BrowserDocumentContext, ComposerCompletionQuery, DetachedQuestionDeliveryReceipt, DetachedQuestionSnapshot, GoalMutationRequest, NativeGoalActivity, ResolveDetachedQuestionReceipt, ResolveDetachedQuestionRequest } from "@agent-desktop/shared";
import type { NativeComposerCatalog, NativeComposerCompletions } from "../omp/composer-actions";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserFrameTarget, BrowserMetadataAvailability, ModelInfo, NativeBrowserFrame, NativeSessionActivity, TranscriptMessage, OmpComposerCatalog, OmpModelCapabilities } from "@agent-desktop/shared";
import type { GoalContinuationEligibility, OmpBrowserTabCreateResult, OmpDetachedQuestionDeliveryRun, OmpGoalContinuationRun, OmpOpenOptions, OmpPromptRun, OmpSession, OmpSessionOptions } from "../omp";
import { DetachedQuestionOutcomeUnknown } from "../omp/detached-questions";
import { copyPreparedImages } from "../omp/images";
import { OmpPromptAdmissionError } from "../omp/prompt";
import type { WorkerEventListener } from "./events";
import { WORKER_PROTOCOL_VERSION, type ChildMessage, type ParentMessage, type SessionSnapshot, type WorkerInit, type WorkerOperation } from "./protocol";
import { localEnvironmentForWorker, type LocalEnvironmentWorkerEnvironment } from "../local-environments/environment";
import { assertBundledRuntime, getBundledRuntimeRoot } from "../runtime-ownership";
import type { NativeBtwSnapshot, NativeBtwStart } from "../../../../packages/shared/src/btw";

export interface WorkerFailure {
  type: "worker_failure";
  message: string;
  pid: number;
  sessionId?: string;
  exitCode?: number | null;
  signalCode?: number | null;
}
export class WorkerFailureError extends Error {
  constructor(readonly failure: WorkerFailure) {
    super(failure.message);
    this.name = "WorkerFailureError";
  }
}
export interface WorkerSession extends Omit<OmpSession, "getMessages" | "getSessionActivity" | "refreshGoalUsage" | "mutateGoal" | "getGoalContinuationEligibility" | "listQuestions" | "getSessionMcp" | "startSessionMcpAuthorization" | "getSessionMcpAuthorization" | "respondSessionMcpAuthorization" | "cancelSessionMcpAuthorization" | "getBtw" | "startBtw" | "cancelBtw" | "subscribe"> {
  readonly workerPid: number;
  readonly workerFailure: WorkerFailure | undefined;
  readonly activity: NativeSessionActivity;
  getMessages(): Promise<TranscriptMessage[]>;
  getSessionActivity(): Promise<NativeSessionActivity>;
  mutateGoal(request: GoalMutationRequest): Promise<NativeGoalActivity | null>;
  getGoalContinuationEligibility(): Promise<GoalContinuationEligibility>;
  startGoalContinuation(expectedGoalId: string): OmpGoalContinuationRun;
  listQuestions(): Promise<DetachedQuestionSnapshot[]>;
  resolveQuestion(request: ResolveDetachedQuestionRequest): Promise<ResolveDetachedQuestionReceipt>;
  startQuestionDelivery(questionId: string): OmpDetachedQuestionDeliveryRun;
  startSessionMcpAuthorization(request: NativeMcpAuthorizationStart): Promise<NativeMcpAuthorizationSnapshot>;
  getSessionMcpAuthorization(): Promise<NativeMcpAuthorizationSnapshot | null>;
  respondSessionMcpAuthorization(request: NativeMcpAuthorizationReply): Promise<NativeMcpAuthorizationSnapshot>;
  cancelSessionMcpAuthorization(authorizationId: string): Promise<NativeMcpAuthorizationSnapshot>;
  getSessionMcp(): Promise<import("@agent-desktop/shared").NativeSessionMcpSnapshot>;
  getBtw(): Promise<NativeBtwSnapshot | null>;
  startBtw(input: NativeBtwStart): Promise<NativeBtwSnapshot>;
  cancelBtw(runId: string): Promise<NativeBtwSnapshot | null>;
  getBrowserMetadata(): Promise<BrowserMetadataAvailability>;
  createBrowserTab(name: string): Promise<OmpBrowserTabCreateResult>;
  controlBrowser(request: BrowserControlRequest): Promise<{name: string; targetId: string; context: BrowserDocumentContext; url: string; title: string}>;
  getBrowserFrame(target: BrowserFrameTarget): Promise<NativeBrowserFrame>;
  subscribe(listener: WorkerEventListener): () => void;
  subscribeWorkerFailure(listener: (failure: WorkerFailure) => void): () => void;
}
export interface WorkerRuntimeOptions {
  agentDir?: string;
  /** Explicit installed Bun path. Defaults to the current Bun executable. */
  executablePath?: string;
  /** Build/install entrypoint override; source execution uses the adjacent entry.ts. */
  workerPath?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  /** A full child environment override, primarily for isolated contract tests.
   * Omitted inherits native CLI/provider/profile configuration unchanged. */
  environment?: Record<string, string | undefined>;
  onWorkerFailure?: (failure: WorkerFailure) => void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timeout?: ReturnType<typeof setTimeout>;
  uncertainTransport?: "prompt-admission" | "question-resolution" | "mcp-authorization";
}

class WorkerClient {
  #process: Bun.Subprocess<"ignore", "ignore", "ignore">;
  #ready = Promise.withResolvers<void>();
  #pending = new Map<string, Pending>();
  #requestId = 0;
  #disposeId?: string;
  #disposeAcknowledged = false;
  #closing = false;
  #closeCall?: Promise<void>;
  #options: WorkerRuntimeOptions;
  #readyDeadline: ReturnType<typeof setTimeout>;
  #events = new Set<WorkerEventListener>();
  #failures = new Set<(failure: WorkerFailure) => void>();
  snapshot?: SessionSnapshot;
  failure?: WorkerFailure;

  constructor(options: WorkerRuntimeOptions, environment = options.environment) {
    this.#options = options;
    if (options.onWorkerFailure) this.#failures.add(options.onWorkerFailure);
    const executable = options.executablePath ?? process.execPath;
    if (!path.isAbsolute(executable)) throw new Error("OMP worker requires an absolute Bun executable path");
    const bundleRoot = getBundledRuntimeRoot();
    const workerPath = bundleRoot ? fileURLToPath(new URL("./packaged-entry.ts", import.meta.url))
      : options.workerPath ?? fileURLToPath(new URL("./entry.ts", import.meta.url));
    if (bundleRoot) {
      assertBundledRuntime(bundleRoot, executable);
      if (options.workerPath !== undefined && options.workerPath !== workerPath)
        throw new Error("Packaged OMP workers must use the app-owned worker entrypoint.");
    }
    this.#readyDeadline = setTimeout(() => {
      this.#fail("OMP worker startup timed out");
      this.#process.kill("SIGKILL");
    }, options.startupTimeoutMs ?? 30_000);
    try {
      this.#process = Bun.spawn({
        cmd: [executable, workerPath],
        ...(environment ? { env: environment } : {}),
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
        serialization: "advanced",
        ipc: (message: unknown) => this.#receive(message),
        onExit: (child, exitCode, signalCode) => {
          clearTimeout(this.#readyDeadline);
          if (!this.#closing) {
            this.#fail(`OMP worker exited (code ${exitCode ?? "unknown"}, signal ${signalCode ?? "none"})`, child.pid, exitCode, signalCode);
          } else this.#rejectPending(new Error(this.#disposeAcknowledged ? "OMP worker closed"
            : `OMP worker exited before disposal acknowledgement (code ${exitCode ?? "unknown"}, signal ${signalCode ?? "none"})`));
        },
        onDisconnect: () => {
          // Exit notification normally follows immediately. A process that
          // disconnected without exiting must not keep owning its session.
          const check = setTimeout(() => {
            if (!this.#closing && !this.failure) {
              this.#fail("OMP worker IPC disconnected");
              this.#process.kill("SIGKILL");
            }
          }, 100);
          check.unref();
        },
      });
    } catch (error) {
      clearTimeout(this.#readyDeadline);
      throw error;
    }
    void this.#ready.promise.catch(() => {});
  }

  get pid(): number { return this.#process.pid; }

  #rejectPending(error: unknown): void {
    this.#ready.reject(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.#transportFailure(pending, error));
    }
    this.#pending.clear();
  }

  #transportFailure(pending: Pending | undefined, error: unknown): unknown {
    if (pending?.uncertainTransport === "mcp-authorization") return Object.assign(new Error("MCP authorization delivery is unknown. Inspect its current state before acting again."), {code:"OUTCOME_UNKNOWN"});
    if (pending?.uncertainTransport === "prompt-admission") return new OmpPromptAdmissionError(error);
    if (pending?.uncertainTransport === "question-resolution") return new DetachedQuestionOutcomeUnknown(error);
    return error;
  }

  #fail(message: string, pid = this.pid, exitCode?: number | null, signalCode?: number | null): void {
    if (this.failure) return;
    clearTimeout(this.#readyDeadline);
    this.failure = { type: "worker_failure", message, pid, sessionId: this.snapshot?.id, exitCode, signalCode };
    if (this.snapshot) this.snapshot = { ...this.snapshot, isStreaming: false, hasPostPromptWork: false };
    this.#rejectPending(new WorkerFailureError(this.failure));
    for (const listener of this.#failures) {
      try { listener(this.failure); }
      catch { console.error("OMP worker failure observer threw an exception"); }
    }
  }

  #receive(value: unknown): void {
    if (!value || typeof value !== "object" || !("type" in value)) return;
    const message = value as ChildMessage;
    if (message.type === "ready") {
      if (message.version !== WORKER_PROTOCOL_VERSION) {
        this.#fail("OMP worker protocol version mismatch");
        this.#process.kill("SIGKILL");
      } else { clearTimeout(this.#readyDeadline); this.#ready.resolve(); }
      return;
    }
    if (message.type === "fatal") {
      this.#fail(`OMP worker failed: ${message.error.message}`);
      return;
    }
    // Buffered native events can follow a newer command response. Their raw
    // order is retained, but they must not roll cached model/status backward.
    if (message.snapshot && !this.failure && message.snapshot.revision > (this.snapshot?.revision ?? -1)) {
      this.snapshot = message.snapshot;
    }
    if (message.type === "event") {
      if (this.failure) return;
      try {
        for (const listener of this.#events) listener(message.event);
        this.#send({ type: "eventAck", sequence: message.sequence });
      } catch {
        this.#fail("The host could not consume an OMP worker event");
        this.#process.kill("SIGKILL");
      }
      return;
    }
    if (message.type === "response") {
      const key = message.phase ? `${message.id}:${message.phase}` : message.id;
      const pending = this.#pending.get(key);
      if (!pending) return;
      this.#pending.delete(key);
      clearTimeout(pending.timeout);
      if (message.id === this.#disposeId) {
        // A successful process exit alone cannot prove native disposal. Receipt
        // of this exact response authorizes the child's final exit handshake.
        try {
          this.#send({ type: "disposeAck", id: message.id });
          this.#disposeAcknowledged = true;
        } catch (error) { pending.reject(error); return; }
      }
      if (message.ok) pending.resolve(message.value);
      else {
        const error = new Error(message.error?.message ?? "OMP worker operation failed");
        error.name = message.error?.name ?? "Error";
        if (message.error?.code === "OUTCOME_UNKNOWN") Object.assign(error, { code: "OUTCOME_UNKNOWN" });
        pending.reject(error);
      }
    }
  }

  #send(message: ParentMessage): void {
    if (this.failure) throw new WorkerFailureError(this.failure);
    this.#process.send(message);
  }

  #promise<T>(key: string, timeoutMs?: number, uncertainTransport?: Pending["uncertainTransport"]): Promise<T> {
    if (this.#pending.size >= 128) throw new Error("OMP worker request limit reached");
    const deferred = Promise.withResolvers<T>();
    const pending: Pending = {
      resolve: value => deferred.resolve(value as T), reject: deferred.reject, uncertainTransport,
    };
    if (timeoutMs) pending.timeout = setTimeout(() => {
      this.#pending.delete(key);
      deferred.reject(this.#transportFailure(pending, new Error("OMP worker operation timed out; its outcome may be unknown")));
    }, timeoutMs);
    this.#pending.set(key, pending);
    void deferred.promise.catch(() => {});
    return deferred.promise;
  }

  async request<T>(operation: WorkerOperation, timeoutMs?: number, uncertainTransport?: Pending["uncertainTransport"]): Promise<T> {
    await this.#ready.promise;
    if (this.failure) throw new WorkerFailureError(this.failure);
    if (this.#closing && operation.operation !== "dispose") throw new Error("OMP worker is closing");
    const id = String(++this.#requestId);
    if (operation.operation === "dispose") this.#disposeId = id;
    const response = this.#promise<T>(id, timeoutMs, uncertainTransport);
    try { this.#send({ type: "request", id, ...operation }); }
    catch (error) {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      clearTimeout(pending?.timeout);
      pending?.reject(this.#transportFailure(pending, error));
    }
    return response;
  }

  startPrompt(text: string, options?: Parameters<OmpSession["startPrompt"]>[1]): OmpPromptRun {
    if (this.failure) throw new WorkerFailureError(this.failure);
    if (this.#closing) throw new Error("OMP worker is closing");
    if (this.#pending.size > 125) throw new Error("OMP worker request limit reached");
    if (options?.images?.length && (this.snapshot?.isStreaming || this.snapshot?.hasPostPromptWork || [...this.#pending.keys()].some(key => key.endsWith(":completion")))) {
      throw new Error("OMP session is busy; image input was not dispatched");
    }
    const preparedOptions = options ? { ...options, images: copyPreparedImages(options.images) } : undefined;
    const id = String(++this.#requestId);
    const accepted = this.#promise<Awaited<OmpPromptRun["accepted"]>>(`${id}:accepted`, undefined, Boolean(preparedOptions?.images?.length) || text.trimStart().startsWith("/") || text.includes("/skill:") ? "prompt-admission" : undefined);
    const completion = this.#promise<boolean>(`${id}:completion`);
    try { this.#send({ type: "request", id, operation: "startPrompt", args: { text, options: preparedOptions } }); }
    catch (error) {
      for (const phase of ["accepted", "completion"]) {
        const key = `${id}:${phase}`;
        const pending = this.#pending.get(key);
        pending?.reject(this.#transportFailure(pending, error));
        this.#pending.delete(key);
      }
    }
    return { accepted, completion };
  }

  startGoalContinuation(expectedGoalId: string): OmpGoalContinuationRun {
    if (this.failure) throw new WorkerFailureError(this.failure);
    if (this.#closing) throw new Error("OMP worker is closing");
    if (this.#pending.size > 125) throw new Error("OMP worker request limit reached");
    const id = String(++this.#requestId);
    const accepted = this.#promise<Awaited<OmpGoalContinuationRun["accepted"]>>(`${id}:accepted`, undefined, "prompt-admission");
    const completion = this.#promise<Awaited<OmpGoalContinuationRun["completion"]>>(`${id}:completion`);
    try { this.#send({ type: "request", id, operation: "startGoalContinuation", args: { expectedGoalId } }); }
    catch (error) {
      for (const phase of ["accepted", "completion"]) {
        const key = `${id}:${phase}`, pending = this.#pending.get(key);
        pending?.reject(phase === "accepted" ? new OmpPromptAdmissionError(error) : error);
        this.#pending.delete(key);
      }
    }
    return { accepted, completion };
  }

  startQuestionDelivery(questionId: string): OmpDetachedQuestionDeliveryRun {
    if (this.failure) throw new WorkerFailureError(this.failure);
    if (this.#closing) throw new Error("OMP worker is closing");
    if (this.#pending.size > 125) throw new Error("OMP worker request limit reached");
    const id = String(++this.#requestId);
    const accepted = this.#promise<DetachedQuestionDeliveryReceipt>(`${id}:accepted`, undefined, "prompt-admission");
    const completion = this.#promise<boolean>(`${id}:completion`);
    try { this.#send({ type: "request", id, operation: "startQuestionDelivery", args: { questionId } }); }
    catch (error) {
      for (const phase of ["accepted", "completion"] as const) {
        const key = `${id}:${phase}`, pending = this.#pending.get(key);
        pending?.reject(error); this.#pending.delete(key);
      }
    }
    return { accepted, completion };
  }

  subscribe(listener: WorkerEventListener): () => void {
    this.#events.add(listener);
    return () => { this.#events.delete(listener); };
  }
  subscribeFailure(listener: (failure: WorkerFailure) => void): () => void {
    this.#failures.add(listener);
    if (this.failure) listener(this.failure);
    return () => { this.#failures.delete(listener); };
  }

  close(): Promise<void> {
    if (this.#closeCall) return this.#closeCall;
    this.#closing = true;
    this.#closeCall = (async () => {
      const deadline = setTimeout(() => { this.#process.kill("SIGKILL"); }, this.#options.shutdownTimeoutMs ?? 15_000);
      try {
        if (!this.failure && this.#process.exitCode === null) {
          await this.request({ operation: "dispose" }, this.#options.shutdownTimeoutMs ?? 15_000);
        }
        const exitCode = await this.#process.exited;
        if (this.#disposeAcknowledged && exitCode !== 0) {
          throw new Error(`OMP worker exited unsuccessfully after disposal acknowledgement (code ${exitCode}, signal ${this.#process.signalCode ?? "none"})`);
        }
      } finally {
        clearTimeout(deadline);
        // Failed startup/disposal must not orphan a file-owning child.
        if (this.#process.exitCode === null) { this.#process.kill("SIGKILL"); await this.#process.exited; }
        this.#events.clear(); this.#failures.clear();
        this.#rejectPending(new Error("OMP worker closed"));
      }
    })();
    return this.#closeCall;
  }
}

/** One native OMP process per session, plus one separate metadata-discovery process. */
export class WorkerRuntime {
  #options: WorkerRuntimeOptions;
  #sessions = new Set<WorkerSession>();
  #clients = new Set<WorkerClient>();
  #setups = new Set<Promise<unknown>>();
  #openFiles = new Set<string>();
  #discovery?: Promise<WorkerClient>;
  #disposed = false;
  #disposeCall?: Promise<void>;

  constructor(options: WorkerRuntimeOptions = {}) { this.#options = options; }

  #assertActive(): void { if (this.#disposed) throw new Error("OMP worker runtime is disposed"); }

  #track<T>(pending: Promise<T>): Promise<T> {
    this.#setups.add(pending);
    const remove = () => { this.#setups.delete(pending); };
    void pending.then(remove, remove);
    return pending;
  }

  async #spawn(init: WorkerInit, onEvent?: WorkerEventListener, localEnvironment?: LocalEnvironmentWorkerEnvironment): Promise<WorkerClient> {
    this.#assertActive();
    const environment = localEnvironment
      ? localEnvironmentForWorker(this.#options.environment ?? process.env, localEnvironment)
      : this.#options.environment;
    const client = new WorkerClient(this.#options, environment);
    this.#clients.add(client);
    if (onEvent) client.subscribe(onEvent);
    try {
      await client.request({ operation: "init", args: init }, this.#options.startupTimeoutMs ?? 30_000);
      this.#assertActive();
      if (init.mode !== "discovery" && !client.snapshot) throw new Error("OMP worker did not return native session metadata");
      return client;
    } catch (error) {
      try { await client.close(); } finally { this.#clients.delete(client); }
      throw error;
    }
  }

  create(options: Omit<OmpSessionOptions, "onEvent"> & { onEvent?: WorkerEventListener }, localEnvironment?: LocalEnvironmentWorkerEnvironment): Promise<WorkerSession> {
    this.#assertActive();
    const { onEvent, ...nativeOptions } = options;
    return this.#track((async () => {
      const client = await this.#spawn({ mode: "create", agentDir: this.#options.agentDir, options: nativeOptions }, onEvent, localEnvironment);
      return this.#handle(client);
    })());
  }

  open(options: Omit<OmpOpenOptions, "onEvent"> & { onEvent?: WorkerEventListener }, localEnvironment?: LocalEnvironmentWorkerEnvironment): Promise<WorkerSession> {
    this.#assertActive();
    return this.#track((async () => {
      const sessionFile = await realpath(options.sessionFile);
      this.#assertActive();
      if (this.#openFiles.has(sessionFile)) throw new Error("OMP session is already open in this worker runtime");
      this.#openFiles.add(sessionFile);
      try {
        const client = await this.#spawn({ mode: "open", agentDir: this.#options.agentDir, options: { sessionFile, interactions: options.interactions, approvalOverride: options.approvalOverride } }, options.onEvent, localEnvironment);
        return this.#handle(client);
      } catch (error) { this.#openFiles.delete(sessionFile); throw error; }
    })());
  }

  #handle(client: WorkerClient): WorkerSession {
    if (!client.snapshot) throw new Error("OMP worker did not return native session metadata");
    const sessionFile = path.resolve(client.snapshot.sessionFile);
    const reservedPaths = new Set([sessionFile]);
    this.#openFiles.add(sessionFile);
    const state = () => client.snapshot!;
    let disposeCall: Promise<void> | undefined;
    let imageReads = 0;
    const handle: WorkerSession = {
      get id() { return state().id; }, get sessionFile() { return state().sessionFile; },
      get cwd() { return state().cwd; }, get model() { return state().model; },
      get thinkingLevel() { return state().thinkingLevel; }, get isStreaming() { return state().isStreaming; },
      get hasPostPromptWork() { return state().hasPostPromptWork; }, get title() { return state().title; },
      get createdAt() { return state().createdAt; }, get modelFallbackMessage() { return state().modelFallbackMessage; },
      get activity() { return state().activity; },
      get workerPid() { return client.pid; }, get workerFailure() { return client.failure; },
      getComposerActions: () => client.request<NativeComposerCatalog>({ operation: "getComposerActions", args: {} }, 15_000),
      getComposerCompletions: query => client.request<NativeComposerCompletions>({ operation: "getComposerCompletions", args: { query } }, 5_000),
      getMessages: () => client.request<TranscriptMessage[]>({ operation: "getMessages" }, 30_000),
      getSessionActivity: () => client.request<NativeSessionActivity>({ operation: "getSessionActivity" }, 15_000),
      mutateGoal: request => client.request({ operation: "mutateGoal", args: { request } }, 30_000),
      getGoalContinuationEligibility: () => client.request({ operation: "getGoalContinuationEligibility" }, 15_000),
      startGoalContinuation: expectedGoalId => client.startGoalContinuation(expectedGoalId),
      listQuestions: () => client.request<DetachedQuestionSnapshot[]>({ operation: "listQuestions" }, 15_000),
      resolveQuestion: request => client.request<ResolveDetachedQuestionReceipt>({ operation: "resolveQuestion", args: { request } }, 15_000, "question-resolution"),
      startQuestionDelivery: questionId => client.startQuestionDelivery(questionId),
      readSessionMcpResource: request => client.request({ operation: "readSessionMcpResource", args: { request } }, 35_000),
      getSessionMcp: () => client.request({ operation: "getSessionMcp" }, 15_000),
      startSessionMcpAuthorization: request => client.request({ operation: "startSessionMcpAuthorization", args: { request } }, 15_000, "mcp-authorization"),
      getSessionMcpAuthorization: () => client.request({ operation: "getSessionMcpAuthorization" }, 15_000),
      respondSessionMcpAuthorization: request => client.request({ operation: "respondSessionMcpAuthorization", args: { request } }, 15_000, "mcp-authorization"),
      cancelSessionMcpAuthorization: authorizationId => client.request({ operation: "cancelSessionMcpAuthorization", args: { authorizationId } }, 15_000, "mcp-authorization"),
      reloadSessionMcp: request => client.request({ operation: "reloadSessionMcp", args: { request } }, 120_000),
      reconnectSessionMcp: request => client.request({ operation: "reconnectSessionMcp", args: { request } }, 120_000),
      getBtw: () => client.request({ operation: "getBtw" }, 15_000),
      startBtw: input => client.request({ operation: "startBtw", args: input }, 15_000),
      cancelBtw: runId => client.request({ operation: "cancelBtw", args: { runId } }, 15_000),
      promoteBtw: async (runId, operationId) => {
        try { return await client.request<{ cancelled: boolean; sessionId: string; sessionFile: string }>({ operation: "promoteBtw", args: { runId, operationId } }); }
        finally { if (client.snapshot?.sessionFile) { const file = path.resolve(client.snapshot.sessionFile); this.#openFiles.add(file); reservedPaths.add(file); } }
      },
      getBrowserMetadata: async () => {
        const metadata = await client.request<BrowserMetadataAvailability>({ operation: "getBrowserMetadata" }, 15_000);
        if (metadata.availability === "running" && metadata.workerPid !== client.pid) return { availability: "unavailable", reason: "Native browser metadata came from a stale worker." };
        return metadata;
      },
      // Native acquisition owns its configured finite timeout. Retain the IPC
      // request until it settles so a desktop timeout cannot release the host's
      // in-flight bound while creation may still be running.
      createBrowserTab: name => client.request<OmpBrowserTabCreateResult>({ operation: "createBrowserTab", args: { name } }),
      controlBrowser: request => client.request({ operation: "controlBrowser", args: { request } }, 15_000),
      getBrowserFrame: target => {
        if (target.workerPid !== client.pid) return Promise.reject(new Error("The selected browser frame belongs to a stale worker."));
        return client.request<NativeBrowserFrame>({ operation: "getBrowserFrame", args: { target } }, 15_000);
      },
      getImage: async (nativeEntryId, blockIndex) => {
        if (imageReads >= 2) throw new Error("Native image retrieval limit reached; retry after an active image read finishes");
        imageReads++;
        try { return await client.request({ operation: "getImage", args: { nativeEntryId, blockIndex } }, 30_000); }
        finally { imageReads--; }
      },
      subscribe: listener => client.subscribe(listener),
      subscribeWorkerFailure: listener => client.subscribeFailure(listener),
      startPrompt: (text, options) => client.startPrompt(text, options),
      prompt: (text, options) => client.startPrompt(text, options).completion,
      steer: (text, expectedApprovalMode, options) => {
        if (options?.images?.length) return Promise.reject(new Error("Image attachments are not supported on steering input yet; no input was queued"));
        return client.request({ operation: "steer", args: { text, expectedApprovalMode, options } });
      },
      abort: () => client.request({ operation: "abort" }),
      setModel: model => client.request({ operation: "setModel", args: { model } }),
      listAccountChoices: () => client.request({ operation: "listAccountChoices" }),
      pinAccount: credentialId => client.request({ operation: "pinAccount", args: { credentialId } }),
      releaseAccountForReselection: () => client.request({ operation: "releaseAccountForReselection" }),
      listInteractions: () => client.request({ operation: "listInteractions" }),
      respondInteraction: (id, response) => client.request({ operation: "respondInteraction", args: { id, response } }),
      cancelInteractions: reason => client.request({ operation: "cancelInteractions", args: { reason } }),
      getControls: () => client.request({ operation: "getControls" }),
      mutateControls: args => client.request({ operation: "mutateControls", args }),
      setApprovalOverride: (mode, expectedRevision) => client.request({ operation: "setApprovalOverride", args: { mode, expectedRevision } }, 30_000),
      dispose: () => {
        if (!disposeCall) disposeCall = (async () => {
          try { await client.close(); }
          finally {
            this.#sessions.delete(handle); this.#clients.delete(client); for (const file of reservedPaths) this.#openFiles.delete(file);
          }
        })();
        return disposeCall;
      },
    };
    this.#sessions.add(handle);
    return handle;
  }

  async #discoveryClient(): Promise<WorkerClient> {
    this.#assertActive();
    if (!this.#discovery) {
      const pending = this.#track(this.#spawn({ mode: "discovery", agentDir: this.#options.agentDir }));
      this.#discovery = pending;
      void pending.catch(() => { if (this.#discovery === pending) this.#discovery = undefined; });
    }
    const client = await this.#discovery;
    this.#assertActive();
    return client;
  }

  async listModels(cwd: string = process.cwd(), options: { refresh?: boolean } = {}): Promise<ModelInfo[]> {
    const client = await this.#discoveryClient();
    return client.request<ModelInfo[]>({ operation: "listModels", args: { cwd, refresh: options.refresh } });
  }

  async listModelCapabilities(cwd: string = process.cwd(), options: { refresh?: boolean } = {}): Promise<OmpModelCapabilities[]> {
    const client = await this.#discoveryClient();
    return client.request<OmpModelCapabilities[]>({ operation: "listModelCapabilities", args: { cwd, refresh: options.refresh } });
  }

  async getComposerCatalog(cwd: string = process.cwd(), options: { refresh?: boolean } = {}): Promise<OmpComposerCatalog> {
    const client = await this.#discoveryClient();
    return client.request<OmpComposerCatalog>({ operation: "getComposerCatalog", args: { cwd, refresh: options.refresh } });
  }

  async getMarketplaceCatalog(cwd: string): Promise<NativeMarketplaceCatalog> {
    return (await this.#discoveryClient()).request({operation:"getMarketplaceCatalog",args:{cwd}},30_000);
  }
  async acquirePlugin(cwd: string, expectedRevision: string, action: NativePluginAcquisition): Promise<NativeMarketplaceCatalog> {
    // Native acquisition has no abort API. Keep ownership until its actual result or worker exit.
    return (await this.#discoveryClient()).request({operation:"acquirePlugin",args:{cwd,expectedRevision,action}});
  }
  async getPlugins(cwd: string): Promise<NativePluginCatalog> {
    return (await this.#discoveryClient()).request({ operation: "getPlugins", args: { cwd } }, 30_000);
  }
  async mutatePlugin(cwd: string, mutation: NativePluginMutation): Promise<NativePluginCatalog> {
    return (await this.#discoveryClient()).request({ operation: "mutatePlugin", args: { cwd, mutation } }, 30_000);
  }
  async getMcpServers(cwd: string): Promise<NativeMcpCatalog> {
    return (await this.#discoveryClient()).request({ operation: "getMcpServers", args: { cwd } }, 30_000);
  }
  async getMcpServerDetail(cwd: string, request: NativeMcpDetailRequest): Promise<NativeMcpDetail> {
    return (await this.#discoveryClient()).request({ operation: "getMcpServerDetail", args: { cwd, request } }, 30_000);
  }
  async mutateMcpServer(cwd: string, mutation: NativeMcpMutation): Promise<NativeMcpCatalog> {
    return (await this.#discoveryClient()).request({ operation: "mutateMcpServer", args: { cwd, mutation } }, 30_000);
  }

  async getComposerActions(cwd: string = process.cwd(), options: { refresh?: boolean } = {}): Promise<NativeComposerCatalog> {
    return (await this.#discoveryClient()).request<NativeComposerCatalog>({ operation: "getComposerActions", args: { cwd, refresh: options.refresh } }, 15_000);
  }
  async getComposerCompletions(cwd: string, query: ComposerCompletionQuery): Promise<NativeComposerCompletions> {
    return (await this.#discoveryClient()).request<NativeComposerCompletions>({ operation: "getComposerCompletions", args: { cwd, query } }, 5_000);
  }

  dispose(): Promise<void> {
    if (this.#disposeCall) return this.#disposeCall;
    this.#disposed = true;
    this.#disposeCall = (async () => {
      // A child belongs to us before its init request completes. Begin bounded
      // shutdown now so a stuck native setup cannot defer cancellation forever.
      const closing = Promise.allSettled([...this.#clients].map(client => client.close()));
      await Promise.allSettled([...this.#setups]);
      const results = await closing;
      this.#sessions.clear(); this.#clients.clear(); this.#openFiles.clear();
      const errors = results.filter(result => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), "OMP worker shutdown failed");
    })();
    return this.#disposeCall;
  }
}
