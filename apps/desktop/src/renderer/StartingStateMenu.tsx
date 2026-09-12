import { useLayoutEffect, useMemo, useRef } from "react";
import type { WorktreeStartingState } from "@agent-desktop/shared";
import { Icon } from "./Icons";
import { useBranchSearch } from "./use-branch-search";
import type { BranchInventory, BranchInventorySnapshot } from "./branch-inventory";
import { startingStateGroups, startingStateSelected, type StartingStateOption } from "./starting-state-options";
import type { WorkspaceState } from "./workspace-state";

/** Mounted only for this open composer menu. Selection saves intent; checkout
 * and creation-time resolution remain with their existing separate owners. */
export function StartingStateMenu({ workspace, connected, disabled, inventory, projectName, query, onQuery, selected, onSelect, onClose }: {
  workspace: WorkspaceState; connected: boolean; disabled: boolean; projectName: string; query: string; onQuery(query: string): void;
  inventory: { controller: BranchInventory; snapshot: BranchInventorySnapshot };
  selected: WorktreeStartingState; onSelect(state: WorktreeStartingState): void; onClose(): void;
}) {
  const search = useBranchSearch(workspace, query, connected && !disabled, "starting-state");
  const revision = workspace.status?.revision;
  const lifetime = useMemo(() => ({}), [workspace, query, connected, disabled, revision, search.snapshot, inventory.snapshot]);
  const committed = useRef<{ lifetime: object; version: number } | undefined>(undefined);
  const composing = useRef(false);
  useLayoutEffect(() => {
    committed.current = { lifetime, version: search.controller.version };
    return () => { committed.current = undefined; };
  }, [lifetime, search.controller]);
  const groups = startingStateGroups(query, workspace.status?.branch, Boolean(workspace.status?.entries.length), selected, inventory.snapshot, search.snapshot);
  const typed = Boolean(query.trim());
  const loading = typed ? search.snapshot.loading : inventory.snapshot.loading || inventory.snapshot.baseBranch === undefined && !inventory.snapshot.defaultError;
  const error = typed ? search.snapshot.error : inventory.snapshot.error ?? inventory.snapshot.defaultError;
  function choose(row: StartingStateOption) {
    const current = committed.current;
    if (!current || current.lifetime !== lifetime || !search.controller.isCurrent(current.version)
      || disabled || !workspace.connected || !workspace.restored || !workspace.status || workspace.status.revision !== revision
      || workspace.busy || workspace.pending) return;
    committed.current = undefined;
    onSelect(row.state); onClose();
  }
  return <>
    <label className="context-search"><Icon name="search"/><input type="search" aria-label={`Search ${projectName} branches`} placeholder={`Search ${projectName} branches`}
      value={query} onChange={event => onQuery(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (event.key !== "Enter" || composing.current || event.nativeEvent.isComposing) return;
        event.preventDefault();
        if (typed && (loading || error)) return;
        const first = groups.flatMap(group => group.rows)[0]; if (first) choose(first);
      }}/></label>
    <div className="context-options context-starting-states">
      {groups.map((group, index) => <div className="context-starting-group" key={group.label ?? `base-${index}`}>
        {group.label && <p className="context-starting-heading">{group.label}</p>}
        {group.rows.map(row => <button type="button" role="menuitemradio" aria-checked={startingStateSelected(selected, row.state)} key={row.key}
          disabled={disabled || !connected} onClick={() => choose(row)} title={row.label}>
          <Icon name="branch"/><span>{row.label}{row.description && <small>{row.description}</small>}</span>{startingStateSelected(selected, row.state) && <Icon name="check"/>}
        </button>)}
      </div>)}
      {loading && <p role="status">Loading branches…</p>}
      {!typed && (inventory.snapshot.warning || inventory.snapshot.defaultWarning) && <p role="status">{inventory.snapshot.warning ?? inventory.snapshot.defaultWarning}<button type="button" disabled={!connected} onClick={() => inventory.controller.retry()}>Retry live updates</button></p>}
      {workspace.repositoryWatchWarning && <p role="status">{workspace.repositoryWatchWarning}</p>}
      {error && <p role="alert">{error}<button type="button" disabled={!connected || disabled} onClick={() => { if (typed) search.controller.retry(); else inventory.controller.retry(); }}>Retry</button></p>}
      {!loading && !error && !groups.some(group => group.rows.length) && <p>No branches found</p>}
    </div>
  </>;
}
