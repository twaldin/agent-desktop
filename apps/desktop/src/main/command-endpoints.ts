import type { CommandEnvelope, CommandResult, OmpSessionControlMutation } from "@agent-desktop/shared";
import { HostRequestError } from "./host-transport";

/** Old hosts normalize away unknown fields. Never downgrade a policy request. */
export function commandEndpoint(envelope: CommandEnvelope): "/v1/commands" | "/v2/commands" | "/v3/commands" | "/v4/commands" | "/v5/commands" {
  const command = envelope.command;
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
    // A missing endpoint establishes that this versioned request was rejected.
    // A timeout or any other failure retains ordinary uncertain-delivery rules.
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
