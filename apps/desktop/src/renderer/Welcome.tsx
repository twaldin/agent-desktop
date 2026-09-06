import { useEffect, useReducer } from "react";
import type { Project } from "../../../../packages/shared/src/protocol";
import type { WorkspaceState } from "./workspace-state";

export function Welcome({ project, workspace, onSelectProject }: { project?: Project; workspace?: WorkspaceState; onSelectProject(): void }) {
  const [, redraw] = useReducer(value => value + 1, 0);
  useEffect(() => workspace?.subscribe(redraw), [workspace]);
  const prompt = workspace?.status ? "What should we build in " : "What should we work on in ";
  return <div className="welcome">
    <div className="welcome-mark" aria-hidden="true">
      <svg viewBox="0 0 48 48" fill="none">
        <path d="M18.1 8.9A13 13 0 0 1 36 7.7a12.7 12.7 0 0 1 9 16.7 12.7 12.7 0 0 1-5.3 17.6 13 13 0 0 1-18.1 1.2A12.7 12.7 0 0 1 5 25.9 12.7 12.7 0 0 1 18.1 8.9Z"/>
        <path d="m16.7 19.1 5.2 5.7-5.2 8.1M27.2 31.2h8.1"/>
      </svg>
    </div>
    <h1>{project ? <>{prompt}<button type="button" aria-label={`${project.name}?`} aria-haspopup="menu" title={`Change project: ${project.name}`} onClick={onSelectProject}>{project.name}?</button></> : "What should we work on?"}</h1>
  </div>;
}
