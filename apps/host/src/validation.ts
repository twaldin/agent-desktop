import { isAbsolute } from "node:path";
import type { CommandEnvelope, ModelChoice } from "@agent-desktop/shared";
import { parseWorkspaceMutation, parseWorkspaceTarget } from "./workspace-http";
import { parsePreferenceChange } from "../../../packages/shared/src/preferences";

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
  const id = text(envelope.id, "command ID");
  const input = object(envelope.command);
  const type = text(input.type, "command type");
  switch (type) {
    case "preferences.put": return { id, command: { type, change: parsePreferenceChange(input.change) } };
    case "workspace.mutate": return { id, command: { type, target: parseWorkspaceTarget(input.target), action: parseWorkspaceMutation(input.action) } };
    case "project.add": return { id, command: { type, path: directory(input.path), name: input.name === undefined ? undefined : text(input.name, "project name", 500) } };
    case "session.create": return { id, command: { type,
      projectId: input.projectId === null ? null : text(input.projectId, "project ID"),
      cwd: input.cwd === undefined ? undefined : directory(input.cwd),
      model: input.model === undefined ? undefined : model(input.model),
    } };
    case "session.prompt": return { id, command: { type,
      sessionId: text(input.sessionId, "session ID"), text: text(input.text, "prompt", 4_000_000),
      model: input.model === undefined ? undefined : model(input.model),
      thinkingLevel: input.thinkingLevel === undefined ? undefined : text(input.thinkingLevel, "thinking level"),
      draft: draftReference(input.draft),
    } };
    case "session.steer": return { id, command: { type, sessionId: text(input.sessionId, "session ID"), text: text(input.text, "prompt", 4_000_000), draft: draftReference(input.draft) } };
    case "session.interrupt": return { id, command: { type, sessionId: text(input.sessionId, "session ID") } };
    case "session.rename": return { id, command: { type, sessionId: text(input.sessionId, "session ID"), title: text(input.title, "session title", 1000) } };
    case "session.archive": {
      if (typeof input.archived !== "boolean") throw new Error("Invalid archived flag.");
      return { id, command: { type, sessionId: text(input.sessionId, "session ID"), archived: input.archived } };
    }
    case "draft.put": {
      const draft = object(input.draft);
      if (typeof draft.text !== "string" || draft.text.length > 4_000_000) throw new Error("Invalid draft text.");
      return { id, command: { type, expectedRevision: revision(input.expectedRevision), draft: {
        id: text(draft.id, "draft ID"), text: draft.text,
        projectId: draft.projectId === null ? null : text(draft.projectId, "project ID"),
        model: draft.model === null ? null : model(draft.model),
        thinkingLevel: draft.thinkingLevel === undefined ? undefined : text(draft.thinkingLevel, "thinking level"),
      } } };
    }
    default: throw new Error(`Unsupported command: ${type}`);
  }
}
