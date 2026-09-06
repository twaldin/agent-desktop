import type { Draft, Project } from "@agent-desktop/shared";
import { approvalModes } from "./ComposerPermissions";
import { ImagePreview } from "./ImagePreview";
import { formatImageBytes, type AttachmentMediaContext } from "./attachment-media";

/** Conflicting versions retain their own ordered manifests and owner-scoped previews. */
export function DraftSnapshot({ draft, hostName, projects, media, hostId, connected = false }: { draft: Draft; hostName: string; projects: Project[]; media?: AttachmentMediaContext; hostId?: string; connected?: boolean }) {
  const project = projects.find(item => item.id === draft.projectId);
  return <div className="draft-snapshot">
    <dl><dt>Host</dt><dd>{hostName}</dd><dt>Project</dt><dd>{project ? `${project.name} · ${project.path}` : draft.projectId ? `Unavailable project · ${draft.projectId}` : "No project"}</dd>
      <dt>Model</dt><dd>{draft.model ? `${draft.model.provider}/${draft.model.id}` : "Follow native default / current session"}</dd>
      <dt>Reasoning</dt><dd>{draft.thinkingLevel ?? "Follow native default / current session"}</dd>
      <dt>Permissions</dt><dd>{draft.approvalMode ? approvalModes[draft.approvalMode]?.label ?? `Unknown saved choice: ${draft.approvalMode}` : "Follow native default / current session"}</dd>
      <dt>Work in</dt><dd>{draft.execution?.type === "worktree" ? "New local worktree" : "Local"}</dd>
      {draft.execution?.type === "worktree" && <><dt>Starting state</dt><dd>{draft.execution.startingState.type === "working-tree" ? "Local file state" : draft.execution.startingState.branchName}</dd></>}
    </dl><pre>{draft.text || (draft.attachments?.length ? "(No authored text)" : "(Empty draft)")}</pre>
    {draft.attachments !== undefined && <div className="draft-snapshot-attachments"><strong>Images</strong>{draft.attachments.length ? <ol>{draft.attachments.map(attachment => <li key={attachment.id}>{media && hostId && <ImagePreview media={media} source={{ kind: "attachment", attachment }} hostId={hostId} connected={connected} label={attachment.name}/>}<span>{attachment.name}</span> · {formatImageBytes(attachment.bytes)}<small> · {hostName}</small></li>)}</ol> : <p>No images</p>}</div>}
  </div>;
}
