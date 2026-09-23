import type { ForceToolReceipt, ForceToolTicket, SessionAccountSelection } from "@agent-desktop/shared";
import type { BrowserEvaluationBinding, BrowserEvaluationDescriptor, BrowserEvaluationFrame, BrowserEvaluationOperation } from "../omp-browser/evaluation-wire";
import type { NativePluginAcquisition } from "../../../../packages/shared/src/plugin-acquisition";
import type { NativePluginMutation, NativeMcpDetailRequest, NativeMcpMutation } from "@agent-desktop/shared";
import type { BrowserControlRequest, BrowserFrameTarget, BrowserMetadataAvailability, ComposerCompletionQuery, GoalMutationRequest, ModelChoice, NativeSessionActivity, OmpApprovalMode, OmpSessionControlMutation, ResolveDetachedQuestionRequest } from "@agent-desktop/shared";
import type { OmpOpenOptions, OmpPromptOptions, OmpSessionOptions, OmpInteractionResponse, PreparedPromptImage } from "../omp";
import type { GoalContinuationEligibility } from "../omp/goal-controller";
import type { WorkerEvent } from "./events";
import { projectNativeErrorMessage } from "./events";
import type { NativeBtwStart } from "../../../../packages/shared/src/btw";
import type { NativeSessionForkInput } from "../omp/session-fork";
import type { TodoMutationRequest } from "../../../../packages/shared/src/session-todos";
import type { ResetPolicyWireRequest, ResetPolicyWireResponse } from "./reset-policy-wire";
import type { WorkerResetPolicyReconnect } from "./reconnect-wire";
import { isAbsolute } from "node:path";
/** Type-only: the daemon parent never loads the native SDK through this module. */
import type { NativeOriginalBinding, NativeOriginalSource } from "@oh-my-pi/pi-coding-agent/session/original-session-ownership";
export type { NativeSessionForkInput, NativeSessionForkResult } from "../omp/session-fork";

// 73 introduced the "open-original" init mode. The ready/recovered handshake
// rejects any other version, so a worker without native original admission can
// never answer an admission request by silently opening the file some other way.
export const WORKER_PROTOCOL_VERSION = 73;

/** Mirrors the native ORIGINAL_SESSION_OWNERSHIP_PROTOCOL literal. The daemon
 * must not import the SDK, so the child asserts the two agree before any
 * native effect and the parent refuses a binding that claims anything else. */
export const ORIGINAL_SESSION_OWNERSHIP_PROTOCOL = 1;
export type { NativeOriginalBinding, NativeOriginalSource };

/** Exactly the native admission input: the enrolled binding, the reviewed
 * read-only source and the caller's durable command id. No worker-side field
 * is added, defaulted or recomputed on the way to the native writer. */
export interface OriginalAdmissionRequest {
  ownershipDirectory: string;
  binding: NativeOriginalBinding;
  source: NativeOriginalSource;
  commandId: string;
}
/** Returned by the child that actually ran the admitted native open, built
 * from the live native manager rather than echoed from the request. */
export interface OriginalAdmissionReceipt {
  protocol: number;
  commandId: string;
  ownershipDirectory: string;
  enrollmentId: string;
  registryId: string;
  nativeId: string;
  originalFile: string;
  recordedCwd: string;
  canonicalCwd: string;
}

/** Proven pre-effect refusal: nothing was opened, locked, moved or written. */
export class OriginalAdmissionRefusal extends Error {
  readonly code = "ORIGINAL_SESSION_NOT_SUBMITTED" as const;
  constructor(readonly reason: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OriginalAdmissionRefusal";
  }
}
/** Effects may have begun. Never downgrade one of these to a refusal. */
export class OriginalAdmissionOutcomeUnknown extends Error {
  readonly code = "OUTCOME_UNKNOWN" as const;
  constructor(readonly reason: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OriginalAdmissionOutcomeUnknown";
  }
}
/** Native and worker refusals both carry code+reason; read them structurally so
 * an error that crossed IPC is classified exactly like a local one. */
