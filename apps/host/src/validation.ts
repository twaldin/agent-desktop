import { parseNativeSessionMcpReload, parseNativeSessionMcpReconnect, parseNativeSkillFileRef } from "@agent-desktop/shared";
import { isAbsolute } from "node:path";
import type { CommandEnvelope, ModelChoice } from "@agent-desktop/shared";
import { parseWorkspaceMutation, parseWorkspaceTarget } from "./workspace-http";
import { parseCommandKeymapMutation } from "../../../packages/shared/src/preferences-v2";
import { parsePreferenceChange } from "../../../packages/shared/src/preferences";
import { approvalMode } from "./approval";
import { parseInlineWholeFileMentions, parseWholeFileAttachments, parseSelectedTextAttachments, parseImageAttachments, parseDetachedQuestionAnswers, parseNewChatExecution, parseWorktreeStartingState, parseEnvironmentSelection } from "@agent-desktop/shared";

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
export function parseCommandEnvelope(value: unknown, transportVersion?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12): CommandEnvelope {
  const envelope = object(value);
  if (envelope.commandVersion !== undefined && envelope.commandVersion !== 4 && envelope.commandVersion !== 5 && envelope.commandVersion !== 6 && envelope.commandVersion !== 7 && envelope.commandVersion !== 8 && envelope.commandVersion !== 9 && envelope.commandVersion !== 10 && envelope.commandVersion !== 11 && envelope.commandVersion !== 12) throw new Error('Unsupported command version.');
  const version = envelope.commandVersion as 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | undefined;
  return { ...parseCommandBody(value, version ?? (transportVersion === 12 ? 12 : transportVersion === 11 ? 11 : transportVersion === 10 ? 10 : transportVersion === 9 ? 9 : undefined)), ...(version === undefined ? {} : { commandVersion: version }) };
}
function parseCommandBody(value: unknown, commandVersion?: 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12): CommandEnvelope {
  const envelope = object(value);
  const id = text(envelope.id, "command ID");
  const input = object(envelope.command);
  const type = text(input.type, "command type");
  if (Object.hasOwn(input, 'worktree') && type !== 'session.create') throw new Error('Only new conversations can select a worktree.');
  if (Object.hasOwn(input, 'environment') && type !== 'session.create') throw new Error('Only worktree creation accepts an environment selection.');
  if (Object.hasOwn(input, "attachments") && type !== "session.prompt" && type !== "session.steer") throw new Error("This command does not accept image attachments.");
  const attachments = Object.hasOwn(input, "attachments") ? parseImageAttachments(input.attachments) : undefined;
  if (Object.hasOwn(input, "selectedTextAttachments") && type !== "session.prompt" && type !== "session.steer") throw new Error("This command does not accept selected text.");
  const selectedTextAttachments = Object.hasOwn(input, "selectedTextAttachments") ? parseSelectedTextAttachments(input.selectedTextAttachments) : undefined;
  if (Object.hasOwn(input, "wholeFileAttachments") && type !== "session.prompt" && type !== "session.steer") throw new Error("This command does not accept whole files.");
  const wholeFileAttachments = Object.hasOwn(input, "wholeFileAttachments") ? (commandVersion ?? 0) >= 9
    ? parseInlineWholeFileMentions(input.wholeFileAttachments, typeof input.text === "string" ? input.text.length : 0)
    : parseWholeFileAttachments(input.wholeFileAttachments,typeof input.text==="string"?input.text.length:undefined) : undefined;
  const hasContext = Boolean(attachments?.length || selectedTextAttachments?.length || wholeFileAttachments?.length);
  const promptText = () => hasContext && input.text === "" ? "" : text(input.text, "prompt", hasContext ? 500_000 : 4_000_000);
  switch (type) {
    case "skill.file.write": {
      if (Object.keys(input).some(key => !["type", "ref", "expectedRevision", "text", "bom"].includes(key))
        || typeof input.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedRevision)
        || typeof input.text !== "string" || new TextEncoder().encode(input.text).byteLength > 1024 * 1024
        || input.bom !== undefined && typeof input.bom !== "boolean") throw new Error("Invalid native skill file write.");
      return { id, command: { type, ref: parseNativeSkillFileRef(input.ref), expectedRevision: input.expectedRevision, text: input.text, ...(input.bom === undefined ? {} : { bom: input.bom }) } };
    }
    case "skill.file.open": {
      if (Object.keys(input).some(key => !["type", "ref", "targetId"].includes(key))) throw new Error("Invalid native skill file open.");
      return { id, command: { type, ref: parseNativeSkillFileRef(input.ref), targetId: text(input.targetId, "application target", 200) } };
    }
    case "skill.file.reveal": {
      if (Object.keys(input).some(key => !["type", "ref"].includes(key))) throw new Error("Invalid native skill file reveal.");
      return { id, command: { type, ref: parseNativeSkillFileRef(input.ref) } };
    }
    case "session.environment.cancel": return { id, command: { type, preparationId: text(input.preparationId, "preparation ID"), projectId: text(input.projectId, "project ID"), runRevision: revision(input.runRevision) } };
    case "session.environment.resume": return { id, command: { type, preparationId: text(input.preparationId, 'preparation ID'), expectedRevision: revision(input.expectedRevision) } };
    case "preferences.keymap.mutate": {
      if ((commandVersion ?? 0) < 11) throw new Error("Keyboard shortcut changes require command version 11.");
      if (Object.keys(input).some(key => !["type", "mutation"].includes(key))) throw new Error("Invalid shortcut mutation fields.");
      return { id, command: { type, mutation: parseCommandKeymapMutation(input.mutation) } };
    }
    case "preferences.put": return { id, command: { type, change: parsePreferenceChange(input.change) } };
    case "workspace.mutate": return { id, command: { type, target: parseWorkspaceTarget(input.target), action: parseWorkspaceMutation(input.action) } };
    case "project.add": return { id, command: { type, path: directory(input.path), name: input.name === undefined ? undefined : text(input.name, "project name", 500) } };
    case "project.rename": return { id, command: { type, projectId: text(input.projectId, "project ID"), name: text(input.name, "project name", 500) } };
    case "project.remove": return { id, command: { type, projectId: text(input.projectId, "project ID") } };
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
      ...(wholeFileAttachments === undefined ? {} : { wholeFileAttachments }),
      ...(selectedTextAttachments === undefined ? {} : { selectedTextAttachments }),
      model: input.model === undefined ? undefined : model(input.model),
      thinkingLevel: input.thinkingLevel === undefined ? undefined : text(input.thinkingLevel, "thinking level"),
      ...(input.approvalMode === undefined ? {} : { approvalMode: approvalMode(input.approvalMode) }),
      draft: draftReference(input.draft),
    } };
    case "session.steer": return { id, command: { type, sessionId: text(input.sessionId, "session ID"), text: promptText(), draft: draftReference(input.draft),
      ...(attachments === undefined ? {} : { attachments }),
      ...(wholeFileAttachments === undefined ? {} : { wholeFileAttachments }),
      ...(selectedTextAttachments === undefined ? {} : { selectedTextAttachments }),
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
        ...(Object.hasOwn(draft, "wholeFileAttachments") ? { wholeFileAttachments: (commandVersion ?? 0) >= 9
          ? parseInlineWholeFileMentions(draft.wholeFileAttachments, draft.text.length)
          : parseWholeFileAttachments(draft.wholeFileAttachments,draft.text.length) } : {}),
        ...(Object.hasOwn(draft, "selectedTextAttachments") ? { selectedTextAttachments: parseSelectedTextAttachments(draft.selectedTextAttachments) } : {}),
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
