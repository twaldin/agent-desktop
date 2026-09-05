import type { ModelChoice, OmpApprovalMode, OmpSessionControlMutation } from "@agent-desktop/shared";
import type { OmpOpenOptions, OmpPromptOptions, OmpSessionOptions, OmpRuntimeEvent, OmpInteractionResponse } from "../omp";

export const WORKER_PROTOCOL_VERSION = 3;
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
  | { operation: "getMessages" }
  | { operation: "startPrompt"; args: { text: string; options?: OmpPromptOptions } }
  | { operation: "steer"; args: { text: string; expectedApprovalMode?: OmpApprovalMode } }
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
export interface RemoteError { name: string; message: string }
export type ChildMessage =
  | { type: "ready"; version: number }
  | { type: "response"; id: string; phase?: "accepted" | "completion"; ok: boolean; value?: unknown; error?: RemoteError; snapshot?: SessionSnapshot }
  | { type: "event"; sequence: number; event: OmpRuntimeEvent; snapshot?: SessionSnapshot }
  | { type: "fatal"; error: RemoteError };

export function remoteError(error: unknown): RemoteError {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: "OMP worker operation failed" };
}