export function originalAdmissionCode(error: unknown): RemoteError["code"] | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const { code } = error;
  return code === "ORIGINAL_SESSION_NOT_SUBMITTED" || code === "OUTCOME_UNKNOWN" ? code : undefined;
}
export function originalAdmissionReason(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("reason" in error)) return undefined;
  const { reason } = error;
  return typeof reason === "string" && reason.length > 0 && reason.length <= MAX_ADMISSION_TEXT ? reason : undefined;
}

const MAX_ADMISSION_TEXT = 512;
const MAX_ADMISSION_PATH = 4_096;
const SHA256_HEX = /^[0-9a-f]{64}$/;
function admissionText(value: unknown, field: string, max = MAX_ADMISSION_TEXT): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0"))
    throw new OriginalAdmissionRefusal("admission-input-invalid", `Original session admission requires ${field}`);
  return value;
}
function admissionPath(value: unknown, field: string): string {
  const text = admissionText(value, field, MAX_ADMISSION_PATH);
  if (!isAbsolute(text))
    throw new OriginalAdmissionRefusal("admission-input-invalid", `Original session admission requires an absolute ${field}`);
  return text;
}
function admissionNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new OriginalAdmissionRefusal("admission-input-invalid", `Original session admission requires a numeric ${field}`);
  return value;
}
/** Whitelist-copies the enrolled binding; any malformed field is a proven
 * pre-effect refusal rather than a degraded admission. */
export function copyOriginalBinding(value: NativeOriginalBinding): NativeOriginalBinding {
  // Crosses IPC: every field below is validated before it is used.
  const binding = value as Partial<Record<keyof NativeOriginalBinding, unknown>> | null;
  if (!binding || typeof binding !== "object" || Array.isArray(binding))
    throw new OriginalAdmissionRefusal("admission-input-invalid", "Original session admission requires an enrolled binding");
  if (binding.protocol !== ORIGINAL_SESSION_OWNERSHIP_PROTOCOL)
    throw new OriginalAdmissionRefusal("ownership-protocol-unsupported", "This original session ownership binding uses an unsupported native protocol");
  return { protocol: ORIGINAL_SESSION_OWNERSHIP_PROTOCOL,
    enrollmentId: admissionText(binding.enrollmentId, "an enrollment id"),
    registryId: admissionText(binding.registryId, "a registry id"),
    originalFile: admissionPath(binding.originalFile, "original session file"),
    nativeId: admissionText(binding.nativeId, "the original native session id"),
    recordedCwd: admissionPath(binding.recordedCwd, "recorded working directory"),
    canonicalCwd: admissionPath(binding.canonicalCwd, "canonical working directory") };
}
/** Whitelist-copies the reviewed read-only observation the native writer
 * revalidates under its lease; the digest and full file identity are retained. */
export function copyOriginalSource(value: NativeOriginalSource): NativeOriginalSource {
  // Crosses IPC: every field below is validated before it is used.
  const source = value as Partial<Record<keyof NativeOriginalSource, unknown>> | null;
  if (!source || typeof source !== "object" || Array.isArray(source))
    throw new OriginalAdmissionRefusal("admission-input-invalid", "Original session admission requires a reviewed source");
  const observed = source.fileIdentity as Partial<Record<keyof NativeOriginalSource["fileIdentity"], unknown>> | null;
  if (!observed || typeof observed !== "object" || Array.isArray(observed))
    throw new OriginalAdmissionRefusal("admission-input-invalid", "Original session admission requires the reviewed file identity");
  const contentSha256 = admissionText(source.contentSha256, "the reviewed content digest");
  if (!SHA256_HEX.test(contentSha256))
    throw new OriginalAdmissionRefusal("admission-input-invalid", "Original session admission requires a sha256 content digest");
  return { originalFile: admissionPath(source.originalFile, "original session file"),
    nativeId: admissionText(source.nativeId, "the original native session id"),
    recordedCwd: admissionPath(source.recordedCwd, "recorded working directory"),
    canonicalCwd: admissionPath(source.canonicalCwd, "canonical working directory"),
    contentSha256,
    fileIdentity: { dev: admissionNumber(observed.dev, "device id"), ino: admissionNumber(observed.ino, "inode"),
      size: admissionNumber(observed.size, "size"), mtimeMs: admissionNumber(observed.mtimeMs, "mtime"),
      ctimeMs: admissionNumber(observed.ctimeMs, "ctime"), birthtimeMs: admissionNumber(observed.birthtimeMs, "birthtime") } };
}
/** Copies the admission verbatim and blocks an identity transition before any
 * native effect: the reviewed source must still describe the enrolled original,
 * never a moved, revived, forked or newly branched one. */
