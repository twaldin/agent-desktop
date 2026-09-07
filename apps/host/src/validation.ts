import { parseNativeSessionMcpReload, parseNativeSessionMcpReconnect } from "@agent-desktop/shared";
import { isAbsolute } from "node:path";
import type { CommandEnvelope, ModelChoice } from "@agent-desktop/shared";
import { parseWorkspaceMutation, parseWorkspaceTarget } from "./workspace-http";
import { parsePreferenceChange } from "../../../packages/shared/src/preferences";
import { approvalMode } from "./approval";
import { parseImageAttachments, parseDetachedQuestionAnswers, parseNewChatExecution, parseWorktreeStartingState, parseEnvironmentSelection } from "@agent-desktop/shared";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, maximum = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`Invalid ${name}.`);
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid draft revision.");
  return value as number;
}
function model(value: unknown): ModelChoice {
  const item = object(value);
  return { provider: text(item.provider, "provider"), id: text(item.id, "model", 500) };
}
function draftReference(value: unknown): { id: string; revision: number } | undefined {
  if (value === undefined) return undefined;
  const item = object(value);
  return { id: text(item.id, "draft ID"), revision: revision(item.revision) };
}
function directory(value: unknown): string {
  const path = text(value, "directory", 16_384);
  if (!isAbsolute(path) || path.includes("\0")) throw new Error("A directory must be an absolute path.");
  return path;
}

