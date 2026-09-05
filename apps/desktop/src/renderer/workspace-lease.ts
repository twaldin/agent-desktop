import type { WorkspaceState } from "./workspace-state";
const users = new WeakMap<WorkspaceState, number>();
/** Several panels can share one workspace without one closing the other's subscription. */
export function retainWorkspace(data: WorkspaceState): () => void {
  const count = users.get(data) ?? 0; users.set(data, count + 1); if (!count) data.start();
  let released = false;
  return () => { if (released) return; released = true; const remaining = (users.get(data) ?? 1) - 1; if (remaining) users.set(data, remaining); else { users.delete(data); data.stop(); } };
}