export function parseOriginalAdmissionRequest(value: OriginalAdmissionRequest): OriginalAdmissionRequest {
  // Crosses IPC: every field below is validated before it is used.
  const request = value as Partial<Record<keyof OriginalAdmissionRequest, unknown>> | null;
  if (!request || typeof request !== "object" || Array.isArray(request))
    throw new OriginalAdmissionRefusal("admission-input-invalid", "Original session admission requires its native input");
  const binding = copyOriginalBinding(request.binding as NativeOriginalBinding);
  const source = copyOriginalSource(request.source as NativeOriginalSource);
  if (source.nativeId !== binding.nativeId || source.originalFile !== binding.originalFile
    || source.recordedCwd !== binding.recordedCwd || source.canonicalCwd !== binding.canonicalCwd)
    throw new OriginalAdmissionRefusal("binding-source-mismatch",
      "The reviewed original session no longer matches its enrolled identity; switching, moving, reviving or forking an enrolled original is not supported");
  return { ownershipDirectory: admissionPath(request.ownershipDirectory, "ownership directory"),
    binding, source, commandId: admissionText(request.commandId, "a command id") };
}
/** The child proves it took the admitted path; its identity fields come from the
 * live native manager, so a worker that opened anything else cannot answer. */
export function assertOriginalAdmissionReceipt(value: unknown, request: OriginalAdmissionRequest): void {
  // Crosses IPC: compared field by field against the exact admission sent.
  const receipt = value as Partial<Record<keyof OriginalAdmissionReceipt, unknown>> | null | undefined;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    throw new OriginalAdmissionOutcomeUnknown("admission-receipt-missing", "The OMP worker did not return a native original admission receipt");
  if (receipt.protocol !== ORIGINAL_SESSION_OWNERSHIP_PROTOCOL || receipt.commandId !== request.commandId
    || receipt.ownershipDirectory !== request.ownershipDirectory
    || receipt.enrollmentId !== request.binding.enrollmentId || receipt.registryId !== request.binding.registryId
    || receipt.nativeId !== request.binding.nativeId || receipt.originalFile !== request.binding.originalFile
    || receipt.recordedCwd !== request.binding.recordedCwd || receipt.canonicalCwd !== request.binding.canonicalCwd)
    throw new OriginalAdmissionOutcomeUnknown("admission-receipt-changed", "The OMP worker changed the admitted original session identity");
}
export type CommitGenerationInput = Omit<import("@oh-my-pi/pi-coding-agent/commit").GenerateGitCommitFromDiffOptions, "signal" | "onProgress">;
export type CommitGenerationResult = import("@oh-my-pi/pi-coding-agent/commit").GeneratedGitCommit & { message: string };
export interface SessionSnapshot {
  revision: number;
  id: string;
  sessionFile: string;
  cwd: string;
  model: ModelChoice | null;
  thinkingLevel?: string;
  isStreaming: boolean;
  hasPostPromptWork: boolean;
  title?: string;
  createdAt: number;
  modelFallbackMessage?: string;
  activity: NativeSessionActivity;
}
export type WorkerInit = { agentDir?: string; resetPolicy?: { workerEpoch: string } } & (
  | { mode: "create"; options: Omit<OmpSessionOptions, "onEvent"> }
  | { mode: "open"; options: Omit<OmpOpenOptions, "onEvent"> }
  /** Admitted cooperative original: the child acquires the native writer lease
   * itself and never falls through to the ordinary unmanaged open above. */
  | { mode: "open-original"; options: OriginalAdmissionRequest }
  | { mode: "discovery" }
  | { mode: "mcp-owner"; owner: { id: string; cwd: string } }
  | { mode: "browser"; owner: { id: string; cwd: string } }
);
export type WorkerOperation = BrowserEvaluationOperation

  | { operation: "init"; args: WorkerInit }
  | { operation: "enableReconnect"; args: { socketPath: string; token: string; instanceId: string; resetPolicy?: WorkerResetPolicyReconnect } }
  /** Pauses new reset admission; ACK follows native callback and channel quiescence.
   * Retains native resources and original settlement obligations until host drain. */
  | { operation: "prepareResetPolicyRecovery" }
  | { operation: "generateCommit"; args: CommitGenerationInput }
  | { operation: "forkSession"; args: NativeSessionForkInput }
  | { operation: "getExportIntent"; args: { text: string } }
  | { operation: "exportSession"; args: import("../omp/session-export").NativeSessionExportInput }
  | { operation: "flushSession" }
  | { operation: "listModels"; args: { cwd: string; refresh?: boolean } }
  | { operation: "listModelCapabilities"; args: { cwd: string; refresh?: boolean } }
  | { operation: "getComposerCatalog"; args: { cwd: string; refresh?: boolean } }
  | { operation: "getComposerActions"; args: { cwd?: string; refresh?: boolean } }
  | { operation: "getSkillInventory"; args: { cwd: string; refresh?: boolean } }
  | { operation: "getComposerCompletions"; args: { cwd?: string; query: ComposerCompletionQuery } }
  | { operation: "getMarketplaceCatalog"; args: { cwd: string } }
  | { operation: "acquirePlugin"; args: { cwd: string; expectedRevision: string; action: NativePluginAcquisition } }
  | { operation: "getPlugins"; args: { cwd: string } }
  | { operation: "mutatePlugin"; args: { cwd: string; mutation: NativePluginMutation } }
  | { operation: "refreshSshConfiguration" }
  | { operation: "getDapConfiguration"; args: { cwd: string } }
  | { operation: "mutateDapConfiguration"; args: { cwd: string; mutation: import("@agent-desktop/shared").NativeDapMutation } }
  | { operation: "getLspConfiguration"; args: { cwd: string } }
  | { operation: "mutateLspConfiguration"; args: { cwd: string; mutation: import("@agent-desktop/shared").NativeLspMutation } }
  | { operation: "getSshHosts"; args: { cwd: string } }
  | { operation: "getSshHostDetail"; args: { cwd: string; request: import("@agent-desktop/shared").NativeSshDetailRequest } }
  | { operation: "mutateSshHost"; args: { cwd: string; mutation: import("@agent-desktop/shared").NativeSshMutation } }
  | { operation: "getMcpServers"; args: { cwd: string } }
  | { operation: "getMcpServerDetail"; args: { cwd: string; request: NativeMcpDetailRequest } }
  | { operation: "mutateMcpServer"; args: { cwd: string; mutation: NativeMcpMutation } }
  | { operation: "getMessages" }
  | { operation: "getSessionActivity" }
  | { operation: "nativeProcesses"; args: { request: import("../../../../packages/shared/src/session-processes").SessionProcessNativeRequest } }
  | { operation: "nativeJobs"; args: { request: import("../../../../packages/shared/src/session-jobs").SessionJobsRequest } }
  | { operation: "nativeSubagents"; args: { request: import("../../../../packages/shared/src/session-subagents").SessionSubagentsRequest } }
  | { operation: "readUsage"; args: { mode: import("../../../../packages/shared/src/session-usage").UsageRefresh } }
  | { operation: "prepareUsageReset"; args: import("../../../../packages/shared/src/session-usage").UsageResetPrepare }
  | { operation: "redeemUsageReset"; args: { ticket: string; redeemRequestId: string } }
  | { operation: "getPlan" }
  | { operation: "getTodoExternalEditorAvailable" }
  | { operation: "prepareTodoExternalEditor"; args: import("../../../../packages/shared/src/todo-external-editor").TodoExternalEditorRequest }
  | { operation: "getPlanExternalEditorAvailable" }
  | { operation: "preparePlanExternalEditor"; args: import("../../../../packages/shared/src/plan-external-editor").PlanExternalEditorRequest }
  | { operation: "getPlanDocumentSection"; args: import("../../../../packages/shared/src/session-plan").PlanDocumentReadRequest }
  | { operation: "startPlanExecution"; args: { phaseId: string } }
  | { operation: "preparePlanDecision"; args: { commandId: string; request: import("../../../../packages/shared/src/session-plan").PlanMutationRequest } }
  | { operation: "controlPlan"; args: import("../../../../packages/shared/src/session-plan").PlanControlRequest }
  | { operation: "getTree" }
  | { operation: "mutateTree"; args: { commandId: string; request: import("../../../../packages/shared/src/session-tree").TreeMutationRequest } }
  | { operation: "getTodos" }
  | { operation: "mutateTodos"; args: { commandId: string; request: TodoMutationRequest } }
  | { operation: "getForceTool" }
  | { operation: "cancelForceTool"; args: { ticket: ForceToolTicket; directiveId: string } }
  | { operation: "mutateGoal"; args: { request: GoalMutationRequest } }
  | { operation: "getGoalContinuationEligibility" }
  | { operation: "startGoalContinuation"; args: { expectedGoalId: string } }
  | { operation: "listQuestions" }
  | { operation: "resolveQuestion"; args: { request: ResolveDetachedQuestionRequest } }
  | { operation: "startQuestionDelivery"; args: { questionId: string } }
  | { operation: "sessionMcpApp"; args: { request: import("@agent-desktop/shared").NativeMcpAppRequest } }
  | { operation: "readSessionMcpResource"; args: { request: import("@agent-desktop/shared").NativeSessionMcpResourceRequest } }
  | { operation: "startSessionMcpAuthorization"; args: { request: import("@agent-desktop/shared").NativeMcpAuthorizationStart } }
  | { operation: "getSessionMcpAuthorization" }
  | { operation: "respondSessionMcpAuthorization"; args: { request: import("@agent-desktop/shared").NativeMcpAuthorizationReply } }
  | { operation: "cancelSessionMcpAuthorization"; args: { authorizationId: string } }
  | { operation: "getMcpOwner" }
  | { operation: "mcpOwnerApp"; args: { request: import("@agent-desktop/shared").NativeMcpAppRequest } }
  | { operation: "listMcpOwnerInteractions" }
  | { operation: "respondMcpOwnerInteraction"; args: { id: string; response: OmpInteractionResponse } }
  | { operation: "getSessionMcp" }
  | { operation: "reloadSessionMcp"; args: { request: import("@agent-desktop/shared").NativeSessionMcpReload } }
  | { operation: "reconnectSessionMcp"; args: { request: import("@agent-desktop/shared").NativeSessionMcpReconnect } }
  | { operation: "unauthorizeSessionMcp"; args: { request: import("@agent-desktop/shared").NativeSessionMcpReconnect } }
  | { operation: "getBtw" }
  | { operation: "startBtw"; args: NativeBtwStart }
  | { operation: "cancelBtw"; args: { runId: string } }
  | { operation: "promoteBtw"; args: { runId: string; operationId?: string } }
  | { operation: "getBrowserMetadata" }
  | { operation: "getBrowserHistory"; args: { target: BrowserFrameTarget } }
  | { operation: "createBrowserTab"; args: { name: string; initialUrl?: string } }
  | { operation: "controlBrowser"; args: { request: BrowserControlRequest } }
  | { operation: "closeBrowserTab"; args: { target: BrowserFrameTarget } }
  | { operation: "inspectBrowserTab"; args: { target: BrowserFrameTarget } }
  | { operation: "reserveBrowserEvaluation"; args: { target: BrowserFrameTarget; operationId: string } }
  | { operation: "inspectBrowserEvaluationReservation"; args: { target: BrowserFrameTarget; operationId: string } }
  | { operation: "prepareRetainedBrowserEvaluation"; args: { binding: BrowserEvaluationBinding; kindTag: import("@agent-desktop/shared").NativeBrowserTabMetadata["kindTag"]; safeDir: string; descriptor: BrowserEvaluationDescriptor } }
  | { operation: "activateRetainedBrowserEvaluation"; args: { binding: BrowserEvaluationBinding } }
  | { operation: "disposeRetainedBrowserEvaluation"; args: { binding: BrowserEvaluationBinding } }
  | { operation: "getBrowserFrame"; args: { target: BrowserFrameTarget } }
  | { operation: "openHtmlPreview"; request: import("../../../../packages/shared/src/html-preview").HtmlPreviewRequest }
  | { operation: "releaseHtmlPreview"; leaseId: string }
  | { operation: "getSessionOutputs" }
  | { operation: "getTurnReview" }
  | { operation: "getImage"; args: { nativeEntryId: string; blockIndex: number; source?: "generated" } }
  | { operation: "startPrompt"; args: { text: string; options?: OmpPromptOptions } }
  | { operation: "steer"; args: { text: string; expectedApprovalMode?: OmpApprovalMode; options?: { images?: PreparedPromptImage[] } } }
  | { operation: "startFollowUp"; args: { text: string; delivery: import("@agent-desktop/shared").FollowUpDelivery; expectedApprovalMode?: OmpApprovalMode; images?: import("../omp/images").PreparedPromptImage[] } }
  | { operation: "getQueuedMessages" }
  | { operation: "mutateQueuedMessages"; args: { mutation: import("../../../../packages/shared/src/queued-messages").NativeQueuedMessageMutation } }
  | { operation: "assertTaskLocationReady" }
  | { operation: "moveSession"; args: { cwd: string } }
  | { operation: "abort" }
  | { operation: "setModel"; args: { model: ModelChoice } }
  | { operation: "listAccountChoices" }
  | { operation: "pinAccount"; args: { credentialId: number; expectedSelection?: SessionAccountSelection } }
  | { operation: "releaseAccountForReselection"; args?: { expectedSelection?: SessionAccountSelection } }
  | { operation: "getExtensionUi" }
  | { operation: "listInteractions" }
  | { operation: "respondInteraction"; args: { id: string; response: OmpInteractionResponse } }
  | { operation: "cancelInteractions"; args: { reason?: "cancelled" | "disconnected" } }
  | { operation: "getControls" }
  | { operation: "mutateControls"; args: OmpSessionControlMutation }
  | { operation: "setApprovalOverride"; args: { mode?: OmpApprovalMode; expectedRevision: string } }
  | { operation: "dispose" };
