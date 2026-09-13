import { requestWorkerBrowserObservation, type WorkerBrowserObservation } from "../omp-browser/observation";
import { openWorkerBrowserEvaluation, recoverWorkerBrowserEvaluation, type WorkerBrowserEvaluation } from "../omp-browser/evaluation-client";
import { copyEvaluationBinding, copyEvaluationFrame, copyEvaluationValue, evaluationKey, type BrowserEvaluationBinding, type BrowserEvaluationFrame } from "../omp-browser/evaluation-wire";
import { requestWorkerBrowserReservation, type WorkerBrowserReservationStatus } from "../omp-browser/reservation";
import { requestWorkerBrowserClose, type WorkerBrowserCloseResult } from "../omp-browser/close";
import type { NativeMarketplaceCatalog, NativePluginAcquisition } from "../../../../packages/shared/src/plugin-acquisition";
import { parseForceToolCancelResult, parseForceToolCommandId, parseForceToolPromptFields, parseForceToolReceipt, parseForceToolState, type ForceToolCancelResult, type ForceToolReceipt, type ForceToolState, type ForceToolTicket, type NativeMcpAuthorizationSnapshot, type NativeMcpAuthorizationReply, type NativeMcpAuthorizationStart } from "@agent-desktop/shared";
import type { NativePluginCatalog, NativePluginMutation, NativeMcpCatalog, NativeMcpDetail, NativeMcpDetailRequest, NativeMcpMutation } from "@agent-desktop/shared";
import type { BrowserControlRequest, BrowserDocumentContext, ComposerCompletionQuery, DetachedQuestionDeliveryReceipt, DetachedQuestionSnapshot, GoalMutationRequest, NativeGoalActivity, ResolveDetachedQuestionReceipt, ResolveDetachedQuestionRequest } from "@agent-desktop/shared";
import type { NativeComposerCatalog, NativeComposerCompletions, NativeSkillInventoryCatalog } from "../omp/composer-actions";
import { realpath } from "node:fs/promises";
import { readSessionHeader, requireDirectory } from "../omp/session-files";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserFrameTarget, BrowserHistoryEntry, BrowserMetadataAvailability, ModelInfo, NativeBrowserFrame, NativeSessionActivity, TranscriptMessage, OmpComposerCatalog, OmpModelCapabilities } from "@agent-desktop/shared";
import type { GoalContinuationEligibility, OmpBrowserTabCreateResult, OmpDetachedQuestionDeliveryRun, OmpGoalContinuationRun, OmpOpenOptions, OmpPromptRun, OmpSession, OmpSessionOptions } from "../omp";
import { DetachedQuestionOutcomeUnknown } from "../omp/detached-questions";
import { copyPreparedImages } from "../omp/images";
import { copyNativeSelectedTextInput } from "../omp/selected-text";
import { copyNativeWholeFileInput } from "../omp/whole-file";
import { OmpPromptAdmissionError } from "../omp/prompt";
import type { WorkerEventListener } from "./events";
import { WORKER_PROTOCOL_VERSION, remoteError, type ChildMessage, type ParentMessage, type SessionSnapshot, type WorkerInit, type WorkerOperation, type CommitGenerationInput, type NativeSessionForkInput, type NativeSessionForkResult } from "./protocol";
import { localEnvironmentForWorker, type LocalEnvironmentWorkerEnvironment } from "../local-environments/environment";
import { assertBundledRuntime, getBundledRuntimeRoot } from "../runtime-ownership";
import type { NativeBtwSnapshot, NativeBtwStart } from "../../../../packages/shared/src/btw";
import { connectWorkerEndpoint, type WorkerReconnectEndpoint } from "./reconnect-wire";

export interface WorkerFailure {
  type: "worker_failure";
  message: string;
  pid: number;
  sessionId?: string;
  browserOwnerId?: string;
  mcpOwnerId?: string;
  exitCode?: number | null;
  signalCode?: number | null;
}
export class WorkerFailureError extends Error {
  constructor(readonly failure: WorkerFailure) {
    super(failure.message);
    this.name = "WorkerFailureError";
  }
}
export interface WorkerSession extends Omit<OmpSession, "getMessages" | "getSessionActivity" | "refreshGoalUsage" | "mutateGoal" | "getGoalContinuationEligibility" | "listQuestions" | "getSessionMcp" | "startSessionMcpAuthorization" | "getSessionMcpAuthorization" | "respondSessionMcpAuthorization" | "cancelSessionMcpAuthorization" | "getBtw" | "startBtw" | "cancelBtw" | "subscribe" | "getQueuedMessages" | "mutateQueuedMessages" | "assertTaskLocationReady" | "moveSession" | "installRetainedBrowserEvaluation" | "getForceTool" | "cancelForceTool"> {
  readonly workerPid: number;
  readonly workerFailure: WorkerFailure | undefined;
  readonly activity: NativeSessionActivity;
  getMessages(): Promise<TranscriptMessage[]>;
  getSessionActivity(): Promise<NativeSessionActivity>;
  getForceTool(): Promise<ForceToolState>;
  cancelForceTool(input: { ticket: ForceToolTicket; directiveId: string }): Promise<ForceToolCancelResult>;
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
  getQueuedMessages(): Promise<import("../../../../packages/shared/src/queued-messages").NativeQueuedMessagesSnapshot>;
  mutateQueuedMessages(mutation: import("../../../../packages/shared/src/queued-messages").NativeQueuedMessageMutation): Promise<import("../../../../packages/shared/src/queued-messages").NativeQueuedMessageMutationReceipt>;
  assertTaskLocationReady(): Promise<void>;
  moveSession(cwd: string): Promise<{ id: string; cwd: string; sessionFile: string }>;
  installBrowserContinuation(input: { sourceOwnerId: string; operationId: string; target: BrowserFrameTarget; kindTag: import("@agent-desktop/shared").NativeBrowserTabMetadata["kindTag"] }, evaluation: WorkerBrowserEvaluation): Promise<void>;
  enableBrowserRecovery?(socketPath: string, token: string, instanceId: string): Promise<WorkerReconnectEndpoint>;
  startBtw(input: NativeBtwStart): Promise<NativeBtwSnapshot>;
  cancelBtw(runId: string): Promise<NativeBtwSnapshot | null>;
  getBrowserMetadata(): Promise<BrowserMetadataAvailability>;
  getBrowserHistory?(target: BrowserFrameTarget): Promise<BrowserHistoryEntry[]>;
  createBrowserTab(name: string, initialUrl?: string): Promise<OmpBrowserTabCreateResult>;
  controlBrowser(request: BrowserControlRequest): Promise<{name: string; targetId: string; context: BrowserDocumentContext; url: string; title: string}>;
  getBrowserFrame(target: BrowserFrameTarget): Promise<NativeBrowserFrame>;
  closeBrowserTab(target: BrowserFrameTarget): Promise<WorkerBrowserCloseResult>;
  inspectBrowserTab(target: BrowserFrameTarget): Promise<WorkerBrowserObservation>;
  subscribe(listener: WorkerEventListener): () => void;
  subscribeWorkerFailure(listener: (failure: WorkerFailure) => void): () => void;
}
export interface WorkerMcpOwner {
  readonly id: string;
  readonly cwd: string;
  readonly workerPid: number;
  readonly workerFailure: WorkerFailure | undefined;
  read(): Promise<import("@agent-desktop/shared").NativeSessionMcpSnapshot>;
  request(request: import("@agent-desktop/shared").NativeMcpAppRequest): Promise<import("@agent-desktop/shared").NativeMcpAppResponse>;
  interactions(): Promise<import("@agent-desktop/shared").OmpInteraction[]>;
  respond(id: string, response: import("@agent-desktop/shared").OmpInteractionResponse): Promise<void>;
  subscribe(listener: WorkerEventListener): () => void;
  subscribeWorkerFailure(listener: (failure: WorkerFailure) => void): () => void;
  dispose(): Promise<void>;
}
export interface WorkerBrowserOwner extends Pick<WorkerSession, "workerPid" | "workerFailure" | "getBrowserMetadata" | "getBrowserHistory" | "createBrowserTab" | "controlBrowser" | "closeBrowserTab" | "inspectBrowserTab" | "getBrowserFrame" | "subscribeWorkerFailure" | "dispose"> {
  readonly id: string;
  readonly cwd: string;
  reserveBrowserEvaluation(target: BrowserFrameTarget, operationId: string): Promise<WorkerBrowserReservationStatus>;
  inspectBrowserEvaluationReservation(target: BrowserFrameTarget, operationId: string): Promise<WorkerBrowserReservationStatus | null>;
  openBrowserEvaluation(target: BrowserFrameTarget, operationId: string, backend: "cdp" | "cmux", timeoutMs: number): Promise<WorkerBrowserEvaluation>;
  enableBrowserRecovery?(socketPath: string, token: string, instanceId: string): Promise<WorkerReconnectEndpoint>;
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
  onProgress?: (message: string) => void;
  uncertainTransport?: "prompt-admission" | "queued-submission" | "question-resolution" | "mcp-authorization" | "force-cancel";
  evaluationDisposal?: boolean;
  evaluation?: { binding: BrowserEvaluationBinding; sequence: number };
  forceTool?: { commandId: string; capture(receipt: ForceToolReceipt): void };
}

