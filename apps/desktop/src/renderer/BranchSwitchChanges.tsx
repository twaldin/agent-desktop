import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { BranchReview, branchReviewPath, type BranchReviewSnapshot } from "./branch-review-summary";
import type { WorkspaceState } from "./workspace-state";

export function BranchSwitchChanges({ data, paths, branch }: { data: WorkspaceState; paths: readonly string[]; branch: string }) {
  const controller = useMemo(() => new BranchReview(data), [data]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useLayoutEffect(() => { controller.configure(true); return () => controller.configure(false); }, [controller]);
  return <BranchChangeDescription paths={paths} branch={branch} snapshot={snapshot} retry={controller.retry}/>;
}

function DiffStatistics({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="branch-switch-statistics" data-thread-find-skip>
    <span className="branch-switch-added">+{additions.toLocaleString()}</span>
    <span className="branch-switch-deleted">-{deletions.toLocaleString()}</span>
  </span>;
}

export function BranchChangeDescription({ paths, branch, snapshot, retry }: {
  paths: readonly string[]; branch: string; snapshot: BranchReviewSnapshot; retry(): void;
}) {
  const value = snapshot.value;
  return <>
    {paths.length ? <>
      <p>Your changes to the following files would be overwritten by checkout:</p>
      <ul>{paths.map((path, index) => { const stats = branchReviewPath(value, path); return <li key={`${path}:${index}`}>
        <span>{path}</span>{stats && <DiffStatistics {...stats}/>}</li>; })}</ul>
      <p>Please commit your changes to continue</p>
    </> : <p>{value ? <>Commit {value.additions + value.deletions > 0 && <><DiffStatistics {...value}/>{" "}</>}
      changes in {value.fileCount} {value.fileCount === 1 ? "file" : "files"} to check out {branch}.</>
      : <>Commit your changes to check out {branch}.</>}</p>}
    {!value && snapshot.loading && <p role="status">Loading change statistics…</p>}
    {snapshot.error && <p role="status">{snapshot.error}{" "}<button type="button" onClick={retry} disabled={snapshot.loading}>Refresh statistics</button></p>}
  </>;
}
