import type { Draft, NewChatExecution } from "@agent-desktop/shared";
import { DraftController, type DraftView } from "./drafts";

export const localExecution: NewChatExecution = { type: "local" };
export const projectExecutionModeDraftId = (projectId: string) => `new-chat-execution-mode:${projectId}`;

/** The slot stores a valid execution value, but only its Local/worktree type is a preference. */
export function projectExecutionModeView(drafts: DraftController, projectId: string, initial?: NewChatExecution): DraftView {
  return drafts.get(projectExecutionModeDraftId(projectId), {
    text: "", projectId, model: null, execution: initial ?? localExecution,
  });
}

function executionForMode(preference: NewChatExecution, current?: NewChatExecution): NewChatExecution {
  if (preference.type === "local") return localExecution;
  return current?.type === "worktree" ? current : preference;
}

function rememberCurrentMode(drafts: DraftController, draft: Draft) {
  if (!draft.projectId || !draft.execution) return;
  const view = projectExecutionModeView(drafts, draft.projectId, draft.execution);
  // A revision-zero slot only exists in this renderer. Persist it before the
  // global composer moves to another project.
  if (view.draft.revision === 0 && view.draft.updatedAt === 0)
    drafts.update(view.draft.id, { execution: draft.execution });
}

/** Switch the global composer without replacing any authored content or selections. */
export function selectProjectWithExecutionMode(drafts: DraftController, draftId: string, projectId: string | null) {
  const current = drafts.get(draftId).draft;
  if (current.projectId === projectId) return;
  rememberCurrentMode(drafts, current);
  if (projectId === null) {
    drafts.update(draftId, { projectId, ...(current.execution?.type === "worktree" ? { execution: localExecution } : {}) });
    return;
  }
  const preferred = projectExecutionModeView(drafts, projectId).draft.execution ?? localExecution;
  drafts.update(draftId, { projectId, execution: executionForMode(preferred) });
}

/** Record an explicit Work in choice. Starting-state-only changes bypass this helper. */
export function selectProjectExecutionMode(drafts: DraftController, draftId: string, projectId: string, execution: NewChatExecution) {
  const current = drafts.get(draftId).draft;
  const preference = projectExecutionModeView(drafts, projectId, current.projectId === projectId ? current.execution : undefined);
  if (current.projectId !== projectId || current.execution?.type !== execution.type)
    drafts.update(draftId, { projectId, execution: executionForMode(execution, current.projectId === projectId ? current.execution : undefined) });
  if (preference.draft.revision === 0 && preference.draft.updatedAt === 0 || preference.draft.execution?.type !== execution.type)
    drafts.update(preference.draft.id, { execution });
}

/** Apply a clean remote preference without replacing an explicit starting state. */
export function applyProjectExecutionMode(drafts: DraftController, draftId: string, preference: Draft) {
  const current = drafts.get(draftId).draft;
  if (current.projectId !== preference.projectId || !preference.execution || current.execution?.type === preference.execution.type) return;
  drafts.update(draftId, { execution: executionForMode(preference.execution, current.execution) });
}

export function resolveProjectExecutionMode(drafts: DraftController, draftId: string, projectId: string, choice: "remote" | "local") {
  const id = projectExecutionModeDraftId(projectId);
  drafts.resolve(id, choice);
  applyProjectExecutionMode(drafts, draftId, drafts.get(id).draft);
}

export function sameModeConflict(view: DraftView): boolean {
  return Boolean(view.conflict?.execution && view.draft.execution?.type === view.conflict.execution.type);
}

export function executionModeLabel(execution?: NewChatExecution) {
  return execution?.type === "worktree" ? "New local worktree" : "Local";
}