/** Host-internal worker lifecycle client; exported for focused transport contract tests. */
export class WorkerClient {
  #process?: Bun.Subprocess<"ignore", "ignore", "ignore">;
  #socket?: { send(value: unknown): void; close(): void };
  #socketOutbox: ParentMessage[] = [];
  #pid = 0;
  #reconnectEndpoint?: WorkerReconnectEndpoint;
  #holdRetained = false;
  #retainedInbox: ChildMessage[] = [];
  #closed = Promise.withResolvers<{ exitCode?: number | null; signalCode?: number | null }>();
  #ready = Promise.withResolvers<void>();
  #pending = new Map<string, Pending>();
  #requestId = 0;
  #disposeId?: string;
  #disposeAcknowledged = false;
  #requireDisposeAcknowledgement = false;
  #closing = false;
  #closeCall?: Promise<void>;
  #options: WorkerRuntimeOptions;
  #readyDeadline: ReturnType<typeof setTimeout>;
  #events = new Set<WorkerEventListener>();
  #failures = new Set<(failure: WorkerFailure) => void>();
  #evaluationRoutes = new Map<string, { post: (frame: BrowserEvaluationFrame) => void; lost: (error: unknown) => void }>();
  #evaluationDisposals = new Map<string, Promise<unknown>>();
  #retainedEvaluations = new Map<string, { binding: BrowserEvaluationBinding; evaluation: WorkerBrowserEvaluation }>();
  snapshot?: SessionSnapshot;
  failure?: WorkerFailure;

