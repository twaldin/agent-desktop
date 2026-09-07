import type { ComposerAction } from "@agent-desktop/shared";
import type { DraftController } from "./drafts";
import { selectProjectWithExecutionMode } from "./project-execution-mode";

/** Try prepares the host's new-chat draft. Sending remains an explicit action. */
export function prepareSkillDraft(drafts: DraftController, action: ComposerAction, projectId: string | null, worktrees = false) {
  if (action.source.kind !== "skill" || action.availability !== "executable" || !/^\/skill:[^\s]+\s*$/.test(action.insertText)) throw new Error(action.reason ?? "This native skill cannot be invoked in the selected workspace.");
  if (worktrees) selectProjectWithExecutionMode(drafts, "new-conversation", projectId);
  else drafts.update("new-conversation", { projectId });
  const draft = drafts.get("new-conversation").draft;
  const prefix = `${action.insertText.trim()} `;
  drafts.update("new-conversation", { text: draft.text.startsWith(prefix) ? draft.text : prefix + draft.text });
}
