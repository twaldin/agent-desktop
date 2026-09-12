import { hasInlineFileIntent, hasRepeatedWholeFileIntent, hasRemoteWorktreeIntent } from "@agent-desktop/shared";
import type { CommandEnvelope, CommandResult, OmpSessionControlMutation } from "@agent-desktop/shared";
import { HostRequestError } from "./host-transport";

/** Old hosts normalize away unknown fields. Never downgrade a policy request. */
export function commandEndpoint(envelope: CommandEnvelope): "/v1/commands" | "/v2/commands" | "/v3/commands" | "/v4/commands" | "/v5/commands" | "/v6/commands" | "/v7/commands" | "/v8/commands" | "/v9/commands" | "/v10/commands" | "/v11/commands" | "/v12/commands" | "/v13/commands" | "/v14/commands" {
  const command = envelope.command;
  if (envelope.commandVersion === 14 || command.type === "session.location.move" || command.type === "session.location.resume") return "/v14/commands";
  if (envelope.commandVersion === 13 || command.type === "session.follow-up") return "/v13/commands";
  if (envelope.commandVersion === 12 || hasRemoteWorktreeIntent(command)) return "/v12/commands";
  if (envelope.commandVersion === 11 || command.type === "preferences.keymap.mutate") return "/v11/commands";
  if (envelope.commandVersion === 10 || command.type === "workspace.mutate" && ["git.submit", "git.submit.cancel", "git.submit.acknowledge"].includes(command.action.type)) return "/v10/commands";
  if(envelope.commandVersion===9 || hasRepeatedWholeFileIntent(command))return "/v9/commands";
  if(envelope.commandVersion===8 || hasInlineFileIntent(command))return "/v8/commands";
  if (envelope.commandVersion === 7 || (command.type === "draft.put" ? Object.hasOwn(command.draft, "wholeFileAttachments") : Object.hasOwn(command, "wholeFileAttachments"))) return "/v7/commands";
  if (envelope.commandVersion === 6 || (command.type === "draft.put" ? Object.hasOwn(command.draft, "selectedTextAttachments") : Object.hasOwn(command, "selectedTextAttachments"))) return "/v6/commands";
  if (command.type === 'workspace.mutate' && (command.action.type === 'environment.select' || command.action.type === 'environment.action')) return '/v5/commands';
  if (envelope.commandVersion === 5 || command.type === 'session.environment.cancel' || command.type === 'session.environment.resume' || command.type === 'session.create' && Object.hasOwn(command, 'environment')
    || command.type === 'draft.put' && Object.hasOwn(command.draft, 'environment')) return '/v5/commands';
  if (envelope.commandVersion === 4 || command.type === 'session.create' && Object.hasOwn(command, 'worktree')
    || command.type === 'draft.put' && Object.hasOwn(command.draft, 'execution')) return '/v4/commands';
  if (command.type === "draft.put" ? Object.hasOwn(command.draft, "attachments") : Object.hasOwn(command, "attachments")) return "/v3/commands";
  const mode = command.type === "draft.put" ? command.draft.approvalMode
    : command.type === "session.create" || command.type === "session.prompt" || command.type === "session.steer" ? command.approvalMode : undefined;
  return mode === undefined ? "/v1/commands" : "/v2/commands";
}

export function sessionControlEndpoint(sessionId: string, mutation: OmpSessionControlMutation): string {
  const durable = (mutation.operation === "override" || mutation.operation === "clear-override") && mutation.path === "tools.approvalMode";
  return `/v${durable ? 2 : 1}/sessions/${encodeURIComponent(sessionId)}/controls`;
}

