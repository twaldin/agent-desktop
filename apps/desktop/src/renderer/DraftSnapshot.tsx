import type { Draft, Project } from "@agent-desktop/shared";
import { approvalModes } from "./ComposerPermissions";

/** Show selection-only conflicts as well as text; catalog names are owner-local. */
export function DraftSnapshot({ draft, hostName, projects }: { draft: Draft; hostName: string; projects: Project[] }) {
  const project = projects.find(item => item.id === draft.projectId);
  return <div className="draft-snapshot">
    <dl><dt>Host</dt><dd>{hostName}</dd><dt>Project</dt><dd>{project ? `${project.name} · ${project.path}` : draft.projectId ? `Unavailable project · ${draft.projectId}` : "No project"}</dd>
      <dt>Model</dt><dd>{draft.model ? `${draft.model.provider}/${draft.model.id}` : "Follow native default / current session"}</dd>
      <dt>Reasoning</dt><dd>{draft.thinkingLevel ?? "Follow native default / current session"}</dd>
      <dt>Permissions</dt><dd>{draft.approvalMode ? approvalModes[draft.approvalMode]?.label ?? `Unknown saved choice: ${draft.approvalMode}` : "Follow native default / current session"}</dd>
    </dl><pre>{draft.text || "(Empty draft)"}</pre>
  </div>;
}