  constructor(options: WorkerRuntimeOptions, environment = options.environment, startupDirectory?: string,
    recover?: WorkerReconnectEndpoint) {
    this.#options = options;
    if (options.onWorkerFailure) this.#failures.add(options.onWorkerFailure);
    if (recover) {
      this.#pid = recover.pid; this.#reconnectEndpoint = recover;
      this.#holdRetained = true;
      this.#readyDeadline = setTimeout(() => this.#fail("OMP worker reconnect timed out", recover.pid), options.startupTimeoutMs ?? 30_000);
      void connectWorkerEndpoint(recover, value => this.#receive(value), error => {
        this.#closed.resolve({});
        if (!this.#closing) this.#fail("OMP worker reconnect transport closed", recover.pid);
      }).then(socket => {
        this.#socket = socket;
        for(const message of this.#socketOutbox.splice(0))socket.send(message);
      }, error => this.#fail(`OMP worker reconnect failed: ${error instanceof Error ? error.message : String(error)}`, recover.pid));
      void this.#ready.promise.catch(() => {});
      return;
    }
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
    const selectedAgentDir = options.agentDir || (environment ?? process.env).PI_CODING_AGENT_DIR;
    const agentDir = selectedAgentDir ? path.resolve(selectedAgentDir) : undefined;
    this.#readyDeadline = setTimeout(() => {
      this.#fail("OMP worker startup timed out");
      this.#process?.kill("SIGKILL");
    }, options.startupTimeoutMs ?? 30_000);
    try {
      this.#process = Bun.spawn({
        cmd: [executable, ...((environment ?? process.env).PI_DISABLE_DOTENV === "1" ? ["--no-env-file"] : []), path.resolve(workerPath)],
        cwd: startupDirectory,
        // Establish the selected directory and native profile before SDK imports run.
        env: { ...(environment ?? process.env), ...(startupDirectory ? { PWD: startupDirectory } : {}), ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}) },
        stdin: "ignore", stdout: "ignore", stderr: "ignore",
        serialization: "advanced",
        ipc: (message: unknown) => this.#receive(message),
        onExit: (child, exitCode, signalCode) => {
          this.#closed.resolve({ exitCode, signalCode });
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
            if (!this.#closing && !this.failure && !this.#reconnectEndpoint) {
              this.#fail("OMP worker IPC disconnected");
              this.#process?.kill("SIGKILL");
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

  get pid(): number { return this.#pid || this.#process?.pid || 0; }
  get reconnectEndpoint(): WorkerReconnectEndpoint|undefined{return this.#reconnectEndpoint;}

  #rejectPending(error: unknown): void {
    this.#ready.reject(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.#transportFailure(pending, error));
    }
    this.#pending.clear();
    // Terminal channel loss remains visible even during an intentional worker close.
    for (const route of [...this.#evaluationRoutes.values()]) {
      try { route.lost(error); } catch { /* The original process is already lost. */ }
    }
    this.#evaluationRoutes.clear();
    for (const record of this.#retainedEvaluations.values()) void record.evaluation.dispose().catch(() => {});
    this.#retainedEvaluations.clear();
  }

  #transportFailure(pending: Pending | undefined, error: unknown): unknown {
    if (pending?.evaluation) return Object.assign(new Error("Original cmux request delivery is unknown; do not replay the operation.", { cause: error }), { code: "OUTCOME_UNKNOWN" as const });
    if (pending?.uncertainTransport === "mcp-authorization") return Object.assign(new Error("MCP authorization delivery is unknown. Inspect its current state before acting again."), {code:"OUTCOME_UNKNOWN"});
    if (pending?.uncertainTransport === "prompt-admission") return new OmpPromptAdmissionError(error);
    if (pending?.uncertainTransport === "queued-submission") return Object.assign(new Error("Queued submission delivery is unknown. Inspect its durable receipt before retrying.", { cause: error }), { code: "OUTCOME_UNKNOWN" as const });
    if (pending?.uncertainTransport === "question-resolution") return new DetachedQuestionOutcomeUnknown(error);
    if (pending?.uncertainTransport === "force-cancel") return Object.assign(new Error("Native force cancellation delivery is unknown. Inspect the live queue before retrying.", { cause: error }), { code: "OUTCOME_UNKNOWN" as const });
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
    if (this.#holdRetained && (message.type === "retainedBrowserFrame" || message.type === "retainedBrowserRequest" || message.type === "browserEvaluationFrame")) {
      if (this.#retainedInbox.length >= 256) { this.#fail("OMP worker retained-browser reconnect backlog exceeded its bound", this.pid); return; }
      this.#retainedInbox.push(message); return;
    }
    if (message.type === "ready") {
      if (message.version !== WORKER_PROTOCOL_VERSION) {
        this.#fail("OMP worker protocol version mismatch");
        this.#process?.kill("SIGKILL");
      } else { clearTimeout(this.#readyDeadline); this.#ready.resolve(); }
      return;
    }
    if (message.type === "recovered") {
      if (message.version !== WORKER_PROTOCOL_VERSION || message.pid !== this.pid
        || message.instanceId !== this.#reconnectEndpoint?.instanceId) this.#fail("OMP worker reconnect identity changed", this.pid);
      else { this.snapshot = message.snapshot; clearTimeout(this.#readyDeadline); this.#ready.resolve(); }
      return;
    }
    if (message.type === "fatal") {
      this.#fail(`OMP worker failed: ${message.error.message}`);
      return;
    }
    if (message.type === "browserEvaluationFrame") {
      let route: { post: (frame: BrowserEvaluationFrame) => void; lost: (error: unknown) => void } | undefined;
      try {
        const binding = copyEvaluationBinding(message.binding);
        if (binding.workerPid !== this.pid) throw new Error("Browser evaluation frame belongs to a different worker.");
        route = this.#evaluationRoutes.get(evaluationKey(binding));
        if (route) route.post(message.frame);
      } catch (error) {
        // A channel callback failure must not kill the original browser owner.
        route?.lost(error);
      }
      return;
    }
    if (message.type === "retainedBrowserFrame") {
      try {
        const binding = copyEvaluationBinding(message.binding), record = this.#retainedEvaluations.get(evaluationKey(binding));
        if (!record || record.evaluation.backend !== "cdp") throw new Error("Retained CDP source is unavailable.");
        record.evaluation.receive(copyEvaluationFrame(message.frame));
      } catch { /* Destination cleanup observes terminal channel failure. */ }
      return;
    }
    if (message.type === "retainedBrowserRequest") {
      const binding = copyEvaluationBinding(message.binding), record = this.#retainedEvaluations.get(evaluationKey(binding));
      if (!record || record.evaluation.backend !== "cmux") {
        try { this.#send({ type: "retainedBrowserResponse", binding, id: message.id, ok: false, error: { name: "Error", message: "Retained cmux source is unavailable." } }); } catch {}
        return;
      }
      void record.evaluation.request(message.method, copyEvaluationValue(message.params), message.options).then(
        value => this.#send({ type: "retainedBrowserResponse", binding, id: message.id, ok: true, value: copyEvaluationValue(value) }),
        error => this.#send({ type: "retainedBrowserResponse", binding, id: message.id, ok: false, error: remoteError(error) }),
      ).catch(() => {});
      return;
    }
    if (message.type === "commitProgress") {
      try {
        if (typeof message.message !== "string" || message.message.length > 4096) throw new Error("Invalid commit progress");
        this.#pending.get(message.id)?.onProgress?.(message.message);
      } catch {
        this.#fail("The host could not consume commit-generation progress");
        this.#process?.kill("SIGKILL");
      }
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
        this.#process?.kill("SIGKILL");
      }
      return;
    }
    if (message.type === "response") {
      const key = message.phase ? `${message.id}:${message.phase}` : message.id;
      const pending = this.#pending.get(key);
      if (!pending) return;
      this.#pending.delete(key);
      clearTimeout(pending.timeout);
      let responseValue = message.value;
      let forceToolReceipt: ForceToolReceipt | undefined;
      try {
        if (message.forceToolReceipt !== undefined) {
          if (!pending.forceTool) throw new Error("Unsolicited force-tool receipt");
          forceToolReceipt = parseForceToolReceipt(message.forceToolReceipt, pending.forceTool.commandId);
          pending.forceTool.capture(forceToolReceipt);
        }
      } catch (cause) {
        pending.reject(this.#transportFailure(pending, new Error("OMP worker returned an invalid force-tool receipt.", { cause })));
        return;
      }
      if (pending.evaluation) {
        try {
          if (!message.evaluation || evaluationKey(message.evaluation.binding) !== evaluationKey(pending.evaluation.binding)
            || message.evaluation.sequence !== pending.evaluation.sequence) throw new Error("Original cmux response receipt changed.");
          if (typeof message.ok !== "boolean" || !message.ok && (!message.error || typeof message.error.message !== "string" || typeof message.error.name !== "string")) throw new Error("Invalid original cmux response.");
          if (message.ok) responseValue = copyEvaluationValue(message.value);
          // A retained, identity-checked response is now owned by this client. An
          // orphan response never reaches this branch and receives no delivery ACK.
          this.#send({ type: "browserEvaluationAck", ...pending.evaluation });
        } catch (cause) {
          pending.reject(Object.assign(new Error("Original browser evaluation response delivery is unknown.", { cause }), { code: "OUTCOME_UNKNOWN" }));
          return;
        }
      }
      if (message.id === this.#disposeId) {
        // A successful process exit alone cannot prove native disposal. Receipt
        // of this exact response authorizes the child's final exit handshake.
        try {
          this.#send({ type: "disposeAck", id: message.id });
          this.#disposeAcknowledged = true;
        } catch (error) { pending.reject(error); return; }
      }
      if (message.ok) pending.resolve(responseValue);
      else {
        const error = new Error(message.error?.message ?? "OMP worker operation failed");
        error.name = message.error?.name ?? "Error";
        if (message.error?.code === "OUTCOME_UNKNOWN") Object.assign(error, { code: "OUTCOME_UNKNOWN" });
        if (forceToolReceipt) Object.assign(error, { forceToolReceipt: { ...forceToolReceipt } });
        pending.reject(error);
      }
    }
  }

  #send(message: ParentMessage): void {
    if (this.failure) throw new WorkerFailureError(this.failure);
    if (this.#socket) this.#socket.send(message);
    else if (this.#process) this.#process.send(message);
    else if(this.#reconnectEndpoint){if(this.#socketOutbox.length>=128)throw new Error("OMP worker reconnect command backlog exceeded its bound");this.#socketOutbox.push(message);}
    else throw new Error("OMP worker reconnect transport is not ready.");
  }

  async enableReconnect(socketPath: string, token: string, instanceId: string): Promise<WorkerReconnectEndpoint> {
    const endpoint = await this.request<WorkerReconnectEndpoint>({ operation: "enableReconnect", args: { socketPath, token, instanceId } }, 15_000);
    if (endpoint.version !== 1 || endpoint.pid !== this.pid || !endpoint.instanceId
      || endpoint.socketPath !== socketPath || endpoint.token !== token || endpoint.instanceId !== instanceId)
      throw new Error("OMP worker reconnect endpoint changed during admission.");
    this.#reconnectEndpoint = Object.freeze({ ...endpoint });
    return this.#reconnectEndpoint;
  }

  static async recover(options: WorkerRuntimeOptions, endpoint: WorkerReconnectEndpoint): Promise<WorkerClient> {
    const client = new WorkerClient(options, undefined, undefined, endpoint);
    await client.#ready.promise;
    return client;
  }

  #promise<T>(key: string, timeoutMs?: number, uncertainTransport?: Pending["uncertainTransport"], evaluationDisposal = false): Promise<T> {
    const regular = [...this.#pending.entries()].filter(([id, item]) => !item.evaluationDisposal && id !== this.#disposeId).length;
    if (regular >= 128 && key !== this.#disposeId && !evaluationDisposal) throw new Error("OMP worker request limit reached");
    const deferred = Promise.withResolvers<T>();
    const pending: Pending = {
      resolve: value => deferred.resolve(value as T), reject: deferred.reject, uncertainTransport, evaluationDisposal,
    };
    if (timeoutMs) pending.timeout = setTimeout(() => {
      this.#pending.delete(key);
      deferred.reject(this.#transportFailure(pending, new Error("OMP worker operation timed out; its outcome may be unknown")));
    }, timeoutMs);
    this.#pending.set(key, pending);
    void deferred.promise.catch(() => {});
    return deferred.promise;
  }

  async request<T>(operation: WorkerOperation, timeoutMs?: number, uncertainTransport?: Pending["uncertainTransport"], onProgress?: (message: string) => void): Promise<T> {
    await this.#ready.promise;
    if (this.failure) throw new WorkerFailureError(this.failure);
    const evaluationDisposal = operation.operation === "disposeBrowserEvaluation";
    if (this.#closing && operation.operation !== "dispose" && !evaluationDisposal) throw new Error("OMP worker is closing");
    let evaluationDisposalKey: string | undefined;
    if (evaluationDisposal) {
      if (operation.args.binding.workerPid !== this.pid) throw new Error("Browser evaluation disposal belongs to a different worker.");
      evaluationDisposalKey = evaluationKey(operation.args.binding);
      const prior = this.#evaluationDisposals.get(evaluationDisposalKey);
      if (prior) return prior as Promise<T>;
      if (this.#evaluationDisposals.size >= 64) throw new Error("Browser evaluation disposal limit reached.");
    }
    const evaluation = operation.operation === "requestBrowserEvaluation"
      ? { binding: copyEvaluationBinding(operation.args.binding), sequence: operation.args.sequence } : undefined;
    if (evaluation && (evaluation.binding.workerPid !== this.pid || !Number.isSafeInteger(evaluation.sequence) || evaluation.sequence < 1)) throw new Error("Invalid original cmux request identity.");
    const id = String(++this.#requestId);
    if (operation.operation === "dispose") {
      if (this.#disposeId) throw new Error("OMP worker disposal has already been requested");
      this.#disposeId = id;
    }
    const response = this.#promise<T>(id, evaluationDisposal ? undefined : timeoutMs, uncertainTransport, evaluationDisposal);
    if (evaluationDisposalKey) this.#evaluationDisposals.set(evaluationDisposalKey, response);
    if (evaluation) this.#pending.get(id)!.evaluation = evaluation;
    if (onProgress) this.#pending.get(id)!.onProgress = onProgress;
    try { this.#send({ type: "request", id, ...operation }); }
    catch (error) {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      clearTimeout(pending?.timeout);
      pending?.reject(this.#transportFailure(pending, error));
    }
    return response;
  }

  subscribeBrowserEvaluation(binding: BrowserEvaluationBinding, post: (frame: BrowserEvaluationFrame) => void,
    lost: (error: unknown) => void): () => void {
    const captured = copyEvaluationBinding(binding), key = evaluationKey(captured);
    if (captured.workerPid !== this.pid) throw new Error("Browser evaluation belongs to a different worker.");
    if (this.#evaluationRoutes.has(key)) throw new Error("Browser evaluation already has an IPC receiver.");
    if (this.#evaluationRoutes.size >= 64) throw new Error("Browser evaluation receiver limit reached.");
    const route = { post, lost };
    this.#evaluationRoutes.set(key, route);
    if (this.failure) lost(new WorkerFailureError(this.failure));
    return () => { if (this.#evaluationRoutes.get(key) === route) this.#evaluationRoutes.delete(key); };
  }

  postBrowserEvaluationFrame(binding: BrowserEvaluationBinding, frame: BrowserEvaluationFrame): void {
    const captured = copyEvaluationBinding(binding);
    if (captured.workerPid !== this.pid || !this.#evaluationRoutes.has(evaluationKey(captured))) throw new Error("Original browser evaluation route is unavailable.");
    // Native ACKs are forwarded unchanged. Closing retains terminal/control delivery.
    this.#send({ type: "browserEvaluationFrame", binding: captured, frame: copyEvaluationFrame(frame) });
  }

  async installRetainedBrowserEvaluation(input: { binding: BrowserEvaluationBinding; kindTag: import("@agent-desktop/shared").NativeBrowserTabMetadata["kindTag"]; safeDir: string }, evaluation: WorkerBrowserEvaluation): Promise<void> {
    const binding = copyEvaluationBinding(input.binding), key = evaluationKey(binding);
    if (this.#retainedEvaluations.has(key) || evaluation.backend !== binding.backend) throw new Error("Invalid retained browser evaluator installation.");
    const record = { binding, evaluation }; this.#retainedEvaluations.set(key, record);
    try {
      await this.request({ operation: "prepareRetainedBrowserEvaluation", args: { binding, kindTag: input.kindTag, safeDir: input.safeDir,
        descriptor: evaluation.backend === "cdp" ? { binding, backend: "cdp", descriptor: { ...evaluation.descriptor } }
          : { binding, backend: "cmux", state: copyEvaluationValue(evaluation.state) } } }, 30_000);
      if (evaluation.backend === "cdp") await evaluation.start(frame => {
        if (this.#retainedEvaluations.get(key) === record) this.#send({ type: "retainedBrowserFrame", binding, frame: copyEvaluationFrame(frame) });
      });
      await this.request({ operation: "activateRetainedBrowserEvaluation", args: { binding } }, 60_000);
      // Activation is the destination's startup boundary. Its response follows
      // every startup frame forwarded to the source. The new session is not yet
      // published to prompt, heartbeat, or guest callers, so this joins only
      // that closed startup set before exposing a restart-recoverable binding.
      await evaluation.waitForIdle(15_000);
    } catch (error) {
      if (this.#retainedEvaluations.get(key) === record) this.#retainedEvaluations.delete(key);
      await this.request({operation:"disposeRetainedBrowserEvaluation",args:{binding}},30_000).catch(()=>{});
      await evaluation.dispose().catch(() => {});
      throw error;
    }
  }

  async recoverBrowserEvaluation(binding: BrowserEvaluationBinding): Promise<WorkerBrowserEvaluation> {
    const state = await this.request<{ descriptor: import("../omp-browser/evaluation-wire").BrowserEvaluationDescriptor; started: boolean; sequence: number; pending: number; unacknowledged: number }>(
      { operation: "inspectOpenBrowserEvaluation", args: { binding } }, 15_000);
    if (state.pending || state.unacknowledged) throw Object.assign(new Error("A browser operation was in flight when the host disconnected; inspect before continuing."), { code: "OUTCOME_UNKNOWN" as const });
    if (state.descriptor.backend === "cdp" && !state.started) throw new Error("Recovered CDP evaluation was not active.");
    return recoverWorkerBrowserEvaluation(this, state.descriptor, state.sequence);
  }

  async recoverRetainedBrowserEvaluation(input: { binding: BrowserEvaluationBinding }, evaluation: WorkerBrowserEvaluation): Promise<void> {
    const binding = copyEvaluationBinding(input.binding), key = evaluationKey(binding);
    if (this.#retainedEvaluations.has(key) || binding.backend !== evaluation.backend) throw new Error("Recovered retained browser evaluator changed.");
    const record = { binding, evaluation }; this.#retainedEvaluations.set(key, record);
    if (evaluation.backend === "cdp") await evaluation.start(frame => {
      if (this.#retainedEvaluations.get(key) === record) this.#send({ type: "retainedBrowserFrame", binding, frame: copyEvaluationFrame(frame) });
    });
  }

  async assertRecoveredRetainedBrowserIdle(binding: BrowserEvaluationBinding): Promise<void> {
    const state=await this.request<{pending:number;bufferedFrames:number}>({operation:"inspectRetainedBrowserEvaluation",args:{binding}},15_000);
    if(state.pending||state.bufferedFrames)throw Object.assign(new Error("A retained browser operation was in flight when the host disconnected; its outcome is unknown."),{code:"OUTCOME_UNKNOWN" as const});
  }

  resumeRecoveredBrowserTraffic(): void {
    this.#holdRetained = false;
    const inbox = this.#retainedInbox.splice(0);
    for (const message of inbox) this.#receive(message);
  }

  startPrompt(text: string, options?: Parameters<OmpSession["startPrompt"]>[1]): OmpPromptRun {
    if (this.failure) throw new WorkerFailureError(this.failure);
    if (this.#closing) throw new Error("OMP worker is closing");
    if (this.#pending.size > 125) throw new Error("OMP worker request limit reached");
    if ((options?.images?.length || options?.selectedText?.attachments?.length || options?.wholeFiles?.attachments?.length) && (this.snapshot?.isStreaming || this.snapshot?.hasPostPromptWork || [...this.#pending.keys()].some(key => key.endsWith(":completion")))) {
      throw new Error("OMP session is busy; attached content was not dispatched");
    }
    const forceFields = parseForceToolPromptFields(options ?? {});
    const forceOperation = forceFields.forceTool !== undefined || forceFields.forceRecovery !== undefined;
    const commandId = options?.commandId === undefined ? undefined
      : forceOperation ? parseForceToolCommandId(options.commandId) : options.commandId;
    if (forceOperation && (commandId === undefined || options?.commandVersion !== 18))
      throw new Error("Force-tool prompt admission requires command version 18 and its original command identity.");
    const preparedOptions = options ? { ...options, ...forceFields, ...(commandId === undefined ? {} : { commandId }), images: copyPreparedImages(options.images), selectedText: copyNativeSelectedTextInput(options.selectedText), wholeFiles: copyNativeWholeFileInput(options.wholeFiles, text.length) } : undefined;
    const id = String(++this.#requestId);
    let forceToolReceipt: ForceToolReceipt | undefined;
    const acceptedKey = `${id}:accepted`;
    const accepted = this.#promise<Awaited<OmpPromptRun["accepted"]>>(acceptedKey, undefined, Boolean(preparedOptions?.forceTool || preparedOptions?.forceRecovery || preparedOptions?.images?.length || preparedOptions?.selectedText?.attachments.length || preparedOptions?.wholeFiles?.attachments.length) || text.trimStart().startsWith("/") || text.includes("/skill:") ? "prompt-admission" : undefined);
    const completion = this.#promise<boolean>(`${id}:completion`);
    if (preparedOptions?.commandId !== undefined) this.#pending.get(acceptedKey)!.forceTool = {
      commandId: preparedOptions.commandId,
      capture: receipt => { forceToolReceipt = { ...receipt }; },
    };
    try { this.#send({ type: "request", id, operation: "startPrompt", args: { text, options: preparedOptions } }); }
    catch (error) {
      for (const phase of ["accepted", "completion"]) {
        const key = `${id}:${phase}`;
        const pending = this.#pending.get(key);
        pending?.reject(this.#transportFailure(pending, error));
        this.#pending.delete(key);
      }
    }
    return { accepted, completion, get forceToolReceipt() { return forceToolReceipt && { ...forceToolReceipt }; } };
  }

  startFollowUp(text: string, delivery: import("@agent-desktop/shared").FollowUpDelivery,
    expectedApprovalMode?: import("@agent-desktop/shared").OmpApprovalMode, images?: import("../omp/images").PreparedPromptImage[]): import("../omp/steer").OmpQueuedSubmissionRun {
    if (this.failure) throw new WorkerFailureError(this.failure);
    if (this.#closing) throw new Error("OMP worker is closing");
    if (this.#pending.size > 125) throw new Error("OMP worker request limit reached");
    const prepared = copyPreparedImages(images);
    const id = String(++this.#requestId);
    const accepted = this.#promise<{ kind: "queued"; delivery: import("@agent-desktop/shared").FollowUpDelivery }>(`${id}:accepted`, undefined, "queued-submission");
    const completion = this.#promise<import("../omp/steer").OmpSteerReceipt>(`${id}:completion`);
    try { this.#send({ type: "request", id, operation: "startFollowUp", args: { text, delivery, expectedApprovalMode, ...(prepared === undefined ? {} : { images: prepared }) } }); }
    catch (error) {
      for (const phase of ["accepted", "completion"] as const) {
        const key = `${id}:${phase}`, pending = this.#pending.get(key);
        pending?.reject(this.#transportFailure(pending, error)); this.#pending.delete(key);
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

  close(options: { requireAcknowledgement?: boolean } = {}): Promise<void> {
    if (options.requireAcknowledgement) this.#requireDisposeAcknowledgement = true;
    if (this.#closeCall) return this.#closeCall.then(() => {
      if (options.requireAcknowledgement && !this.#disposeAcknowledged) throw new Error("OMP worker closed without required disposal acknowledgement");
    });
    this.#closing = true;
    this.#closeCall = (async () => {
      const deadline = setTimeout(() => { if (this.#process) this.#process.kill("SIGKILL"); else { try { process.kill(this.pid, "SIGKILL"); } catch {} } }, this.#options.shutdownTimeoutMs ?? 15_000);
      try {
        if (!this.failure && (!this.#process || this.#process.exitCode === null)) {
          await this.request({ operation: "dispose" }, this.#options.shutdownTimeoutMs ?? 15_000);
        }
        const closed = this.#process ? { exitCode: await this.#process.exited, signalCode: this.#process.signalCode } : await this.#closed.promise;
        const exitCode = closed.exitCode;
        if (this.#requireDisposeAcknowledgement && !this.#disposeAcknowledged) {
          throw new Error(`OMP worker exited before required disposal acknowledgement (code ${exitCode ?? "unknown"}, signal ${closed.signalCode ?? "none"})`);
        }
        if (this.#disposeAcknowledged && exitCode !== undefined && exitCode !== 0) {
          throw new Error(`OMP worker exited unsuccessfully after disposal acknowledgement (code ${exitCode}, signal ${closed.signalCode ?? "none"})`);
        }
      } finally {
        clearTimeout(deadline);
        // Failed startup/disposal must not orphan a file-owning child.
        if (this.#process?.exitCode === null) { this.#process.kill("SIGKILL"); await this.#process.exited; }
        this.#socket?.close();
        this.#events.clear(); this.#failures.clear();
        this.#rejectPending(new Error("OMP worker closed"));
      }
    })();
    return this.#closeCall;
  }

  /** Drops only this host process's transport ownership. The promoted native
   * worker and browser channels remain alive behind their exact endpoint. */
  detachForRecovery():void{
    if(!this.#reconnectEndpoint)throw new Error("OMP worker has no recovery endpoint");
    if(this.#closing)return;
    this.#closing=true;
    const error=Object.assign(new Error("Host detached from the retained browser worker; request outcome is unknown."),{code:"OUTCOME_UNKNOWN" as const});
    this.#ready.reject(error);
    for(const pending of this.#pending.values()){clearTimeout(pending.timeout);pending.reject(this.#transportFailure(pending,error));}
    this.#pending.clear();this.#evaluationRoutes.clear();this.#retainedEvaluations.clear();
    this.#events.clear();this.#failures.clear();
    this.#socket?.close();this.#socket=undefined;
    try{(this.#process as unknown as {disconnect?():void}|undefined)?.disconnect?.();}catch{/* Process exit also closes IPC. */}
    this.#process=undefined;
  }

  abandonRecoveryAttempt():void{
    if(!this.#reconnectEndpoint||this.#process)throw new Error("Only a recovered worker connection can be abandoned.");
    if(this.#closing)return;
    this.#closing=true;this.#socket?.close();this.#socket=undefined;
    const error=Object.assign(new Error("Browser worker recovery did not complete; native ownership was preserved."),{code:"OUTCOME_UNKNOWN" as const});
    this.#ready.reject(error);for(const pending of this.#pending.values()){clearTimeout(pending.timeout);pending.reject(this.#transportFailure(pending,error));}
    this.#pending.clear();this.#evaluationRoutes.clear();this.#retainedEvaluations.clear();this.#events.clear();this.#failures.clear();
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

  constructor(options: WorkerRuntimeOptions = {}) { this.#options = { ...options, agentDir: options.agentDir ? path.resolve(options.agentDir) : undefined }; }

  #assertActive(): void { if (this.#disposed) throw new Error("OMP worker runtime is disposed"); }

  #track<T>(pending: Promise<T>): Promise<T> {
    this.#setups.add(pending);
    const remove = () => { this.#setups.delete(pending); };
    void pending.then(remove, remove);
    return pending;
  }

  async #spawn(init: WorkerInit, onEvent?: WorkerEventListener, localEnvironment?: LocalEnvironmentWorkerEnvironment, signal?: AbortSignal): Promise<WorkerClient> {
    this.#assertActive();
    signal?.throwIfAborted();
    const worktreeRoot = localEnvironment?.worktreeRoot;
    const environment = localEnvironment
      ? localEnvironmentForWorker(this.#options.environment ?? process.env, localEnvironment)
      : { ...(this.#options.environment ?? process.env) };
    const browserOwnerId = init.mode === "browser" ? init.owner.id : undefined;
    const mcpOwnerId = init.mode === "mcp-owner" ? init.owner.id : undefined;
    const options = init.mode === "mcp-owner" && this.#options.onWorkerFailure
      ? { ...this.#options, onWorkerFailure: (failure: WorkerFailure) => this.#options.onWorkerFailure?.({ ...failure, mcpOwnerId }) }
      : init.mode === "browser" && this.#options.onWorkerFailure
      ? { ...this.#options, onWorkerFailure: (failure: WorkerFailure) => this.#options.onWorkerFailure?.({ ...failure, browserOwnerId }) }
      : this.#options;
    let startupDirectory: string | undefined;
    if (init.mode === "create") {
      startupDirectory = await requireDirectory(init.options.cwd);
      init = { ...init, options: { ...init.options, cwd: startupDirectory } };
    } else if (init.mode === "browser" || init.mode === "mcp-owner") startupDirectory = init.owner.cwd;
    else if (init.mode === "open") startupDirectory = init.options.expectedIdentity?.directory;
    if (worktreeRoot && startupDirectory && await requireDirectory(worktreeRoot) !== startupDirectory) {
      throw new Error("OMP worker directory does not match its prepared worktree environment");
    }
    this.#assertActive();
    signal?.throwIfAborted();
    const client = new WorkerClient(options, environment, startupDirectory);
    this.#clients.add(client);
    const cancel = () => { void client.close().catch(() => {}); };
    signal?.addEventListener("abort", cancel, { once: true });
    if (onEvent) client.subscribe(onEvent);
    try {
      const initialized = await client.request<{ ownerId?: string; cwd?: string } | undefined>({ operation: "init", args: init }, this.#options.startupTimeoutMs ?? 30_000);
      signal?.throwIfAborted();
      this.#assertActive();
      if ((init.mode === "create" || init.mode === "open") && !client.snapshot) throw new Error("OMP worker did not return native session metadata");
      if (init.mode === "create" && client.snapshot!.cwd !== init.options.cwd) throw new Error("OMP worker initialization changed working directory");
      if (init.mode === "open" && (client.snapshot!.id !== init.options.expectedIdentity?.id || client.snapshot!.cwd !== init.options.expectedIdentity.cwd)) throw new Error("OMP worker initialization changed session identity");
      if ((init.mode === "browser" || init.mode === "mcp-owner") && (client.snapshot || initialized?.ownerId !== init.owner.id || initialized.cwd !== init.owner.cwd)) throw new Error("OMP browser owner initialization changed identity");
      return client;
    } catch (error) {
      try { await client.close(); } finally { this.#clients.delete(client); }
      if (signal?.aborted) throw signal.reason;
      throw error;
    } finally { signal?.removeEventListener("abort", cancel); }
  }

  /** One disposable owned process per generation; it never creates a chat session. */
  generateCommit(input: CommitGenerationInput, options: { signal?: AbortSignal; onProgress?: (message: string) => void } = {}): Promise<import("./protocol").CommitGenerationResult> {
    this.#assertActive();
    const request = { ...input }, { signal, onProgress } = options;
    return this.#track((async () => {
      signal?.throwIfAborted();
      const client = await this.#spawn({ mode: "discovery", agentDir: this.#options.agentDir }, undefined, undefined, signal);
      const cancel = () => { void client.close().catch(() => {}); };
      signal?.addEventListener("abort", cancel, { once: true });
      let generationCompleted = false;
      try {
        signal?.throwIfAborted();
        const result = await client.request<import("./protocol").CommitGenerationResult>({ operation: "generateCommit", args: request }, undefined, undefined, onProgress);
        signal?.throwIfAborted();
        generationCompleted = true;
        return result;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancel);
        try { await client.close({ requireAcknowledgement: generationCompleted }); } finally { this.#clients.delete(client); }
      }
    })());
  }

  /** Whole-history copy owns a fresh process; it never switches the retained source. */
  forkSession(input: NativeSessionForkInput): Promise<NativeSessionForkResult> {
    this.#assertActive();
    return this.#track((async () => {
      const client = await this.#spawn({ mode: "discovery", agentDir: this.#options.agentDir });
      let copied = false;
      try {
        const result = await client.request<NativeSessionForkResult>({ operation: "forkSession", args: input });
        copied = true;
        return result;
      } finally {
        try { await client.close({ requireAcknowledgement: copied }); } finally { this.#clients.delete(client); }
      }
    })());
  }

  create(options: Omit<OmpSessionOptions, "onEvent"> & { onEvent?: WorkerEventListener }, localEnvironment?: LocalEnvironmentWorkerEnvironment): Promise<WorkerSession> {
    this.#assertActive();
    const { onEvent, ...nativeOptions } = options;
    if (nativeOptions.sessionDirectory) nativeOptions.sessionDirectory = path.resolve(nativeOptions.sessionDirectory);
    return this.#track((async () => {
      const client = await this.#spawn({ mode: "create", agentDir: this.#options.agentDir, options: nativeOptions }, onEvent, localEnvironment);
      return this.#handle(client);
    })());
  }

  open(options: Omit<OmpOpenOptions, "onEvent"> & { onEvent?: WorkerEventListener }, localEnvironment?: LocalEnvironmentWorkerEnvironment): Promise<WorkerSession> {
    this.#assertActive();
    const { onEvent, ...capturedOptions } = options;
    return this.#track((async () => {
      const sessionFile = await realpath(capturedOptions.sessionFile);
      this.#assertActive();
      if (this.#openFiles.has(sessionFile)) throw new Error("OMP session is already open in this worker runtime");
      this.#openFiles.add(sessionFile);
      try {
        const header = await readSessionHeader(sessionFile);
        if (!path.isAbsolute(header.cwd)) throw new Error("Native session working directory must be absolute before worker startup");
        const directory = await requireDirectory(header.cwd);
        const expectedIdentity = { ...header, directory };
        const client = await this.#spawn({ mode: "open", agentDir: this.#options.agentDir, options: { sessionFile, expectedIdentity, interactions: capturedOptions.interactions, approvalOverride: capturedOptions.approvalOverride } }, onEvent, localEnvironment);
        return this.#handle(client);
      } catch (error) { this.#openFiles.delete(sessionFile); throw error; }
    })());
  }

  /** Reconnects the exact two native processes retained by a browser handoff.
   * No session open, browser open, evaluation open, or retained install is replayed. */
  recoverBrowserContinuation(input: { source: WorkerReconnectEndpoint; destination: WorkerReconnectEndpoint;
    bindings: readonly BrowserEvaluationBinding[]; sessionId: string; onEvent?: WorkerEventListener }): Promise<{ session: WorkerSession; closeSource(): Promise<void> }> {
    this.#assertActive();
    return this.#track((async () => {
      const attempts=await Promise.allSettled([WorkerClient.recover(this.#options,input.source),WorkerClient.recover(this.#options,input.destination)]);
      for(const attempt of attempts)if(attempt.status==="fulfilled")this.#clients.add(attempt.value);
      if(attempts[0]!.status==="rejected"||attempts[1]!.status==="rejected"){
        for(const attempt of attempts)if(attempt.status==="fulfilled"){attempt.value.abandonRecoveryAttempt();this.#clients.delete(attempt.value);}
        throw new AggregateError(attempts.flatMap(attempt=>attempt.status==="rejected"?[attempt.reason]:[]),"Browser worker recovery did not acquire both original processes.");
      }
      const source=attempts[0].value,destination=attempts[1].value;
      this.#clients.add(source); this.#clients.add(destination);
      try {
        if (!destination.snapshot || destination.snapshot.id !== input.sessionId) throw new Error("Recovered browser session identity changed.");
        if(destination.snapshot.isStreaming||destination.snapshot.hasPostPromptWork)
          throw Object.assign(new Error("The retained browser session had native work in flight when its host disconnected. Inspect its original command outcome before reopening."),{code:"OUTCOME_UNKNOWN" as const});
        if (input.onEvent) destination.subscribe(input.onEvent);
        for (const binding of input.bindings) {
          await destination.assertRecoveredRetainedBrowserIdle(binding);
          const evaluation = await source.recoverBrowserEvaluation(binding);
          await destination.recoverRetainedBrowserEvaluation({ binding }, evaluation);
        }
        source.resumeRecoveredBrowserTraffic(); destination.resumeRecoveredBrowserTraffic();
        const session = this.#handle(destination);
        let sourceClose: Promise<void> | undefined;
        return { session, closeSource: () => sourceClose ??= source.close().finally(() => this.#clients.delete(source)) };
      } catch (error) {
        source.abandonRecoveryAttempt();destination.abandonRecoveryAttempt();this.#clients.delete(source);this.#clients.delete(destination);
        throw error;
      }
    })());
  }

  /** Explicit native MCP lifetime; no synthetic conversation or model dispatch. */
  createMcpOwner(owner: { id: string; cwd: string }, options: { signal?: AbortSignal; onEvent?: WorkerEventListener } = {}): Promise<WorkerMcpOwner> {
    this.#assertActive();
    const input = { ...owner };
    return this.#track((async () => {
      const cwd = await requireDirectory(input.cwd);
      const client = await this.#spawn({ mode: "mcp-owner", owner: { id: input.id, cwd }, agentDir: this.#options.agentDir }, options.onEvent, undefined, options.signal);
      this.#assertActive();
      let closing: Promise<void> | undefined;
      return {
        id: input.id, cwd,
        get workerPid() { return client.pid; }, get workerFailure() { return client.failure; },
        read: () => client.request({ operation: "getMcpOwner" }),
        request: request => client.request({ operation: "mcpOwnerApp", args: { request } }, 40_000),
        interactions: () => client.request({ operation: "listMcpOwnerInteractions" }),
        respond: (id, response) => client.request({ operation: "respondMcpOwnerInteraction", args: { id, response } }),
        subscribe: listener => client.subscribe(listener), subscribeWorkerFailure: listener => client.subscribeFailure(listener),
        dispose: () => closing ??= client.close().finally(() => { this.#clients.delete(client); }),
      };
    })());
  }

  /** Internal host API. Admission and durable draft/request ownership remain with the caller. */
  createBrowserOwner(owner: { id: string; cwd: string }): Promise<WorkerBrowserOwner> {
    this.#assertActive();
    const input = { ...owner };
    return this.#track((async () => {
      const cwd = await requireDirectory(input.cwd);
      const client = await this.#spawn({ mode: "browser", owner: { id: input.id, cwd }, agentDir: this.#options.agentDir });
      this.#assertActive();
      let closing: Promise<void> | undefined;
      return {
        id: input.id, cwd,
        get workerPid() { return client.pid; }, get workerFailure() { return client.failure; },
        ...this.#browserControls(client, () => input.id),
        reserveBrowserEvaluation: async (target, operationId) => {
          const result = await requestWorkerBrowserReservation(client, input.id, target, operationId);
          if (!result) throw new Error("Browser reservation omitted its operation receipt.");
          return result;
        },
        inspectBrowserEvaluationReservation: (target, operationId) => requestWorkerBrowserReservation(client, input.id, target, operationId, true),
        openBrowserEvaluation: (target, operationId, backend, timeoutMs) => openWorkerBrowserEvaluation(client, input.id, target, operationId, backend, timeoutMs),
        enableBrowserRecovery: (socketPath, token, instanceId) => client.enableReconnect(socketPath, token, instanceId),
        subscribeWorkerFailure: listener => client.subscribeFailure(listener),
        dispose: () => closing ??= client.close().finally(() => { this.#clients.delete(client); }),
      };
    })());
  }

  #browserControls(client: WorkerClient, readOwnerId: () => string): Pick<WorkerSession, "getBrowserMetadata" | "getBrowserHistory" | "createBrowserTab" | "controlBrowser" | "closeBrowserTab" | "inspectBrowserTab" | "getBrowserFrame"> {
    return {
      getBrowserMetadata: async () => {
        const metadata = await client.request<BrowserMetadataAvailability>({ operation: "getBrowserMetadata" }, 15_000);
        if (metadata.availability === "running" && metadata.workerPid !== client.pid) return { availability: "unavailable", reason: "Native browser metadata came from a stale worker." };
        return metadata;
      },
      getBrowserHistory: target => {
        if (target.workerPid !== client.pid) return Promise.reject(new Error("The selected browser history belongs to a stale worker."));
        return client.request<BrowserHistoryEntry[]>({ operation: "getBrowserHistory", args: { target } }, 15_000);
      },
      // Native acquisition owns its configured finite timeout. Retain the IPC
      // request until it settles so a desktop timeout cannot release the host's
      // in-flight bound while creation may still be running.
      createBrowserTab: (name, initialUrl) => client.request<OmpBrowserTabCreateResult>({ operation: "createBrowserTab", args: { name, ...(initialUrl === undefined ? {} : { initialUrl }) } }),
      closeBrowserTab: target => requestWorkerBrowserClose(client, readOwnerId(), target),
      inspectBrowserTab: target => requestWorkerBrowserObservation(client, readOwnerId(), target),
      controlBrowser: request => client.request({ operation: "controlBrowser", args: { request } }, 15_000),
      getBrowserFrame: target => {
        if (target.workerPid !== client.pid) return Promise.reject(new Error("The selected browser frame belongs to a stale worker."));
        return client.request<NativeBrowserFrame>({ operation: "getBrowserFrame", args: { target } }, 15_000);
      },
    };
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
      sessionMcpApp: request => client.request({ operation: "sessionMcpApp", args: { request } }, 40_000),
      readSessionMcpResource: request => client.request({ operation: "readSessionMcpResource", args: { request } }, 35_000),
      getSessionMcp: () => client.request({ operation: "getSessionMcp" }, 15_000),
      startSessionMcpAuthorization: request => client.request({ operation: "startSessionMcpAuthorization", args: { request } }, 15_000, "mcp-authorization"),
      getSessionMcpAuthorization: () => client.request({ operation: "getSessionMcpAuthorization" }, 15_000),
      respondSessionMcpAuthorization: request => client.request({ operation: "respondSessionMcpAuthorization", args: { request } }, 15_000, "mcp-authorization"),
      cancelSessionMcpAuthorization: authorizationId => client.request({ operation: "cancelSessionMcpAuthorization", args: { authorizationId } }, 15_000, "mcp-authorization"),
      reloadSessionMcp: request => client.request({ operation: "reloadSessionMcp", args: { request } }, 120_000),
      reconnectSessionMcp: request => client.request({ operation: "reconnectSessionMcp", args: { request } }, 120_000),
      flushSession: () => client.request({ operation: "flushSession" }),
      getBtw: () => client.request({ operation: "getBtw" }, 15_000),
      startBtw: input => client.request({ operation: "startBtw", args: input }, 15_000),
      cancelBtw: runId => client.request({ operation: "cancelBtw", args: { runId } }, 15_000),
      promoteBtw: async (runId, operationId) => {
        try { return await client.request<{ cancelled: boolean; sessionId: string; sessionFile: string }>({ operation: "promoteBtw", args: { runId, operationId } }); }
        finally { if (client.snapshot?.sessionFile) { const file = path.resolve(client.snapshot.sessionFile); this.#openFiles.add(file); reservedPaths.add(file); } }
      },
      ...this.#browserControls(client, () => client.snapshot!.id),
      openHtmlPreview: request => client.request({ operation: "openHtmlPreview", request }, 30_000),
      releaseHtmlPreview: leaseId => client.request({ operation: "releaseHtmlPreview", leaseId }, 30_000),
      getSessionOutputs: () => client.request({ operation: "getSessionOutputs" }, 30_000),
      getImage: async (nativeEntryId, blockIndex, source) => {
        if (imageReads >= 2) throw new Error("Native image retrieval limit reached; retry after an active image read finishes");
        imageReads++;
        try { return await client.request({ operation: "getImage", args: { nativeEntryId, blockIndex, ...(source ? { source } : {}) } }, 30_000); }
        finally { imageReads--; }
      },
      subscribe: listener => client.subscribe(listener),
      subscribeWorkerFailure: listener => client.subscribeFailure(listener),
      getForceTool: async () => parseForceToolState(await client.request({ operation: "getForceTool" })),
      cancelForceTool: async input => {
        const value = await client.request({ operation: "cancelForceTool", args: input }, 15_000, "force-cancel");
        try {
          const result = parseForceToolCancelResult(value);
          if (result.cancelledDirectiveId !== input.directiveId) throw new Error("Native force cancellation receipt changed directive identity.");
          return result;
        }
        catch (cause) {
          throw Object.assign(new Error("Native force cancellation returned an invalid receipt. Inspect the live queue before retrying.", { cause }), { code: "OUTCOME_UNKNOWN" as const });
        }
      },
      startPrompt: (text, options) => client.startPrompt(text, options),
      prompt: (text, options) => client.startPrompt(text, options).completion,
      steer: (text, expectedApprovalMode, options) => {
        if (options?.images?.length) return Promise.reject(new Error("Image attachments are not supported on steering input yet; no input was queued"));
        return client.request({ operation: "steer", args: { text, expectedApprovalMode, options } });
      },
      startFollowUp: (text, delivery, expectedApprovalMode, images) => client.startFollowUp(text, delivery, expectedApprovalMode, images),
      getQueuedMessages: () => client.request({ operation: "getQueuedMessages" }),
      mutateQueuedMessages: mutation => client.request({ operation: "mutateQueuedMessages", args: { mutation } }),
      assertTaskLocationReady: () => client.request({ operation: "assertTaskLocationReady" }),
      moveSession: cwd => client.request({ operation: "moveSession", args: { cwd } }, 60_000),
      installBrowserContinuation: async (input, evaluation) => {
        const binding: BrowserEvaluationBinding = { ...input.target, ownerId: input.sourceOwnerId, operationId: input.operationId, backend: evaluation.backend };
        await client.installRetainedBrowserEvaluation({ binding, kindTag: input.kindTag, safeDir: state().cwd }, evaluation);
      },
      enableBrowserRecovery: (socketPath, token, instanceId) => client.enableReconnect(socketPath, token, instanceId),
      abort: () => client.request({ operation: "abort" }),
      setModel: model => client.request({ operation: "setModel", args: { model } }),
      listAccountChoices: () => client.request({ operation: "listAccountChoices" }),
      pinAccount: (credentialId, expectedSelection) => client.request({ operation: "pinAccount", args: { credentialId, expectedSelection } }),
      releaseAccountForReselection: expectedSelection => client.request({ operation: "releaseAccountForReselection", args: { expectedSelection } }),
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
  async getSshHosts(cwd: string): Promise<import("@agent-desktop/shared").NativeSshCatalog> {
    return (await this.#discoveryClient()).request({ operation: "getSshHosts", args: { cwd } }, 30_000);
  }
  async getSshHostDetail(cwd: string, request: import("@agent-desktop/shared").NativeSshDetailRequest): Promise<import("@agent-desktop/shared").NativeSshDetail> {
    return (await this.#discoveryClient()).request({ operation: "getSshHostDetail", args: { cwd, request } }, 30_000);
  }
  async mutateSshHost(cwd: string, mutation: import("@agent-desktop/shared").NativeSshMutation): Promise<import("@agent-desktop/shared").NativeSshCatalog> {
    const catalog = await (await this.#discoveryClient()).request<import("@agent-desktop/shared").NativeSshCatalog>({ operation: "mutateSshHost", args: { cwd, mutation } }, 30_000);
    const refreshed = await Promise.allSettled([...this.#clients].filter(client => client.snapshot !== undefined).map(client =>
      client.request({ operation: "refreshSshConfiguration" }, 15_000)));
    if (refreshed.some(result => result.status === "rejected")) catalog.warnings.push("Saved, but an existing session could not refresh its SSH configuration. Reopen that session before using the changed targets.");
    return catalog;
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
  async getSkillInventory(cwd: string = process.cwd(), options: { refresh?: boolean } = {}): Promise<NativeSkillInventoryCatalog> {
    return (await this.#discoveryClient()).request<NativeSkillInventoryCatalog>({ operation: "getSkillInventory", args: { cwd, refresh: options.refresh } }, 15_000);
  }
  async getComposerCompletions(cwd: string, query: ComposerCompletionQuery): Promise<NativeComposerCompletions> {
    return (await this.#discoveryClient()).request<NativeComposerCompletions>({ operation: "getComposerCompletions", args: { cwd, query } }, 5_000);
  }

  dispose(options:{preserveReconnect?:boolean}={}): Promise<void> {
    if (this.#disposeCall) return this.#disposeCall;
    this.#disposed = true;
    this.#disposeCall = (async () => {
      // A child belongs to us before its init request completes. Begin bounded
      // shutdown now so a stuck native setup cannot defer cancellation forever.
      const clients=[...this.#clients];
      if(options.preserveReconnect)for(const client of clients)if(client.reconnectEndpoint)client.detachForRecovery();
      const closing = Promise.allSettled(clients.filter(client=>!options.preserveReconnect||!client.reconnectEndpoint).map(client => client.close()));
      await Promise.allSettled([...this.#setups]);
      const results = await closing;
      this.#sessions.clear(); this.#clients.clear(); this.#openFiles.clear();
      const errors = results.filter(result => result.status === "rejected");
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), "OMP worker shutdown failed");
    })();
    return this.#disposeCall;
  }
}