export async function requestVersionedCommand(request: (path: string, body: unknown) => Promise<unknown>, envelope: CommandEnvelope): Promise<unknown> {
  const endpoint = commandEndpoint(envelope);
  try { return await request(endpoint, envelope); }
  catch (error) {
    if (endpoint === '/v14/commands' && error instanceof HostRequestError && error.status === 404 && !error.code) return {ok:false,commandId:envelope.id,error:{code:'TASK_LOCATION_PROTOCOL_UNSUPPORTED',message:'Update the owning host to move existing tasks between local and managed worktrees. This request was not accepted.'}} satisfies CommandResult;
    // A missing endpoint establishes that this versioned request was rejected.
    // A timeout or any other failure retains ordinary uncertain-delivery rules.
    if (endpoint === '/v13/commands' && error instanceof HostRequestError && error.status === 404 && !error.code) return { ok: false, commandId: envelope.id, error: { code: 'FOLLOW_UP_PROTOCOL_UNSUPPORTED', message: 'Update the owning host to queue active-turn follow-ups. This request was not accepted.' } } satisfies CommandResult;
    if (endpoint === '/v12/commands' && error instanceof HostRequestError && error.status === 404 && !error.code) return { ok: false, commandId: envelope.id, error: { code: 'REMOTE_WORKTREE_PROTOCOL_UNSUPPORTED', message: 'Update the owning host to retain remote worktree starting refs. This request was not accepted.' } } satisfies CommandResult;
    if (endpoint === '/v11/commands' && error instanceof HostRequestError && error.status === 404 && !error.code) return {ok:false,commandId:envelope.id,error:{code:'KEYBINDINGS_PROTOCOL_UNSUPPORTED',message:'Update the owning host to change keyboard shortcuts. This request was not accepted.'}} satisfies CommandResult;
    if (endpoint === '/v10/commands' && error instanceof HostRequestError && error.status === 404 && !error.code) return {ok:false,commandId:envelope.id,error:{code:'GIT_SUBMISSION_PROTOCOL_UNSUPPORTED',message:'Update the owning host to submit Git changes. This request was not accepted.'}} satisfies CommandResult;
    if (endpoint === '/v9/commands' && error instanceof HostRequestError && error.status === 404 && !error.code) return {ok:false,commandId:envelope.id,error:{code:'REPEATED_WHOLE_FILE_PROTOCOL_UNSUPPORTED',message:'Update the owning host to repeat inline file mentions. This request was not accepted.'}} satisfies CommandResult;
    if (endpoint === '/v8/commands' && error instanceof HostRequestError && error.status === 404 && !error.code) return {ok:false,commandId:envelope.id,error:{code:'INLINE_FILE_PROTOCOL_UNSUPPORTED',message:'Update the owning host to retain inline file positions. This request was not accepted.'}} satisfies CommandResult;
    if (endpoint === '/v7/commands' && error instanceof HostRequestError && error.status === 404 && !error.code) {
      return { ok: false, commandId: envelope.id, error: { code: 'WHOLE_FILE_PROTOCOL_UNSUPPORTED', message: 'Update the owning host to attach whole files. This request was not accepted.' } } satisfies CommandResult;
    }
    if (endpoint === '/v6/commands' && error instanceof HostRequestError && error.status === 404 && !error.code) {
      return { ok: false, commandId: envelope.id, error: { code: 'SELECTED_TEXT_PROTOCOL_UNSUPPORTED', message: 'Update the owning host to use selected text. This request was not accepted.' } } satisfies CommandResult;
    }
    if (endpoint === '/v5/commands' && error instanceof HostRequestError && error.status === 404 && !error.code) {
      return { ok: false, commandId: envelope.id, error: { code: 'ENVIRONMENT_PROTOCOL_UNSUPPORTED', message: 'Update the owning host to retain local environment choices. This request was not accepted.' } } satisfies CommandResult;
    }
    if (endpoint === '/v4/commands' && error instanceof HostRequestError && error.status === 404 && !error.code) {
      return { ok: false, commandId: envelope.id, error: { code: 'NEW_CHAT_PROTOCOL_UNSUPPORTED', message: 'Update the owning host to use saved worktree choices. This request was not accepted.' } } satisfies CommandResult;
    }
    if (endpoint === "/v3/commands" && error instanceof HostRequestError && error.status === 404 && !error.code) {
      return { ok: false, commandId: envelope.id, error: { code: "ATTACHMENT_PROTOCOL_UNSUPPORTED", message: "Update the owning host to use image drafts. This request was not accepted." } } satisfies CommandResult;
    }
    if (endpoint === "/v2/commands" && error instanceof HostRequestError && error.status === 404 && !error.code) {
      return { ok: false, commandId: envelope.id, error: { code: "PERMISSION_PROTOCOL_UNSUPPORTED", message: "Update the owning host to use saved permission choices. This request was not accepted." } } satisfies CommandResult;
    }
    throw error;
  }
}

export async function requestVersionedControl(request: (path: string, body: unknown) => Promise<unknown>, sessionId: string, mutation: OmpSessionControlMutation): Promise<unknown> {
  const endpoint = sessionControlEndpoint(sessionId, mutation);
  try { return await request(endpoint, mutation); }
  catch (error) {
    if (endpoint.startsWith("/v2/") && error instanceof HostRequestError && error.status === 404 && !error.code) {
      throw new Error("Update the owning host to retain permission choices across restarts. This permission change was not accepted.");
    }
    throw error;
  }
}