export type ParentMessage = ({ type: "request"; id: string } & WorkerOperation)
  | ResetPolicyWireResponse
  /** A recovered host owner is installed against the original binding; the child
   * retransmits retained settlement requests but admits nothing new until resumed. */
  | { type: "resetPolicyReconnect"; binding: WorkerResetPolicyReconnect }
  | { type: "resetPolicyResume"; binding: WorkerResetPolicyReconnect }
  | { type: "browserEvaluationFrame"; binding: BrowserEvaluationBinding; frame: BrowserEvaluationFrame }
  | { type: "retainedBrowserFrame"; binding: BrowserEvaluationBinding; frame: BrowserEvaluationFrame }
  | { type: "retainedBrowserResponse"; binding: BrowserEvaluationBinding; id: string; ok: boolean; value?: Record<string, unknown>; error?: RemoteError }
  | { type: "browserEvaluationAck"; binding: BrowserEvaluationBinding; sequence: number }
  | { type: "eventAck"; sequence: number }
  /** The child exits only after its disposal result has reached the owner. */
  | { type: "disposeAck"; id: string };
/** `reason` accompanies the native original-admission codes and is preserved
 * verbatim: the caller must be able to tell a proven refusal from an unknown
 * outcome, and which refusal it was. */
export interface RemoteError { name: string; message: string; code?: "OUTCOME_UNKNOWN" | "ORIGINAL_SESSION_NOT_SUBMITTED" | "PLAN_REJECTED" | "TODOS_REJECTED" | "TREE_REJECTED" | "PROCESSES_REJECTED"; reason?: string }
export type ChildMessage =
  | ResetPolicyWireRequest
  | { type: "browserEvaluationFrame"; binding: BrowserEvaluationBinding; frame: BrowserEvaluationFrame }
  | { type: "retainedBrowserFrame"; binding: BrowserEvaluationBinding; frame: BrowserEvaluationFrame }
  | { type: "retainedBrowserRequest"; binding: BrowserEvaluationBinding; id: string; method: string; params: Record<string, unknown>; options?: { timeoutMs?: number } }
  | { type: "ready"; version: number }
  | { type: "recovered"; version: number; pid: number; instanceId: string; snapshot?: SessionSnapshot; resetPolicy?: WorkerResetPolicyReconnect }
  | { type: "commitProgress"; id: string; message: string }
  | { type: "response"; id: string; phase?: "accepted" | "completion"; ok: boolean; value?: unknown; error?: RemoteError; forceToolReceipt?: ForceToolReceipt; evaluation?: { binding: BrowserEvaluationBinding; sequence: number }; snapshot?: SessionSnapshot }
  | { type: "event"; sequence: number; event: WorkerEvent; snapshot?: SessionSnapshot }
  | { type: "fatal"; error: RemoteError }
  /** Sent only after every original native callback drained and every retained
   * settlement RPC settled; the child is still admission-paused. */
  | { type: "resetPolicyQuiescent"; binding: WorkerResetPolicyReconnect; snapshot: SessionSnapshot }
  | { type: "resetPolicyResumed"; binding: WorkerResetPolicyReconnect; snapshot: SessionSnapshot };