/** Normalize untrusted transport data before it reaches filesystem/runtime operations. */
export function parseCommandEnvelope(value: unknown): CommandEnvelope {
  const envelope = object(value);
  if (envelope.commandVersion !== undefined && envelope.commandVersion !== 4 && envelope.commandVersion !== 5) throw new Error('Unsupported command version.');
  return { ...parseCommandBody(value), ...(envelope.commandVersion === undefined ? {} : { commandVersion: envelope.commandVersion as 4 | 5 }) };
}
function parseCommandBody(value: unknown): CommandEnvelope {
  const envelope = object(value);
  const id = text(envelope.id, "command ID");
  const input = object(envelope.command);
  const type = text(input.type, "command type");
  if (Object.hasOwn(input, 'worktree') && type !== 'session.create') throw new Error('Only new conversations can select a worktree.');
  if (Object.hasOwn(input, 'environment') && type !== 'session.create') throw new Error('Only worktree creation accepts an environment selection.');
  if (Object.hasOwn(input, "attachments") && type !== "session.prompt" && type !== "session.steer") throw new Error("This command does not accept image attachments.");
  const attachments = Object.hasOwn(input, "attachments") ? parseImageAttachments(input.attachments) : undefined;
  const promptText = () => attachments?.length && input.text === "" ? "" : text(input.text, "prompt", attachments?.length ? 500_000 : 4_000_000);
  switch (type) {
    case "session.environment.cancel": return { id, command: { type, preparationId: text(input.preparationId, "preparation ID"), projectId: text(input.projectId, "project ID"), runRevision: revision(input.runRevision) } };
    case "session.environment.resume": return { id, command: { type, preparationId: text(input.preparationId, 'preparation ID'), expectedRevision: revision(input.expectedRevision) } };
    case "preferences.put": return { id, command: { type, change: parsePreferenceChange(input.change) } };
    case "workspace.mutate": return { id, command: { type, target: parseWorkspaceTarget(input.target), action: parseWorkspaceMutation(input.action) } };
    case "project.add": return { id, command: { type, path: directory(input.path), name: input.name === undefined ? undefined : text(input.name, "project name", 500) } };
    case "session.create": return { id, command: { type,
      projectId: input.projectId === null ? null : text(input.projectId, "project ID"),
      cwd: input.cwd === undefined ? undefined : directory(input.cwd),
      model: input.model === undefined ? undefined : model(input.model),
      ...(input.worktree === undefined ? {} : { worktree: (() => {
        if (!input.projectId || input.cwd !== undefined) throw new Error('A worktree must belong to the selected project.');
        return parseWorktreeStartingState(input.worktree);
      })() }),
      ...(Object.hasOwn(input, 'environment') ? { environment: (() => {
        if (!input.worktree || !input.projectId || input.cwd !== undefined || !draftReference(input.draft)) throw new Error('Environment creation requires a project worktree and captured draft revision.');
        return parseEnvironmentSelection(input.environment, text(input.projectId, 'project ID'));
      })() } : {}),
      ...(input.draft === undefined ? {} : { draft: draftReference(input.draft) }),
      ...(input.approvalMode === undefined ? {} : { approvalMode: approvalMode(input.approvalMode) }),
    } };
    case "session.prompt": return { id, command: { type,
      sessionId: text(input.sessionId, "session ID"), text: promptText(),
      ...(attachments === undefined ? {} : { attachments }),
      model: input.model === undefined ? undefined : model(input.model),
      thinkingLevel: input.thinkingLevel === undefined ? undefined : text(input.thinkingLevel, "thinking level"),
      ...(input.approvalMode === undefined ? {} : { approvalMode: approvalMode(input.approvalMode) }),
      draft: draftReference(input.draft),
    } };
    case "session.steer": return { id, command: { type, sessionId: text(input.sessionId, "session ID"), text: promptText(), draft: draftReference(input.draft),
      ...(attachments === undefined ? {} : { attachments }),
      ...(input.approvalMode === undefined ? {} : { approvalMode: approvalMode(input.approvalMode) }) } };
    case "session.interrupt": return { id, command: { type, sessionId: text(input.sessionId, "session ID") } };
    case "session.btw.start": {
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid side question command ID.");
      const question = text(input.question, "side question", 32_768).trim();
      if (!question || new TextEncoder().encode(question).byteLength > 32_768) throw new Error("Invalid side question.");
      const sessionId = text(input.sessionId, "session ID"), draft = draftReference(input.draft);
      if (input.nativeCommand !== undefined && input.nativeCommand !== "btw") throw new Error("Invalid native side question command.");
      if (input.nativeCommand === "btw" && (!draft || draft.id !== `session:${sessionId}`)) throw new Error("Native /btw requires the exact main composer draft.");
      return { id, command: { type, sessionId, question,
        ...(draft ? { draft } : {}), ...(input.nativeCommand === "btw" ? { nativeCommand: "btw" as const } : {}) } };
    }
    case "session.mcp.authorize": {
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id) || Object.keys(input).some(key => !["type","hostId","sessionId","epoch","expectedRevision","serverName"].includes(key))) throw new Error("Invalid MCP authorization start.");
      return { id, command: { type, hostId: text(input.hostId, "host ID", 200), sessionId: text(input.sessionId, "session ID", 200), ...parseNativeSessionMcpReconnect({epoch:input.epoch,expectedRevision:input.expectedRevision,serverName:input.serverName}) } };
    }
    case "session.mcp.reload": return { id, command: { type, sessionId: text(input.sessionId, "session ID"), ...parseNativeSessionMcpReload({epoch:input.epoch,expectedRevision:input.expectedRevision}) } };
    case "session.mcp.reconnect": return { id, command: { type, sessionId: text(input.sessionId, "session ID"), ...parseNativeSessionMcpReconnect({epoch:input.epoch,expectedRevision:input.expectedRevision,serverName:input.serverName}) } };
    case "session.btw.promote":
    case "session.btw.cancel": {
      const runId = text(input.runId, "side question run ID", 200);
      if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid side question run ID.");
      return { id, command: { type, sessionId: text(input.sessionId, "session ID"), runId } };
    }
    case "session.question.answer": {
      const sessionId = text(input.sessionId, "session ID"), questionId = text(input.questionId, "question ID"), draft = draftReference(input.draft);
      if (!draft || draft.id !== `question:${sessionId}:${questionId}`) throw new Error("A detached answer requires its own saved draft revision.");
      return { id, command: { type, sessionId, questionId, questionEntryId: text(input.questionEntryId, "question entry ID"), answers: parseDetachedQuestionAnswers(input.answers), draft } };
    }
    case "session.rename": return { id, command: { type, sessionId: text(input.sessionId, "session ID"), title: text(input.title, "session title", 1000) } };
    case "session.archive": {
      if (typeof input.archived !== "boolean") throw new Error("Invalid archived flag.");
      return { id, command: { type, sessionId: text(input.sessionId, "session ID"), archived: input.archived } };
    }
    case "draft.put": {
      const draft = object(input.draft);
      if (Object.hasOwn(draft, "lastConsumption")) throw new Error("Draft consumption is owned by the host.");
      if (typeof draft.text !== "string" || draft.text.length > 4_000_000) throw new Error("Invalid draft text.");
      return { id, command: { type, expectedRevision: revision(input.expectedRevision), draft: {
        id: text(draft.id, "draft ID"), text: draft.text,
        ...(Object.hasOwn(draft, "attachments") ? { attachments: parseImageAttachments(draft.attachments) } : {}),
        projectId: draft.projectId === null ? null : text(draft.projectId, "project ID"),
        model: draft.model === null ? null : model(draft.model),
        thinkingLevel: draft.thinkingLevel === undefined ? undefined : text(draft.thinkingLevel, "thinking level"),
        ...(draft.approvalMode === undefined ? {} : { approvalMode: approvalMode(draft.approvalMode) }),
        ...(draft.execution === undefined ? {} : { execution: parseNewChatExecution(draft.execution, draft.projectId === null ? null : text(draft.projectId, 'project ID')) }),
        ...(Object.hasOwn(draft, 'environment') ? { environment: parseEnvironmentSelection(draft.environment, draft.projectId === null ? null : text(draft.projectId, 'project ID')) } : {}),
      } } };
    }
    default: throw new Error(`Unsupported command: ${type}`);
  }
}
