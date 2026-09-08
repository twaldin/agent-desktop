import type { NativePluginAcquisition } from "../../../../packages/shared/src/plugin-acquisition";
import type { NativePluginMutation, NativeMcpDetailRequest, NativeMcpMutation } from "@agent-desktop/shared";
import type { BrowserControlRequest, BrowserFrameTarget, BrowserMetadataAvailability, ComposerCompletionQuery, GoalMutationRequest, ModelChoice, NativeSessionActivity, OmpApprovalMode, OmpSessionControlMutation, ResolveDetachedQuestionRequest } from "@agent-desktop/shared";
import type { OmpOpenOptions, OmpPromptOptions, OmpSessionOptions, OmpInteractionResponse, PreparedPromptImage } from "../omp";
import type { GoalContinuationEligibility } from "../omp/goal-controller";
import type { WorkerEvent } from "./events";
import { projectNativeErrorMessage } from "./events";
import type { NativeBtwStart } from "../../../../packages/shared/src/btw";

export const WORKER_PROTOCOL_VERSION = 32;
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
);
export type WorkerOperation =
  | { operation: "init"; args: WorkerInit }
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
  | { operation: "getMcpServers"; args: { cwd: string } }
  | { operation: "getMcpServerDetail"; args: { cwd: string; request: NativeMcpDetailRequest } }
  | { operation: "mutateMcpServer"; args: { cwd: string; mutation: NativeMcpMutation } }
  | { operation: "getMessages" }
  | { operation: "getSessionActivity" }
  | { operation: "mutateGoal"; args: { request: GoalMutationRequest } }
  | { operation: "getGoalContinuationEligibility" }
  | { operation: "startGoalContinuation"; args: { expectedGoalId: string } }
  | { operation: "listQuestions" }
  | { operation: "resolveQuestion"; args: { request: ResolveDetachedQuestionRequest } }
  | { operation: "startQuestionDelivery"; args: { questionId: string } }
  | { operation: "readSessionMcpResource"; args: { request: import("@agent-desktop/shared").NativeSessionMcpResourceRequest } }
  | { operation: "startSessionMcpAuthorization"; args: { request: import("@agent-desktop/shared").NativeMcpAuthorizationStart } }
  | { operation: "getSessionMcpAuthorization" }
  | { operation: "respondSessionMcpAuthorization"; args: { request: import("@agent-desktop/shared").NativeMcpAuthorizationReply } }
  | { operation: "cancelSessionMcpAuthorization"; args: { authorizationId: string } }
  | { operation: "getSessionMcp" }
  | { operation: "reloadSessionMcp"; args: { request: import("@agent-desktop/shared").NativeSessionMcpReload } }
  | { operation: "reconnectSessionMcp"; args: { request: import("@agent-desktop/shared").NativeSessionMcpReconnect } }
  | { operation: "getBtw" }
  | { operation: "startBtw"; args: NativeBtwStart }
  | { operation: "cancelBtw"; args: { runId: string } }
  | { operation: "promoteBtw"; args: { runId: string; operationId?: string } }
  | { operation: "getBrowserMetadata" }
  | { operation: "createBrowserTab"; args: { name: string } }
  | { operation: "controlBrowser"; args: { request: BrowserControlRequest } }
  | { operation: "getBrowserFrame"; args: { target: BrowserFrameTarget } }
  | { operation: "getImage"; args: { nativeEntryId: string; blockIndex: number } }
  | { operation: "startPrompt"; args: { text: string; options?: OmpPromptOptions } }
  | { operation: "steer"; args: { text: string; expectedApprovalMode?: OmpApprovalMode; options?: { images?: PreparedPromptImage[] } } }
  | { operation: "abort" }
  | { operation: "setModel"; args: { model: ModelChoice } }
  | { operation: "listAccountChoices" }
  | { operation: "pinAccount"; args: { credentialId: number } }
  | { operation: "releaseAccountForReselection" }
  | { operation: "listInteractions" }
  | { operation: "respondInteraction"; args: { id: string; response: OmpInteractionResponse } }
  | { operation: "cancelInteractions"; args: { reason?: "cancelled" | "disconnected" } }
  | { operation: "getControls" }
  | { operation: "mutateControls"; args: OmpSessionControlMutation }
  | { operation: "setApprovalOverride"; args: { mode?: OmpApprovalMode; expectedRevision: string } }
  | { operation: "dispose" };
export type ParentMessage = ({ type: "request"; id: string } & WorkerOperation)
  | { type: "eventAck"; sequence: number }
  /** The child exits only after its disposal result has reached the owner. */
  | { type: "disposeAck"; id: string };
export interface RemoteError { name: string; message: string; code?: "OUTCOME_UNKNOWN" }
export type ChildMessage =
  | { type: "ready"; version: number }
  | { type: "response"; id: string; phase?: "accepted" | "completion"; ok: boolean; value?: unknown; error?: RemoteError; snapshot?: SessionSnapshot }
  | { type: "event"; sequence: number; event: WorkerEvent; snapshot?: SessionSnapshot }
  | { type: "fatal"; error: RemoteError };

export function remoteError(error: unknown): RemoteError {
  return error instanceof Error
    ? { name: error.name.slice(0, 100), message: projectNativeErrorMessage(error.message),
      ...("code" in error && error.code === "OUTCOME_UNKNOWN" ? { code: "OUTCOME_UNKNOWN" as const } : {}) }
    : { name: "Error", message: "OMP worker operation failed" };
}