const MAX_REMOTE_ERROR_DETAILS = 16;
const MAX_REMOTE_ERROR_DEPTH = 4;
function remoteErrorMessage(error: Error, seen: Set<Error>, budget: { remaining: number }, depth = 0): string {
  if (seen.has(error)) return "[cyclic error omitted]";
  if (budget.remaining-- <= 0) return "[additional error details omitted]";
  seen.add(error);
  const message = projectNativeErrorMessage(error.message);
  if (depth >= MAX_REMOTE_ERROR_DEPTH) return message;
  const details: string[] = [];
  const omit = () => { if (details.at(-1) !== "[additional error details omitted]") details.push("[additional error details omitted]"); };
  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    const limit = Math.min(error.errors.length, budget.remaining);
    for (let index = 0; index < limit; index += 1) {
      const item = error.errors[index];
      if (item instanceof Error) details.push(remoteErrorMessage(item, seen, budget, depth + 1));
      if (budget.remaining <= 0) break;
    }
    if (error.errors.length > limit || budget.remaining <= 0) omit();
  }
  if (error.cause instanceof Error) {
    if (budget.remaining <= 0) omit();
    else details.push(remoteErrorMessage(error.cause, seen, budget, depth + 1));
  }
  return details.length ? projectNativeErrorMessage(`${message}: ${details.join("; ")}`) : message;
}

export function remoteError(error: unknown): RemoteError {
  if (!(error instanceof Error)) return { name: "Error", message: "OMP worker operation failed" };
  // A refusal reason accompanies native and host original-session refusals on
  // every route, including the Plan protocol's own rejection code.
  const reason = originalAdmissionReason(error);
  return { name: error.name.slice(0, 100), message: remoteErrorMessage(error, new Set(), { remaining: MAX_REMOTE_ERROR_DETAILS }),
    ...("code" in error && (error.code === "OUTCOME_UNKNOWN" || error.code === "ORIGINAL_SESSION_NOT_SUBMITTED" || error.code === "PLAN_REJECTED" || error.code === "TODOS_REJECTED" || error.code === "TREE_REJECTED" || error.code === "PROCESSES_REJECTED") ? { code: error.code } : {}),
    ...(reason === undefined ? {} : { reason }) };
}
