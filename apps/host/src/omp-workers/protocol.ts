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
export type { NativeSessionForkInput, NativeSessionForkResult } from "../omp/session-fork";

export const WORKER_PROTOCOL_VERSION = 62;
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
export type WorkerInit = { agentDir?: string } & (
  | { mode: "create"; options: Omit<OmpSessionOptions, "onEvent"> }
  | { mode: "open"; options: Omit<OmpOpenOptions, "onEvent"> }
  | { mode: "discovery" }
  | { mode: "mcp-owner"; owner: { id: string; cwd: string } }
  | { mode: "browser"; owner: { id: string; cwd: string } }
);
export type WorkerOperation = BrowserEvaluationOperation

  | { operation: "init"; args: WorkerInit }
  | { operation: "enableReconnect"; args: { socketPath: string; token: string; instanceId: string } }
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
  | { operation: "getSshHosts"; args: { cwd: string } }
  | { operation: "getSshHostDetail"; args: { cwd: string; request: import("@agent-desktop/shared").NativeSshDetailRequest } }
  | { operation: "mutateSshHost"; args: { cwd: string; mutation: import("@agent-desktop/shared").NativeSshMutation } }
  | { operation: "getMcpServers"; args: { cwd: string } }
  | { operation: "getMcpServerDetail"; args: { cwd: string; request: NativeMcpDetailRequest } }
  | { operation: "mutateMcpServer"; args: { cwd: string; mutation: NativeMcpMutation } }
  | { operation: "getMessages" }
  | { operation: "getSessionActivity" }
  | { operation: "getPlan" }
  | { operation: "getPlanExternalEditorAvailable" }
  | { operation: "preparePlanExternalEditor"; args: import("../../../../packages/shared/src/plan-external-editor").PlanExternalEditorRequest }
  | { operation: "getPlanDocumentSection"; args: import("../../../../packages/shared/src/session-plan").PlanDocumentReadRequest }
  | { operation: "startPlanExecution"; args: { phaseId: string } }
  | { operation: "preparePlanDecision"; args: { commandId: string; request: import("../../../../packages/shared/src/session-plan").PlanMutationRequest } }
  | { operation: "controlPlan"; args: import("../../../../packages/shared/src/session-plan").PlanControlRequest }
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
  | { operation: "listInteractions" }
  | { operation: "respondInteraction"; args: { id: string; response: OmpInteractionResponse } }
  | { operation: "cancelInteractions"; args: { reason?: "cancelled" | "disconnected" } }
  | { operation: "getControls" }
  | { operation: "mutateControls"; args: OmpSessionControlMutation }
  | { operation: "setApprovalOverride"; args: { mode?: OmpApprovalMode; expectedRevision: string } }
  | { operation: "dispose" };
export type ParentMessage = ({ type: "request"; id: string } & WorkerOperation)
  | { type: "browserEvaluationFrame"; binding: BrowserEvaluationBinding; frame: BrowserEvaluationFrame }
  | { type: "retainedBrowserFrame"; binding: BrowserEvaluationBinding; frame: BrowserEvaluationFrame }
  | { type: "retainedBrowserResponse"; binding: BrowserEvaluationBinding; id: string; ok: boolean; value?: Record<string, unknown>; error?: RemoteError }
  | { type: "browserEvaluationAck"; binding: BrowserEvaluationBinding; sequence: number }
  | { type: "eventAck"; sequence: number }
  /** The child exits only after its disposal result has reached the owner. */
  | { type: "disposeAck"; id: string };
export interface RemoteError { name: string; message: string; code?: "OUTCOME_UNKNOWN" | "PLAN_REJECTED" | "TODOS_REJECTED" }
export type ChildMessage =
  | { type: "browserEvaluationFrame"; binding: BrowserEvaluationBinding; frame: BrowserEvaluationFrame }
  | { type: "retainedBrowserFrame"; binding: BrowserEvaluationBinding; frame: BrowserEvaluationFrame }
  | { type: "retainedBrowserRequest"; binding: BrowserEvaluationBinding; id: string; method: string; params: Record<string, unknown>; options?: { timeoutMs?: number } }
  | { type: "ready"; version: number }
  | { type: "recovered"; version: number; pid: number; instanceId: string; snapshot?: SessionSnapshot }
  | { type: "commitProgress"; id: string; message: string }
  | { type: "response"; id: string; phase?: "accepted" | "completion"; ok: boolean; value?: unknown; error?: RemoteError; forceToolReceipt?: ForceToolReceipt; evaluation?: { binding: BrowserEvaluationBinding; sequence: number }; snapshot?: SessionSnapshot }
  | { type: "event"; sequence: number; event: WorkerEvent; snapshot?: SessionSnapshot }
  | { type: "fatal"; error: RemoteError };

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
  return error instanceof Error
    ? { name: error.name.slice(0, 100), message: remoteErrorMessage(error, new Set(), { remaining: MAX_REMOTE_ERROR_DETAILS }),
      ...("code" in error && (error.code === "OUTCOME_UNKNOWN" || error.code === "PLAN_REJECTED" || error.code === "TODOS_REJECTED") ? { code: error.code } : {}) }
    : { name: "Error", message: "OMP worker operation failed" };
}
